/**
 * BotShield - content.js
 * 
 * Runs on https://www.youtube.com/* and https://www.reddit.com/* at document_idle.
 * 
 * Architecture:
 * - Thin client: NEVER calls fetch directly.
 * - Platform Adapters: Modular selector definitions per platform. Adding a platform
 *   requires creating one adapter object without modifying scanner or badge logic.
 * - Privacy Rule: Transmits ONLY handle, comment texts (unaltered), relative monotonic
 *   timestamps, profile hints, and context language.
 * - Verdict Rendering: Inline badges, explainability tooltips, interactive feedback popovers.
 * - MutationObserver with 800ms debounce, SPA navigation listener.
 */

(() => {
  // Page load anchor for monotonic relative timestamp calculation
  const PAGE_LOAD_TIME = Date.now();
  let warnedHandlesOnPage = new Set();
  let assessedVerdicts = new Map(); // normalizedHandle -> verdict
  let dismissedReplyBoxes = new WeakSet();
  let activePopover = null;
  let settings = {
    hideBots: false,
    enableOnReddit: true,
    replyGuardian: true,
    scanInterval: 5
  };

  /**
   * Normalize handle for consistent internal lookup (lowercase, strip '@')
   */
  function normalizeHandle(handle) {
    if (!handle || typeof handle !== 'string') return '';
    return handle.trim().toLowerCase().replace(/^@+/, '');
  }

  // ---------------------------------------------------------------------------
  // PLATFORM ADAPTERS
  // ---------------------------------------------------------------------------

  const adapters = [
    /**
     * YouTube Adapter
     */
    {
      name: 'youtube',
      match: (url) => url.hostname.includes('youtube.com'),

      getCommentContainers: (root = document) => {
        return root.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-view-model, #comment');
      },

      getAuthorElement: (container) => {
        return container.querySelector('yt-formatted-string#author-text, #author-text, a#author-text');
      },

      extractHandle: function (container) {
        const authorEl = this.getAuthorElement(container);
        if (!authorEl) return null;
        const text = authorEl.textContent?.trim() || '';
        if (text) return text;
        const href = authorEl.closest('a')?.getAttribute('href') || '';
        if (href.startsWith('/@')) {
          return href.substring(2);
        }
        return null;
      },

      extractCommentText: (container) => {
        const textEl = container.querySelector('yt-formatted-string#content-text, #content-text');
        // Do NOT normalize or strip characters; preserves Bosnian/Croatian/Serbian diacritics & Cyrillic
        return textEl ? textEl.textContent?.trim() || '' : '';
      },

      extractTimestamp: (container) => {
        const timeEl = container.querySelector('yt-formatted-string.published-time-text a, #published-time-text a, span.published-time-text');
        const rawTimeStr = timeEl ? timeEl.textContent?.trim() : '';
        return parseRelativeTimeToIso(rawTimeStr);
      },

      extractProfileHints: (container) => {
        const avatarImg = container.querySelector('#author-thumbnail img, img#img');
        const src = avatarImg ? (avatarImg.getAttribute('src') || '') : '';
        const isDefaultAvatar = src.includes('default_avatar') || src.includes('default-user') || !src;
        const authorEl = container.querySelector('yt-formatted-string#author-text, #author-text');
        const displayName = authorEl ? authorEl.textContent?.trim() : '';

        return {
          default_avatar: isDefaultAvatar,
          display_name: displayName,
          follower_count: null
        };
      },

      getContextLang: () => {
        // Detect language from html[lang], video description, or channel context
        const htmlLang = (document.documentElement.lang || '').toLowerCase();
        if (htmlLang.startsWith('bs') || htmlLang.startsWith('hr') || htmlLang.startsWith('sr') || htmlLang.startsWith('sh')) {
          return 'bs';
        }

        // Look for common Balkan / BCS context markers in page title / meta keywords
        const pageText = (document.title || '').toLowerCase();
        const bcsKeywords = ['bih', 'bosn', 'srpsk', 'hrvat', 'sarajevo', 'zagreb', 'beograd', 'balkan'];
        if (bcsKeywords.some(kw => pageText.includes(kw))) {
          return 'bs';
        }

        return 'en';
      },

      getHeaderAnchor: () => {
        return document.querySelector('#comments #header, ytd-comments-header-renderer, #comments');
      },

      getReplyContext: (inputEl) => {
        const replyDialog = inputEl.closest('#reply-dialog, ytd-comment-reply-dialog-renderer, ytd-commentbox');
        const thread = inputEl.closest('ytd-comment-thread-renderer, ytd-comment-view-model');
        if (!thread) return null;

        // Skip root video/channel comment box (not a reply to a comment)
        if (inputEl.closest('ytd-comments-header-renderer, #simplebox-container:not(#reply-dialog *)')) {
          return null;
        }

        const authorEl = thread.querySelector('yt-formatted-string#author-text, #author-text, a#author-text');
        const authorHandle = authorEl ? (authorEl.textContent?.trim() || '') : null;
        if (!authorHandle) return null;

        const anchor = replyDialog
          ? (replyDialog.querySelector('#simplebox-placeholder, #placeholder-area, #input-container') || replyDialog.firstElementChild || replyDialog)
          : inputEl;

        return {
          container: replyDialog || thread,
          targetComment: thread,
          anchor: anchor,
          authorHandle: authorHandle
        };
      }
    },

    /**
     * Reddit Adapter
     */
    {
      name: 'reddit',
      match: (url) => url.hostname.includes('reddit.com'),

      getCommentContainers: (root = document) => {
        return root.querySelectorAll('[data-testid="comment"], shreddit-comment, div.comment');
      },

      getAuthorElement: (container) => {
        return container.querySelector('a[data-testid="comment_author_link"], a[href*="/user/"], [slot="authorName"]');
      },

      extractHandle: function (container) {
        const authorEl = this.getAuthorElement(container);
        if (!authorEl) return null;
        const text = authorEl.textContent?.trim() || '';
        if (text) return text.replace(/^u\//, '');
        const href = authorEl.getAttribute('href') || '';
        const match = href.match(/\/user\/([^\/\?]+)/);
        return match ? match[1] : null;
      },

      extractCommentText: (container) => {
        const textEls = container.querySelectorAll('[data-testid="comment"] p, [slot="comment"] p, div.md p');
        if (!textEls || textEls.length === 0) {
          const direct = container.querySelector('[slot="comment"], div.md');
          return direct ? direct.textContent?.trim() || '' : '';
        }
        return Array.from(textEls).map(p => p.textContent?.trim()).filter(Boolean).join('\n');
      },

      extractTimestamp: (container) => {
        const timeEl = container.querySelector('time, [data-testid="comment_timestamp"]');
        if (timeEl) {
          const datetime = timeEl.getAttribute('datetime');
          if (datetime) {
            const parsed = new Date(datetime);
            if (!isNaN(parsed.getTime())) {
              return parsed.toISOString();
            }
          }
          return parseRelativeTimeToIso(timeEl.textContent?.trim());
        }
        return parseRelativeTimeToIso('');
      },

      extractProfileHints: (container) => {
        const avatarImg = container.querySelector('img[alt*="avatar"], faceplate-img, [data-testid="comment_author_icon"]');
        const src = avatarImg ? (avatarImg.getAttribute('src') || '') : '';
        const isDefaultAvatar = src.includes('default') || src.includes('snoo_default') || !src;
        const authorEl = container.querySelector('a[data-testid="comment_author_link"], [slot="authorName"]');
        const displayName = authorEl ? authorEl.textContent?.trim() : '';

        return {
          default_avatar: isDefaultAvatar,
          display_name: displayName,
          follower_count: null
        };
      },

      getContextLang: () => {
        const htmlLang = (document.documentElement.lang || '').toLowerCase();
        if (htmlLang.startsWith('bs') || htmlLang.startsWith('hr') || htmlLang.startsWith('sr')) {
          return 'bs';
        }
        return 'en';
      },

      getHeaderAnchor: () => {
        return document.querySelector('#comment-tree, shreddit-post, div.commentarea');
      },

      getReplyContext: (inputEl) => {
        const composer = inputEl.closest('shreddit-composer, faceplate-form, div.Comment__reply, [slot="comment-composer"]');
        const targetComment = inputEl.closest('[data-testid="comment"], shreddit-comment, div.comment');
        if (!targetComment) return null;

        const authorEl = targetComment.querySelector('a[data-testid="comment_author_link"], a[href*="/user/"], [slot="authorName"]');
        const authorHandle = authorEl ? (authorEl.textContent?.trim()?.replace(/^u\//, '') || '') : null;
        if (!authorHandle) return null;

        const anchor = composer ? (composer.querySelector('div[contenteditable="true"], textarea') || composer) : inputEl;

        return {
          container: composer || targetComment,
          targetComment: targetComment,
          anchor: anchor,
          authorHandle: authorHandle
        };
      }
    }
  ];

  /**
   * Finds matching platform adapter for current URL
   */
  function getCurrentAdapter() {
    const currentUrl = new URL(window.location.href);
    return adapters.find(a => a.match(currentUrl)) || null;
  }

  /**
   * Monotonic relative timestamp parser
   */
  let lastMonotonicTime = PAGE_LOAD_TIME;
  function parseRelativeTimeToIso(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') {
      lastMonotonicTime = Math.max(PAGE_LOAD_TIME, lastMonotonicTime + 1000);
      return new Date(lastMonotonicTime).toISOString();
    }

    const str = timeStr.toLowerCase().trim();
    let offsetMs = 0;

    const match = str.match(/(\d+)\s*(second|sec|minute|min|hour|hr|day|week|month|year)/);
    if (match) {
      const num = parseInt(match[1], 10);
      const unit = match[2];
      if (unit.startsWith('sec')) offsetMs = num * 1000;
      else if (unit.startsWith('min')) offsetMs = num * 60 * 1000;
      else if (unit.startsWith('hour') || unit.startsWith('hr')) offsetMs = num * 3600 * 1000;
      else if (unit.startsWith('day')) offsetMs = num * 86400 * 1000;
      else if (unit.startsWith('week')) offsetMs = num * 7 * 86400 * 1000;
      else if (unit.startsWith('month')) offsetMs = num * 30 * 86400 * 1000;
      else if (unit.startsWith('year')) offsetMs = num * 365 * 86400 * 1000;
    }

    const computed = Math.min(PAGE_LOAD_TIME - offsetMs, PAGE_LOAD_TIME);
    return new Date(computed).toISOString();
  }

  // ---------------------------------------------------------------------------
  // API UNREACHABLE NOTICE
  // ---------------------------------------------------------------------------

  function renderApiUnreachableBanner(adapter) {
    if (document.getElementById('botshield-api-status-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'botshield-api-status-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = 'BotShield: API unreachable';

    const header = adapter.getHeaderAnchor();
    if (header && header.parentNode) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    } else {
      document.body.prepend(banner);
    }
  }

  function removeApiUnreachableBanner() {
    const banner = document.getElementById('botshield-api-status-banner');
    if (banner) {
      banner.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // VERDICT BADGE & PANEL RENDERING
  // ---------------------------------------------------------------------------

  const VERDICT_CONFIG = {
    HUMAN_LIKELY: {
      text: '✓ Human-likely',
      badgeClass: 'botshield-badge-human',
      color: '#16a34a'
    },
    LOW: {
      text: '✓ Human-likely',
      badgeClass: 'botshield-badge-human',
      color: '#16a34a'
    },
    MEDIUM: {
      text: '⚠ Caution — bot-like signals',
      badgeClass: 'botshield-badge-caution',
      color: '#f59e0b'
    },
    HIGH: {
      text: '🤖 Very likely automated — avoid engaging',
      badgeClass: 'botshield-badge-high',
      color: '#ea580c'
    },
    BOT: {
      text: '🤖 Bot — do not engage, report',
      badgeClass: 'botshield-badge-bot',
      color: '#dc2626'
    }
  };

  /**
   * Closes any currently displayed feedback popover panel
   */
  function closeActivePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  /**
   * Opens details & feedback popover panel when a badge is clicked
   */
  function openVerdictPopover(badgeEl, verdict) {
    closeActivePopover();

    const popover = document.createElement('div');
    popover.className = 'botshield-popover';

    const conf = VERDICT_CONFIG[verdict.label] || VERDICT_CONFIG.HUMAN_LIKELY;
    const signalsListHtml = (verdict.signals && verdict.signals.length > 0)
      ? verdict.signals.map(s => `<li>${escapeHtml(s)}</li>`).join('')
      : '<li>No suspicious automation patterns observed.</li>';

    popover.innerHTML = `
      <div class="botshield-popover-header">
        <div class="botshield-popover-title" style="color: ${conf.color};">
          ${escapeHtml(conf.text)}
        </div>
        <button class="botshield-popover-close" title="Close" aria-label="Close">✕</button>
      </div>
      <div class="botshield-popover-score">
        Risk Assessment Score: <strong>${Math.round((verdict.score || 0) * 100)}%</strong>
      </div>
      <div class="botshield-popover-advisory">
        ${escapeHtml(verdict.advisory || 'Account behavior appears consistent with typical human patterns.')}
      </div>
      <div style="font-weight: 600; margin-top: 8px; font-size: 11px;">Observed Signals:</div>
      <ul class="botshield-popover-signals">
        ${signalsListHtml}
      </div>
      <div class="botshield-popover-feedback">
        <div class="botshield-feedback-prompt">Help refine detection — was this assessment accurate?</div>
        <div class="botshield-feedback-actions">
          <button class="botshield-btn botshield-btn-correct" data-verdict-id="${verdict.verdict_id}" data-correct="true">
            ✓ Correct
          </button>
          <button class="botshield-btn botshield-btn-wrong" data-verdict-id="${verdict.verdict_id}" data-correct="false">
            ✗ Wrong
          </button>
        </div>
      </div>
    `;

    // Close button
    popover.querySelector('.botshield-popover-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeActivePopover();
    });

    // Feedback buttons
    const feedbackActions = popover.querySelector('.botshield-feedback-actions');
    const feedbackPrompt = popover.querySelector('.botshield-feedback-prompt');

    popover.querySelectorAll('.botshield-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const isCorrect = btn.getAttribute('data-correct') === 'true';
        const verdictId = btn.getAttribute('data-verdict-id');

        try {
          chrome.runtime.sendMessage({
            type: 'SUBMIT_FEEDBACK',
            payload: { verdict_id: verdictId, is_correct: isCorrect }
          });
        } catch (err) {
          console.warn('[BotShield] Could not dispatch feedback:', err);
        }

        feedbackPrompt.textContent = 'Thank you! Your feedback improves community safety.';
        feedbackActions.innerHTML = '<span class="botshield-feedback-thanks">✓ Feedback submitted</span>';
      });
    });

    // Positioning
    document.body.appendChild(popover);
    const rect = badgeEl.getBoundingClientRect();
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

    let top = rect.bottom + scrollTop + 6;
    let left = rect.left + scrollLeft;

    // Boundary protection for small screens / edge of window
    if (left + 330 > window.innerWidth) {
      left = Math.max(10, window.innerWidth - 340 + scrollLeft);
    }

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;

    activePopover = popover;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Injects inline badge and handles optional comment collapse
   */
  function attachBadgeToComment(container, authorEl, verdict) {
    if (!container || !authorEl || !verdict) return;

    // Never duplicate badge on the same anchor
    if (container.querySelector('.botshield-badge') || authorEl.nextElementSibling?.classList.contains('botshield-badge')) {
      return;
    }

    const conf = VERDICT_CONFIG[verdict.label] || VERDICT_CONFIG.HUMAN_LIKELY;
    const badge = document.createElement('span');
    badge.className = `botshield-badge ${conf.badgeClass}`;
    badge.textContent = conf.text;
    badge.setAttribute('role', 'status');

    // Explainability on hover: title lists fired signals
    const signalsSummary = (verdict.signals && verdict.signals.length > 0)
      ? `Signals: ${verdict.signals.join(' • ')}`
      : 'No suspicious automation signals observed';
    badge.title = `${signalsSummary}\n(Click for full analysis & feedback)`;

    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openVerdictPopover(badge, verdict);
    });

    // Insert inline after author element
    authorEl.parentNode.insertBefore(badge, authorEl.nextSibling);

    // Collapsing logic for HIGH / BOT if enabled in settings
    const isBotRisk = verdict.label === 'HIGH' || verdict.label === 'BOT';
    const norm = normalizeHandle(verdict.handle);
    assessedVerdicts.set(norm, verdict);

    if (isBotRisk && settings.hideBots && !container.classList.contains('botshield-comment-collapsed')) {
      // Warn ONCE per handle per page: ensure clean collapse without stacking redundant banners
      collapseComment(container);
    }

    if (isBotRisk) {
      warnedHandlesOnPage.add(norm);
    }
  }

  /**
   * Collapses comment with a subtle "Hidden by BotShield" reveal placeholder
   */
  function collapseComment(container) {
    if (container.classList.contains('botshield-comment-collapsed')) return;

    container.classList.add('botshield-comment-collapsed');

    const placeholder = document.createElement('div');
    placeholder.className = 'botshield-placeholder';
    placeholder.innerHTML = `
      <span>🤖 Comment hidden by BotShield (Likely automated account)</span>
      <button class="botshield-reveal-btn">Show Comment</button>
    `;

    placeholder.querySelector('.botshield-reveal-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      container.classList.remove('botshield-comment-collapsed');
      placeholder.remove();
    });

    container.prepend(placeholder);
  }

  // ---------------------------------------------------------------------------
  // REPLY GUARDIAN ("The Killer Feature")
  // ---------------------------------------------------------------------------

  function checkReplyGuardian(targetInput) {
    if (settings.replyGuardian === false) return;
    if (!targetInput) return;

    const adapter = getCurrentAdapter();
    if (!adapter || !adapter.getReplyContext) return;

    const context = adapter.getReplyContext(targetInput);
    if (!context || !context.container || !context.authorHandle) return;

    if (dismissedReplyBoxes.has(context.container)) return;
    if (context.container.querySelector('.botshield-reply-guardian')) return;

    const norm = normalizeHandle(context.authorHandle);
    const verdict = assessedVerdicts.get(norm);
    const hasBotBadge = context.targetComment?.querySelector('.botshield-badge-high, .botshield-badge-bot');
    const isFlagged = (verdict && (verdict.label === 'HIGH' || verdict.label === 'BOT' || (verdict.score && verdict.score >= 0.70))) || Boolean(hasBotBadge);

    if (isFlagged) {
      injectReplyGuardianNudge(context.container, context.anchor);
    }
  }

  function injectReplyGuardianNudge(container, anchor) {
    if (!container || container.querySelector('.botshield-reply-guardian')) return;

    const nudge = document.createElement('div');
    nudge.className = 'botshield-reply-guardian';
    nudge.setAttribute('role', 'alert');
    nudge.innerHTML = `
      <div class="botshield-guardian-content">
        <span class="botshield-guardian-icon">⚠️</span>
        <span class="botshield-guardian-text">You're replying to an account with strong bot signals — probably not worth engaging.</span>
      </div>
      <button class="botshield-guardian-dismiss" title="Dismiss warning" aria-label="Dismiss warning">✕</button>
    `;

    nudge.querySelector('.botshield-guardian-dismiss').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissedReplyBoxes.add(container);
      nudge.remove();
    });

    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(nudge, anchor);
    } else {
      container.prepend(nudge);
    }
  }

  // ---------------------------------------------------------------------------
  // SCANNER & SIGNAL COLLECTION
  // ---------------------------------------------------------------------------

  let scanDebounceTimer = null;
  let isScanning = false;

  async function scanPage() {
    const adapter = getCurrentAdapter();
    if (!adapter) return;

    // Respect platform setting for Reddit
    if (adapter.name === 'reddit' && settings.enableOnReddit === false) {
      return;
    }

    const containers = adapter.getCommentContainers();
    if (!containers || containers.length === 0) return;

    const contextLang = adapter.getContextLang();
    const handleGroups = new Map(); // normalizedHandle -> { handle, comments: [], profile_hints, containers: [] }

    containers.forEach(container => {
      // Skip already badged containers
      if (container.querySelector('.botshield-badge')) return;

      const authorEl = adapter.getAuthorElement(container);
      if (!authorEl) return;

      const rawHandle = adapter.extractHandle(container);
      if (!rawHandle) return;

      const normalized = normalizeHandle(rawHandle);
      if (!normalized) return;

      const text = adapter.extractCommentText(container);
      const timestampIso = adapter.extractTimestamp(container);

      if (!handleGroups.has(normalized)) {
        handleGroups.set(normalized, {
          handle: rawHandle,
          comments: [],
          profile_hints: adapter.extractProfileHints(container),
          containers: []
        });
      }

      const group = handleGroups.get(normalized);
      group.containers.push({ container, authorEl });

      // Collect up to 20 comments per handle
      if (text && group.comments.length < 20) {
        group.comments.push({
          text,
          posted_at_iso: timestampIso
        });
      }
    });

    if (handleGroups.size === 0) return;

    // Prepare batch assess items adhering strictly to privacy rule:
    // ONLY handle, comments, timestamps, profile_hints, context_lang.
    const items = [];
    for (const [norm, group] of handleGroups.entries()) {
      // Sort monotonic
      group.comments.sort((a, b) => new Date(a.posted_at_iso) - new Date(b.posted_at_iso));

      items.push({
        handle: group.handle,
        comments: group.comments,
        profile_hints: group.profile_hints,
        context_lang: contextLang
      });
    }

    try {
      chrome.runtime.sendMessage(
        { type: 'ASSESS_HANDLES', items },
        (response) => {
          if (chrome.runtime.lastError) {
            console.debug('[BotShield] Runtime message error:', chrome.runtime.lastError.message);
            return;
          }

          if (!response) return;

          if (response.isApiReachable === false) {
            renderApiUnreachableBanner(adapter);
            return; // Badges silently don't render when API is down
          } else {
            removeApiUnreachableBanner();
          }

          const verdicts = response.verdicts || {};
          for (const [norm, verdict] of Object.entries(verdicts)) {
            assessedVerdicts.set(norm, verdict);
            const group = handleGroups.get(norm);
            if (group) {
              group.containers.forEach(({ container, authorEl }) => {
                attachBadgeToComment(container, authorEl, verdict);
              });
            }
          }
        }
      );
    } catch (err) {
      console.warn('[BotShield] Could not dispatch assess message:', err);
    }
  }

  function debouncedScan(delay = 800) {
    if (scanDebounceTimer) {
      clearTimeout(scanDebounceTimer);
    }
    scanDebounceTimer = setTimeout(() => {
      scanPage();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // INITIALIZATION & LISTENERS
  // ---------------------------------------------------------------------------

  async function init() {
    // Load settings from background
    try {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
        if (res) {
          settings = { ...settings, ...res };
        }
        debouncedScan(400);
      });
    } catch (e) {
      debouncedScan(800);
    }

    // Set up MutationObserver with 800ms debounce
    const observer = new MutationObserver((mutations) => {
      // Check if mutations added relevant comment nodes
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        debouncedScan(800);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // YouTube SPA navigation listener
    window.addEventListener('yt-navigate-finish', () => {
      warnedHandlesOnPage.clear();
      closeActivePopover();
      debouncedScan(600);
    });

    // Close popovers on click outside or Escape
    document.addEventListener('click', (e) => {
      if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.botshield-badge')) {
        closeActivePopover();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeActivePopover();
      }
    });

    // Reply Guardian: detect when user opens or types in a reply box
    document.addEventListener('focusin', (e) => {
      const target = e.target;
      if (target && (target.isContentEditable || target.tagName === 'TEXTAREA' || target.getAttribute('role') === 'textbox')) {
        checkReplyGuardian(target);
      }
    }, true);

    document.addEventListener('input', (e) => {
      const target = e.target;
      if (target && (target.isContentEditable || target.tagName === 'TEXTAREA' || target.getAttribute('role') === 'textbox')) {
        checkReplyGuardian(target);
      }
    }, true);

    // Listen for settings updates from popup
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        if (changes.hideBots !== undefined) settings.hideBots = changes.hideBots.newValue;
        if (changes.replyGuardian !== undefined) settings.replyGuardian = changes.replyGuardian.newValue;
        if (changes.enableOnReddit !== undefined) settings.enableOnReddit = changes.enableOnReddit.newValue;
        if (changes.scanInterval !== undefined) settings.scanInterval = changes.scanInterval.newValue;
      }
    });
  }

  // Run when document is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
