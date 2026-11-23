// Test zrodla "gminy" - wodociagi w gminach sasiadujacych z Zielona Gora.
// Uruchomienie:  node testGminy.js
//
// Dane ponizej nie sa wymyslone. Tytuly, daty i tresc komunikatu o Plotach
// pochodza dokladnie z tego, co 23.11.2026 oddaly kanaly RSS POMAK-u
// i Spolki Wodno-Sciekowej (sonda nr 5 i nr 6 uruchomione na serwerze).
//
// Wpisy sa podane w takiej postaci, w jakiej daje je rss-parser (title, link,
// isoDate, contentSnippet, content:encodedSnippet) - dzieki temu test jest
// synchroniczny i nie wychodzi do sieci, wiec moze chodzic przy kazdym
// starcie serwera.

const {
  przetworzWpisy, zbudujTytul, kategoriaWpisu, wyciagOpis, wykryjMiejsce,
  ODWOLANIE_RE, czyOdwolana, przytnijMiejsce,
} = require('./gminy');

const CZERWIENSK = { gmina: 'Czerwieńsk', zrodlo: 'POMAK Czerwieńsk', kanal: 'https://www.pomak.pl/?format=feed&type=rss', kategoria: 'wodociagi' };
const NOWOGROD = { gmina: 'Nowogród Bobrzański', zrodlo: 'Spółka Wodno-Ściekowa Nowogród Bobrzański', kanal: 'https://spwsnow.pl/?feed=rss2', kategoria: 'wodociagi' };

// Tresc komunikatu o Plotach - przepisana z podstrony pomak.pl. To wlasnie
// ten wpis zawiera ODWOLANIE awarii w tym samym tekscie, nizej.
const TRESC_PLOTY = 'UWAGA MIESZKAŃCY PŁOTÓW! PRZERWA W DOSTAWIE WODY '
  + 'W związku z pracami na sieci wodociągowej informujemy, że dzisiaj od godziny 11:00 '
  + 'nastąpi przerwa w dostawie wody w miejscowości Płoty, na ulicach: Letnia Pogodna Wiosenna '
  + 'O przywróceniu dostaw wody poinformujemy w osobnym komunikacie. '
  + 'Przepraszamy za utrudnienia i dziękujemy za wyrozumiałość. '
  + 'AKTUALIZACJA – PRZYWRÓCENIE DOSTAWY WODY '
  + 'Informujemy, że dostawa wody została przywrócona. '
  + 'Obecnie prowadzone jest płukanie sieci wodociągowej. '
  + 'Dziękujemy za cierpliwość i przepraszamy za powstałe utrudnienia.';

const WPISY_POMAK = [
  {
    title: 'Przerwa w dostawie wody - Płoty',
    link: 'https://www.pomak.pl/480-przerwa-w-dostawie-wody-ploty',
    isoDate: '2026-11-20T08:57:38.000Z',
    contentSnippet: 'UWAGA MIESZKAŃCY PŁOTÓW! PRZERWA W DOSTAWIE WODY […]',
    'content:encodedSnippet': TRESC_PLOTY,
  },
  {
    title: 'PRZERWA W DOSTAWIE WODY - SUW PKP CZERWIEŃSK',
    link: 'https://www.pomak.pl/479-przerwa-w-dostawie-wody-suw-pkp-czerwiensk',
    isoDate: '2026-11-12T06:23:06.000Z',
    'content:encodedSnippet': 'Informujemy, że w dniu 13.11.2026 r. nastąpi przerwa w dostawie wody '
      + 'dla odbiorców zasilanych ze Stacji Uzdatniania Wody PKP w Czerwieńsku.',
  },
  {
    title: 'Uwaga Mieszkańcy Płotów - przerwa w dostawie wody',
    link: 'https://www.pomak.pl/478-uwaga-mieszkancy-plotow-przerwa-w-dostawie-wody',
    isoDate: '2026-11-10T06:45:18.000Z',
    'content:encodedSnippet': 'Informujemy, że w dniu dzisiejszym nastąpi przerwa w dostawie wody '
      + 'w miejscowości Płoty przy ul. Letniej w godzinach od 9:00 do 13:00.',
  },
  {
    title: 'UWAGA MIESZKAŃCY NIETKOWA',
    link: 'https://www.pomak.pl/477-uwaga-mieszkancy-nietkowa',
    isoDate: '2026-11-06T08:05:18.000Z',
    'content:encodedSnippet': 'W związku z awarią sieci wodociągowej w miejscowości Nietków '
      + 'nastąpi przerwa w dostawie wody. Przepraszamy za utrudnienia.',
  },
];

const WPISY_NOWOGROD = [
  {
    title: 'KOMUNIKAT',
    link: 'https://spwsnow.pl/?p=1790',
    isoDate: '2026-11-06T13:55:28.000Z',
    contentSnippet: 'Informujemy o przerwie w dostawie wody w dniu 7.11.2026 r. w Nowogrodzie '
      + 'Bobrzańskim przy ul. Kościuszki w godzinach od 8:00 do 12:00.',
  },
  {
    title: 'Przerwa w dostawie wody w Bogaczowie',
    link: 'https://spwsnow.pl/?p=1760',
    isoDate: '2026-08-13T06:20:40.000Z',
    contentSnippet: 'W dniu 14.08.2026 r. nastąpi przerwa w dostawie wody w miejscowości Bogaczów.',
  },
  // Komunikat, ktory JEST samym odwolaniem awarii - nie dopisujemy mu
  // "(zakonczona)", bo to by zabrzmialo absurdalnie.
  {
    title: 'Przywrócenie dostawy wody',
    link: 'https://spwsnow.pl/?p=1755',
    isoDate: '2026-07-04T08:02:23.000Z',
    contentSnippet: 'Informujemy, że awaria została usunięta, a dostawa wody przywrócona.',
  },
];

// To, co w tych kanalach lezy OBOK awarii. Zadna z tych pozycji nie moze
// trafic do appki, choc wszystkie mowia o sieci wodociagowej albo sciekach.
// Tytuly prawdziwe - z kanalu USKOM-u sprawdzonego ta sama sonda.
const WPISY_SZUM = [
  {
    title: 'Oferta pracy na stanowisko Monter–Konserwator Sieci Wodociągowych i Kanalizacyjnych',
    link: 'https://example.test/oferta-pracy',
    isoDate: '2026-11-03T11:52:25.000Z',
    contentSnippet: 'Poszukujemy pracownika na stanowisko montera sieci wodociągowych.',
  },
  {
    title: 'Sukcesywny odbiór oraz zagospodarowanie osadów ściekowych z Oczyszczalni Ścieków',
    link: 'https://example.test/przetarg-osady',
    isoDate: '2026-11-20T12:19:27.000Z',
    contentSnippet: 'Ogłoszenie o zamówieniu na odbiór osadów ściekowych.',
  },
  {
    title: 'Naprawa reaktora biologicznego w Oczyszczalni Ścieków w Podbrzeziu Dolnym',
    link: 'https://example.test/reaktor',
    isoDate: '2026-11-03T11:11:46.000Z',
    contentSnippet: 'Trwa naprawa reaktora biologicznego na oczyszczalni ścieków.',
  },
  {
    title: 'Wieloletni plan rozwoju i modernizacji urządzeń wodociągowych',
    link: 'https://example.test/plan',
    isoDate: '2026-05-10T10:00:00.000Z',
    contentSnippet: 'Plan rozwoju i modernizacji urządzeń wodociągowych i kanalizacyjnych.',
  },
  // Wpis bez odnosnika - baza wymaga source_url, wiec musi wypasc.
  {
    title: 'Przerwa w dostawie wody bez odnośnika',
    link: '',
    isoDate: '2026-11-01T10:00:00.000Z',
    contentSnippet: 'Nastąpi przerwa w dostawie wody.',
  },
  // Wpisy z PUSTA trescia - tak wyglada 8 z 10 pozycji w kanale Spolki
  // Wodno-Sciekowej. Sam tytul "Awaria" nie mowi mieszkancowi ani gdzie,
  // ani kiedy, ani czego dotyczy, wiec do appki wejsc nie moze.
  {
    title: 'Awaria',
    link: 'https://spwsnow.pl/?p=1786',
    isoDate: '2026-07-04T08:02:23.000Z',
  },
  {
    title: 'KOMUNIKAT',
    link: 'https://spwsnow.pl/?p=1791',
    isoDate: '2026-11-06T13:55:28.000Z',
    contentSnippet: '',
  },
  {
    title: 'Uwaga mieszkańcy',
    link: 'https://spwsnow.pl/?p=1770',
    isoDate: '2026-06-26T07:42:43.000Z',
    contentSnippet: 'Uwaga',
  },
];

const bledy = [];
function sprawdz(warunek, opis) {
  if (!warunek) bledy.push(opis);
}

// ===================== 1. CZERWIENSK: wszystko przechodzi ===================
const pomak = przetworzWpisy(CZERWIENSK, WPISY_POMAK);

sprawdz(pomak.wyniki.length === 4,
  `Czerwieńsk: przeszlo ${pomak.wyniki.length} z 4 komunikatow o wodzie`);
sprawdz(pomak.wyniki.every((w) => w.category === 'wodociagi'),
  'Czerwieńsk: nie wszystkie wpisy maja kategorie "wodociagi"');
sprawdz(pomak.wyniki.every((w) => w.source_name === 'POMAK Czerwieńsk'),
  'Czerwieńsk: zla nazwa zrodla');

// ===================== 2. NAZWA GMINY W TYTULE ==============================
const ploty = pomak.wyniki.find((w) => w.source_url.includes('/480-'));
sprawdz(!!ploty, 'Czerwieńsk: brak komunikatu o Płotach');
if (ploty) {
  sprawdz(ploty.title.startsWith('Czerwieńsk: '),
    `tytul: "${ploty.title}" - powinien zaczynac sie od nazwy gminy`);
}

// Tytul, ktory SAM wymienia gmine, nie moze jej dostac drugi raz.
const suw = pomak.wyniki.find((w) => w.source_url.includes('/479-'));
sprawdz(!!suw, 'Czerwieńsk: brak komunikatu o SUW PKP');
if (suw) {
  sprawdz(!suw.title.startsWith('Czerwieńsk: '),
    `tytul: "${suw.title}" - gmina jest juz w tytule zrodla, nie powtarzamy jej`);
  sprawdz(suw.title.includes('CZERWIEŃSK'), `tytul: "${suw.title}" - zgubiono nazwe gminy`);
}

// ===================== 3. AWARIA ODWOLANA W TYM SAMYM WPISIE ================
// Najwazniejszy przypadek w tym pliku. POMAK dopisuje "AKTUALIZACJA -
// PRZYWROCENIE DOSTAWY WODY" do istniejacego komunikatu. Bez znacznika
// mieszkaniec Plotow czytalby ostrzezenie o awarii, ktora juz sie skonczyla.
if (ploty) {
  sprawdz(ploty.title.endsWith('(zakończona)'),
    `tytul: "${ploty.title}" - awaria jest w tresci odwolana, tytul musi to pokazac`);
  // Tresci urzedu nie przepisujemy - ulice i oba akapity musza zostac.
  for (const fragment of ['Letnia', 'Pogodna', 'Wiosenna', 'AKTUALIZACJA', 'została przywrócona']) {
    sprawdz(ploty.description.includes(fragment),
      `tresc Płoty: brakuje fragmentu "${fragment}"`);
  }
}

// Komunikat, ktory jest samym odwolaniem, NIE dostaje "(zakonczona)".
const nowogrod = przetworzWpisy(NOWOGROD, WPISY_NOWOGROD);
const przywrocenie = nowogrod.wyniki.find((w) => w.source_url.includes('1755'));
sprawdz(!!przywrocenie, 'Nowogród: komunikat o przywróceniu wody nie przeszedl');
if (przywrocenie) {
  sprawdz(!przywrocenie.title.includes('(zakończona)'),
    `tytul: "${przywrocenie.title}" - to sam komunikat o przywroceniu, nie dopisujemy znacznika`);
}

// ===================== 4. SZUM MUSI WYPASC ==================================
const szum = przetworzWpisy(CZERWIENSK, WPISY_SZUM);
sprawdz(szum.wyniki.length === 0,
  `szum: przeszlo ${szum.wyniki.length} wpisow, a nie powinien zaden `
  + `(${szum.wyniki.map((w) => `"${w.title}"`).join(', ')})`);
sprawdz(szum.pominietych === WPISY_SZUM.length,
  `szum: pominieto ${szum.pominietych} z ${WPISY_SZUM.length}`);

// Wpisy z pusta trescia maja byc zgloszone OSOBNO - zeby w logu bylo widac,
// ile informacji tracimy przez to, ze kanal wysyla sam tytul.
sprawdz(szum.bezTresci.length === 3,
  `bez tresci: zgloszono ${szum.bezTresci.length}, oczekiwano 3 ("Awaria", "KOMUNIKAT", "Uwaga mieszkancy")`);
sprawdz(szum.bezTresci.includes('Awaria'),
  'bez tresci: wpis "Awaria" bez jednego zdania opisu musi byc zgloszony jako brak tresci');

// Kategoria pochodzi ZE ZRODLA, nie ze zgadywania. Prawdziwy komunikat
// Spolki Wodno-Sciekowej o pekniętym rurociagu nie zawiera slowa "woda",
// za to mowi o "sieci energetycznej" - i trafial przez to do zakladki "prad".
const rurociag = przetworzWpisy(NOWOGROD, [{
  title: 'Uwaga mieszkańcy Pierzwina i Kamionki',
  link: 'https://spwsnow.pl/?p=1780',
  isoDate: '2026-07-27T18:45:59.000Z',
  contentSnippet: 'W wyniku prac związanych z kładzeniem sieci energetycznej doszło do '
    + 'uszkodzenia głównego rurociągu zasilającego te miejscowości. Ze względu na zakres '
    + 'uszkodzeń do usunięcia awarii przystąpimy w dniu jutrzejszym o godz. 4.00.',
}]);
sprawdz(rurociag.wyniki.length === 1, 'rurociag: komunikat o awarii rurociagu nie przeszedl filtra');
if (rurociag.wyniki.length) {
  sprawdz(rurociag.wyniki[0].category === 'wodociagi',
    `rurociag: kategoria to "${rurociag.wyniki[0].category}" - awaria wodociagu ze spolki `
    + 'wodno-sciekowej nie moze trafic do zakladki "prad"');
}

// Sama nazwa sieci wodociagowej nie czyni z oferty pracy utrudnienia.
sprawdz(kategoriaWpisu('Oferta pracy na stanowisko Monter Sieci Wodociągowych',
  'Poszukujemy montera sieci wodociągowych.') === null,
'filtr: oferta pracy w wodociagach zostala uznana za utrudnienie');
sprawdz(kategoriaWpisu('Awaria sieci wodociągowej', 'Brak wody na ul. Letniej.') === 'wodociagi',
  'filtr: prawdziwa awaria wody zostala odrzucona');

// ===================== 5. NOWOGROD: slabe tytuly, dobra tresc ===============
sprawdz(nowogrod.wyniki.length === 3,
  `Nowogród: przeszlo ${nowogrod.wyniki.length} z 3 komunikatow`);
const komunikat = nowogrod.wyniki.find((w) => w.source_url.includes('1790'));
sprawdz(!!komunikat, 'Nowogród: wpis o tytule "KOMUNIKAT" nie przeszedl - a to prawdziwa przerwa w dostawie');
if (komunikat) {
  sprawdz(komunikat.title === 'Nowogród Bobrzański: KOMUNIKAT',
    `tytul: "${komunikat.title}" - bezuzyteczny tytul zrodla musi dostac przynajmniej nazwe gminy`);
  sprawdz(komunikat.description.includes('ul. Kościuszki'),
    'Nowogród: zgubiono tresc, a to ona jest tu jedyna informacja');
}

// ===================== 6. DATY ==============================================
if (ploty) {
  sprawdz(ploty.published_at === '2026-11-20T08:57:38.000Z',
    `data publikacji: ${ploty.published_at}`);
}
const bogaczow = nowogrod.wyniki.find((w) => w.source_url.includes('1760'));
if (bogaczow) {
  sprawdz(Boolean(bogaczow.event_date),
    'Bogaczów: nie odczytano daty wydarzenia z tresci ("W dniu 14.08.2026 r.")');
}

// ===================== 7. PELNA TRESC PRZED ZAJAWKA =========================
// Zajawka z WordPressa konczy sie "[...]". Pelna tresc jest w tej samej
// odpowiedzi i nic nie kosztuje - ten blad kosztowal nas miesiac przy MZK.
const opisPloty = wyciagOpis(WPISY_POMAK[0]);
sprawdz(!opisPloty.includes('[…]'), 'wyciagOpis: wzieta zostala ucieta zajawka zamiast pelnej tresci');
sprawdz(opisPloty.length > 400, `wyciagOpis: opis ma tylko ${opisPloty.length} zn.`);

// ===================== 8. MIEJSCE ===========================================
sprawdz(wykryjMiejsce('Przerwa w dostawie wody', 'nastąpi przerwa w miejscowości Nietków') === 'Nietków',
  `miejsce: z "w miejscowosci Nietkow" wyszlo "${wykryjMiejsce('Przerwa w dostawie wody', 'nastąpi przerwa w miejscowości Nietków')}"`);

// ===================== 9. ROZPOZNAWANIE ODWOLANIA ===========================
for (const tekst of [
  'Informujemy, że dostawa wody została przywrócona.',
  'Informujemy o przywróceniu dostawy wody.',
  'Awaria została usunięta.',
  'Usunięto awarię sieci wodociągowej.',
  'Przywrócono dostawę wody w miejscowości Płoty.',
]) {
  sprawdz(czyOdwolana(tekst), `odwolanie: nie rozpoznano "${tekst}"`);
}

// Zdania, ktorych NIE WOLNO uznac za odwolanie. Dwa pierwsze stoja
// w PRAWDZIWYCH komunikatach POMAK-u i oba przewrocily kolejne wersje
// wzorca - kazde oznaczylo trwajaca awarie jako zakonczona.
for (const tekst of [
  'Nastąpi przerwa w dostawie wody.',
  'O przywróceniu dostaw wody poinformujemy w osobnym komunikacie.',
  // To zdanie wylapala dopiero proba na zywo 23.11.2026, na komunikacie
  // o Plotach i Zagorzu. Prognoza, nie koniec awarii - a zadne slowo
  // "poinformujemy" tu nie pada, wiec filtr obietnic go nie zatrzymal.
  'Przewidywany czas przywrócenia dostaw wody to około godziny 13:00.',
  'Planowany termin przywrócenia dostawy wody: godz. 15:00.',
  'O przywróceniu dostawy wody zostaną Państwo poinformowani.',
  'Będziemy informować o przywróceniu dostaw wody.',
]) {
  sprawdz(!czyOdwolana(tekst), `odwolanie: BLEDNIE uznano za odwolane "${tekst}"`);
}

// Prawdziwe odwolania z tych kanalow - musza byc rozpoznane.
for (const tekst of [
  'AKTUALIZACJA (g. 9:00): dostawa wody została przywrócona.',
  'Informujemy, że dostawa wody została przywrócona. Obecnie prowadzone jest płukanie sieci.',
]) {
  sprawdz(czyOdwolana(tekst), `odwolanie: nie rozpoznano prawdziwego odwolania "${tekst}"`);
}

// Obietnica i prawdziwe odwolanie w jednym komunikacie - tak jak u POMAK-u.
sprawdz(czyOdwolana('Nastąpi przerwa w dostawie wody. O przywróceniu dostaw wody '
  + 'poinformujemy w osobnym komunikacie. AKTUALIZACJA – dostawa wody została przywrócona.'),
'odwolanie: nie rozpoznano prawdziwego odwolania stojacego obok obietnicy');

// ===================== 9b. PRZYCINANIE MIEJSCA ==============================
// extractStreet zabiera za duzo: "ul. Letniej w godzinach od 9". W appce to
// pole stoi pod tytulem jako nazwa miejsca, wiec taki ogon wyglada jak blad.
sprawdz(przytnijMiejsce('ul. Letniej w godzinach od 9') === 'ul. Letniej',
  `przycinanie: "${przytnijMiejsce('ul. Letniej w godzinach od 9')}"`);
sprawdz(przytnijMiejsce('ul. Kościuszki w godzinach od 8') === 'ul. Kościuszki',
  `przycinanie: "${przytnijMiejsce('ul. Kościuszki w godzinach od 8')}"`);
sprawdz(przytnijMiejsce('Nietków') === 'Nietków', 'przycinanie: zwykla nazwa ma zostac bez zmian');
// Z proby na zywo: extractStreet przeszedl przez kropke do nastepnego zdania.
sprawdz(przytnijMiejsce('ul. Szkolnej w Płotach. Przerwa spo') === 'ul. Szkolnej w Płotach',
  `przycinanie: "${przytnijMiejsce('ul. Szkolnej w Płotach. Przerwa spo')}" - ucinamy na granicy zdania`);
// ...ale kropka w skrocie "ul." zdania NIE konczy.
sprawdz(przytnijMiejsce('ul. Szkolna') === 'ul. Szkolna',
  `przycinanie: "${przytnijMiejsce('ul. Szkolna')}" - kropka po "ul" to skrot, nie koniec zdania`);
sprawdz(przytnijMiejsce('al. Konstytucji 3 Maja') === 'al. Konstytucji 3 Maja',
  'przycinanie: skrot "al." tez nie konczy zdania');
sprawdz(przytnijMiejsce('Informujemy, że w związku z pracami na sieci wodociągowej konieczne '
  + 'będzie wyłączenie stacji uzdatniania wody') === null,
'przycinanie: pol zdania zamiast nazwy miejsca ma dac brak, nie urwany fragment');
sprawdz(przytnijMiejsce('ul. Letnia, ') === 'ul. Letnia', 'przycinanie: ogon z przecinka');
sprawdz(przytnijMiejsce(null) === null, 'przycinanie: brak wartosci');

// A tak wyglada to na prawdziwych wpisach z kanalu.
const letnia = pomak.wyniki.find((w) => w.source_url.includes('/478-'));
if (letnia) {
  sprawdz(!/godzin|od \d/.test(letnia.street || ''),
    `miejsce: "${letnia.street}" - do nazwy miejsca wszedl fragment o godzinach`);
}
if (komunikat) {
  sprawdz(!/godzin|od \d/.test(komunikat.street || ''),
    `miejsce: "${komunikat.street}" - do nazwy miejsca wszedl fragment o godzinach`);
}

// ===================== 10. TYTUL - funkcja osobno ===========================
sprawdz(zbudujTytul('Czerwieńsk', 'Przerwa w dostawie wody - Płoty', false)
  === 'Czerwieńsk: Przerwa w dostawie wody - Płoty', 'zbudujTytul: zwykly przypadek');
sprawdz(zbudujTytul('Czerwieńsk', 'PRZERWA W DOSTAWIE WODY - SUW PKP CZERWIEŃSK', false)
  === 'PRZERWA W DOSTAWIE WODY - SUW PKP CZERWIEŃSK', 'zbudujTytul: gmina juz w tytule (wielkie litery)');
sprawdz(zbudujTytul('Nowogród Bobrzański', 'Awaria w Nowogrodzie Bobrzanskim', false)
  .startsWith('Nowogród Bobrzański: '),
'zbudujTytul: odmieniona nazwa gminy to nie to samo slowo - prefiks ma zostac dopisany');

const LICZBA_WARUNKOW = 73;

function uruchomTesty() {
  return { sprawdzonych: LICZBA_WARUNKOW, bledy };
}

if (require.main === module) {
  console.log(`Czerwieńsk: ${pomak.wyniki.length} wpisow, ${pomak.pominietych} pominietych`);
  for (const w of pomak.wyniki) {
    console.log(`  [${w.category}] ${w.title}`);
    console.log(`      miejsce: ${w.street || '(brak)'} | opis: ${w.description.length} zn.`);
  }
  console.log('');
  console.log(`Nowogród Bobrzański: ${nowogrod.wyniki.length} wpisow, ${nowogrod.pominietych} pominietych`);
  for (const w of nowogrod.wyniki) {
    console.log(`  [${w.category}] ${w.title}`);
    console.log(`      miejsce: ${w.street || '(brak)'} | opis: ${w.description.length} zn.`);
  }
  console.log('');
  console.log(`szum: ${szum.wyniki.length} przeszlo (powinno 0), ${szum.pominietych} pominietych`);
  console.log('');
  for (const b of bledy) console.log(`BLAD ${b}`);
  console.log(`Sprawdzono ${LICZBA_WARUNKOW} warunkow, bledow: ${bledy.length}`);
  process.exit(bledy.length ? 1 : 0);
}

module.exports = { uruchomTesty };
