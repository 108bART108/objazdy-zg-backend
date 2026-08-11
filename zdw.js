const cheerio = require('cheerio');
const crypto = require('crypto');
const { extractStreet } = require('./classify');

// Strona ZDW ma wpisy w formie naglowek (h3) + cztery pola etykieta-wartosc:
// "relacja:", "od dnia:", "do dnia:", "opis:". Uzywamy WYLACZNIE pola
// "opis:" jako opisu - to najbardziej niezawodne, czytelne pole. Wczesniej
// probowalismy dodatkowo doklejac "relacje" jako kontekst w nawiasie, ale
// dla niektorych wpisow ta dodatkowa logika lapala za duzo tekstu i
// powodowala zdublowanie tresci - stad uproszczenie.
//
// WSZYSTKIE wpisy linkuja do tego samego adresu (mapa interaktywna
// zud.zdw.zgora.pl), wiec potrzebujemy sztucznego, unikalnego source_url
// (tak jak przy Enea), inaczej kolejne wpisy nadpisywalyby sie nawzajem
// w bazie.
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

      // Zbieramy tekst kolejnych elementow siostrzanych (pola relacja/od
      // dnia/do dnia/opis), az do kolejnego naglowka h3.
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

      // Wyciagamy WYLACZNIE tresc pola "opis:" - najbardziej niezawodne,
      // czytelne pole z realnym opisem prac.
      const opisMatch = fullText.match(/opis:\s*\|?\s*(.+)$/i);
      let description = opisMatch ? opisMatch[1] : fullText;
      description = description.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!description) return;

      const hash = crypto.createHash('md5').update(title + fullText).digest('hex').slice(0, 10);

      results.push({
        source_url: `${PAGE_URL}#${hash}`,
        source_name: 'ZDW Zielona Gora',
        category: 'drogi',
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: new Date().toISOString(),
      });
    });
  } catch (err) {
    console.error('[zdw] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchZdw };
