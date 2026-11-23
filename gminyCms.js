// Swidnica i Otyn - strony urzedow gmin na tym samym CMS-ie.
//
// SKAD WIEMY, JAK TE STRONY WYGLADAJA: sonda nr 9 uruchomiona 23.11.2026
// na serwerze przeczytala obie strony i jedna podstrone z kazdej. Uklad jest
// identyczny co do nazw klas, wiec jeden parser obsluguje obie gminy:
//
//   .information-header h2                      - tytul komunikatu
//   .information-header li.date span            - data publikacji (DD-MM-RRRR)
//   .information-content-paragraph-first        - tresc
//
// Obie gminy publikuja awarie wody SAME, bez posrednika: Swidnica przez
// Zaklad Uslug Komunalnych, Otyn przez Urzad Miejski. Nie ma tu wiec osobnej
// spolki wodociagowej, ktorej kanal mozna byloby czytac - zrodlem jest strona
// urzedu. To rozni te dwie gminy od Czerwienska i Nowogrodu w gminy.js, gdzie
// czytamy kanaly RSS spolek.
//
// DLACZEGO FILTR PRZEPUSZCZA TYLKO WODE I PRAD: strona urzedu to nie kanal
// spolki wodociagowej - leza na niej obok siebie awarie, sesje rady, konkursy
// plastyczne, stypendia i kondolencje. detectCategory zwraca "drogi" jako
// kategorie DOMYSLNA, wiec gdybysmy przyjmowali takze ja, do appki wjechalaby
// cala gazetka gminna. Dlatego bierzemy wylacznie to, co klasyfikator rozpozna
// jako przerwe w dostawie wody albo pradu - czyli wymaga SYGNALU PRZERWY,
// a nie samej nazwy infrastruktury. Dzieki temu "Harmonogram odczytu
// wodomierzy w grudniu" odpada sam, choc mowi o wodomierzach.
//
// DLACZEGO TRESC CZYTAMY Z PODSTRONY, A NIE Z LISTY: na liscie odnosnik ma
// tekst "czytaj dalej", a tytul stoi obok niego. Sonda nr 8 wlasnie na tym
// sie potknela i zwrocila zero wpisow o wodzie, choc na liscie Otynia wisialy
// trzy. Sama lista nie niesie zadnej tresci, wiec i tak trzeba wejsc glebiej.

const cheerio = require('cheerio');
const {
  zbudujTytul, kategoriaWpisu, czyOdwolana, wykryjMiejsce, TYTUL_O_PRZYWROCENIU_RE,
} = require('./gminy');
const { qualityCheck } = require('./qualityCheck');
const { extractPolishDate } = require('./polishDates');
const { LIMIT_ZRODLA } = require('./sanitize');

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

// Adresy probujemy po kolei i pamietamy pierwszy, ktory odpowiedzial. Otyn
// stoi na "http://" i sonda nie sprawdzila, czy ma dzialajace "https://" -
// probujemy wiec szyfrowanego najpierw i przechodzimy na nieszyfrowany
// dopiero wtedy, gdy tamten nie odpowie. Jesli gmina wlaczy kiedys https,
// zaczniemy go uzywac sami, bez zmiany w kodzie.
const ZRODLA_CMS = [
  {
    gmina: 'Świdnica',
    zrodlo: 'Gmina Świdnica',
    adresy: ['https://swidnica.zgora.pl/'],
  },
  {
    gmina: 'Otyń',
    zrodlo: 'Gmina Otyń',
    adresy: ['https://www.otyn.pl/', 'http://www.otyn.pl/'],
  },
];

const LIMIT_CZASU_MS = 15000;

// Komunikaty newsowe maja w adresie dzial 1000. Strony stale leza w innych
// dzialach i NIE moga wejsc do appki: sonda zlapala na liscie Swidnicy
// "SMS-owy system powiadamiania" (dzial 3131) oraz "Gmina Swidnica"
// (dzial 3035) - to pozycje menu, nie komunikaty.
const ADRES_KOMUNIKATU_RE = /\/PL\/1000\/(\d+)\/[^/]+\/k\/?$/;

const MAX_WPISOW_Z_LISTY = 20;
const MAX_POBRAN_NA_CYKL = 3;      // na gmine, nie razem
const MAX_PROB_PODSTRONY = 3;
const MIN_DL_OPISU = 40;
const MAX_PAMIECI = 200;

// Komunikat o trwajacej albo dopiero zapowiedzianej przerwie urzad CZESTO
// EDYTUJE - dopisuje do tej samej strony akapit o przywroceniu dostawy,
// zamiast publikowac nowy wpis. Tak robi POMAK w Czerwiensku i nie ma powodu
// zakladac, ze te urzedy robia inaczej. Gdybysmy trzymali raz pobrana tresc
// na zawsze, mieszkaniec Grabowca czytalby ostrzezenie o awarii, ktora juz
// sie skonczyla. Dlatego wpisy ZYWE - takie, ktorych data zdarzenia jest
// dzisiejsza albo przyszla - odswiezamy co kilka godzin. Stare zostaja
// w pamieci na zawsze, bo nikt ich już nie zmieni.
const SWIEZOSC_ZYWEGO_MS = 6 * 3600 * 1000;
const DNI_UWAZANE_ZA_ZYWE = 3;

const pamiec = new Map();            // url -> { tytul, data, opis, pobrano }
const nieudanePodstrony = new Map(); // url -> liczba prob
const dzialajacyAdres = new Map();   // gmina -> adres, ktory odpowiedzial

// Awarii wody w gminie moze nie byc przez caly miesiac, wiec pusty wynik jest
// stanem normalnym i nie moze alarmowac. Alarmujemy tylko wtedy, gdy strona
// przestaje odpowiadac - tak samo jak przy kanalach RSS w gminy.js.
const BLEDY_PRZED_ALERTEM = 8;
const stanStron = new Map();

// Gdy klasyfikator powie "prad", a w tekscie stoi wprost mowa o wodzie,
// wygrywa woda. Powod jest z zycia: komunikat Spolki Wodno-Sciekowej
// o pekniętym rurociagu brzmial "w wyniku prac zwiazanych z kladzeniem sieci
// ENERGETYCZNEJ doszlo do uszkodzenia glownego RUROCIAGU" - i awaria wody
// wyladowala w zakladce "prad". Tutaj kategorii nie da sie przypisac zrodlu,
// bo urzad pisze i o wodzie, i o pradzie, wiec potrzebna jest ta zapora.
const WODA_WPROST = new RegExp([
  'dostaw\\w*\\s+wody',
  'przerw\\w*\\s+w\\s+dostawie\\s+wody',
  'brak\\w*\\s+wody',
  'bez\\s+wody',
  'wodoci[ąa]g',
  'wodomierz',
  'sieci\\s+wodn',
  'hydrofor',
  'uj[ęe]ci\\w*\\s+wody',
  'jako[śs][ćc]\\s+wody',
  'zm[ęe]tnieni',
  'uzdatnian',
].join('|'), 'i');

function ustalKategorie(tytul, opis) {
  const kategoria = kategoriaWpisu(tytul, opis);
  if (!kategoria) return null;
  if (kategoria === 'prad' && WODA_WPROST.test(`${tytul} ${opis}`)) return 'wodociagi';
  return kategoria;
}

// Podpis urzedu na koncu komunikatu ("Urzad Miejski w Otyniu"). Dla
// mieszkanca nie niesie nic - wie, ze czyta komunikat gminy, bo tytul
// zaczyna sie od jej nazwy. Usuwamy go TYLKO z konca i tylko gdy jest
// krotki: w komunikacie Swidnicy zdanie "Zaklad Uslug Komunalnych informuje,
// ze..." zaczyna tresc i jest w niej najwazniejsze.
const PODPIS_RE = /^(urz[ąa]d\s+(miejski|gminy)|zak[łl]ad\s+us[łl]ug\s+komunalnych|w[óo]jt|burmistrz)\b/i;
const MAX_DL_PODPISU = 60;

const SMIECI_RE = [
  /^aktualno[śs]ci$/i,
  /^pozosta[łl]e\s+aktualno[śs]ci$/i,
  /^drukuj$/i,
  /^autor:/i,
  /^elementy\s+dodatkowe/i,
];

/**
 * Data z CMS-a: "23-11-2026" (DD-MM-RRRR). Zwraca Date albo null.
 * Swiadomie NIE przyjmujemy "dzisiaj" przy braku daty - raz nas to
 * kosztowalo komunikat z 2023 roku pokazany jako dzisiejszy, razem z pushem.
 */
function dataZCms(tekst) {
  const m = String(tekst || '').match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (!m) return null;
  const [, d, mies, rok] = m;
  const data = new Date(Number(rok), Number(mies) - 1, Number(d), 12);
  if (Number.isNaN(data.getTime())) return null;
  if (Number(mies) < 1 || Number(mies) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return data;
}

/**
 * Wpisy z listy aktualnosci. Tytul bierzemy z atrybutu "title" odnosnika albo
 * z naglowka w otaczajacym bloku - NIE z tekstu odnosnika, bo ten brzmi
 * "czytaj dalej". Tytul z listy sluzy wylacznie do logow i do kolejnosci;
 * do appki idzie tytul z podstrony.
 */
function wyciagListe(html, bazowyUrl) {
  const $ = cheerio.load(html);
  const wpisy = [];

  $('a[href]').each((_, el) => {
    const $a = $(el);
    let pelny;
    try { pelny = new URL($a.attr('href') || '', bazowyUrl).href; } catch { return; }

    const m = pelny.match(ADRES_KOMUNIKATU_RE);
    if (!m) return;
    if (wpisy.some((w) => w.url === pelny)) return;

    const blok = $a.closest('.owl-content, .news-box-item, .information, li, div');
    const zTitle = ($a.attr('title') || '').replace(/^Przejd[źz] do informacji:\s*/i, '').trim();
    const zNaglowka = blok.find('h2, h3, h4').first().text().replace(/\s+/g, ' ').trim();
    const tytul = zTitle || zNaglowka || $a.text().replace(/\s+/g, ' ').trim();

    wpisy.push({
      url: pelny,
      numer: Number(m[1]),
      tytul,
      data: dataZCms(blok.find('.date').first().text()),
    });
  });

  // Numer w adresie rosnie z kazdym nowym komunikatem, wiec sluzy za date
  // tam, gdzie lista jej nie podaje (Swidnica). Najnowsze pobieramy pierwsze -
  // zeby po restarcie serwera swieza awaria weszla do appki w pierwszym
  // cyklu, a nie po godzinie dociagania starych wpisow.
  wpisy.sort((a, b) => b.numer - a.numer);
  return wpisy.slice(0, MAX_WPISOW_Z_LISTY);
}

/**
 * Tytul, data i tresc z podstrony komunikatu. Bez sieci - zeby dalo sie to
 * sprawdzic testem na prawdziwym HTML-u ze sondy.
 */
function wyciagPodstrone(html) {
  const $ = cheerio.load(html);
  $('script, style, .information-picture, .information-content-addons-header').remove();
  // Bez tego cheerio sklei zdania rozdzielone samym <br>.
  $('br').replaceWith(' ');

  const naglowek = $('.information-header').first();
  const tytul = naglowek.find('h2').first().text().replace(/\s+/g, ' ').trim();
  const data = dataZCms(naglowek.find('li.date').first().text());

  const tresc = $('.information-content-paragraph-first').first();
  const linie = [];
  tresc.find('p, div, li, td').each((_, el) => {
    const $el = $(el);
    // Bierzemy tylko liscie, inaczej tresc powtarzalaby sie raz po raz
    // na kazdym poziomie zagniezdzenia.
    if ($el.children('p, div, li, td').length) return;
    const t = $el.text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2) return;
    if (SMIECI_RE.some((re) => re.test(t))) return;
    if (linie.includes(t)) return;
    linie.push(t);
  });

  // Gdy tresc nie jest podzielona na bloki, zostaje caly tekst pojemnika.
  if (!linie.length) {
    const caly = tresc.text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (caly) linie.push(caly);
  }

  while (linie.length > 1
    && linie[linie.length - 1].length <= MAX_DL_PODPISU
    && PODPIS_RE.test(linie[linie.length - 1])) {
    linie.pop();
  }

  const opis = linie.join(' ').replace(/\s+/g, ' ').trim().slice(0, LIMIT_ZRODLA);
  return { tytul, data, opis };
}

/**
 * Zamienia pobrane podstrony na wpisy appki. Bez sieci.
 */
function zbudujWpisy(zrodlo, strony) {
  const wyniki = [];
  let pominietych = 0;
  const bezTresci = [];

  for (const strona of strony || []) {
    const tytul = String(strona.tytul || '').replace(/\s+/g, ' ').trim();
    const opis = String(strona.opis || '').trim();

    if (!tytul || !strona.url) {
      pominietych += 1;
      continue;
    }

    if (opis.length < MIN_DL_OPISU) {
      bezTresci.push(tytul);
      pominietych += 1;
      continue;
    }

    const kategoria = ustalKategorie(tytul, opis);
    if (!kategoria) {
      pominietych += 1;
      continue;
    }

    const zakonczona = czyOdwolana(`${tytul} ${opis}`) && !TYTUL_O_PRZYWROCENIU_RE.test(tytul);
    const zdarzenie = extractPolishDate(opis) || extractPolishDate(tytul);

    wyniki.push(qualityCheck({
      source_url: strona.url,
      source_name: zrodlo.zrodlo,
      category: kategoria,
      title: zbudujTytul(zrodlo.gmina, tytul, zakonczona),
      street: wykryjMiejsce(tytul, opis),
      description: opis,
      published_at: strona.data ? strona.data.toISOString() : null,
      event_date: zdarzenie ? zdarzenie.toISOString() : null,
    }));
  }

  return { wyniki, pominietych, bezTresci };
}

/** Czy pobrana juz tresc trzeba odswiezyc, bo komunikat moze byc edytowany. */
function trzebaOdswiezyc(zapamietane, teraz = Date.now()) {
  if (!zapamietane) return true;
  if (teraz - zapamietane.pobrano < SWIEZOSC_ZYWEGO_MS) return false;

  // Odswiezamy WYLACZNIE to, co w ogole trafia do appki. Symulacja czterech
  // cykli pokazala, po co ten warunek: bez niego "Stypendia naukowe rozdane"
  // byly pobierane ponownie co szesc godzin tylko dlatego, ze mialy swieza
  // date publikacji - a nigdy nie wchodza do appki, bo to nie utrudnienie.
  // Kosztowalo to po jedno pobranie na cykl z budzetu, ktory ma sluzyc
  // prawdziwej awarii, i rosloby z kazdym newsem na stronie gminy.
  if (!ustalKategorie(zapamietane.tytul || '', zapamietane.opis || '')) return false;

  const zdarzenie = extractPolishDate(zapamietane.opis) || extractPolishDate(zapamietane.tytul);
  const granica = new Date(teraz - DNI_UWAZANE_ZA_ZYWE * 24 * 3600 * 1000);
  if (zdarzenie) return zdarzenie >= granica;
  if (zapamietane.data) return zapamietane.data >= granica;
  return false;
}

function zapamietaj(url, dane) {
  if (pamiec.size >= MAX_PAMIECI) {
    const najstarszy = pamiec.keys().next().value;
    pamiec.delete(najstarszy);
  }
  pamiec.delete(url);
  pamiec.set(url, { ...dane, pobrano: Date.now() });
}

function odnotujBlad(zrodlo, szczegol) {
  const s = stanStron.get(zrodlo.gmina) || { bledy: 0, zgloszony: false };
  s.bledy += 1;
  stanStron.set(zrodlo.gmina, s);

  if (s.bledy >= BLEDY_PRZED_ALERTEM && !s.zgloszony) {
    s.zgloszony = true;
    console.error(`[gminyCms] UWAGA: strona ${zrodlo.zrodlo} nie odpowiada od ${s.bledy} cykli `
      + `z rzedu (${szczegol}) - awarie wody w gminie ${zrodlo.gmina} moga nie docierac do appki`);
  }
}

function odnotujSukces(zrodlo) {
  const s = stanStron.get(zrodlo.gmina);
  if (s && s.bledy) {
    console.log(`[gminyCms] strona ${zrodlo.zrodlo} znowu odpowiada (po ${s.bledy} bledach)`);
  }
  stanStron.set(zrodlo.gmina, { bledy: 0, zgloszony: false });
}

async function pobierz(url) {
  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);
  try {
    const odp = await fetch(url, { headers: NAGLOWKI, redirect: 'follow', signal: kontroler.signal });
    if (!odp.ok) throw new Error(`HTTP ${odp.status}`);
    return { tekst: await odp.text(), koncowyUrl: odp.url };
  } finally {
    clearTimeout(stoper);
  }
}

async function pobierzListe(zrodlo) {
  const znany = dzialajacyAdres.get(zrodlo.gmina);
  const kolejka = znany ? [znany, ...zrodlo.adresy.filter((a) => a !== znany)] : zrodlo.adresy;

  let ostatniBlad = null;
  for (const adres of kolejka) {
    try {
      const odp = await pobierz(adres);
      if (dzialajacyAdres.get(zrodlo.gmina) !== adres) {
        dzialajacyAdres.set(zrodlo.gmina, adres);
        if (adres.startsWith('http://')) {
          console.warn(`[gminyCms] ${zrodlo.gmina}: czytam przez nieszyfrowane "http://" `
            + '- gmina nie wystawia dzialajacego https');
        }
      }
      return odp;
    } catch (err) {
      ostatniBlad = err;
    }
  }
  throw ostatniBlad || new Error('brak adresow do sprawdzenia');
}

async function obsluzGmine(zrodlo) {
  const odp = await pobierzListe(zrodlo);
  const lista = wyciagListe(odp.tekst, odp.koncowyUrl);
  odnotujSukces(zrodlo);

  let pobran = 0;
  const strony = [];

  for (const wpis of lista) {
    const zapamietane = pamiec.get(wpis.url);
    const prob = nieudanePodstrony.get(wpis.url) || 0;

    if (zapamietane && !trzebaOdswiezyc(zapamietane)) {
      strony.push({ ...zapamietane, url: wpis.url });
      continue;
    }

    if (pobran >= MAX_POBRAN_NA_CYKL || prob >= MAX_PROB_PODSTRONY) {
      if (zapamietane) strony.push({ ...zapamietane, url: wpis.url });
      continue;
    }

    try {
      pobran += 1;
      const podstrona = await pobierz(wpis.url);
      const dane = wyciagPodstrone(podstrona.tekst);

      if (!dane.tytul || dane.opis.length < MIN_DL_OPISU) {
        nieudanePodstrony.set(wpis.url, prob + 1);
        console.warn(`[gminyCms] ${zrodlo.gmina}: podstrona nie dala tresci `
          + `(proba ${prob + 1}/${MAX_PROB_PODSTRONY}): "${wpis.tytul}"`);
        if (zapamietane) strony.push({ ...zapamietane, url: wpis.url });
        continue;
      }

      nieudanePodstrony.delete(wpis.url);
      zapamietaj(wpis.url, dane);
      strony.push({ ...dane, url: wpis.url });
    } catch (err) {
      nieudanePodstrony.set(wpis.url, prob + 1);
      console.warn(`[gminyCms] ${zrodlo.gmina}: nie udalo sie pobrac podstrony `
        + `(proba ${prob + 1}/${MAX_PROB_PODSTRONY}): ${err.message}`);
      if (zapamietane) strony.push({ ...zapamietane, url: wpis.url });
    }
  }

  const { wyniki, pominietych, bezTresci } = zbudujWpisy(zrodlo, strony);
  return {
    wyniki, pominietych, bezTresci, naLiscie: lista.length, pobran,
  };
}

async function fetchGminyCms() {
  const wszystkie = [];
  const podsumowanie = [];

  for (const zrodlo of ZRODLA_CMS) {
    try {
      const w = await obsluzGmine(zrodlo);
      wszystkie.push(...w.wyniki);
      podsumowanie.push(`${zrodlo.gmina}: ${w.naLiscie} na liscie, ${w.wyniki.length} o utrudnieniach, `
        + `${w.pominietych} pominietych, ${w.pobran} podstron pobranych`);

      if (w.bezTresci.length) {
        console.warn(`[gminyCms] ${zrodlo.gmina}: ${w.bezTresci.length} komunikatow bez tresci `
          + `(${w.bezTresci.map((t) => `"${t}"`).join(', ')}) - do appki nie weszly`);
      }

      for (const wpis of w.wyniki) {
        if (wpis.needs_review) {
          console.warn(`[gminyCms] wpis do przejrzenia (${wpis.title}):`, wpis.review_reasons.join('; '));
        }
      }
    } catch (err) {
      odnotujBlad(zrodlo, err.message);
      podsumowanie.push(`${zrodlo.gmina}: BLAD (${err.message})`);
    }
  }

  console.log(`[gminyCms] ${podsumowanie.join(' | ')}`);
  return wszystkie;
}

module.exports = {
  fetchGminyCms,
  wyciagListe,
  wyciagPodstrone,
  zbudujWpisy,
  ustalKategorie,
  dataZCms,
  trzebaOdswiezyc,
  ZRODLA_CMS,
  ADRES_KOMUNIKATU_RE,
  MIN_DL_OPISU,
};
