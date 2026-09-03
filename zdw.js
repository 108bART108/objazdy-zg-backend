const cheerio = require('cheerio');
const crypto = require('crypto');
const { extractStreet } = require('./classify');

const PAGE_URL = 'https://www.zdw.zgora.pl/utrudnienia/';

async function fetchZdw() {
  const results = [];
  try {
    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': 'ObjazdyZG-bot/1.0 (+kontakt@twoja-domena.pl)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    $('h3').each((_, el) => {
      const $h3 = $(el);
      const title = $h3.text().replace(/\s+/g, ' ').trim();
      if (!title) return;

      const parts = [];
      let $next = $h3.next();
      let guard = 0;
      while ($next.length && !$next.is('h3') && guard < 20) {
        const t = $next.text().replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
        $next = $next.next();
        guard++;
      }
      const fullText = parts.join(' | ');

      const opisMatch = fullText.match(/opis:\s*\|?\s*(.+)$/i);
      let description = opisMatch ? opisMatch[1] : fullText;
      description = description.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!description) return;

      // Pole "od dnia:" trafia do OBU pol: published_at ORAZ event_date.
      // Dzieki temu dziala to poprawnie w obu sytuacjach:
      // - jesli data jest w przeszlosci (prace juz trwaja od jakiegos czasu)
      //   -> baza uzyje jej jako published_at, pokazujac realny poczatek
      //      prac zamiast falszywie "swiezej" dzisiejszej daty.
      // - jesli data jest w przyszlosci (prace jeszcze sie nie zaczely)
      //   -> baza automatycznie NIE uzyje jej jako published_at (odrzuci
      //      jako zbyt odlegla), ale zostanie zachowana w event_date i
      //      appka pokaze plakietke "za X dni" z wyprzedzeniem.
      const odDniaMatch = fullText.match(/od dnia:\s*\|?\s*(\d{4}-\d{2}-\d{2})/i);
      const odDniaIso = odDniaMatch ? new Date(`${odDniaMatch[1]}T00:00:00`).toISOString() : null;

      const hash = crypto.createHash('md5').update(title + fullText).digest('hex').slice(0, 10);

      results.push({
        source_url: `${PAGE_URL}#${hash}`,
        source_name: 'ZDW Zielona Gora',
        category: 'drogi',
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: odDniaIso,
        event_date: odDniaIso,
      });
    });
  } catch (err) {
    console.error('[zdw] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchZdw };
