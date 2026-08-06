const cheerio = require('cheerio');
const crypto = require('crypto');
const { extractStreet } = require('./classify');

// Strona ZDW ma wpisy w formie naglowek (h3) + cztery pola etykieta-wartosc:
// "relacja:", "od dnia:", "do dnia:", "opis:". Generyczny scraper braby
// pierwszy napotkany akapit jako opis, czyli najczesciej pole "relacja:",
// a nie prawdziwy opis prac. Dodatkowo WSZYSTKIE wpisy linkuja do tego
// samego adresu (mapa interaktywna zud.zdw.zgora.pl), wiec potrzebujemy
// sztucznego, unikalnego source_url (tak jak przy Enea), inaczej kolejne
// wpisy nadpisywalyby sie nawzajem w bazie.
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

      const linkHref = $h3.find('a[href]').first().attr('href') || PAGE_URL;

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

      // Wyciagamy konkretnie tresc pola "opis:" - to jest prawdziwy,
      // czytelny opis prac, a nie same dane techniczne (relacja/daty).
      const opisMatch = fullText.match(/opis:\s*\|?\s*(.+?)(?:\s*\|\s*(?:relacja|od dnia|do dnia):|$)/i);
      let description = opisMatch ? opisMatch[1] : fullText;
      description = description.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!description) return;

      // Dodajemy kontekst trasy (relacja) na poczatku opisu, jesli go znalezlismy
      const relacjaMatch = fullText.match(/relacja:\s*\|?\s*(.+?)(?:\s*\|\s*(?:od dnia|do dnia|opis):|$)/i);
      const relacja = relacjaMatch ? relacjaMatch[1].replace(/\s*\|\s*/g, ' ').trim() : '';
      const fullDescription = relacja ? `[${relacja}] ${description}` : description;

      const hash = crypto.createHash('md5').update(title + fullText).digest('hex').slice(0, 10);

      results.push({
        source_url: `${PAGE_URL}#${hash}`,
        source_name: 'ZDW Zielona Gora',
        category: 'drogi',
        title,
        street: extractStreet(fullDescription) || extractStreet(title),
        description: fullDescription.slice(0, 400),
        published_at: new Date().toISOString(),
      });
    });
  } catch (err) {
    console.error('[zdw] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchZdw };
