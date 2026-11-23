// Sonda nr 7 - próba na żywo PRZED wdrożeniem źródła "gminy".
// TYLKO DO CZYTANIA: nie dotyka bazy, nie zapisuje plików, nie wysyła push.
//     node sonda7.js
//
// PO CO: logika w gminy.js jest sprawdzona 57 warunkami, ale na PRÓBKACH -
// na tym, co kanały RSS oddały 23.11.2026 o 10:52. Ta sonda uruchamia
// DOKŁADNIE ten sam kod produkcyjny (przetworzWpisy z gminy.js) na tym, co
// kanały wysyłają w tej chwili. Różnica między "parser działa na moich
// próbkach" a "parser działa na prawdziwych danych" kosztowała nas w tym
// projekcie już kilka błędów - m.in. urwany komunikat MZK o ul. Zacisze
// i cztery wpadki przy PZZD.
//
// Sonda może to zrobić bezpiecznie, bo gminy.js nie importuje db.js -
// cały łańcuch to classify, qualityCheck, polishDates i sanitize, czyli
// same funkcje liczące, bez zapisu.
//
// NA CO PATRZEĆ W WYNIKU:
//   1. ODRZUCONE - czy filtr nie wyrzucił prawdziwej awarii wody,
//   2. (zakończona) - czy znacznik nie trafił na trwającą awarię,
//   3. "opis urwany" - czy kanał Nowogrodu daje zajawkę zamiast treści,
//   4. miejsce - czy do nazwy miejsca nie wszedł ogon o godzinach.
//
// Wynik wklej w rozmowie.

const Parser = require('rss-parser');
const { przetworzWpisy, ZRODLA, czyOdwolana } = require('./gminy');
const { scanItem } = require('./sanitize');

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const LIMIT_CZASU_MS = 20000;
const PAUZA_MS = 400;
const DL_TYTULU = 95;
const DL_POCZATKU = 160;
const DL_KONCA = 120;

function skroc(tekst, ile) {
  const t = String(tekst || '').replace(/\s+/g, ' ').trim();
  return t.length > ile ? `${t.substring(0, ile)}…` : t;
}

function ogon(tekst, ile) {
  const t = String(tekst || '').replace(/\s+/g, ' ').trim();
  return t.length > ile ? `…${t.substring(t.length - ile)}` : t;
}

function dzien(wartosc) {
  if (!wartosc) return '(brak)';
  return String(wartosc).substring(0, 10);
}

function odczekaj(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function pobierz(url) {
  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);
  try {
    const odp = await fetch(url, { headers: NAGLOWKI, redirect: 'follow', signal: kontroler.signal });
    if (!odp.ok) throw new Error(`HTTP ${odp.status}`);
    return await odp.text();
  } finally {
    clearTimeout(stoper);
  }
}

async function zbadaj(zrodlo) {
  console.log('');
  console.log('==========================================================');
  console.log(`${zrodlo.gmina} — ${zrodlo.zrodlo}`);
  console.log(zrodlo.kanal);
  console.log('==========================================================');

  let kanal;
  try {
    const xml = await pobierz(zrodlo.kanal);
    kanal = await new Parser().parseString(xml);
  } catch (err) {
    console.log(`BŁĄD POBIERANIA: ${err.message}`);
    console.log('(na produkcji licznik błędów zgłosi to po 8 cyklach z rzędu)');
    return { weszlo: 0, odrzucone: 0, uwagi: 1 };
  }

  const items = kanal.items || [];
  console.log(`kanał: "${kanal.title || '(bez tytulu)'}" | wpisów: ${items.length}`);

  // To samo wywolanie, ktore wykonuje scrapeAll na produkcji.
  const { wyniki, pominietych } = przetworzWpisy(zrodlo, items);

  // Ktore wpisy wypadly - po adresie, bo tytuly bywaja identyczne.
  const weszlyAdresy = new Set(wyniki.map((w) => w.source_url));
  const odrzucone = items.filter((i) => !weszlyAdresy.has(String(i.link || '').trim()));

  console.log('');
  console.log(`=== WESZŁO DO APPKI: ${wyniki.length} z ${items.length} ===`);
  let uwagi = 0;

  for (const w of wyniki) {
    const problemy = scanItem(w);
    const zakonczona = w.title.includes('(zakończona)');
    console.log('');
    console.log(`  [${w.category}] ${w.title}`);
    console.log(`     miejsce:    ${w.street || '(brak)'}`);
    console.log(`     publikacja: ${dzien(w.published_at)}   wydarzenie: ${dzien(w.event_date)}`);
    console.log(`     opis:       ${w.description.length} zn.`);
    console.log(`     początek:   ${skroc(w.description, DL_POCZATKU)}`);
    console.log(`     koniec:     ${ogon(w.description, DL_KONCA)}`);

    if (zakonczona) {
      console.log('     >>> oznaczone jako ZAKOŃCZONA - sprawdź w treści, czy to prawda');
      uwagi += 1;
    }
    if (w.needs_review) {
      console.log(`     >>> DO PRZEJRZENIA: ${w.review_reasons.join('; ')}`);
      uwagi += 1;
    }
    if (problemy.length) {
      console.log(`     >>> sanitize zgłasza: ${problemy.join('; ')}`);
      uwagi += 1;
    }
    if (/\[…\]|\[\.\.\.\]$/.test(w.description)) {
      console.log('     >>> opis urwany przez CMS ("[...]") - kanał dał zajawkę, nie pełną treść');
      uwagi += 1;
    }
    if (/godzin|\bod \d/.test(w.street || '')) {
      console.log('     >>> do nazwy miejsca wszedł ogon o godzinach');
      uwagi += 1;
    }
  }

  console.log('');
  console.log(`=== ODRZUCONE PRZEZ FILTR: ${odrzucone.length} ===`);
  console.log('(każdą z tych pozycji sprawdź wzrokiem: czy to na pewno NIE jest awaria wody)');
  for (const i of odrzucone) {
    const tytul = skroc(i.title, DL_TYTULU);
    const bezLinku = !String(i.link || '').trim() ? '  [bez odnośnika]' : '';
    console.log(`  • ${tytul}${bezLinku}`);
    const tresc = (i['content:encodedSnippet'] || i.contentSnippet || '');
    if (tresc) console.log(`    treść: ${skroc(tresc, DL_POCZATKU)}`);
  }

  if (pominietych !== odrzucone.length) {
    console.log('');
    console.log(`  (uwaga techniczna: kod zgłasza ${pominietych} pominiętych, `
      + `a po adresach wychodzi ${odrzucone.length} - to znaczy, że dwa wpisy w kanale `
      + 'mają ten sam odnośnik)');
  }

  return { weszlo: wyniki.length, odrzucone: odrzucone.length, uwagi };
}

(async () => {
  console.log('SONDA 7 - próba na żywo źródła "gminy" przed wdrożeniem');
  console.log('(uruchamia kod produkcyjny z gminy.js; nic nie zapisuje)');

  let razemWeszlo = 0;
  let razemUwag = 0;

  for (const zrodlo of ZRODLA) {
    const w = await zbadaj(zrodlo);
    razemWeszlo += w.weszlo;
    razemUwag += w.uwagi;
    await odczekaj(PAUZA_MS);
  }

  // Kontrola rozpoznawania odwolan na zdaniach, ktore naprawde wystepuja
  // w komunikatach POMAK-u. Tu pierwsza wersja wzorca sie przewrocila.
  console.log('');
  console.log('==========================================================');
  console.log('KONTROLA: rozpoznawanie odwołania awarii');
  console.log('==========================================================');
  const PROBY = [
    ['O przywróceniu dostaw wody poinformujemy w osobnym komunikacie.', false],
    ['Informujemy, że dostawa wody została przywrócona.', true],
    ['Nastąpi przerwa w dostawie wody.', false],
    ['O przywróceniu dostawy wody zostaną Państwo poinformowani.', false],
    ['Usunięto awarię sieci wodociągowej.', true],
  ];
  let bledy = 0;
  for (const [zdanie, oczekiwane] of PROBY) {
    const wynik = czyOdwolana(zdanie);
    const ok = wynik === oczekiwane;
    if (!ok) bledy += 1;
    console.log(`  ${ok ? 'OK  ' : 'BŁĄD'} (${wynik ? 'odwołana' : 'trwa'}) ${zdanie}`);
  }

  console.log('');
  console.log('==========================================================');
  console.log(`PODSUMOWANIE: ${razemWeszlo} wpisów weszłoby do appki, `
    + `${razemUwag} rzeczy do obejrzenia, ${bledy} błędów kontroli`);
  console.log('KONIEC. Sonda nic nie zapisała i nic nie zmieniła.');
})();
