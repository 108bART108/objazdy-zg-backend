const cheerio = require('cheerio');
const { detectCategory, extractStreet } = require('./classify');

const SOURCES = [
  {
    name: 'ZDW Zielona Gora',
    url: 'https://www.zdw.zgora.pl/utrudnienia/',
    itemSelector: 'article, .post, .entry',
    titleSelector: 'h2, h3',
    linkSelector: 'a',
    descSelector: 'p',
    defaultCategory: 'drogi',
  },
  {
    name: 'MZK Zielona Gora',
    url: 'https://www.mzk.zgora.pl/aktualnosci',
    itemSelector: 'article, .post, .news-item',
    titleSelector: 'h2, h3, .title',
    linkSelector: 'a',
    descSelector: 'p',
    defaultCategory: 'mzk',
  },
  {
    // UWAGA: strona Enea Operator ma nietypowa, starsza budowe HTML (nie WordPress).
    // Te selektory sa najlepszym mozliwym oszacowaniem bez podgladu zywego kodu
    // strony - PO WDROZENIU NALEZY SPRAWDZIC LOGI I WYNIKI. Jesli scraper zwraca
    // 0 wpisow albo smieciowe dane, trzeba bedzie dopasowac selektory na podstawie
    // rzeczywistej struktury strony (Narzedzia deweloperskie > Zbadaj element
    // na wylaczenia-eneaoperator.pl).
    name: 'Enea Operator - wylaczenia',
    url: 'https://wylaczenia-eneaoperator.pl/index.php?oddzial=Zielona+G%C3%B3ra',
    itemSelector: 'li, tr, .info, .wylaczenie, article',
    titleSelector: 'strong, b, h2, h3, td:first-child',
    linkSelector: 'a',
    descSelector: 'p, td',
    defaultCategory: 'prad',
  },
];

async function fetchOne(source) {
  const results = [];
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'ObjazdyZG-bot/1.0 (+kontakt@twoja-domena.pl)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    $(source.itemSelector).each((_, el) => {
      const $el = $(el);
      const titleEl = $el.find(source.titleSelector).first();
      const title = titleEl.text().trim();
      if (!title) return;

      let link = $el.find(source.linkSelector).first().attr('href') || source.url;
      if (link.startsWith('/')) {
        const base = new URL(source.url);
        link = `${base.origin}${link}`;
      }

      const description = $el.find(source.descSelector).first().text().trim().slice(0, 400);

      // Pomijamy wpisy bez opisu - to zwykle nawigacja/naglowek strony
      // zlapany przez zbyt szeroki selektor, a nie prawdziwe zgloszenie
      // utrudnienia. Prawdziwe wpisy zawsze maja jakis opis.
      if (!description) return;

      const text = `${title} ${description}`;

      results.push({
        source_url: link,
        source_name: source.name,
        category: detectCategory(text) || source.defaultCategory,
        title,
        street: extractStreet(title),
        description,
        published_at: new Date().toISOString(),
      });
    });
  } catch (err) {
    console.error(`[htmlSources] blad pobierania ${source.name} (${source.url}):`, err.message);
  }
  return results;
}

async function fetchHtmlSources() {
  const all = [];
  for (const source of SOURCES) {
    const items = await fetchOne(source);
    all.push(...items);
  }
  return all;
}

module.exports = { fetchHtmlSources };
