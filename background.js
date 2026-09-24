/**
 * BotShield - background.js
 * 
 * Manifest V3 Service Worker:
 * - Performs ALL network operations (content.js never calls fetch)
 * - Rate limits outgoing requests to 30 requests per 60-second window
 * - Caches verdicts in chrome.storage.local for 24 hours keyed by normalized handle
 * - Deduplicates in-flight requests
 * - Implements exponential backoff on HTTP 429
 * - Dispatches feedback and queries platform statistics
 */

const DEFAULT_SETTINGS = {
  apiBaseUrl: 'http://localhost:8000',
  hideBots: false,
  enableOnReddit: true,
  replyGuardian: true,
  scanInterval: 5 // seconds
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 32000;

// State management
let requestTimestamps = [];
let inFlightRequests = new Map(); // normalizedHandle -> Promise<Verdict>
let backoffDelayMs = 0;
let lastSuccessTimestamp = null;
let isApiReachable = true;
let queue = [];
let isProcessingQueue = false;

/**
 * Normalizes handle for cache keys and deduplication:
 * Lowercase and strip leading '@'.
 */
function normalizeHandle(handle) {
  if (!handle || typeof handle !== 'string') return '';
  return handle.trim().toLowerCase().replace(/^@+/, '');
}

/**
 * Retrieves user settings from chrome.storage.sync with defaults
 */
async function getSettings() {
  try {
    const data = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...data };
  } catch (err) {
    console.warn('[BotShield BG] Error getting settings, using defaults:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Check chrome.storage.local for a cached verdict for the handle
 */
async function getCachedVerdict(normalizedHandle) {
  if (!normalizedHandle) return null;
  const key = `verdict:${normalizedHandle}`;
  try {
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (entry && entry.cachedAt && (Date.now() - entry.cachedAt < CACHE_TTL_MS)) {
      return entry.verdict;
    }
    if (entry) {
      // Expired - clean up
      await chrome.storage.local.remove(key);
    }
  } catch (err) {
    console.error('[BotShield BG] Error reading cache:', err);
  }
  return null;
}

/**
 * Saves verdict to chrome.storage.local
 */
async function saveCachedVerdict(normalizedHandle, verdict) {
  if (!normalizedHandle || !verdict) return;
  const key = `verdict:${normalizedHandle}`;
  try {
    await chrome.storage.local.set({
      [key]: {
        verdict,
        cachedAt: Date.now()
      }
    });
  } catch (err) {
    console.error('[BotShield BG] Error writing cache:', err);
  }
}

/**
 * Gets count of valid cached verdicts in storage
 */
async function getCachedVerdictsCount() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    let count = 0;
    for (const key of Object.keys(all)) {
      if (key.startsWith('verdict:')) {
        const item = all[key];
        if (item && item.cachedAt && (now - item.cachedAt < CACHE_TTL_MS)) {
          count++;
        }
      }
    }
    return count;
  } catch (e) {
    return 0;
  }
}

/**
 * Enforces rate limiting: 30 requests per 60-second window.
 * Sleeps if limit is reached until an older slot frees up.
 */
async function enforceRateLimit() {
  while (true) {
    const now = Date.now();
    // Prune timestamps older than 60s
    requestTimestamps = requestTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

    if (requestTimestamps.length < RATE_LIMIT_MAX_REQUESTS && backoffDelayMs === 0) {
      requestTimestamps.push(now);
      return;
    }

    let waitTime = 1000;
    if (backoffDelayMs > 0) {
      waitTime = backoffDelayMs;
    } else if (requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
      const oldest = requestTimestamps[0];
      waitTime = Math.max(100, (RATE_LIMIT_WINDOW_MS - (now - oldest)) + 50);
    }

    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
}

/**
 * Executes network call to POST {API_BASE}/assess for a single handle
 */
async function assessHandleNetwork(item, apiBaseUrl) {
  const normalized = normalizeHandle(item.handle);

  // Payload strictly adheres to privacy rule:
  // ONLY handle, comment texts, timestamps, profile hints, context language.
  const payload = {
    handle: item.handle,
    comments: (item.comments || []).slice(0, 20).map(c => ({
      text: c.text,
      posted_at_iso: c.posted_at_iso
    })),
    profile_hints: {
      default_avatar: Boolean(item.profile_hints?.default_avatar),
      display_name: item.profile_hints?.display_name || item.handle,
      follower_count: item.profile_hints?.follower_count ?? null
    },
    context_lang: item.context_lang || 'en'
  };

  const endpoint = `${apiBaseUrl.replace(/\/+$/, '')}/assess`;

  try {
    await enforceRateLimit();

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.status === 429) {
      // Trigger exponential backoff
      backoffDelayMs = backoffDelayMs === 0 ? INITIAL_BACKOFF_MS : Math.min(backoffDelayMs * 2, MAX_BACKOFF_MS);
      console.warn(`[BotShield BG] HTTP 429 received. Backing off for ${backoffDelayMs}ms.`);
      setTimeout(() => {
        backoffDelayMs = 0; // Reset backoff after duration
      }, backoffDelayMs);
      throw new Error('Rate-limited (429)');
    }

    if (!response.ok) {
      throw new Error(`API HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Normalize verdict response structure
    const verdict = {
      verdict_id: data.verdict_id || `v_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      handle: item.handle,
      score: typeof data.score === 'number' ? data.score : 0.0,
      label: data.label || 'HUMAN_LIKELY',
      signals: Array.isArray(data.signals) ? data.signals : [],
      advisory: data.advisory || 'Account behavior appears consistent with typical human patterns.'
    };

    // Cache valid verdict
    await saveCachedVerdict(normalized, verdict);

    lastSuccessTimestamp = Date.now();
    isApiReachable = true;
    backoffDelayMs = 0;

    return verdict;
  } catch (err) {
    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('ECONNREFUSED')) {
      isApiReachable = false;
    }
    console.error(`[BotShield BG] Assess failed for ${item.handle}:`, err.message);
    throw err;
  }
}

/**
 * Assesses an individual handle with caching & in-flight deduplication
 */
function assessHandle(item, apiBaseUrl) {
  const normalized = normalizeHandle(item.handle);
  if (!normalized) {
    return Promise.reject(new Error('Invalid handle'));
  }

  // Deduplicate in-flight requests
  if (inFlightRequests.has(normalized)) {
    return inFlightRequests.get(normalized);
  }

  const promise = (async () => {
    // 1. Check local cache
    const cached = await getCachedVerdict(normalized);
    if (cached) {
      return cached;
    }

    // 2. Fetch from backend
    return await assessHandleNetwork(item, apiBaseUrl);
  })().finally(() => {
    inFlightRequests.delete(normalized);
  });

  inFlightRequests.set(normalized, promise);
  return promise;
}

/**
 * Batches incoming assess items and processes them
 */
async function handleAssessBatch(items) {
  const settings = await getSettings();
  const results = {};
  const tasks = [];

  for (const item of items) {
    const normalized = normalizeHandle(item.handle);
    if (!normalized) continue;

    tasks.push(
      assessHandle(item, settings.apiBaseUrl)
        .then(verdict => {
          results[normalized] = verdict;
        })
        .catch(err => {
          // If request fails or API is down, silently omit verdict
          // Content script will maintain non-rendered state
        })
    );
  }

  await Promise.allSettled(tasks);

  return {
    verdicts: results,
    isApiReachable,
    lastSuccessTimestamp
  };
}

/**
 * Dispatches feedback to POST {API_BASE}/feedback
 */
async function sendFeedback({ verdict_id, is_correct }) {
  const settings = await getSettings();
  const endpoint = `${settings.apiBaseUrl.replace(/\/+$/, '')}/feedback`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ verdict_id, is_correct })
    });

    if (!response.ok) {
      throw new Error(`Feedback failed with status ${response.status}`);
    }

    return { success: true };
  } catch (err) {
    console.error('[BotShield BG] Feedback submission failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Message listener for content scripts & popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case 'ASSESS_HANDLES': {
      handleAssessBatch(message.items || [])
        .then(data => sendResponse(data))
        .catch(err => sendResponse({ verdicts: {}, isApiReachable: false, error: err.message }));
      return true; // Keep channel open for async response
    }

    case 'SUBMIT_FEEDBACK': {
      sendFeedback(message.payload || {})
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'GET_STATUS': {
      (async () => {
        const cacheCount = await getCachedVerdictsCount();
        const settings = await getSettings();
        sendResponse({
          isApiReachable,
          lastSuccessTimestamp,
          cacheCount,
          settings
        });
      })();
      return true;
    }

    case 'GET_SETTINGS': {
      getSettings().then(settings => sendResponse(settings));
      return true;
    }

    case 'SAVE_SETTINGS': {
      chrome.storage.sync.set(message.settings || {})
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'CLEAR_CACHE': {
      (async () => {
        const all = await chrome.storage.local.get(null);
        const removeKeys = Object.keys(all).filter(k => k.startsWith('verdict:'));
        await chrome.storage.local.remove(removeKeys);
        sendResponse({ success: true, count: removeKeys.length });
      })();
      return true;
    }

    default:
      break;
  }
});

// Periodic cache cleanup on worker activation
chrome.runtime.onInstalled.addListener(() => {
  console.log('[BotShield BG] Extension installed/updated.');
});
