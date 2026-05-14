// api/create-checkout.js
// Creates a Stripe Checkout session and returns the URL

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const allowed = (process.env.ALLOWED_ORIGIN || 'https://skrenio.com,https://www.skrenio.com').split(',').map(s => s.trim());
  const originOk = !origin || allowed.some(a => origin === a) || origin.includes('vercel.app') || origin.startsWith('http://localhost');
  if (!originOk) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, email } = req.body || {};
  if (!plan || !email) return res.status(400).json({ error: 'Brak danych.' });

  const PRICES = {
    solo:      process.env.STRIPE_PRICE_SOLO,
    agencja:   process.env.STRIPE_PRICE_AGENCJA,
    unlimited: process.env.STRIPE_PRICE_UNLIMITED,
  };

  const priceId = PRICES[plan];
  if (!priceId) return res.status(400).json({ error: 'Nieprawidłowy plan.' });

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'customer_email': email,
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'success_url': `${process.env.SITE_URL || 'https://skrenio.com'}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `${process.env.SITE_URL || 'https://skrenio.com'}/?payment=cancelled`,
        'metadata[plan]': plan,
        'metadata[email]': email,
      }).toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) throw new Error(session.error?.message || 'Stripe error');

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Błąd tworzenia sesji płatności.' });
  }
}
