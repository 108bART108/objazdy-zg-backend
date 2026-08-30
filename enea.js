const cheerio = require('cheerio');
const crypto = require('crypto');
const { extractStreet } = require('./classify');

// Strona Enea Operator nie ma osobnych linkow do kazdego wylaczenia -
// wszystkie wpisy sa na jednej stronie, pogrupowane pod naglowkami
// "Obszar <nazwa>" (znaczniki <h4>), a pod kazdym naglowkiem nastepuja
// akapity z data/godzina oraz lista miejscowosci/ulic.
const URL = 'https://wylaczenia.operator.enea.pl/index.php?rejon=1';

const MONTH_FULL = {
  stycznia: 0, lutego: 1, marca: 2, kwietnia: 3, maja: 4, czerwca: 5,
  lipca: 6, sierpnia: 7, września: 8, wrzesnia: 8, października: 9, pazdziernika: 9,
  listopada: 10, grudnia: 11,
};

// Wpisy zawieraja pelne polskie daty typu "23 lipca 2026 r." - wyciagamy
// pierwsza taka date jako prawdziwa date wylaczenia, zamiast (jak wczesniej)
// znaczyc kazdy wpis data scrapowania.
function parseFullPolishDate(text) {
  const m = text.match(/(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})/iu);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTH_FULL[m[2].toLowerCase()];
  const year = Number(m[3]);
  if (month === undefined) return null;
  const d = new Date(year, month, day);
  return isNaN(d.getTime()) ? null : d;
}

async function fetchEnea() {
  const results = [];
  try {
    const res = await fetch(URL, {
      headers: { 'User-Agent': 'ObjazdyZG-bot/1.0 (+kontakt@twoja-domena.pl)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    $('h4').each((_, el) => {
      const $h4 = $(el);
      const title = $h4.text().trim();
      if (!title || !/^obszar\s/i.test(title)) return;

      const parts = [];
      let $next = $h4.next();
      let guard = 0;
      while ($next.length && !$next.is('h4') && guard < 10) {
        const t = $next.text().trim();
        if (t) parts.push(t);
        $next = $next.next();
        guard++;
      }
      const description = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!description) return;

      const parsedDate = parseFullPolishDate(description) || parseFullPolishDate(title);

      const hash = crypto.createHash('md5').update(title + description).digest('hex').slice(0, 10);

      results.push({
        source_url: `${URL}#${hash}`,
        source_name: 'Enea Operator - wyłączenia prądu',
        category: 'prad',
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: (parsedDate || new Date()).toISOString(),
      });
    });
  } catch (err) {
    console.error('[enea] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchEnea };
