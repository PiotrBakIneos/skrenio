// api/webhook.js
// Handles Stripe webhook events — activates/deactivates subscriptions and sends license keys

import { validateLicense } from './licenseValidator.js';

const PLAN_MAP = {
  solo:      { name: 'Solo',      analyses: 50,  seats: 2  },
  agencja:   { name: 'Agencja',   analyses: 200, seats: 10 },
  unlimited: { name: 'Unlimited', analyses: 600, seats: 30 },
};

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function hash6(input) {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuf);
  let result = '';
  for (let i = 0; i < 6; i++) result += CHARSET[bytes[i] % CHARSET.length];
  return result;
}

async function generateKey(plan) {
  const secret = process.env.LICENSE_SECRET;
  if (!secret) throw new Error('LICENSE_SECRET not set');
  const now = new Date();
  // 30 days from today
  const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const yy = String(expiry.getFullYear()).slice(2);
  const mm = String(expiry.getMonth() + 1).padStart(2, '0');
  const dd = String(expiry.getDate()).padStart(2, '0');
  const yymmdd = yy + mm + dd;
  const p = plan[0].toUpperCase(); // S, A, U
  const unique = await hash6(`${secret}:${p}:${yymmdd}`);
  return `SKR-${p}-${unique}-${yymmdd}`;
}

async function sendLicenseEmail(email, key, planName) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log(`LICENSE KEY for ${email}: ${key}`); // fallback log
    return;
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Skrenio <info@skrenio.com>',
      to: email,
      subject: `Twój klucz licencji Skrenio — Plan ${planName}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
          <h2 style="color:#0F172A">Dziękujemy za zakup Skrenio!</h2>
          <p style="color:#475569">Twój klucz licencji dla planu <strong>${planName}</strong>:</p>
          <div style="background:#F1F5F9;border-radius:10px;padding:20px;text-align:center;margin:24px 0">
            <code style="font-size:1.4rem;font-weight:700;color:#7C3AED;letter-spacing:.1em">${key}</code>
          </div>
          <p style="color:#475569">Aby aktywować:</p>
          <ol style="color:#475569">
            <li>Wejdź na <a href="https://skrenio.com">skrenio.com</a></li>
            <li>Wklej klucz w polu "Kod licencji" widocznym na górze strony</li>
            <li>Kliknij "Aktywuj"</li>
          </ol>
          <p style="color:#475569">Klucz jest ważny przez 30 dni. Przed wygaśnięciem otrzymasz nowy automatycznie.</p>
          <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0">
          <p style="color:#94A3B8;font-size:.85rem">Pytania? Odpowiedz na ten email lub napisz na info@skrenio.com</p>
        </div>
      `,
    }),
  });
}

async function storeUser(email, plan, key) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const headers = { Authorization: `Bearer ${upstashToken}`, 'Content-Type': 'application/json' };
  await fetch(`${upstashUrl}/set/user:${email}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ value: JSON.stringify({ plan, key, status: 'active', created: new Date().toISOString() }), ex: 35 * 24 * 3600 }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig       = req.headers['stripe-signature'];
  const secret    = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody   = req.body;

  // Verify Stripe signature
  if (secret && sig) {
    // Simple timestamp + signature check
    const parts     = sig.split(',').reduce((acc, p) => { const [k,v] = p.split('='); acc[k]=v; return acc; }, {});
    const timestamp = parts.t;
    const payload   = `${timestamp}.${typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)}`;
    const enc       = new TextEncoder();
    const keyData   = enc.encode(secret);
    const msgData   = enc.encode(payload);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBytes  = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const computed  = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2,'0')).join('');
    if (computed !== parts.v1) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  const event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email   = session.customer_email || session.metadata?.email;
      const plan    = session.metadata?.plan || 'solo';

      if (email && plan) {
        const key = await generateKey(plan);
        await storeUser(email, plan, key);
        await sendLicenseEmail(email, key, PLAN_MAP[plan]?.name || plan);
      }
    }

    if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
      const email = event.data.object.customer_email;
      if (email && process.env.UPSTASH_REDIS_REST_URL) {
        const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
        const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
        await fetch(`${upstashUrl}/del/user:${email}`, { headers: { Authorization: `Bearer ${upstashToken}` } });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
