const SYSTEM_PROMPT = `Jesteś ekspertem doradcy kariery i rekrutera z 15-letnim doświadczeniem w Polsce. Oceniasz dopasowanie kandydata do konkretnego ogłoszenia o pracę.

Zwróć WYŁĄCZNIE obiekt JSON (bez żadnego tekstu przed ani po):

{
  "procent_dopasowania": number (0-100),
  "poziom": "WYSOKI" | "SREDNI" | "NISKI",
  "podsumowanie": "string (1-2 zdania — dlaczego kandydat pasuje lub nie pasuje do tej roli)",
  "co_pasuje": ["string", "string", "string"],
  "czego_brakuje": ["string", "string"],
  "rekomendacja": "APLIKUJ" | "ROZWAŻ" | "POMIŃ"
}

Zasady ogólne:
- Oceniasz z perspektywy kandydata — czy warto aplikować na tę rolę?
- procent_dopasowania: 80-100 tylko dla naprawdę silnych dopasowań, poniżej 40 dla słabych
- WYSOKI: 70-100%, SREDNI: 40-69%, NISKI: 0-39%
- co_pasuje: max 3 krótkie frazy — konkretne elementy CV spełniające wymagania ogłoszenia
- czego_brakuje: max 3 krótkie frazy — czego kandydatowi brakuje do tej roli ([] jeśli nic)
- APLIKUJ: kandydat spełnia ≥70% wymagań
- ROZWAŻ: kandydat spełnia 40-69% wymagań, warto spróbować
- POMIŃ: kandydat spełnia <40% wymagań
- Odpowiadaj wyłącznie w JSON, zero dodatkowego tekstu
- Nie używaj znaków specjalnych ani nowych linii wewnątrz wartości JSON string

JĘZYKI — mapowanie na CEFR:
- OJCZYSTY / NATIVE → Native
- BIEGŁY / PŁYNNY / C2 / C1 → C1-C2 (Advanced)
- BARDZO DOBRY / ZAAWANSOWANY / B2 → B2 (Upper-intermediate)
- DOBRY / KOMUNIKATYWNY / B1 → B1-B2 (Intermediate)
- ŚREDNIO ZAAWANSOWANY / PODSTAWOWY / A2 / A1 → A1-B1 (Basic)
Porównaj wymagania językowe ogłoszenia z poziomem kandydata. Zaznacz lukę jeśli istnieje.

DOŚWIADCZENIE:
Porównaj wymagany staż z ogłoszenia z doświadczeniem kandydata.
Jeśli okresy nakładają się — licz raz. Nie zgaduj brakujących dat.`;

// Parse individual job postings from combined text.
// Separator: --- Ogłoszenie: <title> --- or --- Rola: <title> ---
function parseJobPostings(text) {
  const sepRe = /---\s*(?:Ogłoszenie|Rola|Stanowisko):\s*(.+?)\s*---/gi;
  const matches = [...text.matchAll(sepRe)];

  if (matches.length === 0) {
    // No separator — treat entire block as one posting
    return [{ title: 'Stanowisko', text: text.trim() }];
  }

  const jobs = [];
  for (let i = 0; i < matches.length; i++) {
    const title = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const jobText = text.slice(start, end).trim();
    if (jobText) jobs.push({ title, text: jobText });
  }
  return jobs;
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
      if (err.name === 'AbortError') throw new Error('Przekroczono limit czasu analizy.');
      throw err;
    }
  }
}

// Match one CV against one job posting in complete isolation.
async function matchOneJob(cvText, jobText) {
  const data = await callAnthropic({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    max_tokens: 1000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `CV KANDYDATA:\n${cvText}\n\n========\n\nOGŁOSZENIE O PRACĘ:\n${jobText}`
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
  const allowed = process.env.ALLOWED_ORIGIN || 'https://skrenio.pl';
  if (origin && origin !== allowed && !origin.endsWith('.vercel.app')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Block headless/bot user-agents with no browser signature
  const ua = req.headers['user-agent'] || '';
  if (!ua || ua.toLowerCase().includes('python-requests') || ua.toLowerCase().includes('curl/') || ua.toLowerCase().includes('go-http') || ua.toLowerCase().includes('axios/')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cvText, jobsText } = req.body || {};
  if (!cvText || !jobsText) return res.status(400).json({ error: 'Brak danych wejściowych.' });
  if (cvText.length > 20000) return res.status(400).json({ error: 'CV jest za długie (maks. 20 000 znaków).' });
  if (jobsText.length > 80000) return res.status(400).json({ error: 'Za dużo ogłoszeń (maks. 80 000 znaków).' });

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    const key = `skrenio_reverse_ip:${ip}`;
    const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const countRes = await fetch(`${upstashUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${upstashToken}` }
      });
      const countData = await countRes.json();
      if (parseInt(countData.result || '0') >= 5) {
        return res.status(429).json({ error: 'Limit 5 bezpłatnych analiz dopasowania odwróconego wykorzystany. Napisz na kontakt@skrenio.pl.' });
      }
      await fetch(`${upstashUrl}/incr/${key}`, { headers: { Authorization: `Bearer ${upstashToken}` } });
      await fetch(`${upstashUrl}/expire/${key}/2592000`, { headers: { Authorization: `Bearer ${upstashToken}` } });
    } catch (_) {
      console.error('Upstash unavailable — rate limiting skipped for reverse');
    }
  }

  try {
    const jobs = parseJobPostings(jobsText);
    if (jobs.length > 10) {
      return res.status(400).json({ error: 'Maksymalnie 10 ogłoszeń naraz.' });
    }

    // Process in batches of 3 sequentially to stay within Vercel timeout
    const BATCH = 3;
    const results = [];
    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(async (job) => {
          const result = await matchOneJob(cvText, job.text);
          return {
            tytul: job.title,
            procent_dopasowania: result.procent_dopasowania,
            poziom: result.poziom,
            podsumowanie: result.podsumowanie,
            co_pasuje: result.co_pasuje,
            czego_brakuje: result.czego_brakuje,
            rekomendacja: result.rekomendacja,
          };
        })
      );
      results.push(...batchResults);
    }

    // Sort by match percentage descending
    results.sort((a, b) => b.procent_dopasowania - a.procent_dopasowania);

    return res.status(200).json({ oferty: results });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Nie udało się przetworzyć odpowiedzi AI. Spróbuj ponownie.' });
    }
    const status = err.message.includes('przeciążony') ? 503 : err.message.includes('limit czasu') ? 504 : 500;
    return res.status(status).json({ error: err.message });
  }
}
