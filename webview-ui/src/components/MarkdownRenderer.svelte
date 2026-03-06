<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- MarkdownRenderer.svelte — Renders Markdown + Mermaid diagrams          -->
<!--                                                                        -->
<!-- Accepts a `content` string prop, renders it as HTML via `marked`, and  -->
<!-- triggers Mermaid diagram rendering on mount and after each update.      -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { renderMarkdown } from "../lib/markdown.js";
    import { renderMermaidBlocks } from "../lib/mermaid.js";

    /** Props */
    let { content = "" }: { content?: string } = $props();

    /** Bound reference to the container element. */
    let container: HTMLDivElement | undefined = $state(undefined);

    /** Derived HTML from markdown content. */
    let html = $derived(renderMarkdown(content));

    /** Render mermaid blocks after mount and whenever content changes. */
    $effect(() => {
        // Track `html` so the effect re-runs when content changes
        html;
        if (container) {
            renderMermaidBlocks(container);
        }
    });
</script>

<div class="markdown-body" bind:this={container}>
    {@html html}
</div>

<style>
    .markdown-body {
        font-size: 13px;
        line-height: 1.6;
        color: var(--vscode-editor-foreground, var(--vscode-foreground));
        word-wrap: break-word;
    }

    /* ── Headings ── */
    .markdown-body :global(h1),
    .markdown-body :global(h2),
    .markdown-body :global(h3),
    .markdown-body :global(h4) {
        margin: 12px 0 6px;
        font-weight: 600;
        color: var(--vscode-foreground);
    }

    .markdown-body :global(h1) {
        font-size: 1.4em;
    }
    .markdown-body :global(h2) {
        font-size: 1.2em;
    }
    .markdown-body :global(h3) {
        font-size: 1.05em;
    }
    .markdown-body :global(h4) {
        font-size: 1em;
    }

    /* ── Paragraphs & lists ── */
    .markdown-body :global(p) {
        margin: 6px 0;
    }

    .markdown-body :global(ul),
    .markdown-body :global(ol) {
        padding-left: 20px;
        margin: 4px 0;
    }

    /* ── Links ── */
    .markdown-body :global(a) {
        color: var(--vscode-textLink-foreground, #3794ff);
        text-decoration: none;
    }

    .markdown-body :global(a:hover) {
        text-decoration: underline;
    }

    /* ── Inline code ── */
    .markdown-body :global(code) {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.9em;
        padding: 1px 4px;
        background: var(
            --vscode-textCodeBlock-background,
            rgba(128, 128, 128, 0.15)
        );
        border-radius: 3px;
    }

    /* ── Code blocks ── */
    .markdown-body :global(pre) {
        background: var(
            --vscode-textCodeBlock-background,
            var(--vscode-editorWidget-background)
        );
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-radius: 4px;
        padding: 10px 12px;
        overflow-x: auto;
        margin: 8px 0;
    }

    .markdown-body :global(pre code) {
        padding: 0;
        background: none;
        border-radius: 0;
        font-size: var(--vscode-editor-font-size, 12px);
        line-height: 1.5;
    }

    /* ── Blockquotes ── */
    .markdown-body :global(blockquote) {
        margin: 8px 0;
        padding: 4px 12px;
        border-left: 3px solid var(--vscode-focusBorder, #007fd4);
        color: var(--vscode-descriptionForeground);
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 5%,
            transparent
        );
    }

    /* ── Tables ── */
    .markdown-body :global(table) {
        border-collapse: collapse;
        width: 100%;
        margin: 8px 0;
    }

    .markdown-body :global(th),
    .markdown-body :global(td) {
        padding: 4px 8px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        font-size: 12px;
    }

    .markdown-body :global(th) {
        background: var(--vscode-editorWidget-background);
        font-weight: 600;
    }

    /* ── Horizontal rules ── */
    .markdown-body :global(hr) {
        border: none;
        border-top: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        margin: 12px 0;
    }

    /* ── Mermaid containers ── */
    .markdown-body :global(.mermaid-container) {
        margin: 12px 0;
        padding: 12px;
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-radius: 4px;
        overflow-x: auto;
    }

    .markdown-body :global(.mermaid-error) {
        color: var(--vscode-errorForeground, #f85149);
        font-size: 11px;
    }

    .markdown-body :global(.mermaid-error-notice) {
        font-size: 10px;
        color: var(--vscode-editorWarning-foreground, #cca700);
        margin-top: 4px;
    }
</style>
