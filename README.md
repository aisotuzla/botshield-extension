# BotShield Extension

**BotShield** is a lightweight, privacy-focused browser extension for Chrome and Firefox that flags likely bot or automated commenter accounts across public discussion forums (YouTube and Reddit), helping users avoid engaging with coordinated inauthentic behavior.

---

## 1. Folder Layout

```text
botshield-extension/
├── manifest.json         # Manifest V3 configuration & permissions
├── background.js         # Service worker: network requests, caching, rate limiting
├── content.js            # Injected script: platform DOM adapters, signal extraction, badges
├── content.css           # Inline badge styling, popover cards, and collapsed comment UI
├── popup.html            # Extension popup UI (API config, toggles, cache stats)
├── popup.js              # Settings persistence and live telemetry polling
├── popup.css             # Dark modern UI styles for extension popup
├── lib/
│   └── ip.js             # CIDR-less IP formatting & sanitization utilities
├── icons/
│   ├── icon16.png        # Toolbar icon (16x16)
│   ├── icon48.png        # Management icon (48x48)
│   └── icon128.png       # Web Store icon (128x128)
├── mock-server.js        # Standalone mock API server for offline testing
├── mock-api.md           # Mock server documentation and schema reference
└── README.md             # Project documentation & adapter development guide
```

---

## 2. Installation & Quick Start

### Loading Unpacked in Google Chrome / Chromium / Edge / Brave

1. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`).
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click the **Load unpacked** button in the top-left.
4. Select the `botshield-extension/` folder on your disk.
5. The BotShield shield icon will appear in your extensions toolbar. Pin it for quick access.

### Loading in Mozilla Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` inside the `botshield-extension/` folder.

---

## 3. Configuring the API URL

By default, BotShield connects to a local backend at `http://localhost:8000`.

To change the endpoint without editing code:
1. Click the **BotShield icon** in your browser toolbar to open the popup.
2. In the **Backend API Endpoint** input box, enter your API base URL (e.g. `https://api.yourdomain.com`).
3. Click **Save**.
4. The endpoint is saved to `chrome.storage.sync` and used for all subsequent assessments and feedback submissions.

---

## 4. Privacy Statement (Non-Negotiable Guarantees)

BotShield is designed as a **zero-surveillance thin client**:
- **Strictly scoped telemetry:** The extension sends **ONLY** public, on-screen commenter metadata:
  1. Commenter handle / username
  2. Up to 20 visible comments (`{ text, posted_at_iso }`)
  3. Basic profile hints (default avatar indicator, display name)
  4. Context language code (e.g. `'bs'` or `'en'`)
- **No IP collection or transmission:** The extension **never** accesses, inspects, or transmits the user's IP address, browser fingerprint, or geographic identity. All CIDR routing and GeoLite2 analysis reside exclusively on the backend.
- **No cross-site tracking:** The extension operates solely on active comment sections of supported platforms. No browsing history, cookies, or session tokens are collected or transmitted.
- **Probabilistic terminology:** Badges and tooltips strictly use probabilistic terminology (e.g., *"Very likely automated"*, *"Bot-like signals"*), never asserting that a named individual is definitively a bot.

---

## 5. Platform Adapter Architecture

BotShield implements an adapter pattern in [content.js](file:///e:/MaxMind/botshield-extension/content.js). All DOM scraping is encapsulated inside small adapter objects. Adding a new platform requires adding **one adapter object** to the `adapters` array without altering badge rendering, debounce loops, or network logic.

### Standard Selectors

#### YouTube Adapter
- **Container / Anchor:** `ytd-comment-thread-renderer, ytd-comment-view-model`
- **Author element:** `yt-formatted-string#author-text, #author-text, a#author-text`
- **Comment text:** `yt-formatted-string#content-text, #content-text`
- **Timestamp:** `yt-formatted-string.published-time-text a, #published-time-text a`
- **Avatar:** `#author-thumbnail img, img#img`
- **Language Detection:** Evaluates `document.documentElement.lang` and Balkan/BCS keywords (`bih`, `bosn`, `srpsk`, `hrvat`, `sarajevo`, `zagreb`, `beograd`), defaulting to `'bs'` or `'en'`.

#### Reddit Adapter
- **Container / Anchor:** `[data-testid='comment'], shreddit-comment, div.comment`
- **Author element:** `a[data-testid='comment_author_link'], a[href*='/user/'], [slot='authorName']`
- **Comment text:** `[data-testid='comment'] p, [slot='comment'] p, div.md p`
- **Timestamp:** `time, [data-testid='comment_timestamp']`
- **Avatar:** `img[alt*='avatar'], faceplate-img, [data-testid='comment_author_icon']`

### How to Add a New Platform Adapter

To support an additional platform (e.g. Discourse, Hacker News):
```javascript
{
  name: 'discourse',
  match: (url) => url.hostname.includes('discourse.example.com'),
  getCommentContainers: (root) => root.querySelectorAll('.topic-post'),
  getAuthorElement: (container) => container.querySelector('.names .username a'),
  extractHandle: function(container) {
    return this.getAuthorElement(container)?.textContent?.trim() || null;
  },
  extractCommentText: (container) => {
    return container.querySelector('.cooked')?.textContent?.trim() || '';
  },
  extractTimestamp: (container) => {
    return container.querySelector('time')?.getAttribute('datetime') || null;
  },
  extractProfileHints: (container) => ({
    default_avatar: false,
    display_name: '',
    follower_count: null
  }),
  getContextLang: () => document.documentElement.lang || 'en',
  getHeaderAnchor: () => document.querySelector('#topic-title')
}
```
*(Note: LinkedIn is explicitly out of scope for v1).*

---

## 6. Verdict Badges & User Actions

| Verdict Label | Badge Color | Label Text | Action / Behavior |
| :--- | :--- | :--- | :--- |
| `HUMAN_LIKELY` / `LOW` | Green (`#16a34a`) | `✓ Human-likely` | Verified typical conversational cadence |
| `MEDIUM` | Amber (`#f59e0b`) | `⚠ Caution — bot-like signals` | Repetitive linguistic templates or burst timing |
| `HIGH` | Orange (`#ea580c`) | `🤖 Very likely automated — avoid engaging` | High velocity across unrelated threads; collapsed if setting enabled |
| `BOT` | Red (`#dc2626`) | `🤖 Bot — do not engage, report` | Known coordinated network signature; collapsed if setting enabled |

### Badge Interaction & Feedback Loop
- **Hover:** Displays tooltip with observed signals (e.g., `Signals: High comment frequency • Default avatar`).
- **Click:** Opens an interactive popover detailing the risk score, localized advisory, and feedback buttons (`✓ Correct` / `✗ Wrong`).
- Feedback is posted to `POST /feedback` with `{ verdict_id, is_correct }` to continuously train detection models.

---

## 7. Minimal Test Plan

### Step 1: Start the Local Mock Server
Run the included standalone mock server:
```bash
node mock-server.js
```
The server starts on `http://localhost:8000` with mock `/assess`, `/feedback`, and `/stats/*` responses.

### Step 2: Test YouTube Comment Thread
1. Visit any active YouTube video (e.g., news broadcast or popular podcast):
   - `https://www.youtube.com/watch?v=dQw4w9WgXcQ`
2. Scroll to the comments section.
3. Observe:
   - Within 800ms of scrolling, inline badges render beside comment author names.
   - Hovering over a badge displays the signal breakdown tooltip.
   - Clicking a badge reveals the popover card with advisory notes and feedback buttons.
   - Clicking `✓ Correct` or `✗ Wrong` triggers a feedback submission and displays confirmation.

### Step 3: Test YouTube SPA Navigation
1. Click a recommended video from the sidebar.
2. Observe that badges clear and re-attach seamlessly on the newly navigated video comments without page reloads.

### Step 4: Test Reddit Discussion
1. Open a Reddit thread:
   - `https://www.reddit.com/r/technology/` or any comment section.
2. Verify inline badges render cleanly beside commenter usernames.

### Step 5: Test "Hide HIGH / BOT" Toggle
1. Open the BotShield popup.
2. Turn on **Hide HIGH / BOT comments**.
3. Verify that high-risk comments collapse behind a `"🤖 Comment hidden by BotShield"` bar with a `"Show Comment"` button.

### Step 6: Test API Downtime Graceful Degradation
1. Stop the mock server (`Ctrl+C`).
2. Refresh or scroll a comment section.
3. Observe:
   - Badges silently do not render.
   - A single, subtle notice `"BotShield: API unreachable"` appears at the header.
   - No intrusive alerts or console errors interrupt page operation.

---

## 8. Legal Notice & MaxMind Attribution

This product includes GeoLite2 data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com).
