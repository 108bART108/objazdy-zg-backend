const cheerio = require('cheerio');
const { extractStreet } = require('./classify');

// Strona z lista aktualnosci MZK nie pokazuje opisow/zajawek artykulow
// (tylko miniature + data + tytul), wiec prawdziwy opis trzeba pobrac
// z podstrony kazdego artykulu osobno. Prawdziwe artykuly rozpoznajemy
// po charakterystycznej koncowce adresu URL "-iNNN"
// (np. /aktualnosci/objazd-ul-poznanskiej-i1005).
const PAGE_URL = 'https://www.mzk.zgora.pl/aktualnosci';
const HEADERS = { 'User-Agent': 'ObjazdyZG-bot/1.0 (+kontakt@twoja-domena.pl)' };

// Pobiera pierwszy sensowny akapit tresci z podstrony artykulu.
// Krotkie akapity (np. z informacji o cookies w stopce) pomijamy.
async function fetchArticleDescription(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    let found = null;
    $('p').each((_, el) => {
      if (found) return;
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length > 60) found = t;
    });
    return found ? found.slice(0, 400) : null;
  } catch (err) {
    console.error(`[mzk] blad pobierania opisu artykulu (${url}):`, err.message);
    return null;
  }
}

async function fetchMzk() {
  const results = [];
  try {
    const res = await fetch(PAGE_URL, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const base = new URL(PAGE_URL).origin;
    const seen = new Set();
    const articles = [];

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

      // Tekst linku czesto zawiera zduplikowany tytul + date (np. z alt
      // obrazka + podpisu), w stylu "Tytul20.07.2026 Tytul". Wyciagamy
      // czysty tytul i date.
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

      articles.push({ href, title, published_at });
    });

    // Ograniczamy do najnowszych 15 artykulow, zeby nie zalewac serwera
    // MZK duza liczba zapytan przy kazdym scrapowaniu.
    const limited = articles.slice(0, 15);

    const descriptions = await Promise.all(
      limited.map((a) => fetchArticleDescription(a.href))
    );

    limited.forEach((a, i) => {
      const description = descriptions[i] || a.title;
      results.push({
        source_url: a.href,
        source_name: 'MZK Zielona Gora',
        category: 'mzk',
        title: a.title,
        street: extractStreet(description) || extractStreet(a.title),
        description,
        published_at: a.published_at,
      });
    });
  } catch (err) {
    console.error('[mzk] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchMzk };
