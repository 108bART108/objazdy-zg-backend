// Sonda nr 2 - celowana. Uruchamiasz tak samo:  node sonda2.js
//
// Pierwsza sonda odpowiedziala na pytanie "ktore zrodla w ogole zyja".
// Ta odpowiada na pytanie "jak dokladnie zbudowana jest strona, z ktorej
// mam czytac" - bo bez tego parser pisalbym po omacku, a wiemy juz, czym
// to sie konczy.
//
// Nowosc wzgledem pierwszej sondy: przy kazdej stronie wypisuje SUROWY
// fragment HTML wokol pierwszej znalezionej daty. To wlasnie ten fragment
// pozwala mi napisac precyzyjne wyszukiwanie zamiast zgadywania.
//
// Skrypt tylko czyta. Nic nie zapisuje, nie dotyka bazy ani aplikacji.

const LIMIT_CZASU_MS = 20000;
const ILE_ODNOSNIKOW = 25;
const ILE_DAT = 12;
const ZNAKOW_PRZED_DATA = 700;
const ZNAKOW_PO_DACIE = 1100;

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG-sonda/1.0 (+info@utrudnienia-zg.pl)',
  'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const CELE = [
  {
    nazwa: 'PZZD - UTRUDNIENIA W RUCHU (glowny kandydat)',
    url: 'https://bip.pzzd.powiat-zielonogorski.pl/47/Utrudnienia_w_ruchu/',
    host: 'bip.pzzd.powiat-zielonogorski.pl',
  },
  {
    nazwa: 'PZZD - zimowe utrzymanie drog',
    url: 'https://bip.pzzd.powiat-zielonogorski.pl/45/Zimowe_utrzymanie_drog/',
    host: 'bip.pzzd.powiat-zielonogorski.pl',
  },
  {
    nazwa: 'PZZD - aktualnosci',
    url: 'https://bip.pzzd.powiat-zielonogorski.pl/28/Aktualnosci/',
    host: 'bip.pzzd.powiat-zielonogorski.pl',
  },
  {
    nazwa: 'GDDKiA - aktualnosci oddzialu 2026',
    url: 'https://www.gov.pl/web/gddkia-zielona-gora/aktualnosci-zielona-gora-2026',
    host: 'www.gov.pl',
    tylkoSciezka: '/web/gddkia-zielona-gora/',
  },
];

// Odnosniki nawigacyjne, ktore wystepuja na kazdej podstronie i tylko
// zasmiecaja obraz - nie sa trescia, ktorej szukamy.
const NAWIGACJA = /mobywatel|\/web\/premier|\/web\/gov\/|javascript:|^#|deklaracja|dostepnosc|rodo|cookies|mapa-strony|wyszukiwanie|przejdz do|szybki przeskok|logowanie|bip\.gov\.pl|\/szukaj\//i;

function zwin(tekst) {
  return String(tekst || '').replace(/\s+/g, ' ').trim();
}

function skrot(tekst, ile) {
  const t = zwin(tekst);
  return t.length > ile ? `${t.slice(0, ile)}…` : t;
}

async function sprawdz(cel) {
  console.log('');
  console.log('='.repeat(78));
  console.log(cel.nazwa);
  console.log(cel.url);
  console.log('-'.repeat(78));

  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);

  try {
    const odp = await fetch(cel.url, { headers: NAGLOWKI, signal: kontroler.signal, redirect: 'follow' });
    const html = await odp.text();
    console.log(`HTTP ${odp.status} | ${html.length} znakow`);
    if (odp.url !== cel.url) console.log(`przekierowano na: ${odp.url}`);
    if (!odp.ok) {
      console.log(`poczatek: ${skrot(html, 300)}`);
      return;
    }

    // --- odnosniki, ktore wygladaja na TRESC, a nie na menu -----------------
    const linki = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ href: m[1], tekst: zwin(m[2].replace(/<[^>]+>/g, ' ')) }))
      .filter((l) => l.tekst.length > 15)
      .filter((l) => !NAWIGACJA.test(l.href) && !NAWIGACJA.test(l.tekst))
      .filter((l) => (cel.tylkoSciezka ? l.href.includes(cel.tylkoSciezka) : true));

    const unikalne = [];
    const widziane = new Set();
    for (const l of linki) {
      if (widziane.has(l.href)) continue;
      widziane.add(l.href);
      unikalne.push(l);
    }

    console.log(`odnosnikow wygladajacych na tresc: ${unikalne.length}`);
    for (const l of unikalne.slice(0, ILE_ODNOSNIKOW)) {
      console.log(`   • "${skrot(l.tekst, 95)}"`);
      console.log(`     ${skrot(l.href, 95)}`);
    }

    // --- daty ---------------------------------------------------------------
    const daty = [...new Set(html.match(/\b\d{2}[.-]\d{2}[.-]\d{4}\b/g) || [])];
    console.log(`daty na stronie (${daty.length}): ${daty.slice(0, ILE_DAT).join(', ') || '(brak)'}`);

    // --- SUROWY FRAGMENT wokol pierwszej daty -------------------------------
    // To jest najwazniejsza czesc tej sondy. Pokazuje, w jakie znaczniki
    // opakowana jest pojedyncza pozycja listy - czyli czego ma szukac parser.
    const pierwsza = html.search(/\b\d{2}[.-]\d{2}[.-]\d{4}\b/);
    if (pierwsza > -1) {
      const od = Math.max(0, pierwsza - ZNAKOW_PRZED_DATA);
      const fragment = html.slice(od, pierwsza + ZNAKOW_PO_DACIE);
      console.log('');
      console.log('--- SUROWY HTML wokol pierwszej daty ---');
      console.log(zwin(fragment));
      console.log('--- koniec fragmentu ---');
    } else {
      console.log('(nie znalazlem daty - nie ma czego pokazac)');
    }
  } catch (err) {
    const powod = err.name === 'AbortError' ? `przekroczono ${LIMIT_CZASU_MS} ms` : err.message;
    console.log(`BLAD POBIERANIA: ${powod}`);
  } finally {
    clearTimeout(stoper);
  }
}

(async () => {
  console.log('SONDA 2 - struktura stron zrodlowych');
  console.log(`data: ${new Date().toISOString()}`);
  console.log('skrypt tylko czyta');

  for (const cel of CELE) {
    // eslint-disable-next-line no-await-in-loop
    await sprawdz(cel);
  }

  console.log('');
  console.log('='.repeat(78));
  console.log('KONIEC. Skopiuj calosc i wklej do rozmowy.');
})();
