// Sonda diagnostyczna zrodel dla Utrudnienia ZG.
//
// PO CO TO JEST:
// Zanim napiszemy scraper, trzeba wiedziec, co dane zrodlo NAPRAWDE zwraca.
// Moje srodowisko nie ma dostepu do tych serwisow, wiec pisanie parsera
// "w ciemno" skonczyloby sie tak samo jak przy MZK: logika, ktorej nikt
// nigdy nie uruchomil na prawdziwej stronie, i blad zyjacy tygodniami.
//
// Ten skrypt NICZEGO NIE ZAPISUJE i niczego nie zmienia. Wykonuje po jednym
// zapytaniu do kazdego kandydata i wypisuje, co przyszlo. Uruchamiasz raz,
// wynik wklejasz mi do rozmowy, a ja buduje juz na faktach.
//
// URUCHOMIENIE (Render Shell, katalog /app):
//     node sonda.js
//
// Nie wymaga zadnych bibliotek ani zmiennych srodowiskowych.

const LIMIT_CZASU_MS = 20000;

// Nazwane stale zamiast liczb w .slice(). Powod jest praktyczny: kontrola
// tresci uruchamiana przy starcie serwera (testObciecia.js) wylapuje kazde
// literalne .slice(0, N) ponizej 3000 i slusznie domaga sie wyjasnienia -
// bo wlasnie tak wygladaly ciche obciecia, ktore gubily ulice w komunikatach.
// Tutaj nie chodzi o tresc komunikatu, tylko o dlugosc wydruku, ale zamiast
// dopisywac wyjatek do testu, prosciej nie zapalac lampki w ogole.
const ILE_DAT_W_PODSUMOWANIU = 6;
const ILE_ODNOSNIKOW_W_PODSUMOWANIU = 8;
const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG-sonda/1.0 (+info@utrudnienia-zg.pl)',
  'Accept': 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const CELE = [
  {
    grupa: 'IMGW',
    nazwa: 'ostrzezenia meteorologiczne',
    url: 'https://danepubliczne.imgw.pl/api/data/warningsmeteo',
    typ: 'json',
    uwaga: 'HTTP 404 przy braku aktywnych ostrzezen to STAN NORMALNY, nie awaria',
  },
  {
    grupa: 'IMGW',
    nazwa: 'ostrzezenia hydrologiczne',
    url: 'https://danepubliczne.imgw.pl/api/data/warningshydro',
    typ: 'json',
    uwaga: 'jw.',
  },
  {
    grupa: 'PZZD Gorzykowo',
    nazwa: 'BIP - aktualnosci (drogi powiatowe wokol ZG)',
    url: 'https://bip.pzzd.powiat-zielonogorski.pl/28/Aktualnosci/',
    typ: 'html',
  },
  {
    grupa: 'PZZD Gorzykowo',
    nazwa: 'BIP - kopia na wrotach lubuskich',
    url: 'https://bip.wrota.lubuskie.pl/pzzd_gorzykowo/28/Aktualnosci/',
    typ: 'html',
    uwaga: 'zapasowy adres tej samej jednostki',
  },
  {
    grupa: 'GDDKiA',
    nazwa: 'aktualnosci oddzialu Zielona Gora',
    url: 'https://www.gov.pl/web/gddkia-zielona-gora/aktualnosci',
    typ: 'html',
    uwaga: 'adres zgadywany - jesli 404, sprawdzamy nastepny',
  },
  {
    grupa: 'GDDKiA',
    nazwa: 'strona glowna oddzialu',
    url: 'https://www.gov.pl/web/gddkia-zielona-gora',
    typ: 'html',
  },
  {
    grupa: 'GDDKiA',
    nazwa: 'aktualnosci krajowe (z oznaczeniem oddzialu przy kazdym wpisie)',
    url: 'https://www.gov.pl/web/gddkia/aktualnosci',
    typ: 'html',
  },
  {
    grupa: 'DIAGNOSTYKA',
    nazwa: 'lista utrudnien GDDKiA',
    url: 'https://drogi.gddkia.gov.pl/informacje-drogowe/lista-utrudnien?woj=lubuskie',
    typ: 'html',
    uwaga: 'TO NIE JEST KANDYDAT NA ZRODLO. Jedno zapytanie, zeby potwierdzic, '
         + 'ze serwis odpowiada strona zabezpieczenia antybotowego. Jesli tak - odpuszczamy.',
  },
];

// ---------------------------------------------------------------- pomocnicze

function skrot(tekst, ile) {
  const t = String(tekst || '').replace(/\s+/g, ' ').trim();
  return t.length > ile ? `${t.slice(0, ile)}…` : t;
}

function podsumujHtml(html) {
  const linie = [];

  const tytul = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  linie.push(`tytul strony: ${tytul ? skrot(tytul[1], 90) : '(brak)'}`);

  // Sygnaly zabezpieczen antybotowych - jesli sa, dalsza analiza nie ma sensu
  const blokada = /_Incapsula_Resource|Incapsula|cf-browser-verification|Just a moment|Attention Required/i.test(html);
  if (blokada) {
    linie.push('>>> UWAGA: odpowiedz wyglada na strone zabezpieczenia antybotowego, nie na tresc');
  }
  if (/<meta[^>]+noindex/i.test(html)) linie.push('strona ma meta NOINDEX');

  const tabele = (html.match(/<table/gi) || []).length;
  const naglowki = (html.match(/<h[123][\s>]/gi) || []).length;
  const artykuly = (html.match(/<article[\s>]/gi) || []).length;
  const listy = (html.match(/<li[\s>]/gi) || []).length;
  linie.push(`elementy: ${tabele} tabel, ${naglowki} naglowkow h1-h3, ${artykuly} <article>, ${listy} <li>`);

  // Naglowek pierwszej tabeli - mowi, czy to tabela z danymi
  const pierwszaTabela = html.match(/<table[\s\S]{0,4000}?<\/tr>/i);
  if (pierwszaTabela) {
    const komorki = [...pierwszaTabela[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((m) => skrot(m[1].replace(/<[^>]+>/g, ''), 24))
      .filter(Boolean);
    if (komorki.length) linie.push(`kolumny 1. tabeli: ${komorki.join(' | ')}`);
  }

  // Daty w formacie dd.mm.rrrr - czy strona w ogole wyglada na liste komunikatow
  const daty = [...new Set((html.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || []))].slice(0, ILE_DAT_W_PODSUMOWANIU);
  linie.push(`znalezione daty: ${daty.length ? daty.join(', ') : '(brak)'}`);

  // Odnosniki, ktore wygladaja na pojedyncze komunikaty
  const linki = [...html.matchAll(/<a[^>]+href="([^"#?]{8,})"[^>]*>([\s\S]{3,120}?)<\/a>/gi)]
    .map((m) => ({ href: m[1], tekst: skrot(m[2].replace(/<[^>]+>/g, ''), 70) }))
    .filter((l) => l.tekst.length > 12 && !/^(menu|strona|bip|kontakt|deklaracja|rodo)/i.test(l.tekst));

  linie.push(`odnosnikow z sensownym tekstem: ${linki.length}`);
  for (const l of linki.slice(0, ILE_ODNOSNIKOW_W_PODSUMOWANIU)) linie.push(`   • "${l.tekst}"  ->  ${skrot(l.href, 80)}`);

  return linie;
}

function podsumujJson(tekst) {
  const linie = [];
  let dane;
  try {
    dane = JSON.parse(tekst);
  } catch (err) {
    linie.push(`NIE JEST POPRAWNYM JSON-em (${err.message})`);
    linie.push(`poczatek odpowiedzi: ${skrot(tekst, 200)}`);
    return linie;
  }

  if (Array.isArray(dane)) {
    linie.push(`tablica, ${dane.length} elementow`);
    if (dane.length) {
      linie.push(`pola pierwszego elementu: ${Object.keys(dane[0]).join(', ')}`);
      linie.push('pierwszy element w calosci:');
      for (const [k, v] of Object.entries(dane[0])) {
        linie.push(`   ${k}: ${skrot(JSON.stringify(v), 110)}`);
      }
    }
  } else if (dane && typeof dane === 'object') {
    linie.push(`obiekt, pola: ${Object.keys(dane).join(', ')}`);
    linie.push(`tresc: ${skrot(JSON.stringify(dane), 400)}`);
  } else {
    linie.push(`wartosc prosta: ${skrot(String(dane), 200)}`);
  }
  return linie;
}

// ------------------------------------------------------------------- przebieg

async function sprawdz(cel) {
  const naglowek = `[${cel.grupa}] ${cel.nazwa}`;
  console.log('');
  console.log('='.repeat(78));
  console.log(naglowek);
  console.log(cel.url);
  if (cel.uwaga) console.log(`uwaga: ${cel.uwaga}`);
  console.log('-'.repeat(78));

  const start = Date.now();
  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);

  try {
    const odp = await fetch(cel.url, { headers: NAGLOWKI, signal: kontroler.signal, redirect: 'follow' });
    const tekst = await odp.text();
    const czas = Date.now() - start;

    console.log(`HTTP ${odp.status} ${odp.statusText} | ${odp.headers.get('content-type') || 'brak typu'} `
      + `| ${tekst.length} znakow | ${czas} ms`);
    if (odp.url !== cel.url) console.log(`przekierowano na: ${odp.url}`);

    if (odp.status === 404 && cel.grupa === 'IMGW') {
      console.log('404 na ostrzezeniach IMGW = brak aktywnych ostrzezen. To stan normalny.');
      return;
    }
    if (!odp.ok) {
      console.log(`poczatek odpowiedzi: ${skrot(tekst, 300)}`);
      return;
    }

    const linie = cel.typ === 'json' ? podsumujJson(tekst) : podsumujHtml(tekst);
    for (const l of linie) console.log(l);
  } catch (err) {
    const czas = Date.now() - start;
    const powod = err.name === 'AbortError' ? `przekroczono ${LIMIT_CZASU_MS} ms` : err.message;
    console.log(`BLAD POBIERANIA po ${czas} ms: ${powod}`);
  } finally {
    clearTimeout(stoper);
  }
}

(async () => {
  console.log('SONDA ZRODEL - Utrudnienia ZG');
  console.log(`data: ${new Date().toISOString()}`);
  console.log(`node: ${process.version}`);
  console.log('skrypt tylko czyta - nic nie zapisuje i nie zmienia');

  for (const cel of CELE) {
    // eslint-disable-next-line no-await-in-loop
    await sprawdz(cel);
  }

  console.log('');
  console.log('='.repeat(78));
  console.log('KONIEC. Skopiuj CALOSC powyzszego i wklej do rozmowy.');
})();
