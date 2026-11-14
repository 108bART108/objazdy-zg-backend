const cheerio = require('cheerio');
const crypto = require('crypto');
const { extractStreet } = require('./classify');
const { qualityCheck } = require('./qualityCheck');
const { LIMIT_ZRODLA } = require('./sanitize');

const URL = 'https://wylaczenia.operator.enea.pl/index.php?rejon=1';

// Ile elementow pod naglowkiem obszaru zbieramy, zanim uznamy, ze cos jest
// nie tak ze strona. Petla i tak zatrzymuje sie na nastepnym <h4>.
const MAX_ELEMENTOW_OBSZARU = 40;

// Gorne ograniczenie dlugosci opisu - zabezpieczenie przed zepsuta strona,
// a nie sposob na skracanie listy ulic. Wlasciwy limit nakłada sanitize.js
// i robi to z ostrzezeniem w logach.
const LIMIT_TWARDY_OPISU = LIMIT_ZRODLA;

const MONTH_FULL = {
  stycznia: 0, lutego: 1, marca: 2, kwietnia: 3, maja: 4, czerwca: 5,
  lipca: 6, sierpnia: 7, września: 8, wrzesnia: 8, października: 9, pazdziernika: 9,
  listopada: 10, grudnia: 11,
};

function parseFullPolishDate(text) {
  const m = text.match(/(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})/iu);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTH_FULL[m[2].toLowerCase()];
  const year = Number(m[3]);
  if (month === undefined) return null;
  const d = new Date(year, month, day);
  return isNaN(d.getTime()) ? null : d;
}

async function fetchEnea() {
  const results = [];
  try {
    const res = await fetch(URL, {
      headers: { 'User-Agent': 'UtrudnieniaZG-bot/1.0 (+info@utrudnienia-zg.pl)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    $('h4').each((_, el) => {
      const $h4 = $(el);
      const title = $h4.text().trim();
      if (!title || !/^obszar\s/i.test(title)) return;

      // Zbieramy wszystko az do nastepnego naglowka obszaru. Dawny limit
      // 10 elementow byl cichy: gdyby Enea rozbila dluzsza liste ulic na
      // wiecej akapitow, koncowka znikalaby bez sladu. Petla i tak konczy
      // sie na kolejnym <h4>, wiec wyzszy limit niczego nie psuje, a
      // przekroczenie go zglaszamy.
      const parts = [];
      let $next = $h4.next();
      let guard = 0;
      while ($next.length && !$next.is('h4') && guard < MAX_ELEMENTOW_OBSZARU) {
        const t = $next.text().trim();
        if (t) parts.push(t);
        $next = $next.next();
        guard++;
      }
      if (guard >= MAX_ELEMENTOW_OBSZARU) {
        console.warn(`[enea] UWAGA: "${title}" ma co najmniej ${MAX_ELEMENTOW_OBSZARU} elementow - lista ulic moze byc niepelna`);
      }

      // Opisu NIE przycinamy tu do 400 znakow, jak dawniej. Komunikat Enei
      // to lista adresow - kazda pozycja to czyjs dom, a ucieta lista
      // wyglada po prostu na krotsza, wiec nikt nie zauwazy braku. Dodatkowo
      // obciete opisy trafialy potem do odsiewacza duplikatow, ktory
      // porownuje tresc: dwa rozne wylaczenia, ktore roznia sie dopiero
      // za 400. znakiem, zlewaly sie w jedno i jedno z nich bylo cicho
      // dezaktywowane. Gorne ograniczenie zostaje, ale wysokie - a wlasciwe
      // przyciecie (z ostrzezeniem w logach) robi sanitize.js.
      const description = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, LIMIT_TWARDY_OPISU);
      if (!description) return;

      // Data zaplanowanego wylaczenia idzie do event_date (uzywana do
      // sortowania "co nadchodzi"), a NIE do published_at (ktore ma
      // oznaczac date odkrycia/publikacji przez nas, nie date zdarzenia).
      const parsedDate = parseFullPolishDate(description) || parseFullPolishDate(title);

      const hash = crypto.createHash('md5').update(title + description).digest('hex').slice(0, 10);

      const checked = qualityCheck({
        source_url: `${URL}#${hash}`,
        source_name: 'Enea Operator - wyłączenia prądu',
        category: 'prad',
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: null,
        event_date: parsedDate ? parsedDate.toISOString() : null,
      });
      if (checked.needs_review) {
        console.warn(`[enea] wpis oznaczony do przejrzenia (${title}):`, checked.review_reasons.join('; '));
      }
      results.push(checked);
    });
  } catch (err) {
    console.error('[enea] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchEnea };
