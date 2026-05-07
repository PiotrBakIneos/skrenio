import { validateLicense } from './licenseValidator.js';

export default async function handler(req, res) {
  // CORS
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
  if (typeof deviceToken !== 'string' || deviceToken.length < 16 || deviceToken.length > 64) {
    return res.status(400).json({ error: 'Nieprawidłowy token urządzenia.' });
  }

  // Validate the license key itself
  const license = await validateLicense(key);
  if (!license.valid) {
    const msgs = {
      expired:           'Licencja wygasła. Skontaktuj się z kontakt@skrenio.com aby odnowić.',
      invalid_format:    'Nieprawidłowy format klucza licencji.',
      invalid_signature: 'Klucz licencji jest nieprawidłowy.',
      invalid_plan:      'Nieznany plan licencji.',
    };
    return res.status(402).json({ error: msgs[license.reason] || 'Nieprawidłowy klucz licencji.' });
  }

  // Without Upstash — no device tracking possible, just confirm key is valid
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(200).json({ activated: true, plan: license.planName, seats: license.seats });
  }

  const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const redisKey     = `skrenio_devices:${key}`;
  const maxSeats     = license.seats;

  try {
    // Get current registered devices for this key
    const getRes  = await fetch(`${upstashUrl}/get/${redisKey}`, { headers: { Authorization: `Bearer ${upstashToken}` } });
    const getData = await getRes.json();
    const devices = getData.result ? JSON.parse(getData.result) : [];

    // If this device is already registered — allow
    if (devices.includes(deviceToken)) {
      return res.status(200).json({ activated: true, plan: license.planName, seats: license.seats, device: 'existing' });
    }

    // Check seat limit
    if (devices.length >= maxSeats) {
      return res.status(402).json({
        error: `Osiągnięto limit urządzeń dla planu ${license.planName} (${maxSeats} urządzenie/urządzeń).`,
        code: 'SEATS_FULL',
        seats: maxSeats,
        plan: license.planName
      });
    }

    // Register new device
    const updated = JSON.stringify([...devices, deviceToken]);
    // Set with expiry matching the license (90 days max TTL in Redis)
    await fetch(`${upstashUrl}/set/${redisKey}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${upstashToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: updated, ex: 90 * 24 * 3600 })
    });

    return res.status(200).json({ activated: true, plan: license.planName, seats: license.seats, device: 'new', registered: devices.length + 1 });
  } catch (err) {
    console.error('Activation error:', err);
    // Fail open — if Redis is down, allow the activation
    return res.status(200).json({ activated: true, plan: license.planName, seats: license.seats, device: 'unchecked' });
  }
}
