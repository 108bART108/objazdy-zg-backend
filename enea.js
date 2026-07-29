const cheerio = require('cheerio');
const { extractStreet } = require('./classify');

// Strona Enea Operator (Rejon Dystrybucji Zielona Gora) nie ma osobnych linkow
// do kazdego wylaczenia - wszystkie wpisy sa na jednej stronie, pogrupowane
// pod naglowkami "Obszar <nazwa>" (znaczniki <h4>), a pod kazdym naglowkiem
// nastepuja akapity z data/godzina oraz lista miejscowosci/ulic.
const URL = 'https://wylaczenia.operator.enea.pl/index.php?rejon=1';

async function fetchEnea() {
  const results = [];
  try {
    const res = await fetch(URL, {
      headers: { 'User-Agent': 'ObjazdyZG-bot/1.0 (+kontakt@twoja-domena.pl)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    $('h4').each((_, el) => {
      const $h4 = $(el);
      const title = $h4.text().trim();
      // Prawdziwe wpisy zaczynaja sie od "Obszar ..." - pomijamy inne naglowki h4,
      // jesli jakies znajda sie gdzie indziej na stronie (np. w stopce).
      if (!title || !/^obszar\s/i.test(title)) return;

      // Zbieramy tekst kolejnych elementow siostrzanych, dopoki nie trafimy
      // na kolejny naglowek h4 (czyli kolejny wpis) lub koniec listy.
      const parts = [];
      let $next = $h4.next();
      let guard = 0;
      while ($next.length && !$next.is('h4') && guard < 10) {
        const t = $next.text().trim();
        if (t) parts.push(t);
        $next = $next.next();
        guard++;
      }
      const description = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);

      // Pomijamy wpisy bez opisu - to samo zabezpieczenie co w htmlSources.js
      if (!description) return;

      results.push({
        source_url: URL,
        source_name: 'Enea Operator - wyłączenia prądu',
        category: 'prad',
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: new Date().toISOString(),
      });
    });
  } catch (err) {
    console.error('[enea] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchEnea };
