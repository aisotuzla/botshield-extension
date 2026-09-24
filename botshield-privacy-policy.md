# BotShield Browser Extension — Privacy Policy

**Last updated:** 24 September 2026

## 1. Overview

BotShield is a browser extension that displays probabilistic indicators next to comment authors on YouTube and Reddit, helping you decide whether an account is likely automated before you engage with it.

This policy explains what the extension collects, what it sends to our API, what we store, and the choices you have. It covers the extension only; it does not cover the websites you visit or any third-party platforms.

## 2. Summary (the short version)

- We do **not** collect your IP address, browsing history, personal identity, or any data about you as the viewer.
- We analyze **other people's public comments** visible on the page you have open, and only: their handle, comment text, timestamps, profile hints (follower counts, avatar presence, display name), and the page language.
- Nothing is sold, shared, or used for advertising. Ever.
- Verdicts are probabilistic signals, not accusations. False positives happen.

## 3. What the extension collects

When you view a YouTube video page or Reddit thread with comments, BotShield reads from the page:

- **Commenter handle** (public username), normalized to lowercase without the leading `@`
- **Up to 20 visible comments per handle**: the comment text and its posting timestamp
- **Public profile hints** exposed in the page: follower/subscriber counts, whether the avatar is a default image, and the display name
- **Context language** of the video or post (e.g., `"bs"` or `"en"`), used to localize advisories and inform detection

That is the complete list. Nothing else on the page is read.

## 4. What is explicitly NOT collected

The extension never collects or transmits:

- Your IP address or any network identifiers
- Your identity, accounts, credentials, cookies, or sessions
- Your browsing history or activity on other sites or tabs
- Content of pages other than the YouTube/Reddit comment sections being scanned
- Any data about you as the extension user that could link the analysis to you personally

IP-based and network-level analysis (if any) is performed exclusively on the backend side using its own data sources, never by the extension.

## 5. What is sent to the API

For each unique commenter handle, the extension sends the data from section 3 to our API endpoint (`POST {API_BASE}/assess`). The API returns a score, a label, the detection signals that fired, a localized advisory, and a `verdict_id`.

When you click "✓ Correct" or "✗ Wrong" on a badge, the extension sends `POST {API_BASE}/feedback` with the `verdict_id` and whether the verdict was correct. This helps improve detection accuracy.

## 6. Data storage

- **On your device:** Verdicts are cached locally in your browser (`chrome.storage.local`) for 24 hours, keyed by the commenter handle. Your settings (API endpoint, toggles) are stored in `chrome.storage.sync`. You can clear this at any time by removing the extension.
- **On our servers:** Comment data sent for assessment is processed to generate verdicts and retained only as long as needed to serve cached verdicts and aggregate, anonymized statistics. We do not build profiles of individual commenters across sites or over time beyond what is necessary to produce the verdict you requested.

## 7. Legal basis and legitimacy of verdicts

BotShield verdicts are **probabilistic signals, not statements of fact**. A badge indicates that an account exhibits patterns consistent with automated behavior — it is not an assertion that a named person is a bot. False positives happen; use the feedback buttons to improve detection.

## 8. Third-party data and attribution

The backend uses GeoLite2 geolocation data. This product includes GeoLite2 data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com). The extension itself does not perform any geolocation.

## 9. Your choices

- You can disable scanning on Reddit in the popup settings.
- You can change or point the extension at your own API endpoint in the popup settings.
- You can turn off bot-comment hiding at any time.
- Uninstalling the extension removes all locally cached data.

## 10. Children's privacy

The extension is not directed at children under 13 (or 16 in the EEA) and does not knowingly collect personal data from them.

## 11. Changes to this policy

We will update this policy if the extension's data practices change and update the "Last updated" date above. Material changes will be noted in the extension's release notes.

## 12. Contact

Questions about this policy or your data: **\[[aiso\_tuzla@proton.me](mailto:your-contact-email@example.com)\]**

---

*This document is a template for the BotShield extension. Replace placeholder contact details and confirm the retention statements in section 6 match your actual backend behavior before publishing to the Chrome Web Store. Chrome Web Store review also requires this policy to be hosted at a public URL — place it at the `privacy_policy` URL in your `manifest.json`.*