// ─────────────────────────────────────────────────────────────────────────────
// src/engine/Scheduler.ts — DAG-based phase scheduling with parallel dispatch
// ─────────────────────────────────────────────────────────────────────────────

import type { Phase } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Scheduler
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * DAG-aware scheduler that determines which phases are ready to execute.
 *
 * For V1 backward-compatibility:
 * - If no phase has `depends_on`, falls back to sequential `current_phase` ordering.
 *
 * For V2 DAG mode:
 * - A phase is "ready" if all phases in its `depends_on` list are `completed`.
 * - Multiple phases can be ready simultaneously for parallel dispatch.
 * - Respects `MAX_CONCURRENT_WORKERS` to limit parallelism.
 */
export class Scheduler {
    private readonly maxConcurrent: number;

    constructor(options?: { maxConcurrent?: number }) {
        this.maxConcurrent = options?.maxConcurrent ?? 4;
    }

    /**
     * Determine if any phase uses `depends_on` (DAG mode).
     */
    isDAGMode(phases: readonly Phase[]): boolean {
        return phases.some(p => p.depends_on !== undefined && p.depends_on.length > 0);
    }

    /**
     * Get all phases that are ready to execute.
     *
     * "Ready" means:
     * 1. Status is `pending`.
     * 2. All phases in `depends_on` are `completed`.
     * 3. Does not exceed `maxConcurrent` when combined with currently `running` phases.
     */
    getReadyPhases(phases: readonly Phase[]): Phase[] {
        const currentlyRunning = phases.filter(p => p.status === 'running').length;
        const availableSlots = Math.max(0, this.maxConcurrent - currentlyRunning);

        if (availableSlots === 0) return [];

        if (!this.isDAGMode(phases)) {
            // V1 fallback: Return the next pending phase sequentially
            const next = phases.find(p => p.status === 'pending');
            return next ? [next] : [];
        }

        // DAG mode: Find all pending phases whose deps are satisfied
        const ready = phases.filter(p => {
            if (p.status !== 'pending') return false;
            const deps = p.depends_on ?? [];
            return deps.every(depId => {
                const dep = phases.find(d => d.id === depId);
                return dep?.status === 'completed';
            });
        });

        // Limit by available slots
        return ready.slice(0, availableSlots);
    }

    /**
     * Check if all phases are completed.
     */
    isAllCompleted(phases: readonly Phase[]): boolean {
        return phases.every(p => p.status === 'completed' || p.status === 'failed');
    }

    /**
     * Check if all phases are either completed or skipped (no pending left).
     */
    isAllDone(phases: readonly Phase[]): boolean {
        return !phases.some(p => p.status === 'pending' || p.status === 'running');
    }

    /**
     * Validate the DAG for cycles (returns cycle members or empty array).
     * Uses Kahn's algorithm (topological sort detection).
     */
    detectCycles(phases: readonly Phase[]): number[] {
        if (!this.isDAGMode(phases)) return [];

        const inDegree = new Map<number, number>();
        const adjacency = new Map<number, number[]>();

        // Initialize
        for (const phase of phases) {
            inDegree.set(phase.id, 0);
            adjacency.set(phase.id, []);
        }

        // Build graph
        for (const phase of phases) {
            for (const dep of (phase.depends_on ?? [])) {
                const neighbors = adjacency.get(dep);
                if (neighbors) neighbors.push(phase.id);
                inDegree.set(phase.id, (inDegree.get(phase.id) ?? 0) + 1);
            }
        }

        // Kahn's algorithm
        const queue: number[] = [];
        for (const [id, degree] of inDegree) {
            if (degree === 0) queue.push(id);
        }

        let processed = 0;
        while (queue.length > 0) {
            const nodeId = queue.shift()!;
            processed++;
            for (const neighbor of (adjacency.get(nodeId) ?? [])) {
                const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
                inDegree.set(neighbor, newDegree);
                if (newDegree === 0) queue.push(neighbor);
            }
        }

        // If not all nodes were processed, there's a cycle
        if (processed === phases.length) return [];

        // Return IDs that are part of cycles (those with remaining in-degree > 0)
        const cycleMemberIds: number[] = [];
        for (const [id, degree] of inDegree) {
            if (degree > 0) cycleMemberIds.push(id);
        }
        return cycleMemberIds;
    }

    /**
     * Get the execution order for display (topological sort).
     * Returns phase IDs in dependency-respecting order.
     */
    getExecutionOrder(phases: readonly Phase[]): number[] {
        if (!this.isDAGMode(phases)) {
            return phases.map(p => p.id);
        }

        const inDegree = new Map<number, number>();
        const adjacency = new Map<number, number[]>();

        for (const phase of phases) {
            inDegree.set(phase.id, 0);
            adjacency.set(phase.id, []);
        }

        for (const phase of phases) {
            for (const dep of (phase.depends_on ?? [])) {
                adjacency.get(dep)?.push(phase.id);
                inDegree.set(phase.id, (inDegree.get(phase.id) ?? 0) + 1);
            }
        }

        const queue: number[] = [];
        for (const [id, degree] of inDegree) {
            if (degree === 0) queue.push(id);
        }

        const order: number[] = [];
        while (queue.length > 0) {
            const nodeId = queue.shift()!;
            order.push(nodeId);
            for (const neighbor of (adjacency.get(nodeId) ?? [])) {
                const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
                inDegree.set(neighbor, newDegree);
                if (newDegree === 0) queue.push(neighbor);
            }
        }

        return order;
    }
}
