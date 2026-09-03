const cheerio = require('cheerio');
const { extractStreet } = require('./classify');
const { qualityCheck } = require('./qualityCheck');

const PAGE_URL = 'https://www.mzk.zgora.pl/aktualnosci';
const HEADERS = { 'User-Agent': 'ObjazdyZG-bot/1.0 (+kontakt@twoja-domena.pl)' };

// Akapity typu "stopka firmowa" (nazwa spolki, adres, NIP) czesto sa
// dluzsze niz 60 znakow i pojawiaja sie PRZED wlasciwa trescia komunikatu
// - trzeba je jawnie pomijac, zamiast brac "pierwszy dluzszy <p>".
const BOILERPLATE_RE = /sp[oó]łka z ograniczon[aą] odpowiedzialno|\bnip:?\s*\d|\bregon:?\s*\d|pliki?\s+cookies?|ustawie(ń|niami)?\s+(dotycz\S*\s+)?cookies|ustawieniami\s+przegl\p{L}darki|korzystaj\p{L}c\s+z\s+(naszego\s+)?serwisu\s+bez\s+zmiany/iu;

async function fetchArticleDescription(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    let found = null;
    $('p').each((_, el) => {
      if (found) return;
      const $el = $(el);
      // Wstaw spacje w miejscu <br>, zeby sklejone linie (np. nazwa firmy
      // + adres w tym samym <p>) nie zlepily sie w jedno slowo po .text()
      $el.find('br').replaceWith(' ');
      const t = $el.text().replace(/\s+/g, ' ').trim();
      if (t.length > 60 && !BOILERPLATE_RE.test(t)) found = t;
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
      if (!/-i\d+\/?$/.test(href)) return;

      if (href.startsWith('/')) href = `${base}${href}`;
      if (seen.has(href)) return;
      seen.add(href);

      const rawText = $a.text().replace(/\s+/g, ' ').trim();
      if (!rawText) return;

      const dateMatch = rawText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      let title = rawText;
      if (dateMatch) {
        const parts = rawText.split(dateMatch[0]);
        title = (parts[1] || parts[0]).trim();
      }
      if (!title) return;

      // Jesli nie znajdziemy daty w tekscie linku - przekazujemy null
      // (nie date scrapowania), zeby baza mogla sama zdecydowac.
      let publishedAt = null;
      if (dateMatch) {
        const [, dd, mm, yyyy] = dateMatch;
        const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
        if (!isNaN(d.getTime())) publishedAt = d.toISOString();
      }

      articles.push({ href, title, publishedAt });
    });

    const limited = articles.slice(0, 15);
    const descriptions = await Promise.all(
      limited.map((a) => fetchArticleDescription(a.href))
    );

    limited.forEach((a, i) => {
      const description = descriptions[i] || a.title;
      const checked = qualityCheck({
        source_url: a.href,
        source_name: 'MZK Zielona Gora',
        category: 'mzk',
        title: a.title,
        street: extractStreet(description) || extractStreet(a.title),
        description,
        published_at: a.publishedAt,
      });
      if (checked.needs_review) {
        console.warn(`[mzk] wpis oznaczony do przejrzenia (${a.href}):`, checked.review_reasons.join('; '));
      }
      results.push(checked);
    });
  } catch (err) {
    console.error('[mzk] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchMzk };
