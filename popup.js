/**
 * BotShield - popup.js
 * 
 * Manages user settings, live API status display, local cache inspection,
 * and MaxMind legal attribution.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const apiUrlInput = document.getElementById('api-url');
  const saveUrlBtn = document.getElementById('save-url-btn');
  const hideBotsToggle = document.getElementById('hide-bots-toggle');
  const replyGuardianToggle = document.getElementById('reply-guardian-toggle');
  const enableRedditToggle = document.getElementById('enable-reddit-toggle');
  const scanIntervalRange = document.getElementById('scan-interval-range');
  const intervalDisplay = document.getElementById('interval-display');
  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const cachedCountEl = document.getElementById('cached-count');
  const lastCallTimeEl = document.getElementById('last-call-time');
  const clearCacheBtn = document.getElementById('clear-cache-btn');
  const saveToast = document.getElementById('save-toast');

  // Load existing settings
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
    if (settings) {
      apiUrlInput.value = settings.apiBaseUrl || 'http://localhost:8000';
      hideBotsToggle.checked = Boolean(settings.hideBots);
      if (replyGuardianToggle) {
        replyGuardianToggle.checked = settings.replyGuardian !== false;
      }
      enableRedditToggle.checked = settings.enableOnReddit !== false;
      const interval = settings.scanInterval || 800;
      scanIntervalRange.value = interval;
      intervalDisplay.textContent = `Debounce delay: ${interval}ms`;
    }
  });

  // Query background for status & cache metrics
  function refreshStatus() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
      if (!status) return;

      // Update API Reachability Badge
      if (status.isApiReachable) {
        statusBadge.className = 'status-badge status-online';
        statusText.textContent = 'API Online';
      } else {
        statusBadge.className = 'status-badge status-offline';
        statusText.textContent = 'API Unreachable';
      }

      // Update Cache Count
      cachedCountEl.textContent = status.cacheCount || 0;

      // Update Last Call Time
      if (status.lastSuccessTimestamp) {
        lastCallTimeEl.textContent = formatTimeAgo(status.lastSuccessTimestamp);
      } else {
        lastCallTimeEl.textContent = 'Never';
      }
    });
  }

  function formatTimeAgo(timestamp) {
    const elapsedSeconds = Math.floor((Date.now() - timestamp) / 1000);
    if (elapsedSeconds < 10) return 'Just now';
    if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
    const minutes = Math.floor(elapsedSeconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  function showToast(message = 'Settings saved') {
    saveToast.textContent = message;
    saveToast.classList.remove('hidden');
    saveToast.style.opacity = '1';
    setTimeout(() => {
      saveToast.style.opacity = '0';
      setTimeout(() => saveToast.classList.add('hidden'), 300);
    }, 2000);
  }

  // Save Settings Handlers
  async function persistSettings(extraMsg) {
    const newSettings = {
      apiBaseUrl: (apiUrlInput.value || 'http://localhost:8000').trim(),
      hideBots: hideBotsToggle.checked,
      replyGuardian: replyGuardianToggle ? replyGuardianToggle.checked : true,
      enableOnReddit: enableRedditToggle.checked,
      scanInterval: parseInt(scanIntervalRange.value, 10) || 800
    };

    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: newSettings }, (res) => {
      if (res && res.success) {
        showToast(extraMsg || 'Settings saved');
        refreshStatus();
      }
    });
  }

  saveUrlBtn.addEventListener('click', () => persistSettings('API URL saved'));
  hideBotsToggle.addEventListener('change', () => persistSettings());
  if (replyGuardianToggle) {
    replyGuardianToggle.addEventListener('change', () => persistSettings());
  }
  enableRedditToggle.addEventListener('change', () => persistSettings());

  scanIntervalRange.addEventListener('input', () => {
    intervalDisplay.textContent = `Debounce delay: ${scanIntervalRange.value}ms`;
  });
  scanIntervalRange.addEventListener('change', () => persistSettings());

  // Clear Cache Handler
  clearCacheBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (res) => {
      showToast(`Cleared ${res?.count || 0} cached items`);
      refreshStatus();
    });
  });

  // Initial status fetch
  refreshStatus();
});
