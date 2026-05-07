import { validateLicense } from './licenseValidator.js';

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const allowed = (process.env.ALLOWED_ORIGIN || 'https://skrenio.com').split(',').map(s => s.trim());
  const originOk = !origin
    || allowed.some(a => origin === a)
    || origin.endsWith('.vercel.app')
    || origin.startsWith('http://localhost')
    || origin.startsWith('http://127.0.0.1');
  if (!originOk) return res.status(403).json({ error: 'Forbidden' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { key, deviceToken } = req.body || {};
  if (!key || !deviceToken) return res.status(400).json({ error: 'Brak danych.' });

  const license = await validateLicense(key);
  if (!license.valid) {
    return res.status(402).json({ error: 'Nieprawidłowy lub wygasły klucz licencji.' });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    // No Redis — just allow
    return res.status(200).json({ transferred: true, plan: license.planName });
  }

  const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const devicesKey   = `skrenio_devices:${key}`;
  const cooldownKey  = `skrenio_transfer_cd:${key}`;
  const headers      = { Authorization: `Bearer ${upstashToken}` };

  try {
    // Check transfer cooldown — max 1 transfer per 7 days per key
    const cdRes  = await fetch(`${upstashUrl}/get/${cooldownKey}`, { headers });
    const cdData = await cdRes.json();
    if (cdData.result) {
      const lastTransfer = new Date(cdData.result);
      const daysSince    = (Date.now() - lastTransfer.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 1) {
        const hoursLeft = Math.ceil((1 - daysSince) * 24);
        return res.status(429).json({
          error: `Przeniesienie licencji możliwe raz na 24 godziny. Następne przeniesienie możliwe za ${hoursLeft} godz.`
        });
      }
    }

    // Get current devices
    const devRes  = await fetch(`${upstashUrl}/get/${devicesKey}`, { headers });
    const devData = await devRes.json();
    let devices   = devData.result ? JSON.parse(devData.result) : [];

    // If already registered on this device — no transfer needed
    if (devices.includes(deviceToken)) {
      return res.status(200).json({ transferred: true, plan: license.planName, note: 'already_registered' });
    }

    // Replace oldest device with new one (FIFO — oldest device loses access)
    if (devices.length >= license.seats) {
      devices.shift(); // remove oldest
    }
    devices.push(deviceToken);

    // Save updated devices
    await fetch(`${upstashUrl}/set/${devicesKey}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(devices), ex: 90 * 24 * 3600 })
    });

    // Set cooldown timestamp
    await fetch(`${upstashUrl}/set/${cooldownKey}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: new Date().toISOString(), ex: 24 * 3600 })
    });

    return res.status(200).json({ transferred: true, plan: license.planName });

  } catch (err) {
    console.error('Transfer error:', err);
    return res.status(500).json({ error: 'Błąd serwera. Spróbuj ponownie.' });
  }
}
