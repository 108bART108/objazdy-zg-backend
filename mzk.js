const cheerio = require('cheerio');
const { extractStreet } = require('./classify');
const { qualityCheck } = require('./qualityCheck');
const { extractPolishDate } = require('./polishDates');

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

    // Wstaw spacje w miejscu <br>, zeby sklejone linie nie zlepily sie
    // w jedno slowo po .text() - dotyczy calego dokumentu, nie tylko
    // wybranego akapitu, bo listy (<ul>) tez czesto uzywaja <br>.
    $('br').replaceWith(' ');

    // Krok 1: znajdz PIERWSZY sensowny (nie-boilerplate) akapit dluzszy
    // niz 60 znakow - to nasz kandydat na opis.
    let $candidate = null;
    let candidateText = null;
    $('p').each((_, el) => {
      if (candidateText) return;
      const $el = $(el);
      const t = $el.text().replace(/\s+/g, ' ').trim();
      if (t.length > 60 && !BOILERPLATE_RE.test(t)) {
        $candidate = $el;
        candidateText = t;
      }
    });
    if (!candidateText) return null;

    // Krok 2: jesli akapit KONCZY SIE DWUKROPKIEM, to prawie na pewno
    // zapowiada liste, ktora nastepuje zaraz po nim (np. lista linii
    // autobusowych) - doklejamy ja, zeby nie urywac informacji w polowie.
    if (/:\s*$/.test(candidateText)) {
      const $listEl = $candidate.nextAll('ul, ol').first();
      if ($listEl.length) {
        const items = [];
        $listEl.find('li').each((_, li) => {
          const t = $(li).text().replace(/\s+/g, ' ').trim();
          if (t) items.push(t);
        });
        if (items.length) {
          candidateText = `${candidateText} ${items.join(', ')}`;
        }
      }
    } else if (candidateText.length < 100) {
      // Krok 3: jesli akapit jest krotki i NIE konczy sie dwukropkiem
      // (czyli to raczej niedokonczona/uboga informacja niz zapowiedz
      // listy), doklejamy jeszcze kolejny sensowny akapit dla kontekstu.
      const $nextP = $candidate.nextAll('p').first();
      if ($nextP.length) {
        const nextText = $nextP.text().replace(/\s+/g, ' ').trim();
        if (nextText.length > 20 && !BOILERPLATE_RE.test(nextText)) {
          candidateText = `${candidateText} ${nextText}`;
        }
      }
    }

    return candidateText.slice(0, 400);
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
      // Wyciagamy konkretna date wydarzenia (np. "31 sierpnia") z opisu,
      // a jak jej tam nie ma - probujemy z tytulu. Dzieki temu appka moze
      // pokazac te sama zolta plakietke "Dzisiaj/Jutro/za X dni" co juz
      // dziala dla kategorii Prad (Enea).
      const eventDate = extractPolishDate(description) || extractPolishDate(a.title);
      const checked = qualityCheck({
        source_url: a.href,
        source_name: 'MZK Zielona Gora',
        category: 'mzk',
        title: a.title,
        street: extractStreet(description) || extractStreet(a.title),
        description,
        published_at: a.publishedAt,
        event_date: eventDate ? eventDate.toISOString() : null,
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
