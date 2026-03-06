<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- App.svelte — Root layout composing all Coogent Mission Control panels  -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
  import { appState } from "./stores/vscode.js";
  import { initMarkdown } from "./lib/markdown.js";
  import { initMermaid, refreshMermaidTheme } from "./lib/mermaid.js";

  import GlobalHeader from "./components/GlobalHeader.svelte";
  import ConversationModeBar from "./components/ConversationModeBar.svelte";
  import ExecutionControls from "./components/ExecutionControls.svelte";
  import PlanReview from "./components/PlanReview.svelte";
  import PhaseNavigator from "./components/PhaseNavigator.svelte";
  import PhaseDetails from "./components/PhaseDetails.svelte";
  import WorkerTerminal from "./components/WorkerTerminal.svelte";
  import ChatInput from "./components/ChatInput.svelte";
  import SessionHistory from "./components/SessionHistory.svelte";
  import ReportModal from "./components/ReportModal.svelte";

  let showHistory = $state(false);

  function handleToggleHistory() {
    showHistory = !showHistory;
  }

  function handleCloseHistory() {
    showHistory = false;
  }

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
  <GlobalHeader ontogglehistory={handleToggleHistory} />
  <ConversationModeBar />
  <ExecutionControls />
  <PlanReview />

  <div class="app-body">
    <PhaseNavigator />
    <PhaseDetails />
  </div>

  <WorkerTerminal />
  <ChatInput />

  <SessionHistory visible={showHistory} onClose={handleCloseHistory} />
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

  .app-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
