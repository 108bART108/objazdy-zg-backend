const cheerio = require('cheerio');
const crypto = require('crypto');
const { extractStreet } = require('./classify');

// Strona ZDW ma wpisy w formie naglowek (h3) + cztery pola etykieta-wartosc:
// "relacja:", "od dnia:", "do dnia:", "opis:". Uzywamy pola "opis:" jako
// tresci, a pola "od dnia:" jako prawdziwej daty wpisu - zamiast (jak
// wczesniej) znaczyc kazdy wpis data scrapowania, co myllo czytelnikow
// sugerujac, ze to swiezy wpis, mimo ze prace trwaja od tygodni.
//
// WSZYSTKIE wpisy linkuja do tego samego adresu (mapa interaktywna
// zud.zdw.zgora.pl), wiec potrzebujemy sztucznego, unikalnego source_url,
// inaczej kolejne wpisy nadpisywalyby sie nawzajem w bazie.
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

      // Prawdziwa data wpisu: pole "od dnia:" (poczatek prac/utrudnienia),
      // w formacie RRRR-MM-DD [HH:MM:SS]. Jesli nie znajdziemy - awaryjnie
      // uzywamy daty scrapowania.
      const odDniaMatch = fullText.match(/od dnia:\s*\|?\s*(\d{4}-\d{2}-\d{2})/i);
      const publishedAt = odDniaMatch
        ? new Date(`${odDniaMatch[1]}T00:00:00`).toISOString()
        : new Date().toISOString();

      const hash = crypto.createHash('md5').update(title + fullText).digest('hex').slice(0, 10);

      results.push({
        source_url: `${PAGE_URL}#${hash}`,
        source_name: 'ZDW Zielona Gora',
        category: 'drogi',
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: publishedAt,
      });
    });
  } catch (err) {
    console.error('[zdw] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchZdw };
