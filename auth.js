// api/auth.js
// Handles Google OAuth callback and session management

export default async function handler(req, res) {
  const { code, state } = req.query || {};

  if (!code) {
    // Step 1 — redirect to Google
    const params = new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      redirect_uri:  `${process.env.SITE_URL || 'https://skrenio.com'}/api/auth`,
      response_type: 'code',
      scope:         'email profile',
      access_type:   'offline',
      prompt:        'select_account',
    });
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }

  // Step 2 — exchange code for token
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${process.env.SITE_URL || 'https://skrenio.com'}/api/auth`,
        grant_type:    'authorization_code',
      }).toString(),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');

    // Step 3 — get user info
    const userRes  = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();
    const email = user.email;

    if (!email) throw new Error('No email from Google');

    // Step 4 — check if user has active subscription in Redis
    let licenseKey = '';
    if (process.env.UPSTASH_REDIS_REST_URL) {
      const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
      const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      const r = await fetch(`${upstashUrl}/get/user:${email}`, { headers: { Authorization: `Bearer ${upstashToken}` } });
      const d = await r.json();
      if (d.result) {
        const userData = JSON.parse(d.result);
        licenseKey = userData.key || '';
      }
    }

    // Step 5 — create session token
    const arr         = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const sessionToken = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');

    // Store session in Redis for 7 days
    if (process.env.UPSTASH_REDIS_REST_URL) {
      const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
      const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      await fetch(`${upstashUrl}/set/session:${sessionToken}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${upstashToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify({ email, name: user.name }), ex: 7 * 24 * 3600 }),
      });
    }

    // Step 6 — redirect back with session + license key as URL params
    // Frontend reads these and stores in localStorage
    const redirectUrl = `${process.env.SITE_URL || 'https://skrenio.com'}/?auth=success&email=${encodeURIComponent(email)}&session=${sessionToken}${licenseKey ? `&key=${encodeURIComponent(licenseKey)}` : ''}`;
    return res.redirect(redirectUrl);

  } catch (err) {
    console.error('Auth error:', err);
    return res.redirect(`${process.env.SITE_URL || 'https://skrenio.com'}/?auth=error`);
  }
}
