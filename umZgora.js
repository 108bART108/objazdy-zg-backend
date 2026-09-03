// Zrodlo #1: oficjalny RSS Urzedu Miasta Zielona Gora (WordPress).
// WordPress domyslnie wystawia kanal RSS pod adresem /feed/ dla kazdego
// tagu/kategorii/calej strony, wiec to najbardziej stabilne zrodlo -
// nie zalezy od zmian w HTML/CSS strony, jak zwykly scraping.

const Parser = require('rss-parser');
const parser = new Parser();
const { detectCategory, extractStreet } = require('./classify');
const { qualityCheck } = require('./qualityCheck');
const { extractPolishDate } = require('./polishDates');

// Mozna dodac wiecej tagow, np. 'mzk', 'ofensywa-drogowa' - kazdy tag WP ma wlasny feed.
const FEEDS = [
  { url: 'https://www.zielona-gora.pl/tag/drogi-w-zielonej-gorze/feed/', name: 'UM Zielona Gora' },
  { url: 'https://www.zielona-gora.pl/tag/ofensywa-drogowa/feed/', name: 'UM Zielona Gora' },
];

async function fetchUmZgora() {
  const results = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items) {
        const text = `${item.title} ${item.contentSnippet || ''}`;
        const description = (item.contentSnippet || '').slice(0, 400);
        const eventDate = extractPolishDate(description) || extractPolishDate(item.title);
        const checked = qualityCheck({
          source_url: item.link,
          source_name: feed.name,
          category: detectCategory(text),
          title: item.title,
          street: extractStreet(item.title),
          description,
          published_at: item.isoDate || item.pubDate || new Date().toISOString(),
          event_date: eventDate ? eventDate.toISOString() : null,
        });
        if (checked.needs_review) {
          console.warn(`[umZgora] wpis oznaczony do przejrzenia (${item.link}):`, checked.review_reasons.join('; '));
        }
        results.push(checked);
      }
    } catch (err) {
      console.error(`[umZgora] blad pobierania ${feed.url}:`, err.message);
    }
  }

  return results;
}

module.exports = { fetchUmZgora };
