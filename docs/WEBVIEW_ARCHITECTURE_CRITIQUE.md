# Mission Control Webview — 6-Zone Dashboard Architecture Critique

> **Author:** Principal UI/UX Architect (Automated Review)
> **Scope:** Proposed 6-zone dashboard layout for the Coogent Mission Control Webview
> **Status:** Design Review

---

## 1. Executive Assessment

The 6-zone layout (Header → Mission Overview → Phase Navigator | Phase Details → Execution Controls → Worker Output) is a strong directional improvement over the flat card-based layout. It replaces horizontal scrolling phase cards with a navigator/detail master-detail pattern — the canonical VS Code UX idiom. However, several constraints of the VS Code Webview environment demand adjustments before this layout can ship reliably.

**Verdict:** Approve with modifications. The zones are conceptually sound. The issues below are solvable without restructuring the zone model.

---

## 2. Zone-by-Zone Critique

### Zone 1: Global Controls (Header)

**Strengths:**
- Sticky `position: sticky; top: 0` with `z-index: 10` correctly pins the header during scroll.
- Uses `--vscode-titleBar-activeBackground`, blending natively with the editor chrome.
- New Chat (left) and Reset (right, red hover) follow VS Code's action-bar placement convention.

**Issues:**
- **History Drawer overlay conflict.** The drawer uses `position: fixed; z-index: 100` and spans `100vh`. In a Webview panel, `100vh` equals the panel height, not the window — this is correct, but the drawer steals focus from keyboard navigation of the main content. Add `role="dialog"` and `aria-modal="true"` with a focus trap.
- **Reset button visibility.** `$btnReset` is only shown when `isCompleted`. Users in `ERROR_PAUSED` also need a "start fresh" affordance. The FSM already allows `RESET` from `ERROR_PAUSED`; surface it.

### Zone 2: Mission Overview (Hero Section)

**Strengths:**
- Clean, lightweight bar (`padding: 12px 16px`, no excessive decoration) that avoids visual competition with the Phase Details area.
- Hidden by default (`style.display = 'block'` set only when `runbook` exists) — prevents empty-state flicker.

**Issues:**
- **Information redundancy.** Subtitle shows `${phases.length} phases · Status: ${runbook.status}`, but the Header already displays `state-badge` with the FSM state. The runbook `status` field (`idle|running|paused_error|completed`) is a *different* concept from `EngineState` (9 states). This dual-status display will confuse users. **Recommendation:** Show only the user-facing phase count and elapsed time here; let the Header badge own state identity.
- **Missing goal echo.** The `project_id` is a UUID, not a human-readable description. There is no field in the `Runbook` interface for a `description` or `goal` string. The Mission Overview should echo the user's original prompt — but `firstPrompt` only exists on `SessionSummary`. Wire the planner's input prompt into the runbook model or the state snapshot.

### Zone 3: Phase Navigator (Left Sidebar)

**Strengths:**
- Master-detail pattern is the strongest layout decision. It mirrors VS Code's Explorer/Editor split and is immediately intuitive to target users (developers).
- Auto-selection logic (prefer running → pending → first) is correct and saves a click on state transitions.
- Status icon map (`○ ◉ ✓ ✗ ⊘`) is compact and accessible in monospace rendering.

**Issues:**
- **Fixed width is fragile.** `width: 220px; min-width: 180px` is too wide for narrow Webview panels (common in side-panel mode, where the panel can be <400px). At 220px + 16px border + scrollbar, the Phase Details area gets <160px — unusable. **Fix:** Use `clamp(140px, 30%, 220px)` or make the sidebar collapsible with a toggle chevron (standard VS Code pattern, e.g., the Outline view).
- **No keyboard navigation.** Phase nav items are `<div>` with click handlers but no `tabindex`, `role="listbox"`, or arrow-key roving. This is a WCAG 2.1 Level A failure for keyboard users. Add `role="listbox"` on the container, `role="option"` + `tabindex="-1"` on items, and handle ArrowUp/ArrowDown.
- **Scroll persistence.** `overflow-y: auto` is correct, but after `renderPhaseNavigator` rebuilds the list (called on every `STATE_SNAPSHOT`), scroll position resets. For runbooks with 20+ phases, this is jarring. Preserve `scrollTop` before rebuild and restore it.

### Zone 4: Execution Controls (Action Bar)

**Strengths:**
- Button state reactivity via `updateControlState(s)` correctly maps all 9 FSM states to enable/disable flags.
- `is-loading` pseudo-spinner is a good micro-interaction for latency feedback.

**Issues:**
- **Sticky positioning conflict.** The controls bar uses `position: sticky; top: 0; z-index: 9`, but the Header is `position: sticky; top: 0; z-index: 10`. Both stick to `top: 0` — the controls bar will be hidden behind the header. **Fix:** Set `top: <header-height>` on the controls bar, or nest it inside `.main-center` where its sticky context is below the header.
- **Missing "Pause" semantics.** `CMD_PAUSE` exists but the FSM has no `PAUSED` state. The Engine transitions on `ABORT` to `IDLE`, not a paused state. Either introduce a `PAUSED` state in the FSM or clarify that "Pause" means "stop after current phase" (a flag, not a state). The current UX implies pause-resume, which the FSM cannot deliver.
- **Per-phase controls placement.** Pause/Stop/Restart buttons for individual phases are in the Phase Details panel (Zone 5), which is correct — but their `dataset.phaseId` is set in `selectPhase()` via `renderers.js`, yet the click handlers in `controls.js` read `dataset.phaseId` at click time. This is fine, but if the user switches phases while a background action is in-flight, the stale `phaseId` on the button won't match the now-selected phase. Use a closure or event delegation instead.

### Zone 5: Phase Details (Main Content)

**Strengths:**
- Replaces the horizontal card scroll (200px fixed-width cards) with a full-width detail view — dramatically better for reading prompts and file lists.
- Clean section-based layout: Prompt → Context Files → Success Criteria.

**Issues:**
- **No editing capability.** The PRD references `CMD_EDIT_PHASE` with `{ phaseId, patch }`, but the Phase Details panel renders read-only text. There is no inline edit mode. This is a significant gap: users must edit `.task-runbook.json` manually. Add inline editing with a pencil icon toggle, at minimum for `prompt` and `context_files`.
- **Empty-state when no phase selected.** On initial load with no runbook, both Phase Navigator and Phase Details are empty — but only Phase Cards (`phases-container`) shows the "No runbook loaded" empty state. Phase Details shows nothing. Add an empty-detail placeholder: "Select a phase to view details."
- **`success_criteria` display is opaque.** Showing `exit_code:0` as a raw string is unhelpful. Map known evaluator types to human labels: "✓ Pass if exit code = 0" or "🔍 Regex: /pattern/".

### Zone 6: Worker Output (Bottom Panel)

**Strengths:**
- Resizable via `terminal-resizer` with mouse drag — correct UX for a terminal pane.
- Auto-scroll logic (only if user is near bottom) prevents the "scroll hijack" problem.
- `MAX_LOG_NODES = 5000` prevents DOM bloat.

**Issues:**
- **No per-phase output separation.** `appendOutput()` writes to a single global `#output` element. When the user switches phases in Zone 3, they still see the output from all phases. This breaks the mental model of the navigator/detail pattern. **Fix:** Buffer output per `phaseId`, and filter the terminal view to the selected phase (or add tabs: "Current Phase" / "All Output").
- **Log level detection is fragile.** Only `stream === 'stderr'` gets the `.stderr` class. The CSS defines `.warn` and `.info` classes but they're never applied — the `LOG_ENTRY` handler in `main.js` maps `error` to `stderr` stream and everything else to `stdout`, losing the level granularity. Apply CSS classes based on `msg.payload.level`, not stream.
- **No syntax highlighting.** The critique spec requests "syntax highlighting class markers." The current implementation is plain `textContent` insertion. For V1, add ANSI color code parsing; for V2, use a lightweight terminal emulator library.

---

## 3. Cross-Cutting Concerns

### Viewport Constraints

VS Code Webview panels have no minimum width guarantee. In side-panel mode, the viewport can be as narrow as 200px. The 3-column layout (Navigator 220px + Details + Terminal) will collapse badly. **Recommendation:** Implement a responsive breakpoint at ~500px: below it, collapse the Phase Navigator into a dropdown/select element, and stack the Phase Details above the Terminal.

### Theme Compliance

The CSS design tokens are exemplary. Every surface, text, and accent color derives from `--vscode-*` variables. The `color-mix()` usage for backgrounds is modern but has one risk: VS Code's Webview runs Chromium, but the exact version depends on the VS Code version. `color-mix(in srgb, ...)` requires Chrome 111+. VS Code 1.87+ ships Electron 28 (Chromium 120), so this is safe for current releases but will break on VS Code ≤1.86. Add a fallback:

```css
--accent-bg: rgba(0, 127, 212, 0.12); /* fallback */
--accent-bg: color-mix(in srgb, var(--accent) 12%, transparent);
```

### Accessibility

- ❌ No `aria-live` regions for dynamic content updates (phase transitions, terminal output).
- ❌ Phase Navigator items lack `role` and `tabindex` attributes.
- ❌ Terminal output lacks `role="log"` and `aria-label`.
- ✅ `:focus-visible` outlines are correctly implemented.
- ✅ Button disabled states use `opacity: 0.35` + `pointer-events: none`.

**Priority fix:** Add `aria-live="polite"` to the state badge and terminal output container.

### FSM State Coverage

The UI must handle all 9 states. Current gaps:
- `PARSING` (transient): No visual indicator. Add a spinner or badge-pulse on the state badge.
- `EVALUATING` (transient): Mapped to "running" badge, which is correct but indistinguishable from `EXECUTING_WORKER`. Consider a distinct badge label for evaluating.

### Information Density vs. Cognitive Load

The 6-zone layout's information density is appropriate for the "monitoring" use case (watching execution). However, during the "planning" phase (IDLE → PLANNING → PLAN_REVIEW), Zones 2-5 are empty or hidden, leaving a large void. The Planning Panel currently overlays the content column — this is correct. Ensure the planning panel does not fight with the Phase Navigator for horizontal space; during planning, hide the navigator entirely.

---

## 4. Prioritized Recommendations

| # | Priority | Recommendation |
|---|----------|---------------|
| 1 | **P0** | Add keyboard navigation to Phase Navigator (WCAG Level A) |
| 2 | **P0** | Fix sticky positioning conflict between Header and Controls bar |
| 3 | **P0** | Add responsive collapse for narrow viewports (<500px) |
| 4 | **P1** | Separate terminal output per phase (filter by selected phase) |
| 5 | **P1** | Add `aria-live` regions for dynamic updates |
| 6 | **P1** | Clarify Pause semantics (flag vs. state) |
| 7 | **P2** | Wire user prompt into Mission Overview (replace UUID) |
| 8 | **P2** | Add inline editing for phase prompt and context files |
| 9 | **P2** | Use `clamp()` for Phase Navigator width |
| 10 | **P3** | Add ANSI color parsing for terminal output |
| 11 | **P3** | Add `color-mix()` CSS fallbacks for older Electron versions |

---

## 5. Conclusion

The 6-zone dashboard is architecturally sound and correctly leverages VS Code's native CSS variables and layout conventions. The master-detail pattern for phases is the single biggest UX win. The critical gaps — keyboard accessibility, responsive collapse, sticky positioning conflict, and per-phase output isolation — are all addressable without rearchitecting the zone model. Ship the layout with P0 fixes applied; P1 issues can follow in a fast-follow iteration.
