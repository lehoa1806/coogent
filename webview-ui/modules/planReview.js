// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/planReview.js — Plan draft carousel rendering
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { setAppState, getAppState } from './store.js';
import { escapeHtml } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Plan Draft (Carousel)
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {HTMLElement[]} */
let planSlideCards = [];

/**
 * Render the plan draft for user review as a carousel (one phase at a time).
 * Uses #plan-carousel container from the HTML template.
 * @param {any} draft
 * @param {string[]} fileTree
 */
export function renderPlanDraft(draft, fileTree) {
    const $planCarousel = document.getElementById('plan-carousel');
    if (!$planCarousel) return;
    $planCarousel.innerHTML = '';
    planSlideCards = [];
    setAppState({ planSlideIndex: 0 });

    if (!draft?.phases) return;

    // Project ID header
    const header = document.createElement('div');
    header.className = 'plan-project-id';
    header.textContent = `Project: ${draft.project_id || 'untitled'} · ${draft.phases.length} phases`;
    $planCarousel.appendChild(header);

    // Render each phase as a review card
    draft.phases.forEach((/** @type {any} */ p) => {
        const card = document.createElement('div');
        card.className = 'plan-review-card carousel-hidden';
        card.innerHTML = `
            <div class="plan-card-header">
                <span class="phase-id">#${p.id}</span>
                <span class="plan-card-files">${(p.context_files || []).length} context files</span>
            </div>
            <div class="plan-card-prompt">${escapeHtml(p.prompt)}</div>
            ${(p.context_files || []).length > 0 ? `
            <div class="plan-card-context">
                ${p.context_files.map((/** @type {string} */ f) => `<code>${escapeHtml(f)}</code>`).join(' ')}
            </div>` : ''}
            <div class="plan-card-criteria">
                <span>Success: <code>${escapeHtml(p.success_criteria || 'exit_code:0')}</code></span>
            </div>
        `;
        $planCarousel.appendChild(card);
        planSlideCards.push(card);
    });

    // Show first slide
    if (planSlideCards.length > 0) {
        showPlanSlide(0);
    }
}

/**
 * Show a specific slide in the plan carousel.
 * @param {number} index
 */
export function showPlanSlide(index) {
    if (index < 0 || index >= planSlideCards.length) return;
    setAppState({ planSlideIndex: index });

    // Toggle visibility
    planSlideCards.forEach((card, i) => {
        card.classList.toggle('carousel-hidden', i !== index);
    });

    // Update label
    const $planCarouselLabel = document.getElementById('plan-carousel-label');
    if ($planCarouselLabel) {
        $planCarouselLabel.textContent = `Phase ${index + 1} / ${planSlideCards.length}`;
    }

    // Enable/disable nav buttons
    const $planCarouselPrev = document.getElementById('plan-carousel-prev');
    const $planCarouselNext = document.getElementById('plan-carousel-next');
    if ($planCarouselPrev) /** @type {HTMLButtonElement} */ ($planCarouselPrev).disabled = index === 0;
    if ($planCarouselNext) /** @type {HTMLButtonElement} */ ($planCarouselNext).disabled = index === planSlideCards.length - 1;
}

/**
 * Get the current plan slide count (for keyboard nav guard).
 * @returns {number}
 */
export function getPlanSlideCount() {
    return planSlideCards.length;
}

/**
 * Update the planning spinner status.
 * Uses #plan-status from the HTML template.
 * @param {'generating' | 'parsing' | 'ready' | 'error'} status
 * @param {string} [message]
 */
export function renderPlanStatus(status, message) {
    const $planStatus = document.getElementById('plan-status');
    const $planPromptSection = document.getElementById('plan-prompt-section');

    if ($planStatus && message) {
        $planStatus.textContent = message;
    }

    if (status === 'error') {
        if ($planStatus) $planStatus.style.display = 'none';
        if ($planPromptSection) $planPromptSection.style.display = 'block';
    }
}
