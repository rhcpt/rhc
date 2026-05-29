// api/demo-request.js
//
// Anonymous endpoint backing both forms on rhc.pt:
//   - the "Get a demo" modal (#demo-form: name + email + company)
//   - the inline CTA (#cta-email: email only)
//
// Only `email` is required. `name` and `company` are optional so the
// CTA can fire with just an email. The recipient inbox (hello@rhc.pt)
// gets a small HTML body summarising whatever the visitor filled in.
//
// Defences:
//   - In-memory rate-limit: 5 req/IP/min (best-effort; Vercel recycles
//     instances so the map resets occasionally — sufficient for a
//     low-value marketing form)
//   - from is server-pinned (noreply@rhc.pt); user input is only
//     rendered in the HTML body (escaped)
//   - No Reply-to (per spec — reply directly to the user is intentionally
//     not enabled here)
//
// Required env: RESEND_API_KEY (must be set in the rhc.pt Vercel project).

const ALLOWED_ORIGINS = new Set([
  'https://rhc.pt',
  'https://www.rhc.pt',
  'https://rhc.vercel.app'
]);
const DEST = 'hello@rhc.pt';
const FROM = 'RHC <noreply@rhc.pt>';

const _rateMap       = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 5;

function applyCors(req, res) {
  const origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'method_not_allowed' });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.warn('[demo-request] missing RESEND_API_KEY');
    return res.status(500).json({ error: 'misconfigured' });
  }

  // Rate-limit (best-effort, per-IP)
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.headers['x-real-ip']
          || 'unknown';
  const now  = Date.now();
  const slot = _rateMap.get(ip);
  if (slot && slot.start > now - RATE_WINDOW_MS) {
    if (slot.count >= RATE_MAX) return res.status(429).json({ error: 'rate_limited' });
    slot.count++;
  } else {
    _rateMap.set(ip, { start: now, count: 1 });
  }

  // Parse + validate
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'bad_body' });
  }

  const name    = String(body.name    || '').trim().slice(0, 100);
  const company = String(body.company || '').trim().slice(0, 100);
  const email   = String(body.email   || '').trim().toLowerCase().slice(0, 200);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const subject = company
    ? `Novo pedido de demo — ${company}`
    : `Novo pedido de demo — sem empresa`;

  const html = `
    <h2 style="margin:0 0 12px;font-family:sans-serif;">Novo pedido de demo</h2>
    <p style="font-family:sans-serif;margin:6px 0;"><strong>Nome:</strong> ${name ? esc(name) : '<em style="color:#888;">(não fornecido)</em>'}</p>
    <p style="font-family:sans-serif;margin:6px 0;"><strong>Empresa:</strong> ${company ? esc(company) : '<em style="color:#888;">(não fornecido)</em>'}</p>
    <p style="font-family:sans-serif;margin:6px 0;"><strong>Email:</strong> ${esc(email)}</p>
  `;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: FROM,
        to: [DEST],
        subject,
        html
      })
    });
    if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      console.error('[demo-request] Resend error:', errData);
      return res.status(502).json({ error: 'send_failed' });
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[demo-request]', e && e.message);
    return res.status(500).json({ error: 'server_error' });
  }
}
