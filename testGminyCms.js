// Testy parsera stron gmin Swidnica i Otyn.
//
// HTML ponizej NIE jest wymyslony - to fragmenty przepisane z wyniku sondy
// nr 9, uruchomionej 23.11.2026 na serwerze. Razem z nimi przechodza tu
// pulapki, ktore w tym projekcie juz raz nas kosztowaly bledny wpis w appce:
// sklejone zdania, pozycje menu udajace komunikaty, prognoza przywrocenia
// dostawy czytana jak koniec awarii i data przyjeta "na dzisiaj" przy braku
// daty w zrodle.

const {
  wyciagListe, wyciagPodstrone, zbudujWpisy, ustalKategorie, dataZCms,
  trzebaOdswiezyc, ADRES_KOMUNIKATU_RE,
} = require('./gminyCms');

// --- prawdziwe fragmenty stron ---------------------------------------------

const PODSTRONA_SWIDNICA = `
<div class="information-expanded">
  <div class="information">
    <div class="information-header">
      <h1>Aktualności</h1>
      <h2>Przerwa w dostawie wody w Grabowcu</h2>
      <ul class="information-content-tools">
        <li class="date"><span title="Data upublicznienia informacji">23-11-2026</span></li>
        <li class="print"><a href="https://swidnica.zgora.pl/PL/drukuj/1000/4984/x/wersja/">drukuj</a></li>
      </ul>
    </div>
    <div class="information-body">
      <div class="information-content">
        <div class="information-content-paragraph-first">
          <div>
            <div>Zakład Usług Komunalnych informuje, że w związku z pracami na sieci wodociągowej w dniu 24.11.2026 r. (wtorek) od godz. 8.00 do godz. 13.00, nastąpi przerwa w dostawie wody w miejscowości Grabowiec.&nbsp;&nbsp;</div>
            <div>W związku z powyższym po wznowieniu dostawy mogą wystąpić chwilowe zabrudzenia wody na terenie miejscowości Grabowiec.Za utrudnienia przepraszamy. &nbsp;</div>
            <div>&nbsp;</div>
          </div>
          <div class="information-picture">
            <a href="https://swidnica.zgora.pl/system/pobierz.php?id=6611" class="gallery-images-tb">
              <img class="imgLeft" width="145" src="https://swidnica.zgora.pl/system/pobierz.php?id=6611" alt="Ilustracja do informacji: Przerwa w dostawie wody w Grabowcu">
            </a>
          </div>
        </div>
        <div class="information-content-addons-header"><h3>Elementy dodatkowe powiązane z tą informacją</h3></div>
      </div>
    </div>
  </div>
</div>`;

const PODSTRONA_OTYN = `
<div class="information">
  <div class="information-header">
    <h1>Pozostałe aktualności</h1>
    <h2><span>Przerwa w dostawie wody 25.11.2026 - NIEDORADZ</span></h2>
    <ul class="information-content-tools">
      <li class="date"><span title="Data upublicznienia informacji">23-11-2026</span></li>
      <li class="author">Autor: j.nad</li>
      <li class="print"><a href="http://www.otyn.pl/PL/drukuj/1000/1157/x/wersja/">drukuj</a></li>
    </ul>
  </div>
  <div class="information-body">
    <div class="information-content">
      <div class="information-content-paragraph-first">
        <div class="information-picture">
          <a href="http://www.otyn.pl/system/pobierz.php?id=1558" class="gallery-images-tb">
            <img class="imgLeft" width="145" src="http://www.otyn.pl/system/pobierz.php?id=1558" alt="Ilustracja do informacji: Przerwa w dostawie wody">
          </a>
        </div>
        <div>
          <div>W związku z koniecznością przeprowadzenia prac technicznych na sieci wodociągowej w dniu 25.11.2026 w godz. od 14.00 do 19.00 nastąpi całkowita przerwa w dostawie wody w miejscowości Niedoradz, z wyjątkiem ulic Sienkiewicza i Tuwima.<br>Prosimy o zaopatrzenie się w niezbędne ilości wody. Po wznowieniu dostawy może wystąpić chwilowe pogorszenie się jakości wody w postaci zmętnienia. Za wszelkie utrudnienia przepraszamy.</div>
          <div>&nbsp;</div>
          <div>Urząd Miejski w Otyniu</div>
        </div>
      </div>
      <div class="information-content-addons-header"><h3>Elementy dodatkowe powiązane z tą informacją</h3></div>
    </div>
  </div>
</div>`;

// Lista Swidnicy: tytul stoi w atrybucie "title", bo tekst odnosnika to
// "czytaj dalej". Obok prawdziwych komunikatow leza pozycje menu z innych
// dzialow - i wlasnie one nie moga przejsc.
const LISTA_SWIDNICA = `
<div class="owl-content">
  <h3>SMS-owy system powiadamiania – zapisz się</h3>
  <a href="/PL/3131/508/SMS-owy_system_powiadamiania_-_zapisz_sie/k/" title="Przejdź do informacji: SMS-owy system powiadamiania">czytaj dalej</a>
</div>
<div class="owl-content">
  <a href="/PL/1000/4984/Przerwa_w_dostawie_wody_w_Grabowcu/k/" title="Przejdź do informacji: Przerwa w dostawie wody w Grabowcu">czytaj dalej</a>
</div>
<div class="owl-content">
  <h3>Harmonogram odczytu wodomierzy w grudniu</h3>
  <a href="/PL/1000/4982/Harmonogram_odczytu_wodomierzy_w_grudniu/k/">czytaj dalej</a>
</div>
<div class="owl-content">
  <a href="/PL/3035/511/Gmina_Swidnica/k/" title="Przejdź do informacji: Gmina Świdnica">czytaj dalej</a>
</div>
<div class="owl-content">
  <a href="/PL/1000/4980/Kondolencje/k/" title="Przejdź do informacji: Kondolencje">czytaj dalej</a>
</div>
<a href="/PL/1000/4983/W_grudniu_rozpocznie_sie_podstawianie_pojemnikow/k/" title="Przejdź do informacji: W grudniu rozpocznie się podstawianie pojemników">czytaj dalej</a>
<a href="https://swidnica.zgora.pl/PL/drukuj/1000/4984/x/wersja/">drukuj</a>
<a href="/PL/1000/4984/Przerwa_w_dostawie_wody_w_Grabowcu/k/">ten sam adres drugi raz</a>`;

const LISTA_OTYN = `
<div class="information">
  <span class="date">23-11-2026</span>
  <a href="/PL/1000/1157/Przerwa_w_dostawie_wody_25_11_2026_-_NIEDORADZ/k/" title="Przejdź do informacji: Przerwa w dostawie wody 25.11.2026 - NIEDORADZ">czytaj dalej</a>
</div>
<div class="information">
  <span class="date">18-11-2026</span>
  <a href="/PL/1000/1155/Informacja_o_XXXIV_Sesji_Rady_Miejskiej_Otyn/k/" title="Przejdź do informacji: Informacja o XXXIV Sesji Rady Miejskiej Otyń">czytaj dalej</a>
</div>`;

// --- pomocnicze -------------------------------------------------------------

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

// Daty porownujemy w czasie LOKALNYM, a nie po przedrostku napisu ISO.
// Powod jest praktyczny: extractPolishDate buduje date na lokalna polnoc,
// Render chodzi w UTC, a moj kontener w UTC+1 - wiec ten sam poprawny kod
// dawal raz "2026-11-24T00:00Z", raz "2026-11-23T23:00Z". Appka czyta te
// date w strefie przegladarki i pokazuje wlasciwy dzien w obu przypadkach,
// wiec test ma sprawdzac dzien kalendarzowy, a nie zapis godziny.
function dzienLokalny(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mies = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mies}-${String(d.getDate()).padStart(2, '0')}`;
}

const ZRODLO_SWIDNICA = { gmina: 'Świdnica', zrodlo: 'Gmina Świdnica' };
const ZRODLO_OTYN = { gmina: 'Otyń', zrodlo: 'Gmina Otyń' };

function jedenWpis(zrodlo, strona) {
  const { wyniki } = zbudujWpisy(zrodlo, [strona]);
  return wyniki[0] || null;
}

// --- 1. odsiew pozycji menu -------------------------------------------------

function testLista() {
  const lista = wyciagListe(LISTA_SWIDNICA, 'https://swidnica.zgora.pl/');
  const adresy = lista.map((w) => w.url);

  sprawdz('komunikat z dzialu 1000 wchodzi na liste',
    adresy.some((a) => a.includes('/PL/1000/4984/')));
  sprawdz('pozycja menu z dzialu 3131 NIE wchodzi na liste (to nie komunikat)',
    !adresy.some((a) => a.includes('/PL/3131/')));
  sprawdz('pozycja menu z dzialu 3035 NIE wchodzi na liste (to nie komunikat)',
    !adresy.some((a) => a.includes('/PL/3035/')));
  sprawdz('odnosnik do wersji do druku NIE wchodzi na liste',
    !adresy.some((a) => a.includes('/drukuj/')));
  rowne('ten sam adres nie powtarza sie na liscie',
    adresy.filter((a) => a.includes('/PL/1000/4984/')).length, 1);
  rowne('z listy Swidnicy zostaja cztery komunikaty', lista.length, 4);

  // Tytul z listy sluzy do logow i kolejnosci - nie moze brzmiec "czytaj dalej".
  const grabowiec = lista.find((w) => w.url.includes('4984'));
  rowne('tytul z atrybutu "title", a nie z tekstu odnosnika',
    grabowiec.tytul, 'Przerwa w dostawie wody w Grabowcu');
  sprawdz('zaden tytul z listy nie brzmi "czytaj dalej"',
    lista.every((w) => !/^czytaj dalej$/i.test(w.tytul)));

  const wodomierze = lista.find((w) => w.url.includes('4982'));
  rowne('bez atrybutu "title" tytul brany jest z naglowka w bloku',
    wodomierze.tytul, 'Harmonogram odczytu wodomierzy w grudniu');

  // Po restarcie serwera budzet pobran jest maly, wiec kolejnosc decyduje
  // o tym, czy swieza awaria wejdzie do appki w pierwszym cyklu.
  rowne('najnowszy komunikat (najwyzszy numer) jest pierwszy',
    lista[0].numer, 4984);
  sprawdz('numery na liscie maleja',
    lista.every((w, i) => i === 0 || lista[i - 1].numer > w.numer));

  const otyn = wyciagListe(LISTA_OTYN, 'http://www.otyn.pl/');
  rowne('lista Otynia ma dwa komunikaty', otyn.length, 2);
  sprawdz('data z listy Otynia zostala odczytana',
    otyn[0].data instanceof Date && otyn[0].data.getFullYear() === 2026);

  sprawdz('wzorzec adresu wymaga dzialu 1000',
    ADRES_KOMUNIKATU_RE.test('https://x.pl/PL/1000/12/Tytul/k/')
      && !ADRES_KOMUNIKATU_RE.test('https://x.pl/PL/3131/12/Tytul/k/'));
}

// --- 2. tresc podstrony -----------------------------------------------------

function testPodstrony() {
  const sw = wyciagPodstrone(PODSTRONA_SWIDNICA);

  rowne('tytul Swidnicy z naglowka h2',
    sw.tytul, 'Przerwa w dostawie wody w Grabowcu');
  sprawdz('tytul nie zawiera naglowka dzialu "Aktualnosci"',
    !/Aktualno/i.test(sw.tytul));
  sprawdz('data publikacji Swidnicy odczytana z li.date',
    sw.data instanceof Date && sw.data.getDate() === 23 && sw.data.getMonth() === 10);

  sprawdz('tresc zawiera pierwsze zdanie komunikatu',
    sw.opis.includes('Zakład Usług Komunalnych informuje'));
  sprawdz('tresc zawiera drugie zdanie komunikatu',
    sw.opis.includes('chwilowe zabrudzenia wody'));
  sprawdz('tresc podaje date i godziny przerwy',
    sw.opis.includes('24.11.2026') && sw.opis.includes('8.00'));

  // To sa dokladnie te smieci, ktore widzialem w surowym HTML-u.
  sprawdz('tresc nie zawiera slowa "drukuj"', !/drukuj/i.test(sw.opis));
  sprawdz('tresc nie zawiera naglowka "Aktualnosci"', !/Aktualno[śs]ci/i.test(sw.opis));
  sprawdz('tresc nie zawiera stopki o elementach dodatkowych',
    !/Elementy dodatkowe/i.test(sw.opis));
  sprawdz('tresc nie zawiera opisu ilustracji',
    !/Ilustracja do informacji/i.test(sw.opis));
  sprawdz('tresc nie zawiera twardej spacji', !sw.opis.includes(' '));
  sprawdz('tresc nie ma podwojnych spacji', !/ {2}/.test(sw.opis));

  // Zagniezdzone <div>-y moglyby dac te sama tresc dwa razy.
  const ile = sw.opis.split('Zakład Usług Komunalnych').length - 1;
  rowne('tresc nie powtarza sie przez zagniezdzone bloki', ile, 1);

  const ot = wyciagPodstrone(PODSTRONA_OTYN);
  rowne('tytul Otynia z naglowka h2 (owinietego w span)',
    ot.tytul, 'Przerwa w dostawie wody 25.11.2026 - NIEDORADZ');
  sprawdz('tresc Otynia zawiera godziny przerwy',
    ot.opis.includes('14.00') && ot.opis.includes('19.00'));
  sprawdz('tresc Otynia podaje wyjatki od przerwy',
    ot.opis.includes('Sienkiewicza') && ot.opis.includes('Tuwima'));

  // <br> bez tego zabiegu sklei dwa zdania w jedno slowo.
  sprawdz('zdanie po znaczniku <br> nie skleja sie z poprzednim',
    ot.opis.includes('Tuwima. Prosimy') || ot.opis.includes('Tuwima.  Prosimy'));
  sprawdz('po <br> nie powstalo zrosniete slowo',
    !/Tuwima\.Prosimy/.test(ot.opis));

  sprawdz('podpis urzedu na koncu zostal usuniety',
    !/Urząd Miejski w Otyniu/.test(ot.opis));
  sprawdz('tresc Otynia nie zawiera wiersza "Autor:"', !/Autor:/i.test(ot.opis));

  // Odwrotny przypadek: nazwa instytucji NA POCZATKU jest trescia, nie podpisem.
  sprawdz('nazwa instytucji na poczatku komunikatu zostaje',
    sw.opis.startsWith('Zakład Usług Komunalnych'));

  const pusta = wyciagPodstrone('<div class="information-header"><h2>Coś</h2></div>');
  rowne('brak pojemnika tresci daje pusty opis, a nie wyjatek', pusta.opis, '');
  rowne('brak daty daje null, a nie dzisiejsza date', pusta.data, null);
}

// --- 3. data z CMS-a --------------------------------------------------------

function testData() {
  const d = dataZCms('23-11-2026');
  sprawdz('data DD-MM-RRRR czytana jest jako dzien-miesiac-rok',
    d && d.getDate() === 23 && d.getMonth() === 10 && d.getFullYear() === 2026);

  rowne('brak daty daje null', dataZCms(''), null);
  rowne('tekst bez daty daje null', dataZCms('Data upublicznienia informacji'), null);
  rowne('niemozliwy miesiac daje null', dataZCms('05-13-2026'), null);
  rowne('niemozliwy dzien daje null', dataZCms('32-11-2026'), null);

  const zOpisem = dataZCms('Data upublicznienia informacji 01-02-2026');
  sprawdz('data wyciagana jest z dluzszego tekstu',
    zOpisem && zOpisem.getDate() === 1 && zOpisem.getMonth() === 1);
}

// --- 4. kategoria i filtr ---------------------------------------------------

function testKategorie() {
  rowne('przerwa w dostawie wody idzie do zakladki wodociagi',
    ustalKategorie('Przerwa w dostawie wody w Grabowcu',
      'Zakład Usług Komunalnych informuje, że nastąpi przerwa w dostawie wody.'),
    'wodociagi');

  rowne('wylaczenie pradu idzie do zakladki prad',
    ustalKategorie('Przerwa w dostawie energii elektrycznej',
      'Enea informuje o planowanym wyłączeniu prądu w miejscowości Ługi.'),
    'prad');

  // To byl prawdziwy blad w tym projekcie: awaria rurociagu wyladowala
  // w zakladce "prad", bo w tekscie stalo "sieci energetycznej".
  rowne('awaria wody z wtretem o sieci energetycznej zostaje przy wodzie',
    ustalKategorie('Awaria sieci wodociągowej',
      'W wyniku prac związanych z kładzeniem sieci energetycznej doszło do awarii '
      + 'głównego rurociągu. Nastąpi przerwa w dostawie wody.'),
    'wodociagi');

  // Gazetka gminna nie moze wjechac do appki.
  rowne('harmonogram odczytu wodomierzy nie jest utrudnieniem',
    ustalKategorie('Harmonogram odczytu wodomierzy w grudniu',
      'Informujemy o harmonogramie odczytu wodomierzy w grudniu. Prosimy o udostępnienie.'),
    null);
  rowne('sesja rady nie jest utrudnieniem',
    ustalKategorie('Informacja o XXXIV Sesji Rady Miejskiej Otyń',
      'Informujemy o zwołaniu sesji Rady Miejskiej. Porządek obrad w załączeniu.'),
    null);
  rowne('kondolencje nie sa utrudnieniem',
    ustalKategorie('Kondolencje', 'Z głębokim żalem przyjęliśmy wiadomość o śmierci.'),
    null);
  rowne('konkurs plastyczny nie jest utrudnieniem',
    ustalKategorie('Świąteczny Konkurs Plastyczny',
      'Zapraszamy dzieci do udziału w świątecznym konkursie plastycznym.'),
    null);
  rowne('nieczynny urzad nie jest utrudnieniem w ruchu ani w dostawie',
    ustalKategorie('12.11.2026 - Urząd Miejski w Otyniu będzie nieczynny.',
      'Informujemy, że 12 listopada Urząd Miejski będzie nieczynny.'),
    null);
}

// --- 5. gotowy wpis dla appki ----------------------------------------------

function testWpisy() {
  const sw = wyciagPodstrone(PODSTRONA_SWIDNICA);
  const wpis = jedenWpis(ZRODLO_SWIDNICA, { ...sw, url: 'https://swidnica.zgora.pl/PL/1000/4984/x/k/' });

  sprawdz('komunikat Swidnicy o wodzie wchodzi do appki', Boolean(wpis));
  rowne('kategoria wpisu', wpis.category, 'wodociagi');
  rowne('nazwa zrodla', wpis.source_name, 'Gmina Świdnica');

  // Zakladka "wodociagi" pokazuje obok siebie miasto i okolice - bez nazwy
  // gminy czytelnik nie wie, czy sprawa go dotyczy.
  sprawdz('tytul zaczyna sie od nazwy gminy',
    wpis.title.startsWith('Świdnica: '));
  sprawdz('tytul nie jest oznaczony jako zakonczony',
    !/zakończona/i.test(wpis.title));

  rowne('data publikacji wziela sie ze strony, a nie z dzisiejszego dnia',
    dzienLokalny(wpis.published_at), '2026-11-23');
  rowne('data zdarzenia to dzien przerwy, nie dzien publikacji',
    dzienLokalny(wpis.event_date), '2026-11-24');
  rowne('miejsce rozpoznane z tresci', wpis.street, 'Grabowiec');

  // "Grabowiec.Za utrudnienia" stoi tak w zrodle - urzad zapomnial spacji.
  sprawdz('sklejone zdanie ze zrodla zostalo rozdzielone',
    !wpis.description.includes('Grabowiec.Za'));

  const ot = wyciagPodstrone(PODSTRONA_OTYN);
  const wpisOt = jedenWpis(ZRODLO_OTYN, { ...ot, url: 'http://www.otyn.pl/PL/1000/1157/x/k/' });
  sprawdz('komunikat Otynia o wodzie wchodzi do appki', Boolean(wpisOt));
  sprawdz('tytul Otynia zaczyna sie od nazwy gminy',
    wpisOt.title.startsWith('Otyń: '));
  rowne('miejsce Otynia rozpoznane z tresci', wpisOt.street, 'Niedoradz');
  rowne('data zdarzenia Otynia to 25 listopada',
    dzienLokalny(wpisOt.event_date), '2026-11-25');

  // Komunikat bez tresci nie moze zajmowac miejsca w appce.
  const krotki = zbudujWpisy(ZRODLO_OTYN, [{ url: 'http://x/PL/1000/1/a/k/', tytul: 'Awaria', opis: 'Awaria.' }]);
  rowne('komunikat bez tresci nie wchodzi do appki', krotki.wyniki.length, 0);
  rowne('komunikat bez tresci jest odnotowany', krotki.bezTresci.length, 1);

  const bezTytulu = zbudujWpisy(ZRODLO_OTYN, [{ url: 'http://x/PL/1000/1/a/k/', tytul: '', opis: 'x'.repeat(100) }]);
  rowne('komunikat bez tytulu nie wchodzi do appki', bezTytulu.wyniki.length, 0);
}

// --- 6. przerwa odwolana ----------------------------------------------------

function testOdwolania() {
  const odwolana = jedenWpis(ZRODLO_SWIDNICA, {
    url: 'https://swidnica.zgora.pl/PL/1000/4990/x/k/',
    tytul: 'Przerwa w dostawie wody w Grabowcu',
    data: new Date(2026, 10, 23, 12),
    opis: 'Zakład Usług Komunalnych informuje, że nastąpi przerwa w dostawie wody '
      + 'w miejscowości Grabowiec. AKTUALIZACJA: dostawa wody została przywrócona.',
  });
  sprawdz('odwolana przerwa dostaje w tytule "(zakonczona)"',
    /\(zakończona\)/.test(odwolana.title));

  // Prognoza nie jest koncem awarii. Ten blad juz raz przeszedl do produkcji.
  const prognoza = jedenWpis(ZRODLO_SWIDNICA, {
    url: 'https://swidnica.zgora.pl/PL/1000/4991/x/k/',
    tytul: 'Przerwa w dostawie wody w Grabowcu',
    data: new Date(2026, 10, 23, 12),
    opis: 'Zakład Usług Komunalnych informuje, że nastąpi przerwa w dostawie wody. '
      + 'Przewidywany czas przywrócenia dostaw wody to około godziny 13:00.',
  });
  sprawdz('prognoza przywrocenia NIE oznacza przerwy jako zakonczonej',
    !/zakończona/i.test(prognoza.title));

  const obietnica = jedenWpis(ZRODLO_SWIDNICA, {
    url: 'https://swidnica.zgora.pl/PL/1000/4992/x/k/',
    tytul: 'Przerwa w dostawie wody w Grabowcu',
    data: new Date(2026, 10, 23, 12),
    opis: 'Nastąpi przerwa w dostawie wody w miejscowości Grabowiec. '
      + 'O przywróceniu dostaw wody poinformujemy w osobnym komunikacie.',
  });
  sprawdz('obietnica informacji NIE oznacza przerwy jako zakonczonej',
    !/zakończona/i.test(obietnica.title));

  const juzWTytule = jedenWpis(ZRODLO_SWIDNICA, {
    url: 'https://swidnica.zgora.pl/PL/1000/4993/x/k/',
    tytul: 'Przywrócenie dostawy wody w Grabowcu',
    data: new Date(2026, 10, 23, 12),
    opis: 'Informujemy o przywróceniu dostawy wody w miejscowości Grabowiec '
      + 'po usunięciu awarii sieci wodociągowej.',
  });
  sprawdz('tytul o przywroceniu nie dostaje jeszcze "(zakonczona)"',
    !/zakończona/i.test(juzWTytule.title));
}

// --- 7. odswiezanie zapamietanej tresci ------------------------------------

function testOdswiezanie() {
  const teraz = new Date(2026, 10, 23, 12).getTime();
  const dzien = 24 * 3600 * 1000;

  sprawdz('brak zapamietanej tresci wymaga pobrania',
    trzebaOdswiezyc(null, teraz));

  sprawdz('swiezo pobrana tresc nie jest pobierana drugi raz',
    !trzebaOdswiezyc({
      tytul: 'Przerwa w dostawie wody', opis: 'Przerwa w dniu 24.11.2026.', pobrano: teraz - 1000,
    }, teraz));

  // Urzad dopisuje "przywrocono" do TEJ SAMEJ strony, wiec komunikat o
  // trwajacej przerwie trzeba czytac ponownie. Inaczej mieszkaniec Grabowca
  // widzi ostrzezenie o awarii, ktorej juz nie ma.
  sprawdz('komunikat o przerwie jutro jest odswiezany po kilku godzinach',
    trzebaOdswiezyc({
      tytul: 'Przerwa w dostawie wody', opis: 'Przerwa w dniu 24.11.2026.', pobrano: teraz - 7 * 3600 * 1000,
    }, teraz));

  sprawdz('stary komunikat nie jest pobierany bez konca',
    !trzebaOdswiezyc({
      tytul: 'Przerwa w dostawie wody', opis: 'Przerwa w dniu 02.06.2026.', pobrano: teraz - 30 * dzien,
    }, teraz));

  sprawdz('przy braku daty w tresci decyduje data publikacji - swieza wraca',
    trzebaOdswiezyc({
      tytul: 'Awaria wody', opis: 'Trwa usuwanie awarii.', data: new Date(teraz - dzien), pobrano: teraz - 7 * 3600 * 1000,
    }, teraz));

  sprawdz('przy braku daty w tresci decyduje data publikacji - stara nie wraca',
    !trzebaOdswiezyc({
      tytul: 'Awaria wody', opis: 'Trwa usuwanie awarii.', data: new Date(teraz - 40 * dzien), pobrano: teraz - 30 * dzien,
    }, teraz));

  // To znalazla symulacja czterech cykli, a nie zaden test jednostkowy:
  // swiezy news, ktory NIE jest utrudnieniem, byl pobierany ponownie co
  // szesc godzin i zjadal budzet pobran potrzebny prawdziwej awarii.
  sprawdz('swiezy news, ktory nie jest utrudnieniem, nie jest odswiezany',
    !trzebaOdswiezyc({
      tytul: 'Stypendia naukowe rozdane',
      opis: 'Wójt Gminy wręczył stypendia naukowe najlepszym uczniom szkół podstawowych.',
      data: new Date(teraz - 3600 * 1000),
      pobrano: teraz - 7 * 3600 * 1000,
    }, teraz));

  sprawdz('komunikat o awarii ze swieza data publikacji nadal jest odswiezany',
    trzebaOdswiezyc({
      tytul: 'Awaria sieci wodociągowej w Letnicy',
      opis: 'Informujemy o awarii sieci wodociągowej. Brak wody potrwa do godzin wieczornych.',
      data: new Date(teraz - 3600 * 1000),
      pobrano: teraz - 7 * 3600 * 1000,
    }, teraz));
}

function uruchomTesty() {
  bledy.length = 0;
  sprawdzonych = 0;
  testLista();
  testPodstrony();
  testData();
  testKategorie();
  testWpisy();
  testOdwolania();
  testOdswiezanie();
  return { sprawdzonych, bledy };
}

if (require.main === module) {
  const wynik = uruchomTesty();
  for (const b of wynik.bledy) console.error(`  BLAD: ${b}`);
  console.log(`Sprawdzono ${wynik.sprawdzonych} warunkow, bledow: ${wynik.bledy.length}`);
  if (wynik.bledy.length) process.exitCode = 1;
}

module.exports = { uruchomTesty };
