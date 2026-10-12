const cheerio = require('cheerio');
const { extractStreet } = require('./classify');

const PAGE_URL = 'https://www.zwik.zgora.pl/aktualnosci/awarie-i-remonty/';
const PERMALINK_RE = /^https?:\/\/www\.zwik\.zgora\.pl\/\d{4}\/\d{2}\/[a-z0-9-]+\/?$/i;
const NOISE_TEXTS = [
  'czytaj więcej', 'awarie i remonty', 'strona główna',
  'uncategorized', 'bez kategorii', 'aktualności', 'komunikaty',
];

// Metadane wpisu, ktore WordPress potrafi wkleic przed wlasciwa trescia.
// Dwa warianty daty: "Dzisiaj o 08:15" oraz "1 godzine temu".
const LEADING_DATE_RE = new RegExp(
  '^\\s*(?:'
  + '(?:Dzisiaj|Wczoraj|\\d{1,2}\\s+\\p{L}+)\\s+o\\s+\\d{2}:\\d{2}'
  + '|\\d+\\s+\\p{L}+\\s+temu'
  + ')\\s*[,;:·|\\u2013\\u2014-]*\\s*',
  'iu',
);
const LEADING_CATEGORY_RE = new RegExp(
  '^\\s*(?:Uncategorized|Bez kategorii|Aktualno\\u015bci|Awarie i remonty|Komunikaty)'
  + '\\s*[,;:·|\\u2013\\u2014-]*\\s*',
  'iu',
);

// Metadane moga wystapic jedna po drugiej ("1 godzine temu, Uncategorized ..."),
// wiec obcinamy je w petli az do skutku.
function stripLeadingMeta(text) {
  let out = text;
  for (let i = 0; i < 6; i += 1) {
    const before = out;
    out = out.replace(LEADING_DATE_RE, '').replace(LEADING_CATEGORY_RE, '');
    if (out === before) break;
  }
  return out;
}

const MONTH_ABBR = {
  sty: 0, lut: 1, mar: 2, kwi: 3, maj: 4, cze: 5,
  lip: 6, sie: 7, wrz: 8, paz: 9, paź: 9, lis: 10, gru: 11,
};

// "1 godzine temu", "3 dni temu", "2 tygodnie temu", "5 miesiecy temu"
const AGO_UNITS = [
  { re: /^minut/i, ms: 60 * 1000 },
  { re: /^godzin/i, ms: 60 * 60 * 1000 },
  { re: /^(dni|dzie)/i, ms: 24 * 60 * 60 * 1000 },
  { re: /^(tydz|tygod)/i, ms: 7 * 24 * 60 * 60 * 1000 },
  { re: /^miesi/i, ms: 30 * 24 * 60 * 60 * 1000 },
  { re: /^(rok|lat)/i, ms: 365 * 24 * 60 * 60 * 1000 },
];

function parseAgoDate(text, now) {
  const m = text.match(/^\s*(\d+)\s+(\p{L}+)\s+temu/iu);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999) return null;
  const unit = AGO_UNITS.find((u) => u.re.test(m[2]));
  if (!unit) return null;
  return new Date(now.getTime() - amount * unit.ms);
}

function parseRelativeDate(text, now) {
  const ago = parseAgoDate(text, now);
  if (ago) return ago;

  let m = text.match(/^Dzisiaj\s+o\s+(\d{2}):(\d{2})/i);
  if (m) {
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  }
  m = text.match(/^Wczoraj\s+o\s+(\d{2}):(\d{2})/i);
  if (m) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  }
  m = text.match(/^(\d{1,2})\s+([a-zżźćąśęłóń]{3})[a-zżźćąśęłóń]*\s+o\s+(\d{2}):(\d{2})/iu);
  if (m) {
    const day = Number(m[1]);
    const month = MONTH_ABBR[m[2].toLowerCase()];
    if (month !== undefined) {
      const d = new Date(now.getFullYear(), month, day, Number(m[3]), Number(m[4]));
      if (d.getTime() > now.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1);
      return d;
    }
  }
  return null;
}

async function fetchZwik() {
  const results = [];
  try {
    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': 'ObjazdyZG-bot/1.0 (+kontakt@twoja-domena.pl)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const base = new URL(PAGE_URL).origin;
    const seen = new Set();
    const now = new Date();

    $('h2').each((_, el) => {
      const $h2 = $(el);
      const $a = $h2.find('a[href]').first();
      let href = $a.attr('href') || '';
      if (href.startsWith('/')) href = `${base}${href}`;
      if (!PERMALINK_RE.test(href)) return;
      if (seen.has(href)) return;
      seen.add(href);

      const title = $h2.text().replace(/\s+/g, ' ').trim();
      if (!title) return;

      const parts = [];
      let $next = $h2.next();
      let guard = 0;
      while ($next.length && !$next.is('h2') && guard < 8) {
        const t = $next.text().replace(/\s+/g, ' ').trim();
        const isNoise = !t || NOISE_TEXTS.some((n) => t.toLowerCase() === n || t.toLowerCase().startsWith(n));
        if (t && !isNoise) parts.push(t);
        $next = $next.next();
        guard++;
      }
      const rawText = parts.join(' ');

      // Jesli nie uda sie rozpoznac daty - przekazujemy null (nie "teraz"!).
      // Baza danych sama zdecyduje: dla nowego wpisu uzyje dzisiejszej daty
      // jako jedynego rozsadnego przyblizenia, a dla juz istniejacego wpisu
      // ZACHOWA poprzednio zapisana, dobra date zamiast ja nadpisywac.
      const parsedDate = parseRelativeDate(rawText, now);

      const description = stripLeadingMeta(rawText)
        .replace(/Awarie i remonty/gi, '')
        .replace(/Czytaj więcej/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
      if (!description) return;

      results.push({
        source_url: href,
        source_name: 'ZWiK Zielona Gora',
        category: 'wodociagi',
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: parsedDate ? parsedDate.toISOString() : null,
      });
    });
  } catch (err) {
    console.error('[zwik] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchZwik };
