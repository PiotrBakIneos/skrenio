import { validateLicense, checkDevice } from './licenseValidator.js';

const SYSTEM_PROMPT = `Jesteś ekspertem ds. inkluzywnej rekrutacji z 15-letnim doświadczeniem w Polsce. Generujesz pytania screeningowe pozbawione biasów poznawczych.

Na podstawie ogłoszenia o pracę wygeneruj dokładnie 10 pytań screeningowych.

Zwróć WYŁĄCZNIE obiekt JSON (bez żadnego tekstu przed ani po):

{
  "pytania": [
    {
      "pytanie": "string — treść pytania",
      "eliminuje_biasy": ["Bias płci" | "Bias wieku" | "Bias afiliacji" | "Bias potwierdzenia" | "Bias atrakcyjności"],
      "uzasadnienie": "string — jedno zdanie wyjaśniające dlaczego to pytanie jest neutralne"
    }
  ]
}

Zasady generowania pytań:
- Pytania muszą oceniać KOMPETENCJE i DOŚWIADCZENIE, nie cechy osobiste
- Żadnych pytań o wiek, rok ukończenia studiów, stan cywilny, plany rodzinne
- Żadnych pytań które faworyzują konkretną płeć
- Używaj formy bezosobowej lub "Proszę opisać..."
- Pytania muszą być konkretne i mierzalne
- Mix: pytania behawioralne (STAR), sytuacyjne i kompetencyjne
- Nie używaj znaków specjalnych ani nowych linii wewnątrz wartości JSON string
- Odpowiadaj wyłącznie w JSON, zero dodatkowego tekstu`;

function repairJson(str) {
  const stack = [];
  let inStr = false;
  let escape = false;
  for (const ch of str) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return str + stack.reverse().join('');
}

async function callAnthropic(body, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await response.json();
      if (response.status === 529 || (data.error && data.error.type === 'overloaded_error')) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, delayMs * attempt));
          continue;
        }
        throw new Error('Serwer jest chwilowo przeciążony. Spróbuj ponownie za 30 sekund.');
      }
      if (data.error) throw new Error(data.error.message);
      return data;
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Przekroczono limit czasu. Spróbuj ponownie.');
      throw err;
    }
  }
}

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  // Allow: configured origin, any vercel.app preview, localhost dev
  const allowed = (process.env.ALLOWED_ORIGIN || 'https://skrenio.com').split(',').map(s => s.trim());
  const originOk = !origin
    || allowed.some(a => origin === a)
    || origin.endsWith('.vercel.app')
    || origin.startsWith('http://localhost')
    || origin.startsWith('http://127.0.0.1');
  if (!originOk) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Block obvious bots only — don't block browsers with modified UA strings
  const ua = req.headers['user-agent'] || '';
  const isBot = ua.toLowerCase().includes('python-requests') || ua.toLowerCase().includes('go-http');
  if (isBot) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // License validation
  const licenseKey   = req.headers['x-license-key'] || '';
  const deviceToken  = req.headers['x-device-token'] || '';
  const license      = await validateLicense(licenseKey);
  let isLicensed     = license.valid;

  // Device token check — prevents key sharing
  if (isLicensed && licenseKey) {
    const deviceOk = await checkDevice(licenseKey, deviceToken);
    if (!deviceOk) {
      return res.status(402).json({ error: 'To urządzenie nie jest zarejestrowane dla tej licencji. Aktywuj licencję ponownie lub skontaktuj się z kontakt@skrenio.com.' });
    }
  }

  const freeLimit = 5;

  const { jobDesc, cvText } = req.body || {};
  if (!jobDesc) return res.status(400).json({ error: 'Brak treści ogłoszenia.' });
  if (jobDesc.length > 15000) return res.status(400).json({ error: 'Ogłoszenie jest za długie.' });
  if (cvText && cvText.length > 20000) return res.status(400).json({ error: 'CV jest za długie.' });

  // Skip rate limiting for licensed users
  if (!isLicensed && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    const key = `znalezieni_q_ip:${ip}`;
    const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const countRes = await fetch(`${upstashUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${upstashToken}` }
      });
      const countData = await countRes.json();
      if (parseInt(countData.result || '0') >= 5) {
        return res.status(429).json({ error: 'Limit 5 bezpłatnych generowań wykorzystany. Napisz na kontakt@znalezieni.pl.' });
      }
      await fetch(`${upstashUrl}/incr/${key}`, { headers: { Authorization: `Bearer ${upstashToken}` } });
      await fetch(`${upstashUrl}/expire/${key}/2592000`, { headers: { Authorization: `Bearer ${upstashToken}` } });
    } catch (_) {
      console.error('Upstash unavailable — rate limiting skipped for questions');
    }
  }

  try {
    const data = await callAnthropic({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: cvText
        ? `OGŁOSZENIE O PRACĘ:\n${jobDesc}\n\n========\n\nCV KANDYDATA:\n${cvText}\n\nUwaga: masz dostęp do CV kandydata — uwzględnij jego doświadczenie i umiejętności przy formułowaniu pytań, aby były trafniejsze i bardziej spersonalizowane.`
        : `OGŁOSZENIE O PRACĘ:\n${jobDesc}` }]
    });

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    if (start === -1) throw new Error('Nieprawidłowa odpowiedź.');
    let jsonStr = clean.slice(start);
    const end = jsonStr.lastIndexOf('}');
    jsonStr = end === -1 ? repairJson(jsonStr) : jsonStr.slice(0, end + 1);
    const parsed = JSON.parse(jsonStr);
    return res.status(200).json(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Nie udało się przetworzyć odpowiedzi AI. Spróbuj ponownie.' });
    }
    const status = err.message.includes('przeciążony') ? 503 : err.message.includes('limit czasu') ? 504 : 500;
    return res.status(status).json({ error: err.message });
  }
}
