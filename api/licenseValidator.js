// licenseValidator.js — shared license key validation
// Key format: SKR-{P}-{6CHARS}-{YYMMDD}
// P = S (Solo, 1 device) | A (Agencja, 5 devices) | U (Unlimited, 20 devices)
// 6CHARS = SHA-256(secret:plan:yymmdd)[0..6] mapped to safe charset
// YYMMDD = 2-digit year + 2-digit month + 2-digit day of expiry

const PLAN_CONFIG = {
  S: { name: 'Solo',      analyses: 50,  seats: 2  }, // work + home device
  A: { name: 'Agencja',   analyses: 200, seats: 10 }, // 5 recruiters x 2 devices
  U: { name: 'Unlimited', analyses: 600, seats: 30 }, // no real concern
};

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function hash6(input) {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuf);
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += CHARSET[bytes[i] % CHARSET.length];
  }
  return result;
}

// Returns { valid, plan, planName, analyses, seats, reason }
export async function validateLicense(key) {
  if (!key) return { valid: false, reason: 'no_key' };

  const secret = process.env.LICENSE_SECRET;
  if (!secret) {
    console.warn('LICENSE_SECRET not set — skipping license validation');
    return { valid: true, plan: 'U', planName: 'Unlimited', analyses: 600, seats: 20 };
  }

  const parts = key.toUpperCase().trim().split('-');
  if (parts.length !== 4 || parts[0] !== 'SKR') {
    return { valid: false, reason: 'invalid_format' };
  }

  const [, plan, unique, yymmdd] = parts;

  if (!PLAN_CONFIG[plan]) {
    return { valid: false, reason: 'invalid_plan' };
  }

  // Support both YYMMDD (6 digits, new) and YYMM (4 digits, legacy)
  let expiryDate;
  if (yymmdd.length === 6) {
    const yy = parseInt(yymmdd.slice(0, 2), 10);
    const mm = parseInt(yymmdd.slice(2, 4), 10);
    const dd = parseInt(yymmdd.slice(4, 6), 10);
    expiryDate = new Date(2000 + yy, mm - 1, dd, 23, 59, 59);
  } else if (yymmdd.length === 4) {
    // Legacy YYMM — expires last day of that month
    const yy = parseInt(yymmdd.slice(0, 2), 10);
    const mm = parseInt(yymmdd.slice(2, 4), 10);
    expiryDate = new Date(2000 + yy, mm, 0, 23, 59, 59);
  } else {
    return { valid: false, reason: 'invalid_expiry' };
  }

  if (new Date() > expiryDate) {
    return { valid: false, reason: 'expired' };
  }

  // Verify signature
  const expected = await hash6(`${secret}:${plan}:${yymmdd}`);
  if (unique !== expected) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const cfg = PLAN_CONFIG[plan];
  return { valid: true, plan, planName: cfg.name, analyses: cfg.analyses, seats: cfg.seats };
}

// Check if a device token is registered for this key in Upstash
// Returns true if valid, false if not registered or seat limit exceeded
export async function checkDevice(key, deviceToken) {
  if (!deviceToken) return false;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return true; // no Redis = skip check

  const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const redisKey     = `skrenio_devices:${key}`;

  try {
    const res  = await fetch(`${upstashUrl}/get/${redisKey}`, { headers: { Authorization: `Bearer ${upstashToken}` } });
    const data = await res.json();
    const devices = data.result ? JSON.parse(data.result) : [];
    return devices.includes(deviceToken);
  } catch {
    return true; // Redis down — fail open
  }
}
