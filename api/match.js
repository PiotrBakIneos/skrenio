import { validateLicense, checkDevice } from './licenseValidator.js';

const SYSTEM_PROMPT = `Jesteś ekspertem rekrutera z 15-letnim doświadczeniem w Polsce. Analizujesz dopasowanie kandydata do konkretnej roli.

Zwróć WYŁĄCZNIE obiekt JSON (bez żadnego tekstu przed ani po):

{
  "procent_dopasowania": number (0-100),
  "poziom": "WYSOKI" | "SREDNI" | "NISKI",
  "podsumowanie_dopasowania": "string (1-2 zdania dlaczego pasuje lub nie pasuje do roli)",
  "co_pasuje": ["string", "string", "string"],
  "czego_brakuje": ["string", "string"],
  "rekomendacja": "ZAPROŚ" | "ROZWAŻ" | "ODRZUĆ",
  "uzasadnienie_rekomendacji": "string (1 zdanie uzasadniające decyzję)"
}

Zasady ogólne:
- Bądź bezwzględnie szczery — HR potrzebuje prawdy, nie dyplomacji
- procent_dopasowania: 80-100 tylko dla naprawdę silnych dopasowań, poniżej 40 dla słabych
- WYSOKI: 70-100%, SREDNI: 40-69%, NISKI: 0-39%
- co_pasuje: max 3 krótkie frazy (nie całe zdania) — konkretne elementy CV spełniające wymagania
- czego_brakuje: max 3 krótkie frazy — brakujące umiejętności lub doświadczenie (pusta lista [] jeśli nic nie brakuje)
- Odpowiadaj wyłącznie w JSON, zero dodatkowego tekstu
- Nie używaj znaków specjalnych ani nowych linii wewnątrz wartości JSON string

JĘZYKI — mapowanie na CEFR (FIX 4):
Rozpoznaj polskie opisy i mapuj na poziom CEFR:
- OJCZYSTY / NATIVE / MOTHER TONGUE → Native
- BIEGŁY / PŁYNNY / C2 / C1 → C1-C2 (Advanced)
- BARDZO DOBRY / ZAAWANSOWANY / B2 → B2 (Upper-intermediate)
- DOBRY / KOMUNIKATYWNY / B1 → B1-B2 (Intermediate)
- ŚREDNIO ZAAWANSOWANY / PODSTAWOWY / A2 / A1 → A1-B1 (Basic)
W co_pasuje lub czego_brakuje zawsze podawaj poziom CEFR obok polskiego opisu z CV.
Jeśli zadeklarowany poziom jest zawyżony względem CEFR, dodaj do czego_brakuje jako: "Język X: deklarowany [opis] = realnie [CEFR] — niewystarczający".

DOŚWIADCZENIE — obliczanie stażu (FIX 5):
1. Wypisz każdą rolę z datami (rok rozpoczęcia – rok zakończenia lub "obecnie")
2. Wykryj nakładające się okresy — licz je tylko raz
3. Jeśli daty są niejasne lub brakuje ich — NIE zgaduj, dodaj do czego_brakuje: "Brak dat przy roli [nazwa]"
4. Całkowity staż podaj w podsumowanie_dopasowania jako: "Łączne doświadczenie: X lat (bez nakładań)"

CZERWONE FLAGI — detekcja (FIX 6):
Skanuj pełny tekst CV i wykryj:
- Jawne preferencje PRZECIW wymaganiom roli (np. "nie lubię pracy zespołowej" gdy rola wymaga teamwork)
- Samoopisane ograniczenia sprzeczne z wymaganiami stanowiska
- Luki w zatrudnieniu powyżej 6 miesięcy bez wyjaśnienia
- Zmiany pracy częściej niż co 12 miesięcy (więcej niż 3 razy z rzędu)
- Krytyczne braki wymagań z ogłoszenia
Jeśli wykryto flagę: dodaj do czego_brakuje z prefiksem "🚩 " i zacytuj dokładny fragment z CV w cudzysłowie.
Jeśli brak flag: czego_brakuje zawiera tylko faktycznie brakujące umiejętności.`;

// Parse individual CVs from the combined cvsText block.
// Handles separator: --- CV: <name> --- or --- CV 1: <name> ---
function parseCVs(cvsText) {
  const separatorRegex = /---\s*CV(?:\s+\d+)?:\s*(.+?)\s*---/gi;
  const matches = [...cvsText.matchAll(separatorRegex)];

  if (matches.length === 0) {
    return [{ name: 'Kandydat', text: cvsText.trim() }];
  }

  const cvs = [];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : cvsText.length;
    const text = cvsText.slice(start, end).trim();
    if (text) cvs.push({ name, text });
  }
  return cvs;
}

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
      if (err.name === 'AbortError') throw new Error('Przekroczono limit czasu. Spróbuj z mniejszą liczbą CV.');
      throw err;
    }
  }
}

// Analyze a single CV in complete isolation — no label, no other candidates in context.
async function analyzeOneCv(jobDesc, cvText) {
  const data = await callAnthropic({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    max_tokens: 1500,
    temperature: 0,          // BIAS FIX: deterministic, position-independent scoring
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      // BIAS FIX: CV sent without any label or number — pure content only
      content: `OGŁOSZENIE O PRACĘ:\n${jobDesc}\n\n========\n\nCV KANDYDATA:\n${cvText}`
    }]
  });

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  if (start === -1) throw new Error('Nieprawidłowa odpowiedź serwera.');
  let jsonStr = clean.slice(start);
  const end = jsonStr.lastIndexOf('}');
  jsonStr = end === -1 ? repairJson(jsonStr) : jsonStr.slice(0, end + 1);
  return JSON.parse(jsonStr);
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

  const { jobDesc, cvsText } = req.body || {};
  if (!jobDesc || !cvsText) return res.status(400).json({ error: 'Brak danych wejściowych.' });
  if (jobDesc.length > 15000 || cvsText.length > 80000) return res.status(400).json({ error: 'Za dużo danych wejściowych.' });

  // Skip rate limiting for licensed users
  if (!isLicensed && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    const key = `znalezieni_match_ip:${ip}`;
    const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const countRes = await fetch(`${upstashUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${upstashToken}` }
      });
      const countData = await countRes.json();
      if (parseInt(countData.result || '0') >= 5) {
        return res.status(429).json({ error: 'Limit 5 bezpłatnych analiz dopasowania wykorzystany. Napisz na kontakt@znalezieni.pl.' });
      }
      await fetch(`${upstashUrl}/incr/${key}`, { headers: { Authorization: `Bearer ${upstashToken}` } });
      await fetch(`${upstashUrl}/expire/${key}/2592000`, { headers: { Authorization: `Bearer ${upstashToken}` } });
    } catch (_) {
      console.error('Upstash unavailable — rate limiting skipped for match');
    }
  }

  try {
    // BIAS FIX: Extract role name from job posting for the response envelope
    const roleMatch = jobDesc.match(/(?:stanowisko|rola|pozycja|tytuł)[:\s]+([^\n]+)/i);
    const rola = roleMatch ? roleMatch[1].trim() : 'Stanowisko';

    // BIAS FIX: Parse individual CVs, analyze each in complete isolation
    const cvs = parseCVs(cvsText);

    // Each CV analyzed independently — parallel execution, no shared context
    const results = await Promise.all(
      cvs.map(async (cv) => {
        const result = await analyzeOneCv(jobDesc, cv.text);
        // BIAS FIX: Name re-attached AFTER analysis — never sent to Claude
        return {
          imie_nazwisko: cv.name,
          procent_dopasowania: result.procent_dopasowania,
          poziom: result.poziom,
          podsumowanie_dopasowania: result.podsumowanie_dopasowania,
          co_pasuje: result.co_pasuje,
          czego_brakuje: result.czego_brakuje,
          rekomendacja: result.rekomendacja,
          uzasadnienie_rekomendacji: result.uzasadnienie_rekomendacji,
        };
      })
    );

    // Sort by match percentage descending
    results.sort((a, b) => b.procent_dopasowania - a.procent_dopasowania);

    return res.status(200).json({ rola, kandydaci: results });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Nie udało się przetworzyć odpowiedzi AI. Spróbuj z mniejszą liczbą CV lub krótszymi opisami.' });
    }
    const status = err.message.includes('przeciążony') ? 503 : err.message.includes('limit czasu') ? 504 : 500;
    return res.status(status).json({ error: err.message });
  }
}
