// Sonda nr 12 - jak zbudowany jest dzial wodny Zaboru. TYLKO DO CZYTANIA.
//     node sonda12.js
//
// Sonda nr 11 ustalila dwie rzeczy. Pierwsza: RSS Zaboru niesie same tytuly
// (tresc: 0 zn. przy 4 z 5 wpisow), wiec zostajemy przy czytaniu HTML.
// Druga: dzial wodny NAPRAWDE zawiera to, czego szukamy - w podgladzie stalo
// "INFORMACJA nr 50/2026 Panstwowego Powiatowego Inspektora Sanitarnego
// w Zielonej Gorze z dnia 16 pazdziernika 2026 r. w sprawie jakosci wody do
// spozycia z systemu zaopatrzenia w wode Dabrowa (gm. Zabor...)" - ale moj
// wzorzec adresow znalazl zero pozycji.
//
// Znaczy to, ze te komunikaty nie sa zwyklymi artykulami z adresem
// /PL/1000/<numer>/<nazwa>/k/. Trzeba zobaczyc, czym sa naprawde, zanim
// napisze parser - bo pisanie go na domysl juz raz w tym projekcie
// skonczylo sie tym, ze sonda "znalazla" zero wpisow o wodzie, choc trzy
// wisialy na liscie.
//
// Ta sonda robi trzy rzeczy, ktorych zabraklo poprzedniej:
//   1. WYRZUCA MENU przed czytaniem tresci. Poprzednio podglad zapchalo
//      cale menu boczne gminy, przez co na wlasciwa tresc zostalo kilkaset
//      znakow i urwalo sie w najciekawszym miejscu;
//   2. wypisuje WSZYSTKIE odnosniki z tresci, razem z adresami - takze te
//      do plikow PDF, bo komunikaty sanepidu zwykle sa zalacznikami;
//   3. pokazuje surowy uklad tresci, zeby bylo widac, czy pozycje maja
//      wlasne podstrony, czy sa tylko wierszami na jednej stronie.
//
// Pytanie, na ktore musi odpowiedziec: czy z tej strony da sie wyciagnac
// komunikat na tyle konkretny, zeby mial sens w appce. Nazwa typu
// "INFORMACJA nr 50/2026 ... w sprawie jakosci wody" sama w sobie NIE mowi
// mieszkancowi najwazniejszego - czy wode mozna pic. Jesli ta informacja
// siedzi wylacznie w PDF-ie, to zrodlo nie nadaje sie do appki w obecnej
// postaci i trzeba bedzie powiedziec o tym wprost, zamiast wpuszczac
// komunikaty, ktorych tresci nie znamy.

const cheerio = require('cheerio');
const { ogniwoDlaHosta, pobierzZOgniwem } = require('./certyfikaty');

const HOST = 'www.gminazabor.pl';
const STRONA = 'https://www.gminazabor.pl/PL/3171/KOMUNIKATY_W_SPRAWIE__JAKOSCI_WODY_PRZEZNACZONEJ_DO_SPOZYCIA/';

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const DL_UKLADU = 5000;
const DL_LINII = 220;
const MAX_LINII = 30;
const MAX_ODNOSNIKOW = 25;

// Menu boczne gminy ma kilkadziesiat pozycji i w poprzedniej sondzie
// zajelo caly podglad. Wycinamy je, zanim cokolwiek przeczytamy.
const SMIECI_SELEKTORY = [
  'script', 'style', 'noscript',
  'nav', 'header', 'footer',
  '#leftMenu', '#rightMenu', '.menu-left-wrapper', '.menu-right-wrapper',
  '.sidebar', '.nav-toggle', '.breadcrumb', '.weather-box', '.calendar-day-of',
  '#menu', '.menu', '.submenu', '.tools', '.accessibility',
];

function skroc(t, ile) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > ile ? `${s.substring(0, ile)}…` : s;
}

function obetnij(t, ile) {
  const s = String(t || '');
  return s.length > ile ? `${s.substring(0, ile)}\n…[uciete, calosc ma ${s.length} zn.]` : s;
}

function rodzajOdnosnika(url) {
  if (/\.pdf(\?|$)/i.test(url)) return 'PDF';
  if (/pobierz\.php/i.test(url)) return 'PLIK DO POBRANIA';
  if (/\/PL\/\d+\/\d+\/[^/]+\/k\/?$/.test(url)) return 'ARTYKUL (mamy parser)';
  if (/\.(doc|docx|xls|xlsx|jpg|png)(\?|$)/i.test(url)) return 'ZALACZNIK';
  return 'inny';
}

(async () => {
  console.log('SONDA 12 — uklad dzialu wodnego Zaboru (tylko czytanie)');
  console.log('');

  const ogniwo = await ogniwoDlaHosta(HOST);
  if (!ogniwo) {
    console.log('Nie udalo sie zdobyc wiarygodnego ogniwa certyfikatu - przerywam.');
    return;
  }

  let odp;
  try {
    odp = await pobierzZOgniwem(STRONA, ogniwo, NAGLOWKI);
  } catch (e) {
    console.log(`BLAD pobierania: ${e.message}`);
    return;
  }
  console.log(`Pobrano ${odp.tekst.length} zn.`);

  const $ = cheerio.load(odp.tekst);
  $(SMIECI_SELEKTORY.join(', ')).remove();

  // Po wycieciu menu szukamy pojemnika z NAJWIEKSZA iloscia tekstu.
  const kandydaci = ['.information-content-paragraph-first', '.information', '.content-main', '#content', '.content', 'article', 'main']
    .map((sel) => {
      const el = $(sel).first();
      return { sel, el, dl: el.length ? el.text().replace(/\s+/g, ' ').trim().length : 0 };
    })
    .filter((k) => k.dl > 0)
    .sort((a, b) => b.dl - a.dl);

  console.log('');
  console.log('=== POJEMNIKI PO WYCIECIU MENU ===');
  kandydaci.forEach((k) => console.log(`  ${k.sel.padEnd(38)} ${k.dl} zn.`));

  if (!kandydaci.length) {
    console.log('  Zaden typowy pojemnik nie zawiera tekstu. Cale <body>:');
    console.log(obetnij($('body').text().replace(/\s+/g, ' ').trim(), DL_UKLADU));
    return;
  }

  // Bierzemy NAJMNIEJSZY pojemnik, ktory wciaz ma wiekszosc tekstu - czyli
  // najwezszy fragment obejmujacy tresc, bez opakowan.
  const najwiekszy = kandydaci[0];
  const wlasciwy = kandydaci
    .filter((k) => k.dl >= najwiekszy.dl * 0.6)
    .sort((a, b) => a.dl - b.dl)[0];

  console.log('');
  console.log(`=== SUROWY UKLAD (${wlasciwy.sel}) ===`);
  console.log(obetnij(wlasciwy.el.html(), DL_UKLADU));

  console.log('');
  console.log('=== WSZYSTKIE ODNOSNIKI W TRESCI ===');
  const odnosniki = [];
  wlasciwy.el.find('a[href]').each((_, el) => {
    const $a = $(el);
    let pelny;
    try { pelny = new URL($a.attr('href') || '', STRONA).href; } catch { return; }
    if (odnosniki.some((o) => o.url === pelny)) return;
    odnosniki.push({
      url: pelny,
      rodzaj: rodzajOdnosnika(pelny),
      nazwa: skroc($a.attr('title') || $a.text(), DL_LINII),
    });
  });

  if (!odnosniki.length) {
    console.log('  ZADNYCH odnosnikow - komunikaty sa tylko tekstem na tej stronie.');
  } else {
    const wgRodzaju = {};
    odnosniki.forEach((o) => { wgRodzaju[o.rodzaj] = (wgRodzaju[o.rodzaj] || 0) + 1; });
    console.log(`  razem: ${odnosniki.length} (${Object.entries(wgRodzaju).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
    console.log('');
    odnosniki.slice(0, MAX_ODNOSNIKOW).forEach((o) => {
      console.log(`  [${o.rodzaj}] ${o.nazwa || '(bez nazwy)'}`);
      console.log(`      ${o.url}`);
    });
  }

  console.log('');
  console.log('=== TEKST POZYCJA PO POZYCJI ===');
  const linie = [];
  wlasciwy.el.find('p, div, li, td, h1, h2, h3, h4, span').each((_, el) => {
    const $el = $(el);
    if ($el.children('p, div, li, td').length) return;
    const t = skroc($el.text().replace(/ /g, ' '), DL_LINII);
    if (!t || t.length < 3 || linie.includes(t)) return;
    linie.push(t);
  });
  if (!linie.length) linie.push(skroc(wlasciwy.el.text(), DL_UKLADU));
  linie.slice(0, MAX_LINII).forEach((l, i) => {
    // Interesuje nas, czy ktorakolwiek pozycja mowi, CZY WODE MOZNA PIC -
    // sama nazwa "INFORMACJA nr 50/2026 w sprawie jakosci wody" tego nie mowi.
    const rozstrzyga = /nieprzydatn|warunkowo\s+przydatn|przydatn\w*\s+do\s+spo[żz]yci|zakaz|nie\s+nadaje\s+si[ęe]|skaz|bakteri|przekrocz/i.test(l);
    console.log(`  ${String(i + 1).padStart(2)}. ${rozstrzyga ? '[ROZSTRZYGA] ' : ''}${l}`);
  });
  if (linie.length > MAX_LINII) console.log(`  … i jeszcze ${linie.length - MAX_LINII} linii`);

  console.log('');
  console.log('KONIEC. Sonda nic nie zapisala i nic nie zmienila.');
})();
