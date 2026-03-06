<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- App.svelte — Root layout composing all Coogent Mission Control panels  -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
  import { appState, patchState } from "./stores/vscode.js";
  import { initMarkdown } from "./lib/markdown.js";
  import { initMermaid, refreshMermaidTheme } from "./lib/mermaid.js";

  import GlobalHeader from "./components/GlobalHeader.svelte";

  import ExecutionControls from "./components/ExecutionControls.svelte";
  import PlanReview from "./components/PlanReview.svelte";
  import PhaseNavigator from "./components/PhaseNavigator.svelte";
  import PhaseDetails from "./components/PhaseDetails.svelte";
  import WorkerTerminal from "./components/WorkerTerminal.svelte";
  import ChatInput from "./components/ChatInput.svelte";

  import ReportModal from "./components/ReportModal.svelte";

  let showTerminal = $state(false);
  /** Controls the View-All plan modal triggered from ExecutionControls */
  let showPlanModal = $state(false);

  function handleToggleTerminal() {
    showTerminal = !showTerminal;
  }

  function handleCloseTerminal() {
    showTerminal = false;
  }

  function handleViewPlan() {
    showPlanModal = true;
  }

  function handleClosePlanModal() {
    showPlanModal = false;
  }

  let isPlanning = $derived($appState.engineState === "PLANNING");

  /**
   * BUG FIX: Auto-select the currently running (or first pending) phase
   * whenever phases update and the user hasn't manually selected one.
   * Without this, PhaseDetails shows "Select a phase" even while a phase
   * is actively executing.
   */
  $effect(() => {
    // Respect explicit user selection
    if ($appState.userSelectedPhaseId !== null) return;
    const phases = $appState.phases;
    if (phases.length === 0) return;
    const running = phases.find((p) => p.status === "running");
    const pending = phases.find((p) => p.status === "pending");
    const target = running ?? pending ?? phases[0];
    if (target && $appState.selectedPhaseId !== target.id) {
      patchState({ selectedPhaseId: target.id });
    }
  });

  // Initialize markdown + mermaid on mount, watch for theme changes
  $effect(() => {
    // Sync init
    initMarkdown();

    // Async init (mermaid)
    initMermaid();

    // Watch for VS Code theme changes (class/style mutations on <html>)
    const themeObserver = new MutationObserver(() => {
      refreshMermaidTheme();
    });

    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    return () => {
      themeObserver.disconnect();
    };
  });
</script>

<main class="app-shell">
  <GlobalHeader ontoggleterminal={handleToggleTerminal} />

  <ExecutionControls onviewplan={handleViewPlan} />

  <!-- PlanReview fills available space so ChatInput stays at the very bottom -->
  <div class="main-content">
    <PlanReview {showPlanModal} onclosePlanModal={handleClosePlanModal} />

    {#if isPlanning}
      <!-- Planning state: show user's prompt with spinner -->
      <div class="planning-view">
        <div class="planning-spinner"></div>
        <p class="planning-label">Planning…</p>
        {#if $appState.lastPrompt}
          <div class="planning-prompt">
            <span class="prompt-label">Your prompt</span>
            <p class="prompt-text">{$appState.lastPrompt}</p>
          </div>
        {/if}
      </div>
    {:else if $appState.engineState !== "PLAN_REVIEW"}
      <div class="app-body">
        <PhaseNavigator />
        <PhaseDetails />
      </div>
    {/if}
  </div>

  <ChatInput />

  <WorkerTerminal visible={showTerminal} onClose={handleCloseTerminal} />
  <ReportModal />
</main>

<style>
  .app-shell {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .main-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .app-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* ── Planning View ───────────────────────────────────────────────────── */

  .planning-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    min-height: 0;
    padding: 32px 24px;
    text-align: center;
    overflow-y: auto;
  }

  .planning-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(128, 128, 128, 0.2);
    border-top-color: var(--vscode-charts-purple, #a78bfa);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .planning-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-charts-purple, #a78bfa);
    margin: 0;
    animation: pulse 2s ease-in-out infinite;
  }

  .planning-prompt {
    margin-top: 16px;
    width: 100%;
    background: var(
      --vscode-editorWidget-background,
      var(--vscode-sideBar-background)
    );
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    padding: 16px;
    text-align: left;
  }

  .prompt-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--vscode-descriptionForeground);
    font-weight: 700;
    margin-bottom: 6px;
    display: block;
  }

  .prompt-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-foreground);
    white-space: pre-wrap;
    word-wrap: break-word;
    margin: 0;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.6;
    }
  }
</style>
