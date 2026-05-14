// api/auth.js
// Handles: Google OAuth + Magic Link email login
// GET /api/auth?provider=google → start Google login
// GET /api/auth?code=xxx → Google callback
// POST /api/auth/magic → send magic link email
// GET /api/auth?token=xxx → verify magic link token

const SITE_URL = process.env.SITE_URL || 'https://skrenio.com';

async function createSession(email) {
  const arr   = new Uint8Array(24);
  crypto.getRandomValues(arr);
  const token = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');

  if (process.env.UPSTASH_REDIS_REST_URL) {
    const url   = process.env.UPSTASH_REDIS_REST_URL;
    const tok   = process.env.UPSTASH_REDIS_REST_TOKEN;
    await fetch(`${url}/set/session:${token}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value: JSON.stringify({ email }), ex: 7 * 24 * 3600 }),
    });
  }
  return token;
}

async function getSubscription(email) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return null;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r   = await fetch(`${url}/get/user:${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${tok}` } });
  const d   = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

async function sendMagicLink(email, token) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`MAGIC LINK: ${SITE_URL}/api/auth?token=${token}`);
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'Skrenio <info@skrenio.com>',
      to:      email,
      subject: 'Zaloguj się do Skrenio',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="color:#0F172A;margin-bottom:8px">Zaloguj się do Skrenio</h2>
          <p style="color:#475569;margin-bottom:24px">Kliknij poniższy link aby się zalogować. Link jest ważny przez 15 minut.</p>
          <a href="${SITE_URL}/api/auth?token=${token}" style="display:inline-block;background:linear-gradient(135deg,#7C3AED,#3B82F6);color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:1rem">Zaloguj się →</a>
          <p style="color:#94A3B8;font-size:.82rem;margin-top:24px">Jeśli nie prosiłeś/aś o ten link — zignoruj tę wiadomość.</p>
        </div>
      `,
    }),
  });
}

export default async function handler(req, res) {
  const { code, token, provider } = req.query || {};

  // ── Magic link verification ──────────────────────────────
  if (token) {
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.redirect(`${SITE_URL}/?auth=error`);
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const r   = await fetch(`${url}/get/magic:${token}`, { headers: { Authorization: `Bearer ${tok}` } });
    const d   = await r.json();
    if (!d.result) return res.redirect(`${SITE_URL}/?auth=error&reason=expired`);

    const { email } = JSON.parse(d.result);
    // Delete magic token — one-time use
    await fetch(`${url}/del/magic:${token}`, { headers: { Authorization: `Bearer ${tok}` } });

    const sessionToken = await createSession(email);
    const sub = await getSubscription(email);
    const plan = sub?.plan || '';
    return res.redirect(`${SITE_URL}/?auth=success&email=${encodeURIComponent(email)}&session=${sessionToken}&plan=${plan}`);
  }

  // ── Send magic link ──────────────────────────────────────
  if (req.method === 'POST') {
    const { email } = req.body || {};
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Nieprawidłowy email.' });

    // Generate magic token — valid 15 minutes
    const arr   = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const magicToken = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');

    if (process.env.UPSTASH_REDIS_REST_URL) {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
      await fetch(`${url}/set/magic:${magicToken}`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ value: JSON.stringify({ email }), ex: 15 * 60 }),
      });
    }

    await sendMagicLink(email, magicToken);
    return res.status(200).json({ sent: true });
  }

  // ── Google OAuth start ───────────────────────────────────
  if (!code) {
    const params = new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID || '',
      redirect_uri:  `${SITE_URL}/api/auth`,
      response_type: 'code',
      scope:         'email profile',
      access_type:   'offline',
      prompt:        'select_account',
    });
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }

  // ── Google OAuth callback ────────────────────────────────
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri:  `${SITE_URL}/api/auth`,
        grant_type:    'authorization_code',
      }).toString(),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user  = await userRes.json();
    const email = user.email;
    if (!email) throw new Error('No email');

    const sessionToken = await createSession(email);
    const sub  = await getSubscription(email);
    const plan = sub?.plan || '';
    return res.redirect(`${SITE_URL}/?auth=success&email=${encodeURIComponent(email)}&session=${sessionToken}&plan=${plan}`);
  } catch (err) {
    console.error('Auth error:', err);
    return res.redirect(`${SITE_URL}/?auth=error`);
  }
}
