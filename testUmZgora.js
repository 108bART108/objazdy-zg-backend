// Test filtra i klasyfikacji komunikatow ze strony miasta.
// Uruchomienie:  node testUmZgora.js
//
// Powstal po tym, jak 12.11.2026 dwa komunikaty drogowe nie pokazaly sie
// w zakladce "drogi" - kazdy z innego powodu. Oba sa tu pierwszymi
// przypadkami testowymi i maja zostac na zawsze.

const { dotyczyUtrudnienia } = require('./umZgora');
const { detectCategory } = require('./classify');

// [tytul, opis, czy ma trafic do appki, oczekiwana zakladka]
const PRZYPADKI = [
  // --- dwa komunikaty, ktore przepadly 12.11.2026 ---------------------------
  ['Ofensywa drogowa. Budowa w Raculi',
    'Ofensywa drogowa nie zwalnia tempa. Pod koniec pazdziernika miasto podpisalo umowe na budowe ulicy Racula-Wyspianskiego. Termin realizacji to dwa miesiace od przekazania terenu budowy, czyli jesli pogoda nie stanie na przeszkodzie, droga bedzie gotowa',
    true, 'drogi'],
  ['Budowa sieci wodociagowej na al. Konstytucji 3 Maja',
    'W czwartek (12 listopada), rozpoczna sie prace zwiazane z budowa sieci wodociagowej wraz z przylaczami w ul. al. Konstytucji 3 Maja. Roboty rozpoczna sie w rejonie skrzyzowania ulic Moniuszki, Dlugiej i al. Konstytucji 3',
    true, 'drogi'],

  // Te same dwa komunikaty z prawdziwymi polskimi znakami - tak, jak
  // przychodza z RSS. Wersja bez ogonkow nie sprawdza klas znakow typu
  // [żz] czy [ąa], a wlasnie tam najlatwiej o literowke.
  ['Ofensywa drogowa. Budowa w Raculi',
    'Ofensywa drogowa nie zwalnia tempa. Pod koniec października miasto podpisało umowę na budowę ulicy Racula-Wyspiańskiego. Termin realizacji to dwa miesiące od przekazania terenu budowy, czyli jeśli pogoda nie stanie na przeszkodzie, droga będzie gotowa',
    true, 'drogi'],
  ['Budowa sieci wodociągowej na al. Konstytucji 3 Maja',
    'W czwartek (12 listopada), rozpoczną się prace związane z budową sieci wodociągowej wraz z przyłączami w ul. al. Konstytucji 3 Maja. Roboty rozpoczną się w rejonie skrzyżowania ulic Moniuszki, Długiej i al. Konstytucji 3',
    true, 'drogi'],
  ['Awaria sieci wodociągowej na ul. Dąbrowskiego', 'Brak wody do godz. 14.', true, 'wodociagi'],
  ['Wyłączenia prądu w Zielonej Górze', 'Enea Operator informuje o wyłączeniach prądu.', true, 'prad'],
  ['ul. Wodociągowa wyłączona z ruchu', 'Odcinek nieprzejezdny do piątku.', true, 'drogi'],

  // --- komunikaty, przez ktore powstal kanal glowny (2.11.2026) -------------
  ['Rusza przebudowa zielonogorskiego deptaka', 'Prace potrwaja do wiosny.', true, 'drogi'],
  ['Zmiany w organizacji ruchu na Fabrycznej', 'Od poniedzialku obowiazuje nowa organizacja ruchu.', true, 'drogi'],

  // --- inne typowe komunikaty drogowe --------------------------------------
  ['Remont ul. Wyszynskiego', 'Kierowcy musza liczyc sie z objazdami.', true, 'drogi'],
  ['Nowa nawierzchnia na Sulechowskiej', 'Rozpoczelo sie frezowanie starej warstwy asfaltu.', true, 'drogi'],
  ['Budowa ronda przy Batorego', 'Inwestycja drogowa potrwa do czerwca.', true, 'drogi'],
  ['Roboty ziemne na Chrobrego', 'Prace naprawcze na odcinku 200 metrow.', true, 'drogi'],

  // --- prawdziwe przerwy w dostawie: musza trafic do swoich zakladek -------
  ['Awaria sieci wodociagowej na ul. Dabrowskiego', 'Brak wody do godz. 14.', true, 'wodociagi'],
  ['Nie bedzie wody na Chrobrego', 'Przerwa w dostawie wody potrwa do wieczora.', true, 'wodociagi'],
  ['Wylaczenia pradu w Zielonej Gorze', 'Enea Operator informuje o wylaczeniach pradu.', true, 'prad'],

  // --- MZK ------------------------------------------------------------------
  ['Zmiana trasy linii nr 27', 'Autobus pojedzie objazdem przez Wroclawska.', true, 'mzk'],

  // --- zycie miasta: NIE moze trafic do appki o utrudnieniach --------------
  ['Forum senioralne w ratuszu', 'Zapraszamy na spotkanie dla seniorow.', false, null],
  ['Koncert noworoczny w filharmonii', 'Bilety do nabycia w kasie.', false, null],
  ['Swieto Niepodleglosci - zapraszamy na bieg', 'Zachecamy do ruchu na swiezym powietrzu.', false, null],
  ['Budowa nowego przedszkola na Jedrzychowie', 'Placowka przyjmie 150 dzieci.', false, null],
  ['Budowa hali sportowej przy szkole', 'Inwestycja oswiatowa za 12 mln zl.', false, null],
  ['Konsultacje budzetu obywatelskiego', 'Mieszkancy zglaszaja projekty do 30 listopada.', false, null],
  ['Noc Bibliotek w Zielonej Gorze', 'W programie warsztaty i spotkania autorskie.', false, null],
];

let bledow = 0;

for (const [tytul, opis, maPrzejsc, zakladka] of PRZYPADKI) {
  const przeszedl = dotyczyUtrudnienia(tytul, opis);

  if (przeszedl !== maPrzejsc) {
    bledow++;
    console.log(`BLAD filtra: "${tytul}"`);
    console.log(`   oczekiwano: ${maPrzejsc ? 'wpuscic' : 'odrzucic'}, jest: ${przeszedl ? 'wpuszczony' : 'odrzucony'}`);
    continue;
  }

  if (!maPrzejsc) continue;

  const kategoria = detectCategory(`${tytul} ${opis}`);
  if (kategoria !== zakladka) {
    bledow++;
    console.log(`BLAD kategorii: "${tytul}"`);
    console.log(`   oczekiwano: ${zakladka}, jest: ${kategoria}`);
  }
}

console.log(`\nSprawdzono ${PRZYPADKI.length} komunikatow, bledow: ${bledow}`);
process.exit(bledow ? 1 : 0);
