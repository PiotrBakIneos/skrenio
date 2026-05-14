import { validateSession } from './sessionValidator.js';

const SYSTEM_PROMPT = `Jesteś narzędziem do anonimizacji CV. Twoim zadaniem jest usunięcie wszystkich danych osobowych z CV kandydatów.

Zasady anonimizacji:
- Imiona i nazwiska → zastąp "Kandydat A", "Kandydat B" itd. (kolejno według kolejności pojawiania się)
- Adresy email → zastąp [email]
- Numery telefonów → zastąp [telefon]
- Adresy fizyczne (ulica, miasto, kod pocztowy) → zastąp [adres]
- Daty urodzenia lub roczniki urodzenia → zastąp [data]
- Linki LinkedIn, GitHub, portfolio lub inne URL z profilem osobistym → zastąp [profil]
- Referencje do zdjęć ("Zdjęcie:", "Photo:") → usuń całą linię
- NIE usuwaj: nazw firm, stanowisk, uczelni, certyfikatów, umiejętności technicznych, języków

Zachowaj dokładnie tę samą strukturę separatorów co w danych wejściowych (np. "--- CV 1: ... ---").

Na OSTATNIEJ LINII odpowiedzi (oddzielonej od tekstu CV pustą linią) zwróć WYŁĄCZNIE obiekt JSON:
{"usunieto":{"imiona":N,"emaile":N,"telefony":N,"adresy":N}}

gdzie N to liczba zastąpionych elementów każdego typu. Zero jeśli nic nie usunięto.
Nie dodawaj żadnego innego tekstu poza zanonimizowanym CV i końcowym JSON.`;

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
      if (err.name === 'AbortError') throw new Error('Przekroczono limit czasu anonimizacji. Spróbuj z mniejszą liczbą CV.');
      throw err;
    }
  }
}

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const allowed = (process.env.ALLOWED_ORIGIN || 'https://skrenio.com,https://www.skrenio.com').split(',').map(s => s.trim());
  const originOk = !origin                              // no origin header = same-origin or server-to-server
    || origin === 'null'                                // file:// protocol sends literal "null"
    || allowed.some(a => origin === a)                  // exact match on configured domains
    || origin.endsWith('.vercel.app')                   // any Vercel preview
    || origin.includes('.vercel.app')                   // Vercel preview with subdomain prefix
    || origin.startsWith('http://localhost')            // local dev
    || origin.startsWith('http://127.0.0.1')            // local dev
    || origin.startsWith('https://localhost');          // local dev with https
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

  // Session validation — check if user is logged in with active subscription
  const sessionToken = req.headers['x-session-token'] || '';
  const session      = await validateSession(sessionToken);
  const isLicensed   = session.valid;
  const freeLimit    = 5;

  const { cvsText } = req.body || {};
  if (!cvsText) return res.status(400).json({ error: 'Brak tekstu CV.' });
  if (cvsText.length > 80000) return res.status(400).json({ error: 'Za dużo danych wejściowych.' });

  try {
    const data = await callAnthropic({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `CV DO ANONIMIZACJI:\n${cvsText}` }]
    });

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    const lines = text.trimEnd().split('\n');
    let usunieto = { imiona: 0, emaile: 0, telefony: 0, adresy: 0 };

    let jsonLineIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (l.startsWith('{') && l.includes('usunieto')) {
        jsonLineIdx = i;
        try { usunieto = JSON.parse(l).usunieto || usunieto; } catch (_) {}
        break;
      }
      if (l !== '') break;
    }

    if (jsonLineIdx !== -1) {
      lines.splice(jsonLineIdx, lines.length - jsonLineIdx);
    }

    const anonymizedText = lines.join('\n').trimEnd();
    return res.status(200).json({ anonymizedText, usunieto });
  } catch (err) {
    const status = err.message.includes('przeciążony') ? 503 : err.message.includes('limit czasu') ? 504 : 500;
    return res.status(status).json({ error: err.message });
  }
}
