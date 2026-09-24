/**
 * BotShield - mock-server.js
 * Standalone offline development server for BotShield Extension testing.
 */

const http = require('http');

const LABELS = ['HUMAN_LIKELY', 'LOW', 'MEDIUM', 'HIGH', 'BOT'];
const ADVISORIES = {
  HUMAN_LIKELY: 'Account behavior appears consistent with typical human patterns.',
  LOW: 'Low automation indicators detected; standard conversational profile.',
  MEDIUM: 'Caution: Repeated linguistic templates or burst timing detected.',
  HIGH: 'Very likely automated: High comment velocity across unrelated threads.',
  BOT: 'Automated entity: Known copypasta footprint and botnet propagation pattern.'
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const url = req.url.split('?')[0];

    // POST /assess
    if (req.method === 'POST' && url === '/assess') {
      try {
        const payload = JSON.parse(body || '{}');
        const handle = payload.handle || 'unknown';
        const hash = Array.from(handle).reduce((acc, c) => acc + c.charCodeAt(0), 0);
        const label = LABELS[hash % LABELS.length];
        const score = (hash % 100) / 100;

        const response = {
          verdict_id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          handle: handle,
          score: score,
          label: label,
          signals: [
            label === 'BOT' || label === 'HIGH' ? 'High comment frequency in short window' : 'Organic posting rhythm',
            payload.profile_hints?.default_avatar ? 'Default profile avatar detected' : 'Custom user avatar active',
            `Context language evaluated: ${payload.context_lang || 'en'}`
          ],
          advisory: ADVISORIES[label]
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    }

    // POST /feedback
    if (req.method === 'POST' && url === '/feedback') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Feedback recorded' }));
    }

    // GET /stats/*
    if (req.method === 'GET' && url.startsWith('/stats/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        daily: { total_assessments: 1420, bot_ratio: 0.18 },
        platforms: { youtube: 1100, reddit: 320 }
      }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });
});

const PORT = 8000;
server.listen(PORT, () => {
  console.log(`BotShield Mock API running at http://localhost:${PORT}`);
});
