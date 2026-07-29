const cheerio = require('cheerio');
const { extractStreet } = require('./classify');

// Strona z lista aktualnosci MZK nie pokazuje opisow/zajawek artykulow
// (tylko miniature + data + tytul), wiec generyczny mechanizm z htmlSources.js
// (ktory wymaga opisu) pomijalby tu wszystko. Dlatego osobny scraper:
// znajdujemy prawdziwe artykuly po charakterystycznym wzorcu adresu PAGE_URL
// (koncowka "-iNNN", np. /aktualnosci/objazd-ul-poznanskiej-i1005),
// a jako opis uzywamy tytulu (pelna tresc jest tylko na podstronie artykulu).
const PAGE_URL = 'https://www.mzk.zgora.pl/aktualnosci';

async function fetchMzk() {
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

    $('a[href*="/aktualnosci/"]').each((_, el) => {
      const $a = $(el);
      let href = $a.attr('href') || '';
      // Tylko prawdziwe artykuly maja koncowke "-iNNN" w adresie,
      // linki do samej listy/kategorii jej nie maja.
      if (!/-i\d+\/?$/.test(href)) return;

      if (href.startsWith('/')) href = `${base}${href}`;
      if (seen.has(href)) return;
      seen.add(href);

      const rawText = $a.text().replace(/\s+/g, ' ').trim();
      if (!rawText) return;

      // Tekst linku czesto zawiera zduplikowany tytul + date (np. z alt obrazka
      // + podpisu), w stylu "Tytul20.07.2026 Tytul". Wyciagamy czysty tytul
      // i date.
      const dateMatch = rawText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      let title = rawText;
      if (dateMatch) {
        const parts = rawText.split(dateMatch[0]);
        title = (parts[1] || parts[0]).trim();
      }
      if (!title) return;

      let published_at = new Date().toISOString();
      if (dateMatch) {
        const [, dd, mm, yyyy] = dateMatch;
        const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
        if (!isNaN(d.getTime())) published_at = d.toISOString();
      }

      results.push({
        source_url: href,
        source_name: 'MZK Zielona Gora',
        category: 'mzk',
        title,
        street: extractStreet(title),
        description: title,
        published_at,
      });
    });
  } catch (err) {
    console.error('[mzk] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchMzk };
