// Powiatowy Zielonogorski Zarzad Drog w Gorzykowie (PZZD).
//
// Zarzadca drog POWIATOWYCH wokol Zielonej Gory - Swidnica, Czerwiensk,
// Nowogrod Bobrzanski, Zabor, Sulechow. To jest ta czesc "i okolic",
// ktorej nie pokrywa ani miasto (drogi miejskie), ani ZDW (wojewodzkie),
// ani GDDKiA (krajowe).
//
// SKAD BIERZEMY DANE
// BIP ma wydzielona zakladke "Utrudnienia w ruchu" (/47/), w ktorej kazde
// zamkniecie jest osobna pozycja podmenu, a data stoi wprost w nazwie:
//     "28.10.2026 Zamkniecie drogi powiatowej nr 1181F"
// Tresc zawiadomienia (ktory odcinek, od kiedy do kiedy, ktoredy objazd)
// jest dopiero na podstronie, wiec dociagamy ja osobno - dokladnie tak
// samo jak przy ZWiK-u, razem z pamiecia podreczna w bazie.
//
// SKALA: okolo szesciu komunikatow rocznie. Malo, ale kazdy to prawdziwe
// zamkniecie trwajace od kilku dni do dwoch tygodni i nie ma go w zadnym
// innym zrodle appki.

const cheerio = require('cheerio');
const { qualityCheck } = require('./qualityCheck');
const { extractPolishDate } = require('./polishDates');
const { getDescriptionsByUrls } = require('./db');
const { LIMIT_ZRODLA } = require('./sanitize');

const HOST = 'https://bip.pzzd.powiat-zielonogorski.pl';
const STRONA_LISTY = `${HOST}/47/Utrudnienia_w_ruchu/`;

// Ile podstron dociagamy w jednym cyklu. To zwykly BIP, nie API -
// pobieramy kroplowo i tylko to, czego naprawde brakuje.
const MAX_POBRAN_NA_CYKL = 3;

// Podstrony, ktore odpowiedzialy, ale nie dalo sie z nich wyciagnac tresci.
// Bez tego licznika kazdy taki komunikat byl pobierany ponownie co 10 minut
// do konca swiata i zjadal limit, ktory nalezal sie nowszym wpisom.
// Licznik zeruje sie przy restarcie serwera - czyli po kazdym wdrozeniu
// poprawki parsera probujemy od nowa, i to jest zamierzone.
const nieudanePodstrony = new Map();
const MAX_PROB_PODSTRONY = 3;

// Jak sie przedstawiamy. To NIE jest drobiazg: 22.11.2026 pierwsze wdrozenie
// dostalo z BIP-u HTTP 403, mimo ze dwa dni wczesniej sondy pobraly te same
// strony z tego samego serwera Render bez problemu. Jedyna roznica miedzy nimi
// byla nazwa w User-Agent - sondy mowily "UtrudnieniaZG-sonda", a scraper
// "UtrudnieniaZG-bot". Filtry na BIP-ach i zapory aplikacyjne rutynowo odrzucaja
// wszystko, co ma w nazwie "bot", "crawler" czy "spider".
//
// Dlatego nie zgadujemy jednego napisu, tylko mamy liste i trzymamy sie
// pierwszego, ktory zadziala - dokladnie tak, jak dziala juz wybor posrednika
// w mzk.js. Zadna z tych nazw nikogo nie udaje: kazda mowi, czym jesteśmy, i
// podaje kontakt, zeby urzad mial do kogo napisac. Ostatnia, przegladarkowa,
// jest wylacznie awaryjna.
const WARIANTY_UA = [
  'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'UtrudnieniaZG-sonda/1.0 (+info@utrudnienia-zg.pl)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/131.0.0.0 Safari/537.36',
];

// Odpowiedzi, ktore znacza "blokujemy Cie", a nie "nie ma takiej strony".
// Tylko przy nich warto sprobowac przedstawic sie inaczej.
const KODY_BLOKADY = [401, 403, 406, 429];

// Indeks wariantu, ktory ostatnio zadzialal. Zostaje do restartu serwera.
let dzialajacyUA = 0;
let zgloszonoUA = false;

function naglowki(indeksUA) {
  return {
    'User-Agent': WARIANTY_UA[indeksUA],
    'Accept': 'text/html,*/*;q=0.8',
    'Accept-Language': 'pl-PL,pl;q=0.9',
  };
}

// Linie, ktore w zawiadomieniu sa ozdoba albo odsylaczem do zalacznika,
// a nie trescia. "Z A W I A D O M I E N I E" bywa rozstrzelone spacjami.
const SMIECI = [
  /^akapit nr \d+/i,
  /^z\s*a\s*w\s*i\s*a\s*d\s*o\s*m\s*i\s*e\s*n\s*i\s*e$/i,
  // Sama data w osobnej linii - BIP stawia ja nad zawiadomieniem. Czasem
  // z "r." na koncu ("05.06.2023r."), czasem bez.
  /^\d{1,2}\.\d{1,2}\.\d{4}\s*(r\.?)?\s*$/i,
  /^(za[łl][ąa]cznik\w*|plik\w*|mapk\w*)\s*(do pobrania|z orientacyjnym[^:]*)?\s*[:.]?\s*$/i,
  /^w za[łl][ąa]czeniu mapka/i,
  /^pobierz dane xml/i,
  /^drukuj/i,
];

// Surowe adresy plikow do pobrania nie sa trescia komunikatu, a w tym BIP-ie
// stoja raz w osobnym <div>, a raz WKLEJONE wprost za etykieta - w komunikacie
// o drodze 1140F cala linia brzmi "Plik do pobrania:https://bip...". Dlatego
// nie wyliczamy kolejnych ksztaltow, tylko wycinamy adres z kazdej linii i
// dopiero potem patrzymy, czy zostalo cos poza etykieta.
const ADRES_RE = /https?:\/\/\S+/gi;

function czysty(tekst) {
  return String(tekst || '').replace(ADRES_RE, ' ').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function jestSmieciem(linia) {
  if (!linia) return true;
  // Po wycieciu adresu moze zostac sama interpunkcja ("Plik do pobrania:"
  // bez tresci) albo jedna litera - to nie jest zdanie dla mieszkanca.
  const litery = (linia.match(/[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
  if (litery < 2) return true;
  return SMIECI.some((re) => re.test(linia));
}

/**
 * Wyciaga liste komunikatow ze strony "Utrudnienia w ruchu".
 * Bez sieci - dziala na gotowym HTML, zeby dalo sie to przetestowac.
 */
function wyciagListe(html) {
  const $ = cheerio.load(html);
  const wpisy = [];
  const widziane = new Set();

  // Sposob glowny: podmenu pod pozycja "Utrudnienia w ruchu". Precyzyjny,
  // bo bierze wylacznie dzieci tej jednej galezi menu, a nie wszystkie
  // odnosniki BIP-u (gdzie sa tez nabory, kontrole i regulaminy).
  const $pozycja = $(`a[href*="/47/Utrudnienia_w_ruchu/"]`).first().closest('li');
  let $linki = $pozycja.find('ul a[href]');

  // Sposob zapasowy: gdyby urzad przebudowal menu, bierzemy z calej strony
  // odnosniki, ktorych tekst zaczyna sie od daty. Mniej precyzyjne, ale
  // ratuje zrodlo zamiast zwracac zero.
  let sposob = 'podmenu';
  if ($linki.length === 0) {
    sposob = 'zapasowy (cala strona)';
    $linki = $('a[href]');
  }

  $linki.each((_, el) => {
    const href = $(el).attr('href') || '';
    const tekst = czysty($(el).text());
    if (!href.startsWith(HOST) && !href.startsWith('/')) return;

    const pelny = href.startsWith('http') ? href : `${HOST}${href}`;
    // Pozycje tresci maja adres postaci /<liczba>/<nazwa>/ - to odsiewa
    // odnosniki do wyszukiwarki, rejestru zmian czy archiwum.
    if (!/^https?:\/\/[^/]+\/\d+\/[^/]+\/?$/.test(pelny)) return;
    if (pelny === STRONA_LISTY) return;
    if (widziane.has(pelny)) return;

    const zData = tekst.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(.+)$/);

    // W trybie zapasowym bierzemy WYLACZNIE pozycje z data na poczatku -
    // inaczej wciagnelibysmy cale menu BIP-u.
    if (!zData && sposob !== 'podmenu') return;
    if (!tekst || tekst.length < 8) return;

    widziane.add(pelny);
    wpisy.push({
      url: pelny,
      tytul: zData ? zData[4].trim() : tekst,
      // Data bez godziny, w strefie lokalnej - tak samo jak w pozostalych
      // scraperach, zeby wpisy z roznych zrodel sortowaly sie spojnie.
      data: zData ? new Date(Number(zData[3]), Number(zData[2]) - 1, Number(zData[1])) : null,
    });
  });

  return { wpisy, sposob };
}

/**
 * Wyciaga tresc zawiadomienia z podstrony. Tez bez sieci.
 */
function wyciagTresc(html) {
  const $ = cheerio.load(html);

  const $obszar = $('.paragraph').first();
  if (!$obszar.length) return '';

  // Obrazki, ukryte naglowki i odsylacze do zalacznikow nie niosa tresci.
  $obszar.find('h4.hide, img, script, style').remove();

  const linie = [];
  $obszar.find('div, p, li').each((_, el) => {
    const $el = $(el);
    // Bierzemy tylko elementy "liscie" - inaczej tekst powtarzalby sie
    // tyle razy, ile jest zagniezdzen (a w tym BIP-ie sa cztery poziomy).
    if ($el.children('div, p, li').length) return;
    const t = czysty($el.text());
    if (jestSmieciem(t)) return;
    if (linie.includes(t)) return;
    linie.push(t);
  });

  // Zdanie konczace sie dwukropkiem obiecuje ciag dalszy. Gdy po nim nic nie
  // zostalo, obietnica jest bez pokrycia - i wlasnie tak konczyly sie dwa
  // komunikaty 22.11.2026: "Mape z zaznaczonymi ulicami przejazdu wyscigu
  // mozna pobrac ponizej:" oraz "Proponowany objazd:". W obu przypadkach
  // dalej byl tylko adres pliku PDF, ktory wycinamy, bo nie jest trescia.
  // qualityCheck wylapal to sam ("opis urywa sie na dwukropku") i oznaczyl
  // wpisy do przejrzenia, czyli ukryl je w appce.
  //
  // Nie dopisujemy kolejnych sformulowan do listy SMIECI, bo urzad zawsze
  // wymysli nowe ("szczegoly w zalaczniku:", "trasa objazdu:"). Zamiast tego
  // odcinamy KAZDE wiszace zdanie z konca - niezaleznie od tego, jak brzmi.
  // W srodku tekstu dwukropek zostaje nietkniety, bo tam ciag dalszy jest.
  while (linie.length && /:\s*$/.test(linie[linie.length - 1])) linie.pop();

  return linie.join(' ').replace(/\s+/g, ' ').trim().slice(0, LIMIT_ZRODLA);
}

/**
 * Kolejnosc dociagania podstron: OD NAJNOWSZEJ, wpisy bez daty na koniec.
 *
 * Pierwsza wersja szla po prostu w kolejnosci menu, czyli od najstarszych -
 * i limit trzech pobran na cykl wyczerpywal sie na komunikatach z 2023 i maja,
 * a najswiezsze zamkniecie drogi trafialo do appki jako sam tytul, bez tresci.
 * Czyli dokladnie ten wpis, na ktorym mieszkancowi zalezy najbardziej, byl
 * obslugiwany ostatni. Nie wykryl tego test parsera, tylko przejscie calej
 * drogi od HTML do bazy - dlatego ta decyzja jest tu osobna funkcja.
 */
function kolejnoscPobierania(wpisy) {
  return [...wpisy].sort((a, b) => {
    if (a.data && b.data) return b.data - a.data;
    if (a.data) return -1;
    if (b.data) return 1;
    return 0;
  });
}

/**
 * Data publikacji komunikatu.
 *
 * Tu PZZD rozni sie od wszystkich pozostalych zrodel: w zakladce wisi pozycja
 * "1 2023 Utrudnienia w ruchu drogowym - most na Kanale Dychowskim", ktora NIE
 * MA daty w nazwie. Gdybysmy oddali null, baza wstawilaby COALESCE(..., 'now')
 * - i zamkniecie mostu z 2023 roku wyladowaloby na szczycie listy jako
 * dzisiejsza wiadomosc, razem z powiadomieniem push do wszystkich.
 *
 * Szukamy wiec po kolei: data w nazwie pozycji, potem data w tresci
 * zawiadomienia, a na koniec sam rok z nazwy. Rok to przyblizenie (1 stycznia),
 * ale stawia wpis tam, gdzie historycznie nalezy, i trzyma go z dala od push.
 */
function dataPublikacjiWpisu(wpis, opis) {
  if (wpis.data) return wpis.data;

  const zTresci = extractPolishDate(opis || '');
  if (zTresci) return zTresci;

  const rok = String(wpis.tytul || '').match(/\b(20\d{2})\b/);
  return rok ? new Date(Number(rok[1]), 0, 1) : null;
}

/**
 * Czy wpis nadal czeka na prawdziwa tresc zawiadomienia.
 *
 * Pierwsza wersja pytala tylko "czy opis ma mniej niz 60 znakow" - i wpadla
 * w te sama pulapke, co reszta tego projektu: komunikat "1 2023 Utrudnienia
 * w ruchu drogowym - most na Kanale Dychowskim - przed m. Lagoda" ma sam
 * tytul dlugosci 81 znakow. Zapisany raz jako opis = tytul przechodzil ten
 * warunek i NIGDY wiecej nie byl pobierany. Wpis zamarzal na zawsze z pustym
 * opisem, a nikt by sie o tym nie dowiedzial. Wylapala to dopiero symulacja
 * czterech kolejnych cykli, nie jeden przebieg.
 *
 * Wlasciwe pytanie nie dotyczy dlugosci, tylko tego, czy w bazie siedzi
 * cokolwiek POZA tytulem.
 */
function brakTresci(opis, tytul) {
  if (!opis) return true;
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm(opis) === norm(tytul)) return true;

  // Opis konczacy sie dwukropkiem to slad po starej wersji parsera, ktora
  // zostawiala wiszace zdanie ("Proponowany objazd:"). Takie opisy siedza
  // JUZ w bazie - dlugie i rozne od tytulu, wiec bez tego warunku zostalyby
  // tam na zawsze, a appka trzymalaby oba komunikaty ukryte jako wpisy do
  // przejrzenia. Pytanie "czy ta tresc jest w porzadku" musi obejmowac tez
  // to, co zapisalismy wczoraj, nie tylko to, co pobieramy dzisiaj - bo na
  // tym wlasnie wykladalismy sie w tym projekcie najczesciej.
  if (/:\s*$/.test(opis.trim())) return true;

  return opis.length < 60;
}

/**
 * Pobiera strone. Przy odpowiedzi "blokujemy Cie" (403 i pokrewne) probuje
 * przedstawic sie inaczej i zapamietuje wariant, ktory zadzialal - zeby nie
 * dobijac sie do urzedu trzema zapytaniami przy kazdej kolejnej stronie.
 *
 * Kolejne warianty probujemy TYLKO przy kodach blokady. Przy 404 albo 500
 * zmiana nazwy nic nie da, a tylko mnozylaby zapytania.
 */
async function pobierz(url) {
  let ostatniKod = null;

  for (let i = 0; i < WARIANTY_UA.length; i += 1) {
    // Zaczynamy od wariantu, ktory juz raz zadzialal w tym procesie.
    const indeks = (dzialajacyUA + i) % WARIANTY_UA.length;
    const odp = await fetch(url, { headers: naglowki(indeks), redirect: 'follow' });

    if (odp.ok) {
      if (indeks !== dzialajacyUA || !zgloszonoUA) {
        console.log(`[pzzd] BIP przyjmuje zapytania jako "${WARIANTY_UA[indeks].split(' ')[0]}"`);
        zgloszonoUA = true;
      }
      dzialajacyUA = indeks;
      return odp.text();
    }

    ostatniKod = odp.status;
    if (!KODY_BLOKADY.includes(odp.status)) break;

    console.warn(`[pzzd] HTTP ${odp.status} przy nazwie "${WARIANTY_UA[indeks].split(' ')[0]}" `
      + `- probuje przedstawic sie inaczej (${i + 1}/${WARIANTY_UA.length})`);
  }

  if (KODY_BLOKADY.includes(ostatniKod)) {
    throw new Error(`HTTP ${ostatniKod} - BIP odrzuca wszystkie nasze nazwy, `
      + 'zrodlo wymaga kontaktu z urzedem');
  }
  throw new Error(`HTTP ${ostatniKod}`);
}

async function fetchPzzd() {
  const wyniki = [];

  let html;
  try {
    html = await pobierz(STRONA_LISTY);
  } catch (err) {
    console.error(`[pzzd] nie udalo sie pobrac listy (${STRONA_LISTY}):`, err.message);
    return wyniki;
  }

  const { wpisy, sposob } = wyciagListe(html);
  if (sposob !== 'podmenu') {
    console.warn('[pzzd] UWAGA: podmenu "Utrudnienia w ruchu" nie znalezione - '
      + 'uzywam sposobu zapasowego. Urzad mogl przebudowac strone.');
  }
  if (!wpisy.length) {
    console.warn('[pzzd] strona odpowiedziala, ale nie znalazlem ani jednego komunikatu '
      + '- to moze znaczyc, ze zmienil sie uklad BIP-u');
    return wyniki;
  }

  const znaneOpisy = getDescriptionsByUrls(wpisy.map((w) => w.url));
  let pobran = 0;

  for (const wpis of kolejnoscPobierania(wpisy)) {
    let opis = znaneOpisy.get(wpis.url) || '';
    const prob = nieudanePodstrony.get(wpis.url) || 0;

    // Pobieramy podstrone tylko wtedy, gdy nie mamy jeszcze sensownego
    // opisu. Zawiadomienia sie nie zmieniaja, wiec raz pobrane zostaje.
    if (brakTresci(opis, wpis.tytul) && pobran < MAX_POBRAN_NA_CYKL && prob < MAX_PROB_PODSTRONY) {
      pobran += 1;
      try {
        const nowy = wyciagTresc(await pobierz(wpis.url));
        // Nowa tresc wygrywa, gdy jest dluzsza ALBO gdy dotad mielismy w
        // bazie sam tytul - wtedy nawet krotsze zdanie jest wiecej warte
        // niz powtorzony naglowek.
        if (nowy && nowy.length >= 60 && (nowy.length > opis.length || brakTresci(opis, wpis.tytul))) {
          console.log(`[pzzd] pobrano tresc komunikatu (${nowy.length} zn.): "${wpis.tytul}"`);
          opis = nowy;
          nieudanePodstrony.delete(wpis.url);
        } else {
          // Strona odpowiedziala, ale nic z niej nie wyszlo - to blad parsera
          // albo nietypowy uklad. Liczymy probe, zeby nie dobijac sie co cykl.
          nieudanePodstrony.set(wpis.url, prob + 1);
          console.warn(`[pzzd] podstrona nie dala tresci (proba ${prob + 1}/${MAX_PROB_PODSTRONY}): "${wpis.tytul}"`);
        }
      } catch (err) {
        // Awaria sieci NIE zuzywa proby - winna jest chwila, nie parser.
        console.warn(`[pzzd] nie udalo sie pobrac podstrony (${wpis.url}): ${err.message}`);
      }
    }

    // Bez opisu zostaje sam tytul - a ten i tak mowi, ktora droga jest
    // zamknieta. Lepsze to niz pominiecie calego komunikatu.
    const description = opis || wpis.tytul;

    // Data obowiazywania bierze sie z tresci ("od dnia 03.11.2026 r.").
    const eventDate = extractPolishDate(description) || extractPolishDate(wpis.tytul);

    const dataPublikacji = dataPublikacjiWpisu(wpis, description);
    if (!wpis.data && dataPublikacji) {
      console.log(`[pzzd] komunikat bez daty w nazwie - przyjalem ${dataPublikacji.toLocaleDateString('pl-PL')}: "${wpis.tytul}"`);
    } else if (!dataPublikacji) {
      console.warn(`[pzzd] komunikat bez zadnej daty - baza wstawi dzisiejsza: "${wpis.tytul}"`);
    }

    const checked = qualityCheck({
      source_url: wpis.url,
      source_name: 'PZZD Gorzykowo',
      category: 'drogi',
      title: wpis.tytul,
      street: wykryjDroge(wpis.tytul) || wykryjDroge(description),
      description,
      published_at: dataPublikacji ? dataPublikacji.toISOString() : null,
      event_date: eventDate ? eventDate.toISOString() : null,
    });

    if (checked.needs_review) {
      console.warn(`[pzzd] wpis do przejrzenia (${wpis.tytul}):`, checked.review_reasons.join('; '));
    }
    wyniki.push(checked);
  }

  console.log(`[pzzd] ${wpisy.length} komunikatow na liscie, ${pobran} podstron pobranych w tym cyklu`);
  return wyniki;
}

// Drogi powiatowe maja numery w rodzaju 1181F, 1140F. To jest ich
// "nazwa ulicy" - mieszkaniec rozpoznaje je wlasnie po numerze.
function wykryjDroge(tekst) {
  const m = String(tekst || '').match(/dro(?:g[ai]|dze|ge)\s+(?:powiatow\w*\s+)?(?:nr\s*)?(\d{3,4}[A-Z])/i);
  if (m) return `droga powiatowa nr ${m[1].toUpperCase()}`;
  const sam = String(tekst || '').match(/\b(\d{4}[A-Z])\b/);
  return sam ? `droga powiatowa nr ${sam[1].toUpperCase()}` : null;
}

module.exports = {
  fetchPzzd,
  wyciagListe,
  wyciagTresc,
  wykryjDroge,
  kolejnoscPobierania,
  dataPublikacjiWpisu,
  brakTresci,
  WARIANTY_UA,
  KODY_BLOKADY,
};
