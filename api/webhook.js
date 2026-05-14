// api/webhook.js
// Payment succeeds → write subscription to Redis → user has instant access
// No keys, no emails with codes

async function setSubscription(email, plan, stripeCustomerId) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  await fetch(`${url}/set/user:${encodeURIComponent(email)}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      value: JSON.stringify({ plan, status: 'active', stripe_customer_id: stripeCustomerId, activated: new Date().toISOString() }),
      ex:    35 * 24 * 3600,
    }),
  });
}

async function removeSubscription(email) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  await fetch(`${url}/del/user:${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function getCustomerEmail(customerId) {
  const stripeRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const customer = await stripeRes.json();
  return customer.email;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const sig     = req.headers['stripe-signature'] || '';
    const secret  = process.env.STRIPE_WEBHOOK_SECRET;

    // Verify signature if secret is set
    if (secret && sig) {
      const parts     = {};
      sig.split(',').forEach(p => { const [k, v] = p.split('='); parts[k] = v; });
      const payload   = `${parts.t}.${rawBody}`;
      const enc       = new TextEncoder();
      const key       = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sigBytes  = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
      const computed  = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
      if (computed !== parts.v1) return res.status(400).json({ error: 'Invalid signature' });
    }

    event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    return res.status(400).json({ error: 'Webhook parse error' });
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const email   = session.customer_email || session.metadata?.email;
        const plan    = session.metadata?.plan || 'solo';
        const custId  = session.customer;
        if (email) await setSubscription(email, plan, custId);
        break;
      }

      case 'invoice.paid': {
        // Renewal — refresh subscription for another 35 days
        const invoice = event.data.object;
        const email   = invoice.customer_email || await getCustomerEmail(invoice.customer);
        const plan    = invoice.lines?.data?.[0]?.metadata?.plan || 'solo';
        if (email) await setSubscription(email, plan, invoice.customer);
        break;
      }

      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj    = event.data.object;
        const email  = obj.customer_email || await getCustomerEmail(obj.customer);
        if (email) await removeSubscription(email);
        break;
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Processing failed' });
  }
}
