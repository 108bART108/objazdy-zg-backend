const cheerio = require('cheerio');
const { detectCategory, extractStreet } = require('./classify');

// Generyczny mechanizm - obecnie bez zadnego zrodla. ZDW i MZK maja teraz
// wlasne, dedykowane scrapery (zdw.js, mzk.js) dopasowane do ich
// nietypowej struktury stron. Ten plik zostaje w gotowosci na przyszlosc,
// gdyby pojawilo sie nowe zrodlo o standardowej budowie WordPress
// (article/.post/.entry).
const SOURCES = [];

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
