// ─────────────────────────────────────────────────────────────────────────────
// src/context/ContextPackBuilder.ts — Core assembly pipeline for worker context packs
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import type { TokenEncoder } from './ContextScoper.js';
import { FileContextModeSelector } from './FileContextModeSelector.js';
import { ImportScanner } from './ImportScanner.js';
import type {
    BuildContextPackInput,
    BuildContextPackResult,
    ContextPack,
    ContextManifest,
    FileContextEntry,
    FileSlice,
    HandoffPacket,
    ChangedFileHandoff,
} from '../types/context.js';
import type { PhaseHandoff } from '../mcp/types.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Number of lines of padding around edit regions when building slices. */
const SLICE_PADDING_LINES = 75;

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers — exactOptionalPropertyTypes-safe object construction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns `{ workspaceFolder }` when defined, or `{}` when undefined.
 * Prevents `exactOptionalPropertyTypes` violations when spreading into
 * interfaces with `workspaceFolder?: string`.
 */
function wsFolder(wf: string | undefined): { workspaceFolder: string } | Record<string, never> {
    return wf !== undefined ? { workspaceFolder: wf } : {};
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ContextPackBuilder
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assembles worker-ready context packs from upstream handoffs, file state,
 * and a token budget. Implements a 6-step pipeline:
 *
 *   1. Collect upstream handoffs
 *   2. Identify target files
 *   3. Choose file context mode
 *   4. Materialize selected file context
 *   5. Prune to budget
 *   6. Build manifest
 */
export class ContextPackBuilder {
    constructor(
        private readonly artifactDb: ArtifactDB,
        private readonly encoder: TokenEncoder,
        private readonly workspaceRoot: string,
    ) { }

    /**
     * Build a context pack for a target phase.
     *
     * @param input - Assembly parameters including upstream phases and budget.
     * @returns The assembled context pack and its audit manifest.
     */
    async build(input: BuildContextPackInput): Promise<BuildContextPackResult> {
        const { sessionId, taskId, phaseId, workspaceFolder, prompt, contextFiles, upstreamPhaseIds, maxTokens } = input;

        log.info(`[ContextPackBuilder] Building context pack for phase ${phaseId} (budget: ${maxTokens} tokens)`);

        // ── Step 1: Collect upstream handoffs ────────────────────────────────
        const handoffs: HandoffPacket[] = [];
        let handoffTokens = 0;

        for (const upPhaseId of upstreamPhaseIds) {
            const raw = this.artifactDb.handoffs.get(taskId, upPhaseId);
            if (!raw) {
                log.warn(`[ContextPackBuilder] No handoff found for upstream phase ${upPhaseId}`);
                continue;
            }

            const packet = this.phaseHandoffToPacket(raw, sessionId, taskId);
            const cost = this.encoder.countTokens(JSON.stringify(packet));
            handoffTokens += cost;
            handoffs.push(packet);
        }

        log.info(`[ContextPackBuilder] Collected ${handoffs.length} upstream handoffs (${handoffTokens} tokens)`);

        // ── Step 2: Identify target files ───────────────────────────────────
        const fileSet = new Set<string>(contextFiles);
        for (const handoff of handoffs) {
            for (const cf of handoff.changedFiles) {
                fileSet.add(cf.path);
            }
        }
        const targetFiles = [...fileSet];

        log.info(`[ContextPackBuilder] ${targetFiles.length} unique target files identified`);

        // ── Step 3 & 4: Choose mode and materialize file context ────────────
        const selector = new FileContextModeSelector(this.encoder);
        const fileContexts: FileContextEntry[] = [];
        const fileDecisions: ContextManifest['fileDecisions'] = [];
        let fileTokens = 0;

        // Build a map of upstream changed files for quick lookup
        const changedFileMap = new Map<string, { handoff: HandoffPacket; file: ChangedFileHandoff }>();
        for (const handoff of handoffs) {
            for (const cf of handoff.changedFiles) {
                changedFileMap.set(cf.path, { handoff, file: cf });
            }
        }

        for (const filePath of targetFiles) {
            const absPath = path.resolve(this.workspaceRoot, filePath);
            const upstream = changedFileMap.get(filePath);
            const isSameFileContinuation = upstream !== undefined;

            // Step 3: Select mode
            const decision = await selector.selectMode({
                filePath: absPath,
                workspaceRoot: this.workspaceRoot,
                ...wsFolder(workspaceFolder),
                ...(upstream?.file !== undefined ? { upstreamHandoff: upstream.file } : {}),
                isSameFileContinuation,
                phaseNeedsFullSemantics: input.requiresFullFileContext ?? false,
                tokenBudget: maxTokens,
            });

            // Step 4: Materialize
            try {
                const entry = await this.materializeFileContext(
                    filePath, absPath, decision.mode, upstream?.file, workspaceFolder,
                );

                if (entry) {
                    const cost = this.encoder.countTokens(JSON.stringify(entry));
                    fileTokens += cost;
                    fileContexts.push(entry);

                    fileDecisions.push({
                        ...wsFolder(workspaceFolder),
                        path: filePath,
                        selectedMode: decision.mode,
                        reason: decision.reason,
                        tokenCost: cost,
                        omitted: false,
                    });
                } else {
                    fileDecisions.push({
                        ...wsFolder(workspaceFolder),
                        path: filePath,
                        selectedMode: decision.mode,
                        reason: decision.reason,
                        tokenCost: 0,
                        omitted: true,
                        omissionReason: 'materialization returned no content',
                    });
                }
            } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log.warn(`[ContextPackBuilder] Failed to materialize ${filePath}: ${errMsg}`);
                fileDecisions.push({
                    ...wsFolder(workspaceFolder),
                    path: filePath,
                    selectedMode: decision.mode,
                    reason: decision.reason,
                    tokenCost: 0,
                    omitted: true,
                    omissionReason: errMsg,
                });
            }
        }

        // ── Step 4.5: Resolve transitive dependencies (V2-C 3.2) ─────────
        const scanner = new ImportScanner(this.workspaceRoot);
        const depPaths = await scanner.scan(targetFiles);
        const includedDependencies: ContextPack['includedDependencies'] = [];
        const dependencyDecisions: ContextManifest['dependencyDecisions'] = [];
        let dependencyTokens = 0;

        for (const depPath of depPaths) {
            const absDepPath = path.resolve(this.workspaceRoot, depPath);
            try {
                await fs.access(absDepPath);
                // Include as metadata-mode dependency (lightweight)
                const depEntry = { path: depPath, reason: 'transitive import' };
                const cost = this.encoder.countTokens(JSON.stringify(depEntry));
                dependencyTokens += cost;
                includedDependencies.push({
                    ...wsFolder(workspaceFolder),
                    ...depEntry,
                });
                dependencyDecisions.push({
                    ...wsFolder(workspaceFolder),
                    path: depPath,
                    included: true,
                    reason: 'direct import of a target file',
                    tokenCost: cost,
                });
            } catch {
                dependencyDecisions.push({
                    ...wsFolder(workspaceFolder),
                    path: depPath,
                    included: false,
                    reason: 'resolved import not found on disk',
                });
            }
        }

        log.info(`[ContextPackBuilder] Resolved ${includedDependencies.length} dependencies (${dependencyTokens} tokens)`);

        // ── Step 5: Prune to budget ─────────────────────────────────────────
        const totalBeforePrune = handoffTokens + fileTokens + dependencyTokens;

        if (totalBeforePrune > maxTokens) {
            log.warn(
                `[ContextPackBuilder] Over budget: ${totalBeforePrune} > ${maxTokens} tokens. Pruning…`,
            );

            // Drop lowest-priority entries first:
            // 1. Dependencies (none in V1)
            // 2. Metadata-only files
            // 3. Patch files
            const pruneOrder: Array<FileContextEntry['mode']> = ['metadata', 'patch'];

            for (const modeToRemove of pruneOrder) {
                if (handoffTokens + fileTokens + dependencyTokens <= maxTokens) { break; }

                // Walk backwards to remove from end first
                for (let i = fileContexts.length - 1; i >= 0; i--) {
                    if (fileContexts[i].mode !== modeToRemove) { continue; }
                    if (handoffTokens + fileTokens + dependencyTokens <= maxTokens) { break; }

                    const removed = fileContexts.splice(i, 1)[0];
                    const cost = this.encoder.countTokens(JSON.stringify(removed));
                    fileTokens -= cost;

                    // Mark as omitted in decisions
                    const decisionIdx = fileDecisions.findIndex(
                        d => d.path === removed.path && !d.omitted,
                    );
                    if (decisionIdx >= 0) {
                        fileDecisions[decisionIdx].omitted = true;
                        fileDecisions[decisionIdx].omissionReason = `pruned (${modeToRemove} mode) to fit budget`;
                        fileDecisions[decisionIdx].tokenCost = 0;
                    }

                    log.info(`[ContextPackBuilder] Pruned ${removed.path} (${modeToRemove} mode, ~${cost} tokens)`);
                }
            }
        }

        const totalTokens = handoffTokens + fileTokens + dependencyTokens;
        const overBudget = totalTokens > maxTokens;

        if (overBudget) {
            log.warn(
                `[ContextPackBuilder] Pack still over budget after pruning: ` +
                `${totalTokens}/${maxTokens} tokens. ` +
                `Handoffs: ${handoffTokens}, Files: ${fileTokens} (${fileContexts.length} entries), ` +
                `Dependencies: ${dependencyTokens}. Proceeding with best-effort context.`,
            );
        }

        // ── Step 6: Build manifest ──────────────────────────────────────────
        const manifestId = crypto.randomUUID();
        const now = new Date().toISOString();

        const manifest: ContextManifest = {
            manifestId,
            sessionId,
            taskId,
            phaseId,
            ...wsFolder(workspaceFolder),
            upstreamPhaseIds,
            includedHandoffIds: handoffs.map(h => h.handoffId),
            fileDecisions,
            dependencyDecisions,
            totals: {
                handoffTokens,
                fileTokens,
                dependencyTokens,
                totalTokens,
                budgetTokens: maxTokens,
            },
            createdAt: now,
        };

        // Persist manifest to DB
        this.artifactDb.contextManifests.upsert({
            manifestId,
            sessionId,
            taskId,
            phaseId,
            ...wsFolder(workspaceFolder),
            payloadJson: JSON.stringify(manifest),
            createdAt: Date.now(),
        });

        // Build pack
        const pack: ContextPack = {
            phaseId,
            ...wsFolder(workspaceFolder),
            targetPrompt: prompt,
            handoffs,
            fileContexts,
            includedDependencies,
            tokenUsage: {
                handoffs: handoffTokens,
                files: fileTokens,
                dependencies: dependencyTokens,
                total: totalTokens,
                budget: maxTokens,
            },
        };

        log.info(
            `[ContextPackBuilder] Context pack assembled: ${totalTokens}/${maxTokens} tokens ` +
            `(${handoffs.length} handoffs, ${fileContexts.length} files)`,
        );

        return { pack, manifest };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Private Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Convert a persisted `PhaseHandoff` row into a typed `HandoffPacket`.
     */
    private phaseHandoffToPacket(raw: PhaseHandoff, sessionId: string, taskId: string): HandoffPacket {
        // Parse changedFilesJson if available
        let changedFiles: ChangedFileHandoff[] = [];
        if (raw.changedFilesJson) {
            try {
                changedFiles = JSON.parse(raw.changedFilesJson) as ChangedFileHandoff[];
            } catch {
                log.warn(`[ContextPackBuilder] Failed to parse changedFilesJson for phase ${raw.phaseId}`);
                // Fallback: synthesize minimal ChangedFileHandoff from modifiedFiles
                changedFiles = raw.modifiedFiles.map(p => ({ path: p }));
            }
        } else {
            // No rich changed-files data — synthesize from modifiedFiles list
            changedFiles = raw.modifiedFiles.map(p => ({ path: p }));
        }

        return {
            handoffId: `${taskId}::${raw.phaseId}`,
            sessionId,
            taskId,
            fromPhaseId: raw.phaseId,
            ...wsFolder(raw.workspaceFolder),
            summary: raw.summary ?? raw.nextStepsContext ?? '',
            ...(raw.rationale !== undefined ? { rationale: raw.rationale } : {}),
            ...(raw.remainingWork !== undefined ? { remainingWork: raw.remainingWork } : {}),
            ...(raw.constraints !== undefined ? { constraints: raw.constraints } : {}),
            ...(raw.warnings !== undefined ? { warnings: raw.warnings } : {}),
            changedFiles,
            decisions: raw.decisions,
            producedAt: new Date(raw.completedAt).toISOString(),
        };
    }

    /**
     * Materialize a file's context payload based on the selected mode.
     *
     * @returns A `FileContextEntry` or `undefined` if no content could be produced.
     */
    private async materializeFileContext(
        relativePath: string,
        absPath: string,
        mode: FileContextEntry['mode'],
        upstreamFile: ChangedFileHandoff | undefined,
        workspaceFolder: string | undefined,
    ): Promise<FileContextEntry | undefined> {
        const wf = wsFolder(workspaceFolder);

        switch (mode) {
            case 'full': {
                const content = await fs.readFile(absPath, 'utf-8');
                return { mode: 'full', ...wf, path: relativePath, content };
            }

            case 'slice': {
                const content = await fs.readFile(absPath, 'utf-8');
                const lines = content.split('\n');
                const totalLines = lines.length;
                const editRegions = upstreamFile?.editRegions ?? [];

                if (editRegions.length === 0) {
                    // No edit regions — fallback to full
                    return { mode: 'full', ...wf, path: relativePath, content };
                }

                // V2-A 1.2: Compute padded intervals, then merge overlapping ones
                const rawIntervals = editRegions.map(r => ({
                    start: Math.max(1, r.startLine - SLICE_PADDING_LINES),
                    end: Math.min(totalLines, r.endLine + SLICE_PADDING_LINES),
                }));
                rawIntervals.sort((a, b) => a.start - b.start);
                const merged: typeof rawIntervals = [];
                for (const r of rawIntervals) {
                    const last = merged[merged.length - 1];
                    if (last && r.start <= last.end + 1) {
                        last.end = Math.max(last.end, r.end);
                    } else {
                        merged.push({ ...r });
                    }
                }

                const slices: FileSlice[] = merged.map(m => ({
                    ...wf,
                    path: relativePath,
                    startLine: m.start,
                    endLine: m.end,
                    content: lines.slice(m.start - 1, m.end).join('\n'),
                    reason: 'edited-region' as const,
                }));

                return { mode: 'slice', ...wf, path: relativePath, slices };
            }

            case 'patch': {
                if (!upstreamFile?.patch) {
                    // No patch available — skip
                    return undefined;
                }
                return { mode: 'patch', ...wf, path: relativePath, patch: upstreamFile.patch };
            }

            case 'metadata': {
                return {
                    mode: 'metadata',
                    ...wf,
                    path: relativePath,
                    ...(upstreamFile?.symbolsTouched !== undefined ? { symbolsTouched: upstreamFile.symbolsTouched } : {}),
                    ...(upstreamFile?.summary !== undefined ? { summary: upstreamFile.summary } : {}),
                };
            }

            default:
                return undefined;
        }
    }
}
