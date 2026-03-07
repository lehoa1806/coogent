<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- App.svelte — Root layout composing all Coogent Mission Control panels  -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
  import { appState, patchState } from "./stores/vscode.svelte.js";
  import { initMarkdown } from "./lib/markdown.js";
  import { initMermaid, refreshMermaidTheme } from "./lib/mermaid.js";

  import GlobalHeader from "./components/GlobalHeader.svelte";

  import ExecutionControls from "./components/ExecutionControls.svelte";
  import PlanReview from "./components/PlanReview.svelte";
  import PhaseNavigator from "./components/PhaseNavigator.svelte";
  import PhaseDetails from "./components/PhaseDetails.svelte";
  import WorkerTerminal from "./components/WorkerTerminal.svelte";
  import ChatInput from "./components/ChatInput.svelte";
  import WorkerStudio from "./components/WorkerStudio.svelte";

  import ReportModal from "./components/ReportModal.svelte";

  let showTerminal = $state(false);
  /** Controls the View-All plan modal triggered from ExecutionControls */
  let showPlanModal = $state(false);
  /** Active view tab: 'phases' (default) or 'workers' */
  let activeView: "phases" | "workers" = $state("phases");

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

  let isPlanning = $derived(appState.engineState === "PLANNING");
  let showTabs = $derived(
    !isPlanning && appState.engineState !== "PLAN_REVIEW",
  );

  /**
   * BUG FIX: Auto-select the currently running (or first pending) phase
   * whenever phases update and the user hasn't manually selected one.
   * Without this, PhaseDetails shows "Select a phase" even while a phase
   * is actively executing.
   */
  $effect(() => {
    // Respect explicit user selection
    if (appState.userSelectedPhaseId !== null) return;
    const phases = appState.phases;
    if (phases.length === 0) return;
    const running = phases.find((p) => p.status === "running");
    const pending = phases.find((p) => p.status === "pending");
    const target = running ?? pending ?? phases[0];
    if (target && appState.selectedPhaseId !== target.id) {
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
        {#if appState.lastPrompt}
          <div class="planning-prompt">
            <span class="prompt-label">Your prompt</span>
            <p class="prompt-text">{appState.lastPrompt}</p>
          </div>
        {/if}
      </div>
    {:else if appState.engineState !== "PLAN_REVIEW"}
      <!-- Tab bar for Phases / Workers view toggle -->
      {#if showTabs}
        <div class="view-tabs" role="tablist">
          <button
            class="view-tab"
            class:active={activeView === "phases"}
            role="tab"
            aria-selected={activeView === "phases"}
            onclick={() => (activeView = "phases")}
          >
            Phases
          </button>
          <button
            class="view-tab"
            class:active={activeView === "workers"}
            role="tab"
            aria-selected={activeView === "workers"}
            onclick={() => (activeView = "workers")}
          >
            Workers
          </button>
        </div>
      {/if}

      {#if activeView === "phases"}
        <div class="app-body">
          <PhaseNavigator />
          <PhaseDetails />
        </div>
      {:else}
        <WorkerStudio />
      {/if}
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

  /* ── View Tab Bar ─────────────────────────────────────────────────── */
  .view-tabs {
    display: flex;
    gap: 0;
    padding: 0 16px;
    border-bottom: 1px solid
      var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    background: var(
      --vscode-sideBar-background,
      var(--vscode-editor-background)
    );
    flex-shrink: 0;
  }

  .view-tab {
    padding: 6px 16px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .view-tab:hover {
    color: var(--vscode-foreground);
  }

  .view-tab.active {
    color: var(--vscode-focusBorder, #007fd4);
    border-bottom-color: var(--vscode-focusBorder, #007fd4);
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
