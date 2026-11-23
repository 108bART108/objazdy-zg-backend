// Sonda nr 8 - Zabór, Świdnica, Otyń. TYLKO DO CZYTANIA: nie dotyka bazy,
// nie zapisuje plików, nie zmienia niczego.
//     node sonda8.js
//
// TRZY PYTANIA, NA KTÓRE MA ODPOWIEDZIEĆ:
//
// 1. ZABÓR - dlaczego gminazabor.pl odpowiada "fetch failed" z Rendera,
//    skoro z mojego narzędzia strona działała. "fetch failed" to komunikat
//    bezużyteczny - prawdziwy powód siedzi w err.cause i może być zupełnie
//    inny w skutkach: inna sprawa to wygasły certyfikat (obejdziemy),
//    inna blokada adresu IP Rendera (trzeba pośrednika jak przy MZK),
//    a jeszcze inna literówka w nazwie domeny.
//
// 2. ŚWIDNICA i OTYŃ - obie gminy stoją na tym samym CMS-ie (adresy
//    /PL/<liczba>/<id>/<nazwa>/k/). Sonda nr 6 pokazała listę, ale ani jednej
//    PODSTRONY komunikatu - a bez niej nie da się napisać parsera treści
//    inaczej niż zgadując. Przy PZZD zgadywanie kosztowało cztery błędy
//    w jeden dzień.
//
// 3. Czy w archiwum obu gmin w ogóle są komunikaty o wodzie - bo jeśli
//    przez rok było ich dwa, to parser może nie być wart pisania.

const cheerio = require('cheerio');

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const LIMIT_CZASU_MS = 20000;
const PAUZA_MS = 400;
const DL_UKLADU = 3000;
const DL_LINII = 170;
const MAX_LINII = 22;
const MAX_TROPOW = 8;
const MAX_POJEMNIKOW = 6;

const POJEMNIKI = [
  '.information', '.paragraph', '.news', '.newsbox', '.tresc', '.content',
  '#content', '#tresc', 'article', '.article', '.entry-content', '.post',
  '.item-page', 'main', '.art-content', '.srodek', '.content-main',
];

const SLOWA_WODA = /awari|przerw\w*\s+w\s+dostaw|brak\w*\s+wody|bez\s+wody|wodoci[ąa]g|wodomierz|uzdatnian|jako[śs][ćc]\s+wody|ska[żz]eni/i;

function skroc(tekst, ile) {
  const t = String(tekst || '').replace(/\s+/g, ' ').trim();
  return t.length > ile ? `${t.substring(0, ile)}…` : t;
}

function obetnij(tekst, ile) {
  const t = String(tekst || '');
  return t.length > ile ? `${t.substring(0, ile)}\n…[uciete, calosc ma ${t.length} zn.]` : t;
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

// ============================ 1. ZABÓR ======================================
// "fetch failed" nic nie mowi. Prawdziwy powod jest w err.cause - rozwijamy
// cały łańcuch przyczyn i wypisujemy kod błędu, bo to on decyduje, co dalej.
function opiszBlad(err) {
  const warstwy = [];
  let e = err;
  let glebokosc = 0;
  while (e && glebokosc < 5) {
    warstwy.push({
      nazwa: e.name || '(bez nazwy)',
      komunikat: e.message || '(bez komunikatu)',
      kod: e.code || e.errno || null,
    });
    e = e.cause;
    glebokosc += 1;
  }
  return warstwy;
}

const WYJASNIENIA = {
  ENOTFOUND: 'domena nie rozwiazuje sie na adres IP - zla nazwa albo problem z DNS',
  EAI_AGAIN: 'chwilowy problem z DNS po stronie serwera',
  ECONNREFUSED: 'serwer odrzucil polaczenie',
  ECONNRESET: 'serwer zerwal polaczenie w trakcie - czesto tak wyglada blokada',
  ETIMEDOUT: 'serwer nie odpowiedzial - moze blokowac adres IP Rendera',
  UND_ERR_CONNECT_TIMEOUT: 'przekroczony czas laczenia - czesto blokada adresu IP',
  CERT_HAS_EXPIRED: 'certyfikat strony wygasl',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'niepelny lancuch certyfikatu po stronie urzedu',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certyfikat podpisany przez samego siebie',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certyfikat wystawiony na inna domene',
};

async function zbadajZabor() {
  console.log('');
  console.log('==========================================================');
  console.log('1. ZABÓR — dlaczego "fetch failed"');
  console.log('==========================================================');

  const PROBY = [
    'https://www.gminazabor.pl/',
    'https://gminazabor.pl/',
    'http://www.gminazabor.pl/',
    'http://gminazabor.pl/',
    'https://www.gminazabor.pl/PL/1000/1/archiwum/News_box/',
  ];

  let ktorykolwiekDziala = null;

  for (const url of PROBY) {
    await odczekaj(PAUZA_MS);
    try {
      const w = await pobierz(url);
      console.log(`  DZIALA  ${url}`);
      console.log(`          HTTP ${w.status} | ${w.typ} | ${w.tekst.length} zn.`);
      if (w.koncowyUrl !== url) console.log(`          przekierowano na: ${w.koncowyUrl}`);
      if (!ktorykolwiekDziala && w.ok) ktorykolwiekDziala = w;
    } catch (err) {
      const warstwy = opiszBlad(err);
      const kod = warstwy.map((w) => w.kod).find(Boolean);
      console.log(`  BLAD    ${url}`);
      warstwy.forEach((w, i) => {
        console.log(`          ${'  '.repeat(i)}${w.nazwa}: ${w.komunikat}${w.kod ? ` [${w.kod}]` : ''}`);
      });
      if (kod && WYJASNIENIA[kod]) console.log(`          >>> ${WYJASNIENIA[kod]}`);
    }
  }

  console.log('');
  if (ktorykolwiekDziala) {
    console.log('  WNIOSEK: ktorys adres dziala - wystarczy go uzyc, bez posrednika.');
  } else {
    console.log('  WNIOSEK: zaden adres nie dziala z tego serwera. Jesli kod bledu mowi');
    console.log('  o czasie oczekiwania albo zerwaniu polaczenia, to blokada adresu IP');
    console.log('  Rendera i potrzebny bedzie posrednik, taki jak przy MZK.');
  }
  return ktorykolwiekDziala;
}

// ===================== 2. ŚWIDNICA I OTYŃ ===================================
function zmierzPojemniki($) {
  const wyniki = [];
  for (const sel of POJEMNIKI) {
    const $el = $(sel);
    if (!$el.length) continue;
    wyniki.push({
      sel,
      ile: $el.length,
      dl: $el.first().text().replace(/\s+/g, ' ').trim().length,
    });
  }
  return wyniki.sort((a, b) => b.dl - a.dl);
}

async function pokazPodstrone(url, etykieta) {
  console.log('');
  console.log(`  --- PODSTRONA: ${etykieta}`);
  console.log(`      ${url}`);
  let odp;
  try {
    odp = await pobierz(url);
  } catch (err) {
    console.log(`      BLAD: ${err.message}`);
    return;
  }
  console.log(`      HTTP ${odp.status} | ${odp.tekst.length} zn.`);
  if (!odp.ok) return;

  const $ = cheerio.load(odp.tekst);
  $('script, style, nav, header, footer').remove();

  const pojemniki = zmierzPojemniki($);
  console.log('');
  console.log('      === POJEMNIKI (wg ilosci tekstu) ===');
  pojemniki.slice(0, MAX_POJEMNIKOW).forEach((p) => {
    console.log(`      ${p.sel.padEnd(16)} x${String(p.ile).padStart(3)}  ${p.dl} zn.`);
  });
  if (!pojemniki.length) {
    console.log('      zaden typowy selektor nie wystepuje');
    return;
  }

  const najlepszy = pojemniki[0];
  console.log('');
  console.log(`      === UKLAD (surowy HTML: ${najlepszy.sel}) ===`);
  console.log(obetnij($(najlepszy.sel).first().html(), DL_UKLADU));

  console.log('');
  console.log('      === TEKST (linia po linii) ===');
  const linie = [];
  $(najlepszy.sel).first().find('p, div, li, td, h1, h2, h3, h4, span').each((_, el) => {
    const $el = $(el);
    if ($el.children('p, div, li, td').length) return;
    const t = skroc($el.text(), DL_LINII);
    if (t && t.length > 2 && !linie.includes(t)) linie.push(t);
  });
  linie.slice(0, MAX_LINII).forEach((l, i) => {
    const uwaga = /:$/.test(l) ? '   <<< DWUKROPEK NA KONCU' : '';
    console.log(`      ${String(i + 1).padStart(2)}. ${l}${uwaga}`);
  });
  if (linie.length > MAX_LINII) console.log(`      … i jeszcze ${linie.length - MAX_LINII} linii`);
}

async function zbadajGmine(gmina, adresy) {
  console.log('');
  console.log('==========================================================');
  console.log(`${gmina}`);
  console.log('==========================================================');

  let lista = null;
  let uzytyAdres = null;

  for (const url of adresy) {
    await odczekaj(PAUZA_MS);
    try {
      const w = await pobierz(url);
      console.log(`  ${w.ok ? 'OK  ' : `HTTP ${w.status}`}  ${url}  (${w.tekst.length} zn.)`);
      if (w.ok && !lista) { lista = w; uzytyAdres = url; }
    } catch (err) {
      console.log(`  BLAD  ${url} — ${err.message}`);
    }
  }

  if (!lista) {
    console.log('  Zadna z list nie odpowiedziala - nie ma czego parsowac.');
    return;
  }

  console.log('');
  console.log(`  Pracuje na: ${uzytyAdres}`);
  const $ = cheerio.load(lista.tekst);
  console.log(`  CMS (z metadanych): ${$('meta[name="generator"]').attr('content') || '(nie podaje)'}`);

  // Wszystkie odnosniki do pozycji tresci w tym CMS-ie.
  const wpisy = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const tekst = skroc($(el).text(), DL_LINII);
    if (!tekst || tekst.length < 8) return;
    let pelny;
    try { pelny = new URL(href, lista.koncowyUrl).href; } catch { return; }
    if (!/\/PL\/\d+\/\d+\//.test(pelny)) return;
    if (wpisy.some((w) => w.url === pelny)) return;
    wpisy.push({ tekst, url: pelny, oWodzie: SLOWA_WODA.test(tekst) });
  });

  const oWodzie = wpisy.filter((w) => w.oWodzie);
  console.log('');
  console.log(`  === WPISY NA LISCIE: ${wpisy.length}, w tym o wodzie: ${oWodzie.length} ===`);
  (oWodzie.length ? oWodzie : wpisy).slice(0, MAX_TROPOW).forEach((w) => {
    console.log(`  ${w.oWodzie ? '[WODA]' : '      '} ${w.tekst}`);
    console.log(`         ${w.url}`);
  });

  if (!wpisy.length) {
    console.log('  Brak odnosnikow w tym ukladzie - pokazuje strukture samej listy:');
    await pokazPodstrone(uzytyAdres, 'lista');
    return;
  }

  // Podstrona komunikatu o wodzie, a gdy takiego nie ma - pierwszego z brzegu.
  // Uklad tresci jest ten sam, wiec parser da sie napisac tak czy inaczej.
  const cel = oWodzie[0] || wpisy[0];
  await odczekaj(PAUZA_MS);
  await pokazPodstrone(cel.url, cel.oWodzie ? `komunikat o wodzie: ${cel.tekst}` : `dowolny wpis: ${cel.tekst}`);
}

(async () => {
  console.log('SONDA 8 — Zabór, Świdnica, Otyń (tylko czytanie)');

  await zbadajZabor();

  await zbadajGmine('2. ŚWIDNICA', [
    'https://swidnica.zgora.pl/PL/1000/1/archiwum/News_box/',
    'https://swidnica.zgora.pl/PL/1000/1/News_box/',
    'https://swidnica.zgora.pl/',
  ]);

  await zbadajGmine('3. OTYŃ', [
    'http://www.otyn.pl/PL/1000/1/archiwum/News_box/',
    'http://www.otyn.pl/',
  ]);

  console.log('');
  console.log('KONIEC. Sonda nic nie zapisala i nic nie zmienila.');
})();
