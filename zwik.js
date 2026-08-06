const cheerio = require('cheerio');
const { extractStreet } = require('./classify');

// Strona ZWiK (Zielonogorskie Wodociagi i Kanalizacja) jest zbudowana w
// WPBakery Page Builder, ktory nie uzywa standardowych znacznikow
// <article>/.post/.entry - generyczny scraper z htmlSources.js nic by tu
// nie znalazl. Zamiast zgadywac niestandardowe klasy CSS, identyfikujemy
// prawdziwe wpisy po charakterystycznym wzorcu adresu URL (data-permalink
// WordPressa: /RRRR/MM/nazwa-wpisu/), a opis zbieramy z tekstu wystepujacego
// zaraz po tytule (h2), az do kolejnego naglowka h2.
const PAGE_URL = 'https://www.zwik.zgora.pl/aktualnosci/awarie-i-remonty/';
const PERMALINK_RE = /^https?:\/\/www\.zwik\.zgora\.pl\/\d{4}\/\d{2}\/[a-z0-9-]+\/?$/i;
const NOISE_TEXTS = ['czytaj więcej', 'awarie i remonty', 'strona główna'];

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
      const description = parts.join(' ').trim().slice(0, 400);
      if (!description) return;

      results.push({
        source_url: href,
        source_name: 'ZWiK Zielona Gora',
        category: 'wodociagi',
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: new Date().toISOString(),
      });
    });
  } catch (err) {
    console.error('[zwik] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchZwik };
