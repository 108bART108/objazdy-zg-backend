// Zrodlo #2: strony bez RSS (np. ZDW Zielona Gora, MZK Zielona Gora).
// UWAGA (wazne): w przeciwienstwie do umZgora.js (ktory korzysta z
// oficjalnego RSS i jest gotowy do produkcji), selektory CSS ponizej
// sa PRZYKLADOWE - napisane na podstawie struktury strony w momencie
// tworzenia tego pliku. Strony HTML zmieniaja sie bez ostrzezenia i
// scraping bez RSS zawsze wymaga okresowej konserwacji.
//
// Przed uruchomieniem na produkcji: otworz kazdy adres w przegladarce,
// kliknij prawym -> "Zbadaj element" na jednym wpisie i sprawdz, czy
// selektory ponizej faktycznie pasuja. Zaktualizuj SOURCES.selector.

const cheerio = require('cheerio');
const { detectCategory, extractStreet } = require('./classify');

const SOURCES = [
  {
    name: 'ZDW Zielona Gora',
    url: 'https://www.zdw.zgora.pl/utrudnienia/',
    itemSelector: 'article, .post, .entry',
    titleSelector: 'h2, h3, .entry-title',
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
