// Sonda nr 11 - dzial wodny gminy Zabor. TYLKO DO CZYTANIA.
//     node sonda11.js
//
// Zabor jest juz podlaczony i czyta aktualnosci z dzialu 1000. Problem w tym,
// ze komunikaty o wodzie moga tam nie trafiac: sonda nr 10 pokazala osobna
// pozycje menu "KOMUNIKATY W SPRAWIE JAKOSCI WODY PRZEZNACZONEJ DO SPOZYCIA"
// pod adresem /PL/3171/..., a nasz filtr bierze wylacznie dzial 1000.
//
// To jest gorszy rodzaj luki niz zwykly blad: zrodlo wyglada na zdrowe,
// log pokazuje "6 na liscie", nikt niczego nie zglasza - a ostrzezenie
// o jakosci wody pitnej po prostu nigdy nie dociera do mieszkanca.
//
// Sonda odpowiada na trzy pytania:
//   1. czy dzial wodny w ogole zawiera komunikaty i jakie maja adresy
//      (ktory dzial, czy koncza sie na /k/) - od tego zalezy filtr;
//   2. czy podstrona takiego komunikatu ma ten sam uklad, co Swidnica
//      i Otyn - jesli tak, parser mamy gotowy;
//   3. czy kanaly RSS znalezione przy sondzie nr 10 niosa TRESC - bo jesli
//      tak, cale scrapowanie HTML jest tu niepotrzebne i lepiej czytac kanal.
//
// Polaczenie idzie przez certyfikaty.js, czyli z dociagnietym ogniwem
// i WLACZONA weryfikacja - tak samo jak w prawdziwym scraperze.

const cheerio = require('cheerio');
const Parser = require('rss-parser');
const { ogniwoDlaHosta, pobierzZOgniwem } = require('./certyfikaty');

const HOST = 'www.gminazabor.pl';
const DZIAL_WODNY = 'https://www.gminazabor.pl/PL/3171/KOMUNIKATY_W_SPRAWIE__JAKOSCI_WODY_PRZEZNACZONEJ_DO_SPOZYCIA/';
const KANALY = [
  'https://www.gminazabor.pl/PL/rss/kanal/2/',
  'https://www.gminazabor.pl/PL/rss/3184/',
];

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,application/rss+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const DL_UKLADU = 2500;
const DL_LINII = 160;
const MAX_LINII = 20;
const MAX_WPISOW = 12;
const MAX_Z_KANALU = 5;

function skroc(t, ile) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > ile ? `${s.substring(0, ile)}…` : s;
}

function obetnij(t, ile) {
  const s = String(t || '');
  return s.length > ile ? `${s.substring(0, ile)}\n…[uciete, calosc ma ${s.length} zn.]` : s;
}

/** Wszystkie odnosniki wygladajace na komunikat, z numerem dzialu. */
function wyciagWpisy($, bazowyUrl) {
  const wpisy = [];
  $('a[href]').each((_, el) => {
    const $a = $(el);
    let pelny;
    try { pelny = new URL($a.attr('href') || '', bazowyUrl).href; } catch { return; }

    const m = pelny.match(/\/PL\/(\d+)\/(\d+)\/([^/]+)\/k\/?$/);
    if (!m) return;
    if (wpisy.some((w) => w.url === pelny)) return;

    const blok = $a.closest('.owl-content, .news-box-item, .information, li, div');
    const zTitle = ($a.attr('title') || '').replace(/^Przejd[źz] do informacji:\s*/i, '').trim();
    const zNaglowka = skroc(blok.find('h2, h3, h4').first().text(), DL_LINII);

    wpisy.push({
      url: pelny,
      dzial: m[1],
      numer: Number(m[2]),
      tytul: zTitle || zNaglowka || skroc($a.text(), DL_LINII),
      data: skroc(blok.find('.date').first().text(), 40),
    });
  });
  return wpisy;
}

async function pokazPodstrone(url, ogniwo) {
  console.log('');
  console.log(`  --- PODSTRONA: ${url}`);
  let odp;
  try { odp = await pobierzZOgniwem(url, ogniwo, NAGLOWKI); } catch (e) { console.log(`      BLAD: ${e.message}`); return; }
  console.log(`      ${odp.tekst.length} zn.`);

  const $ = cheerio.load(odp.tekst);
  $('script, style, .information-picture, .information-content-addons-header').remove();
  $('br').replaceWith(' ');

  // Dokladnie te selektory, ktorych uzywa gminyCms.js - jesli tu zagraja,
  // parser nie wymaga ani jednej zmiany.
  const naglowek = $('.information-header').first();
  const tytul = naglowek.find('h2').first().text().replace(/\s+/g, ' ').trim();
  const data = naglowek.find('li.date').first().text().replace(/\s+/g, ' ').trim();
  const tresc = $('.information-content-paragraph-first').first();

  console.log('');
  console.log('      === CZY NASZ PARSER TU ZAGRA ===');
  console.log(`      .information-header h2        -> ${tytul ? `"${tytul}"` : 'NIC'}`);
  console.log(`      .information-header li.date   -> ${data ? `"${data}"` : 'NIC'}`);
  console.log(`      .information-content-paragraph-first -> ${tresc.length ? `${tresc.text().replace(/\s+/g, ' ').trim().length} zn.` : 'NIE MA TEGO POJEMNIKA'}`);

  if (tresc.length) {
    console.log('');
    console.log('      === UKLAD TRESCI ===');
    console.log(obetnij(tresc.html(), DL_UKLADU));

    console.log('');
    console.log('      === TEKST, JAKI WSZEDLBY DO APPKI ===');
    const linie = [];
    tresc.find('p, div, li, td').each((_, el) => {
      const $el = $(el);
      if ($el.children('p, div, li, td').length) return;
      const t = skroc($el.text().replace(/ /g, ' '), DL_LINII);
      if (t && t.length > 2 && !linie.includes(t)) linie.push(t);
    });
    if (!linie.length) linie.push(skroc(tresc.text(), DL_LINII));
    linie.slice(0, MAX_LINII).forEach((l, i) => console.log(`      ${String(i + 1).padStart(2)}. ${l}`));
  } else {
    console.log('');
    console.log('      === POJEMNIKI, JAKIE SA ===');
    ['.information', '.content-main', '#content', '.content', 'article', 'main'].forEach((sel) => {
      const el = $(sel).first();
      if (el.length) console.log(`      ${sel.padEnd(16)} ${el.text().replace(/\s+/g, ' ').trim().length} zn.`);
    });
  }
}

async function zbadajKanaly(ogniwo) {
  console.log('');
  console.log('==========================================================');
  console.log('3. KANALY RSS — czy niosa TRESC, czy same tytuly');
  console.log('==========================================================');
  console.log('(gdyby niosly tresc, scrapowanie HTML byloby tu zbedne)');

  for (const adres of KANALY) {
    console.log('');
    console.log(`  ${adres}`);
    let xml;
    try {
      xml = (await pobierzZOgniwem(adres, ogniwo, NAGLOWKI)).tekst;
    } catch (e) { console.log(`    BLAD: ${e.message}`); continue; }

    let kanal;
    try { kanal = await new Parser().parseString(xml); } catch (e) { console.log(`    nie jest kanalem RSS: ${e.message}`); continue; }

    const items = kanal.items || [];
    console.log(`    tytul kanalu: ${kanal.title || '(brak)'}`);
    console.log(`    wpisow: ${items.length}`);

    items.slice(0, MAX_Z_KANALU).forEach((it) => {
      const pelna = (it['content:encodedSnippet'] || '').trim();
      const zajawka = (it.contentSnippet || '').trim();
      const tresc = pelna.length > zajawka.length ? pelna : zajawka;
      console.log(`      "${skroc(it.title, DL_LINII)}"`);
      console.log(`        data: ${it.isoDate || it.pubDate || '(brak)'} | tresc: ${tresc.length} zn.`);
      if (tresc) console.log(`        ${skroc(tresc, DL_LINII)}`);
    });
  }
}

(async () => {
  console.log('SONDA 11 — dzial wodny gminy Zabor (tylko czytanie)');
  console.log('');

  const ogniwo = await ogniwoDlaHosta(HOST);
  if (!ogniwo) {
    console.log('Nie udalo sie zdobyc wiarygodnego ogniwa certyfikatu - przerywam.');
    console.log('(to ten sam mechanizm, ktorego uzywa scraper, wiec problem dotyczylby i jego)');
    return;
  }

  console.log('==========================================================');
  console.log('1. DZIAL WODNY — co na nim lezy');
  console.log('==========================================================');
  console.log(`  ${DZIAL_WODNY}`);

  let strona;
  try {
    strona = await pobierzZOgniwem(DZIAL_WODNY, ogniwo, NAGLOWKI);
  } catch (e) {
    console.log(`  BLAD: ${e.message}`);
    console.log('  >>> Jesli to 404, adres z menu prowadzi gdzie indziej niz myslalem.');
    return;
  }
  console.log(`  ${strona.tekst.length} zn.`);

  const $ = cheerio.load(strona.tekst);
  const wpisy = wyciagWpisy($, DZIAL_WODNY);
  const dzialy = [...new Set(wpisy.map((w) => w.dzial))];

  console.log('');
  console.log(`  === KOMUNIKATY: ${wpisy.length} ===`);
  console.log(`  numery dzialow w adresach: ${dzialy.join(', ') || '(zadnych)'}`);
  if (dzialy.length && !dzialy.includes('1000')) {
    console.log('  >>> UWAGA: to NIE jest dzial 1000, wiec obecny filtr ich NIE przepuszcza.');
  }
  if (dzialy.includes('1000')) {
    console.log('  >>> Czesc komunikatow lezy w dziale 1000 - te juz dzis wpadaja do appki.');
  }

  wpisy.slice(0, MAX_WPISOW).forEach((w) => {
    console.log(`  [dzial ${w.dzial}] ${w.data ? `${w.data}  ` : ''}${w.tytul}`);
    console.log(`      ${w.url}`);
  });

  if (!wpisy.length) {
    console.log('');
    console.log('  Zadnych komunikatow w typowej postaci. Podglad tresci strony:');
    const tekst = $('#content, .content-main, .content').first().text().replace(/\s+/g, ' ').trim();
    console.log(obetnij(tekst || $('body').text().replace(/\s+/g, ' ').trim(), DL_UKLADU));
  } else {
    console.log('');
    console.log('==========================================================');
    console.log('2. PODSTRONA KOMUNIKATU — czy parser zagra bez zmian');
    console.log('==========================================================');
    await pokazPodstrone(wpisy[0].url, ogniwo);
  }

  await zbadajKanaly(ogniwo);

  console.log('');
  console.log('KONIEC. Sonda nic nie zapisala i nic nie zmienila.');
})();
