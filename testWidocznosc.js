// Testy wygasania wpisow.
//
// Przypadki nie sa wymyslone - to wpisy, ktore 24.11.2026 naprawde wisialy
// w appce albo naprawde przez nia przeszly. Przy kazdym jest napisane,
// czego dotyczy, bo za pol roku nikt tego nie odtworzy z samej nazwy.

const {
  czyWidoczny, powodUkrycia, podzielWpisy, datolicznik, progiDla, WIDOCZNOSC,
} = require('./widocznosc');

const bledy = [];
let sprawdzonych = 0;

function sprawdz(opis, warunek) {
  sprawdzonych += 1;
  if (!warunek) bledy.push(opis);
}

function rowne(opis, mam, oczekuje) {
  sprawdzonych += 1;
  if (mam !== oczekuje) bledy.push(`${opis} - jest "${mam}", powinno byc "${oczekuje}"`);
}

const TERAZ = Date.parse('2026-11-24T09:00:00.000Z');
const DZIEN = 24 * 3600 * 1000;

function kiedy(dniTemu) {
  return new Date(TERAZ - dniTemu * DZIEN).toISOString();
}

function wpis(nadpisania) {
  return {
    category: 'wodociagi',
    published_at: kiedy(0),
    event_date: null,
    last_seen: kiedy(0),
    ...nadpisania,
  };
}

// --- 1. wpisy, ktore MUSZA zniknac --------------------------------------

function testZnikaja() {
  // Wisial w zakladce "drogi" przez caly czas istnienia appki. PZZD trzyma
  // go na swojej liscie do dzis, wiec regula nieobecnosci go NIE zdejmie -
  // i wlasnie po to jest druga regula.
  const most = wpis({
    category: 'drogi',
    title: 'Utrudnienia w ruchu drogowym - most na Kanale Dychowskim',
    published_at: '2023-06-05T12:00:00.000Z',
    last_seen: kiedy(0), // widziany dzis, bo PZZD wciaz go wymienia
  });
  sprawdz('most z 2023 znika mimo ze PZZD wciaz go wymienia', !czyWidoczny(most, TERAZ));
  sprawdz('powod ukrycia mostu mowi o wieku, nie o nieobecnosci',
    /dni/.test(powodUkrycia(most, TERAZ)) && !/nie wymienia/.test(powodUkrycia(most, TERAZ)));

  // Przerwa w Otyniu z 26 pazdziernika - dawno zakonczona.
  const otyn = wpis({
    category: 'wodociagi',
    title: 'Otyń: KOMUNIKAT – PRZEDŁUŻENIE PRZERWY W DOSTAWIE WODY',
    published_at: '2026-10-26T12:00:00.000Z',
    event_date: '2026-10-26T00:00:00.000Z',
    last_seen: kiedy(0), // Otyn wciaz trzyma ja na stronie glownej
  });
  sprawdz('pazdziernikowa przerwa w Otyniu znika', !czyWidoczny(otyn, TERAZ));

  // Awaria ZWiK zdjeta ze strony - czyli usunieta.
  const zwik = wpis({
    category: 'wodociagi',
    title: 'ul. Dolina Zielona 6',
    published_at: kiedy(3),
    last_seen: kiedy(2),
  });
  sprawdz('awaria wody usunieta ze strony zrodla znika', !czyWidoczny(zwik, TERAZ));
  sprawdz('powod mowi, ze zrodlo przestalo ja wymieniac',
    /nie wymienia/.test(powodUkrycia(zwik, TERAZ)));
}

// --- 2. wpisy, ktore MUSZA zostac ---------------------------------------

function testZostaja() {
  // Grabowiec: opublikowany wczoraj, przerwa jutro. To jest dokladnie ten
  // wpis, dla ktorego appka istnieje.
  const grabowiec = wpis({
    title: 'Świdnica: Przerwa w dostawie wody w Grabowcu',
    published_at: '2026-11-23T12:00:00.000Z',
    event_date: '2026-11-24T00:00:00.000Z',
    last_seen: kiedy(0),
  });
  sprawdz('jutrzejsza przerwa w Grabowcu zostaje', czyWidoczny(grabowiec, TERAZ));

  // Przerwa zapowiedziana z miesiecznym wyprzedzeniem. Liczymy wiek od
  // POZNIEJSZEJ z dat, inaczej zniknelaby na tydzien przed terminem.
  const zapowiedz = wpis({
    title: 'Planowana przerwa w dostawie wody',
    published_at: kiedy(30),
    event_date: new Date(TERAZ + 5 * DZIEN).toISOString(),
    last_seen: kiedy(0),
  });
  sprawdz('przerwa zapowiedziana miesiac wczesniej zostaje do swojego terminu',
    czyWidoczny(zapowiedz, TERAZ));

  // Trwajaca awaria, widziana u zrodla dzis, choc zgloszona 5 dni temu.
  const trwajaca = wpis({
    title: 'Awaria sieci wodociągowej',
    published_at: kiedy(5),
    last_seen: kiedy(0),
  });
  sprawdz('trwajaca awaria wody potwierdzana przez zrodlo zostaje',
    czyWidoczny(trwajaca, TERAZ));

  // Remont drogi sprzed dwoch miesiecy - dla drog to norma, nie starzyzna.
  const remont = wpis({
    category: 'drogi',
    title: 'Remont DW 278 w m. Sława',
    published_at: kiedy(60),
    last_seen: kiedy(1),
  });
  sprawdz('dwumiesieczny remont drogi zostaje', czyWidoczny(remont, TERAZ));

  // Zmiana w rozkladzie MZK sprzed trzech tygodni.
  const mzk = wpis({
    category: 'mzk',
    title: 'Zmiana trasy linii 27',
    published_at: kiedy(21),
    last_seen: kiedy(2),
  });
  sprawdz('trzytygodniowa zmiana w MZK zostaje', czyWidoczny(mzk, TERAZ));
}

// --- 3. progi zalezne od kategorii --------------------------------------

function testProgi() {
  // Ten sam wiek i ta sama nieobecnosc, dwie rozne kategorie, dwa rozne
  // rozstrzygniecia. O to w tych progach chodzi: awaria wody trwa godziny,
  // zamkniecie drogi miesiacami.
  const wspolne = { published_at: kiedy(3), last_seen: kiedy(3) };
  sprawdz('po trzech dniach bez potwierdzenia awaria wody znika',
    !czyWidoczny(wpis({ ...wspolne, category: 'wodociagi' }), TERAZ));
  sprawdz('po trzech dniach bez potwierdzenia zamkniecie drogi zostaje',
    czyWidoczny(wpis({ ...wspolne, category: 'drogi' }), TERAZ));

  rowne('prad ma te same progi co woda',
    JSON.stringify(progiDla('prad')), JSON.stringify(progiDla('wodociagi')));

  // Nowa kategoria nie moze zaczac po cichu znikac, zanim ktos o niej pomysli.
  const nieznana = wpis({ category: 'smieci', published_at: kiedy(30), last_seen: kiedy(3) });
  sprawdz('wpis nieznanej kategorii nie znika po kilku dniach', czyWidoczny(nieznana, TERAZ));

  Object.entries(WIDOCZNOSC).forEach(([nazwa, progi]) => {
    sprawdz(`prog nieobecnosci dla "${nazwa}" jest sensownie dodatni`,
      progi.nieobecnoscDni >= 1);
    sprawdz(`prog wieku dla "${nazwa}" jest dluzszy niz prog nieobecnosci`,
      progi.wiekDni > progi.nieobecnoscDni);
  });
}

// --- 4. braki w danych --------------------------------------------------

function testBraki() {
  // Wpis sprzed wprowadzenia last_seen. Nie wolno go ukryc z tego powodu -
  // brak znacznika nie jest dowodem, ze zrodlo go porzucilo.
  const bezZnacznika = wpis({ last_seen: null, published_at: kiedy(2) });
  sprawdz('brak last_seen nie ukrywa wpisu', czyWidoczny(bezZnacznika, TERAZ));

  // ...ale regula wieku nadal go obowiazuje.
  const staryBezZnacznika = wpis({ last_seen: null, published_at: kiedy(30) });
  sprawdz('brak last_seen nie chroni przed regula wieku',
    !czyWidoczny(staryBezZnacznika, TERAZ));

  const bezDat = { category: 'wodociagi', published_at: null, event_date: null, last_seen: null };
  sprawdz('wpis bez zadnej daty zostaje, zamiast zniknac po cichu',
    czyWidoczny(bezDat, TERAZ));

  const zepsutaData = wpis({ published_at: 'nie-data', last_seen: 'tez-nie' });
  sprawdz('niepoprawna data nie wywala filtra', czyWidoczny(zepsutaData, TERAZ));

  rowne('brak wpisu nie wywala filtra', powodUkrycia(null, TERAZ), null);

  rowne('datolicznik bierze pozniejsza z dat',
    datolicznik({ published_at: kiedy(10), event_date: kiedy(2) }),
    Date.parse(kiedy(2)));
  rowne('datolicznik radzi sobie z sama data publikacji',
    datolicznik({ published_at: kiedy(4), event_date: null }),
    Date.parse(kiedy(4)));
}

// --- 5. zimny start po wdrozeniu ----------------------------------------

function testZimnyStart() {
  // Po restarcie gminyCms pobiera tylko trzy podstrony na gmine, wiec
  // czesc wpisow nie odswiezy sie przez kilka cykli. Przy progu doby jest
  // na to ogromny zapas - ale niech test tego pilnuje, bo gdyby ktos
  // kiedys skrocil prog do godziny, appka zaczelaby mrugac po kazdym
  // wdrozeniu i nikt by nie wiedzial dlaczego.
  const poRestarcie = wpis({ last_seen: new Date(TERAZ - 45 * 60 * 1000).toISOString() });
  sprawdz('wpis nieodswiezony przez 45 minut po restarcie zostaje',
    czyWidoczny(poRestarcie, TERAZ));

  const najkrotszy = Math.min(...Object.values(WIDOCZNOSC).map((p) => p.nieobecnoscDni));
  sprawdz('najkrotszy prog nieobecnosci daje co najmniej dobe zapasu na zimny start',
    najkrotszy >= 1);
}

// --- 6. podzial na widoczne i ukryte ------------------------------------

function testPodzial() {
  const wpisy = [
    wpis({ title: 'swieza', last_seen: kiedy(0) }),
    wpis({ title: 'porzucona', last_seen: kiedy(5), published_at: kiedy(5) }),
    wpis({ title: 'tez swieza', last_seen: kiedy(0) }),
  ];
  const { widoczne, ukryte } = podzielWpisy(wpisy, TERAZ);
  rowne('widoczne dwa wpisy', widoczne.length, 2);
  rowne('ukryty jeden wpis', ukryte.length, 1);
  rowne('ukryty to ten porzucony', ukryte[0].wpis.title, 'porzucona');
  sprawdz('ukryty wpis ma podany powod', Boolean(ukryte[0].powod));

  const pusty = podzielWpisy(null, TERAZ);
  rowne('brak wpisow nie wywala podzialu', pusty.widoczne.length, 0);
}

function uruchomTesty() {
  bledy.length = 0;
  sprawdzonych = 0;
  testZnikaja();
  testZostaja();
  testProgi();
  testBraki();
  testZimnyStart();
  testPodzial();
  return { sprawdzonych, bledy };
}

if (require.main === module) {
  const wynik = uruchomTesty();
  for (const b of wynik.bledy) console.error(`  BLAD: ${b}`);
  console.log(`Sprawdzono ${wynik.sprawdzonych} warunkow, bledow: ${wynik.bledy.length}`);
  if (wynik.bledy.length) process.exitCode = 1;
}

module.exports = { uruchomTesty };
