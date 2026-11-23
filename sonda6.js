// Sonda nr 6 - uklad stron, ktore nie maja kanalu RSS. TYLKO DO CZYTANIA:
// nic nie zapisuje, nie dotyka bazy, nie zmienia zadnego pliku.
//     node sonda6.js
//
// PO CO: jesli sonda nr 5 nie znajdzie kanalu, komunikaty trzeba czytac
// wprost ze strony. Zeby napisac parser, musze zobaczyc PRAWDZIWY uklad
// HTML - a nie zgadywac. Przy PZZD zgadywanie kosztowalo nas cztery bledy
// w jeden dzien (zlepiona etykieta z adresem pliku, wiszacy dwukropek, data
// z "r." na koncu i zamarzniety opis), a wszystkie wylapala dopiero sonda.
//
// Trzy z tych gmin - Swidnica, Zabor, Otyn - stoja na tym samym CMS-ie
// gminnym (adresy w postaci /PL/<liczba>/<id>/<nazwa>/k/). Jesli to
// potwierdzi, jeden parser obsluzy cala trojke.
//
// CO ROBI: dla kazdej strony z ogloszeniami znajduje pierwszy odnosnik
// wygladajacy na komunikat o wodzie, wchodzi na niego i pokazuje:
//   - ktory pojemnik HTML trzyma tresc (sprawdza liste typowych selektorow),
//   - surowy HTML tego pojemnika,
//   - tekst linia po linii, z oznaczeniem linii konczacych sie dwukropkiem.
//
// Wynik wklej w rozmowie. Jesli jest bardzo dlugi, wystarcza czesci
// "=== POJEMNIKI" i "=== TEKST".

const cheerio = require('cheerio');

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const LIMIT_CZASU_MS = 20000;
const PAUZA_MS = 400;
const DL_UKLADU = 3500;     // ile znakow surowego HTML pojemnika pokazac
const DL_LINII = 180;
const MAX_LINII = 25;
const MAX_TROPOW = 5;

// Typowe pojemniki tresci. Sprawdzamy, ktore istnieja i ile maja tekstu -
// ten z najwieksza iloscia tekstu jest zwykle tym wlasciwym.
const POJEMNIKI = [
  '.information', '.paragraph', '.news', '.newsbox', '.tresc', '.content',
  '#content', '#tresc', 'article', '.article', '.entry-content', '.post',
  '.item-page', 'main', '.art-content', '.srodek', '.srodek_tresc',
];

const SLOWA = /awari|przerw\w*\s+w\s+dostaw|brak\w*\s+wody|bez\s+wody|wodoci[ąa]g|wy[łl][ąa]czeni|uzdatnian|jakos[ćc]\s+wody/i;

const CELE = [
  {
    gmina: 'Czerwieńsk',
    kto: 'POMAK (Joomla)',
    lista: 'https://www.pomak.pl/',
  },
  {
    gmina: 'Świdnica',
    kto: 'gmina Świdnica / ZUK (CMS gminny)',
    lista: 'https://swidnica.zgora.pl/',
  },
  {
    gmina: 'Zabór',
    kto: 'gmina Zabór (CMS gminny)',
    lista: 'https://www.gminazabor.pl/',
  },
  {
    gmina: 'Otyń',
    kto: 'gmina Otyń (CMS gminny)',
    lista: 'http://www.otyn.pl/PL/1000/1/archiwum/News_box/',
  },
];

function skroc(tekst, ile) {
  const t = String(tekst || '');
  return t.length > ile ? `${t.substring(0, ile)}\n…[uciete, całość ma ${t.length} zn.]` : t;
}

function jednaLinia(tekst, ile) {
  const t = String(tekst || '').replace(/\s+/g, ' ').trim();
  return t.length > ile ? `${t.substring(0, ile)}…` : t;
}

function odczekaj(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function pobierz(url) {
  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);
  try {
    const odp = await fetch(url, { headers: NAGLOWKI, redirect: 'follow', signal: kontroler.signal });
    return {
      ok: odp.ok,
      status: odp.status,
      typ: odp.headers.get('content-type') || '(brak)',
      koncowyUrl: odp.url,
      tekst: await odp.text(),
    };
  } finally {
    clearTimeout(stoper);
  }
}

// Ktory pojemnik trzyma tresc. Zwraca liste: selektor, ile wystapien, ile tekstu.
function zmierzPojemniki($) {
  const wyniki = [];
  for (const sel of POJEMNIKI) {
    const $el = $(sel);
    if (!$el.length) continue;
    const dl = $el.first().text().replace(/\s+/g, ' ').trim().length;
    wyniki.push({ sel, ile: $el.length, dl });
  }
  return wyniki.sort((a, b) => b.dl - a.dl);
}

async function pokazPodstrone(url, etykieta) {
  console.log('');
  console.log(`--- PODSTRONA (${etykieta})`);
  console.log(`    ${url}`);

  let odp;
  try {
    odp = await pobierz(url);
  } catch (err) {
    console.log(`    BLAD POBIERANIA: ${err.message}`);
    return;
  }
  console.log(`    HTTP ${odp.status} | ${odp.typ} | ${odp.tekst.length} zn.`);
  if (!odp.ok) return;

  const $ = cheerio.load(odp.tekst);
  $('script, style, nav, header, footer').remove();

  const pojemniki = zmierzPojemniki($);
  console.log('');
  console.log('    === POJEMNIKI (posortowane po ilości tekstu) ===');
  if (!pojemniki.length) {
    console.log('    żaden z typowych selektorów nie występuje na tej stronie');
  } else {
    pojemniki.forEach((p) => console.log(`    ${p.sel.padEnd(16)} wystąpień: ${String(p.ile).padStart(3)}  tekstu: ${p.dl} zn.`));
  }

  const najlepszy = pojemniki[0];
  if (najlepszy) {
    console.log('');
    console.log(`    === UKŁAD (surowy HTML: ${najlepszy.sel}) ===`);
    console.log(skroc($(najlepszy.sel).first().html(), DL_UKLADU));
  }

  console.log('');
  console.log('    === TEKST (linia po linii) ===');
  const zrodloTekstu = najlepszy ? $(najlepszy.sel).first() : $('body');
  const linie = [];
  zrodloTekstu.find('p, div, li, td, h1, h2, h3, h4, span').each((_, el) => {
    const $el = $(el);
    if ($el.children('p, div, li, td').length) return;   // tylko liscie
    const t = jednaLinia($el.text(), DL_LINII);
    if (t && t.length > 2 && !linie.includes(t)) linie.push(t);
  });
  linie.slice(0, MAX_LINII).forEach((l, i) => {
    const uwaga = /:$/.test(l) ? '   <<< KOŃCZY SIĘ DWUKROPKIEM' : '';
    console.log(`    ${String(i + 1).padStart(2)}. ${l}${uwaga}`);
  });
  if (linie.length > MAX_LINII) console.log(`    … i jeszcze ${linie.length - MAX_LINII} linii`);
}

async function zbadaj(cel) {
  console.log('');
  console.log('==========================================================');
  console.log(`${cel.gmina} — ${cel.kto}`);
  console.log('==========================================================');

  let lista;
  try {
    lista = await pobierz(cel.lista);
  } catch (err) {
    console.log(`lista ${cel.lista}`);
    console.log(`  BLAD POBIERANIA: ${err.message}`);
    return;
  }

  console.log(`lista: ${cel.lista}`);
  console.log(`  HTTP ${lista.status} | ${lista.typ} | ${lista.tekst.length} zn.`);
  if (!lista.ok) return;

  const $ = cheerio.load(lista.tekst);
  const generator = $('meta[name="generator"]').attr('content');
  console.log(`  CMS (z metadanych): ${generator || '(nie podaje)'}`);

  // Szukamy odnosnikow, ktore wygladaja na komunikat o wodzie.
  const tropy = [];
  $('a[href]').each((_, el) => {
    const tekst = jednaLinia($(el).text(), DL_LINII);
    const href = $(el).attr('href');
    if (!tekst || !href || !SLOWA.test(tekst)) return;
    let pelny;
    try {
      pelny = new URL(href, lista.koncowyUrl).href;
    } catch {
      return;
    }
    if (!tropy.some((t) => t.url === pelny)) tropy.push({ tekst, url: pelny });
  });

  console.log('');
  console.log(`  === ODNOŚNIKI O WODZIE: ${tropy.length} ===`);
  tropy.slice(0, MAX_TROPOW).forEach((t) => {
    console.log(`  • ${t.tekst}`);
    console.log(`    ${t.url}`);
  });

  if (!tropy.length) {
    console.log('  Brak takich odnośników na stronie głównej - komunikaty mogą być');
    console.log('  w osobnej zakładce (aktualności / komunikaty / archiwum).');
    console.log('  Pokazuję układ samej listy, żeby było widać, jak zbudowane są wpisy:');
    await pokazPodstrone(cel.lista, 'strona listy');
    return;
  }

  // Wchodzimy na pierwszy komunikat - tam jest prawdziwa tresc.
  await odczekaj(PAUZA_MS);
  await pokazPodstrone(tropy[0].url, `pierwszy komunikat: ${tropy[0].tekst}`);
}

(async () => {
  console.log('SONDA 6 - układ stron bez kanału RSS (tylko czytanie)');
  for (const cel of CELE) {
    await zbadaj(cel);
    await odczekaj(PAUZA_MS);
  }
  console.log('');
  console.log('KONIEC. Sonda nic nie zapisała i nic nie zmieniła.');
})();
