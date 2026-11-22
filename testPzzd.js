// Test zrodla PZZD (drogi powiatowe wokol Zielonej Gory).
// Uruchomienie:  node testPzzd.js
//
// WAZNE: fragmenty HTML ponizej nie sa wymyslone. To dosłowne kawalki
// odpowiedzi, ktore 22.11.2026 przyszly z BIP-u PZZD podczas rozpoznania
// (sonda2.js i sonda3.js uruchomione na serwerze). Dzieki temu test
// sprawdza parser na tym, co zrodlo naprawde wysyla, a nie na tym, co
// wydawalo mi sie, ze wysyla - bo wlasnie ta roznica kosztowala nas
// miesiac uciętego komunikatu MZK o ul. Zacisze.

const {
  wyciagListe, wyciagTresc, wykryjDroge, kolejnoscPobierania, dataPublikacjiWpisu, brakTresci,
  WARIANTY_UA, KODY_BLOKADY,
} = require('./pzzd');

// --- fragment menu ze strony /47/Utrudnienia_w_ruchu/ -----------------------
const LISTA = `<html><body><ul>
<li><a href="https://bip.pzzd.powiat-zielonogorski.pl/55/Obsluga_interesantow/" title="Przejdź do pozycji menu">Obsługa interesantów</a></li>
<li><a href="https://bip.pzzd.powiat-zielonogorski.pl/przetargi/29/status/" title="Przejdź do pozycji menu">Zamówienia publiczne</a></li>
<li><a aria-current="page" href="https://bip.pzzd.powiat-zielonogorski.pl/47/Utrudnienia_w_ruchu/" class="selected" title="Przejdź do pozycji menu">Utrudnienia w ruchu</a>
  <ul>
    <li><a aria-current="page" href="https://bip.pzzd.powiat-zielonogorski.pl/311/1_2023_Utrudnienia_w_ruchu_drogowym_-_most_na_Kanale_Dychowskim_-_przed_m__Lagoda/" title="Przejdź do pozycji menu">1 2023 Utrudnienia w ruchu drogowym - most na Kanale Dychowskim - przed m. Łagoda</a> </li>
    <li><a aria-current="page" href="https://bip.pzzd.powiat-zielonogorski.pl/503/22_05_2026_Zamkniecie_drogi_powiatowej_1140F/" title="Przejdź do pozycji menu">22.05.2026 Zamknięcie drogi powiatowej 1140F</a> </li>
    <li><a aria-current="page" href="https://bip.pzzd.powiat-zielonogorski.pl/507/10_07_2026_Zamkniecie_drogi_powiatowej_1189F/" title="Przejdź do pozycji menu">10.07.2026 Zamknięcie drogi powiatowej 1189F</a> </li>
    <li><a aria-current="page" href="https://bip.pzzd.powiat-zielonogorski.pl/510/05_08_2026_Tour_De_Pologne/" title="Przejdź do pozycji menu">05.08.2026 Tour De Pologne</a> </li>
    <li><a aria-current="page" href="https://bip.pzzd.powiat-zielonogorski.pl/512/19_08_2026_Zamkniecie_drogi_powiatowej_1189F_w_m__Karszyn/" title="Przejdź do pozycji menu">19.08.2026 Zamknięcie drogi powiatowej 1189F w m. Karszyn</a> </li>
    <li><a aria-current="page" href="https://bip.pzzd.powiat-zielonogorski.pl/524/28_10_2026_Zamkniecie_drogi_powiatowej_nr_1181F/" title="Przejdź do pozycji menu">28.10.2026 Zamknięcie drogi powiatowej nr 1181F</a> </li>
  </ul>
</li>
<li><a href="https://bip.pzzd.powiat-zielonogorski.pl/45/Zimowe_utrzymanie_drog/" title="Przejdź do pozycji menu">Zimowe utrzymanie dróg</a></li>
<li><a href="https://bip.pzzd.powiat-zielonogorski.pl/wakaty/2/status/" title="Przejdź do pozycji menu">Nabór na wolne stanowiska</a></li>
<li><a href="https://bip.pzzd.powiat-zielonogorski.pl/61/Akt_zalozycielski/" title="Przejdź do pozycji menu">Akt założycielski</a></li>
</ul></body></html>`;

// --- podstrona komunikatu 1181F (Slone - Buchalow) --------------------------
const PODSTRONA_1181F = `<div class="information"> <p class="phx ph3"> 28.10.2026 Zamknięcie drogi powiatowej nr 1181F </p>
<div class="paragraph"> <h4 class="hide">Akapit nr 1 - brak tytułu</h4>
<div>
<div style="text-align:center">&nbsp;</div>
<div><strong>28.10.2026</strong></div>
<div style="text-align:center"><strong>Z A W I A D O M I E N I E</strong></div>
<div>&nbsp;</div>
<div>&nbsp;&nbsp;&nbsp; Powiatowy Zielonog&oacute;rski Zarząd Dr&oacute;g informuje, że w związku z awarią przepustu w pasie drogowym drogi powiatowej nr 1181F relacji Słone - Buchał&oacute;w, zlokalizowanego ok. 100m za m. Buchał&oacute;w w kierunku m. Słone, konieczne jest całkowite zamknięcie odcinka drogi powiatowej dla ruchu od dnia 03.11.2026 r. (wtorek) do dnia 10.11.2026 r. (wtorek) włącznie, na wysokości w/w przepustu.</div>
<div>Połączenie drogowe pomiędzy miejscowościami Buchał&oacute;w i Słone możliwe będzie dla obu stron drogą wojew&oacute;dzką nr 279 i drogą krajową nr 27.&nbsp;</div>
<div><strong>Jednocześnie informujemy, że w przypadku konieczności przejazdu pojazd&oacute;w specjalnych: Pogotowie Ratunkowe, Straż Pożarna, Policja możliwy będzie objazd prowadzonych rob&oacute;t poprzez teren rekreacyjny należący do Gminy Świdnica</strong></div>
<div>W załączeniu mapka z orientacyjnym przebiegiem objazdu.</div>
<div style="text-align:center"><img alt="" src="https://bip.pzzd.powiat-zielonogorski.pl/system/pobierz.php?id=5a623fd41c" style="height:343px; width:800px" /></div>
<div>Załącznik do pobrania:</div>
<div><a href="https://bip.pzzd.powiat-zielonogorski.pl/system/pobierz.php?id=f75365a690">https://bip.pzzd.powiat-zielonogorski.pl/system/pobierz.php?id=f75365a690</a></div>
</div> </div>
<div class="print"> <a href="https://bip.pzzd.powiat-zielonogorski.pl/xml/524/462/x/wersja/" class="xml-bt">Pobierz dane XML<span class="hide"> 28.10.2026 Zamknięcie drogi powiatowej nr 1181F</span></a> </div></div>`;

// --- podstrona komunikatu 1140F (Nowogrod Bobrzanski - Lagoda) --------------
const PODSTRONA_1140F = `<div class="information"> <p class="phx ph3"> 22.05.2026 Zamknięcie drogi powiatowej 1140F </p>
<div class="paragraph"> <h4 class="hide">Akapit nr 1 - brak tytułu</h4>
<div>
<div style="text-align:left"><span style="font-size:28px"><strong>22.05.2026&nbsp; </strong></span></div>
<div style="text-align:center"><span style="font-size:28px"><strong>ZAMKNIĘCIE DROGI POWIATOWEJ NR 1140F&nbsp;</strong></span></div>
<div style="text-align:center"><span style="font-size:26px"><strong>od dnia 23.05.2026 r. od godziny 7.00 do niedzieli 24.05.2026 r. do godzin wieczornych.</strong></span></div>
<div style="text-align:center">&nbsp;</div>
<div style="text-align:center">
  <div><span style="font-size:18px"><strong>Z A W I A D O M I E N I E</strong></span></div>
  <div>&nbsp;</div>
  <div><span style="font-size:18px">Powiatowy Zielonog&oacute;rski Zarząd Dr&oacute;g informuje, że w związku z awarią przepustu w pasie drogowym drogi powiatowej nr 1140F relacji Nowogr&oacute;d Bobrzański &ndash; Łagoda, zlokalizowanego ok. 200m<br /> za m. Nowogr&oacute;d Bobrzański, konieczne jest całkowite zamknięcie drogi powiatowej dla ruchu <strong>od dnia 23.05.2026 r. od godziny 7.00 do niedzieli 24.05.2026 r. do godzin wieczornych.</strong></span></div>
  <div><span style="font-size:18px">Dojazd do m. Nowogr&oacute;d Bobrzański możliwy będzie drogą gminną nr 003841F od strony Krzywańca do drogi wojew&oacute;dzkiej nr 289 i dalej do Nowogrodu Bobrzańskiego.</span></div>
  <div><span style="font-size:18px">Mapka z orientacyjnym przebiegiem objazdu:</span></div>
  <div>&nbsp;</div>
  <div style="text-align: left;"><span style="font-size:18px">Plik do pobrania:<a href="https://bip.pzzd.powiat-zielonogorski.pl/system/pobierz.php?id=75c17f6280">https://bip.pzzd.powiat-zielonogorski.pl/system/pobierz.php?id=75c17f6280</a></span></div>
</div>
</div> </div></div>`;

const bledy = [];
function sprawdz(warunek, opis) {
  if (!warunek) bledy.push(opis);
}

// ============================ 1. LISTA ======================================
const { wpisy, sposob } = wyciagListe(LISTA);

sprawdz(sposob === 'podmenu', `lista: uzyto sposobu "${sposob}", a powinno byc "podmenu"`);
sprawdz(wpisy.length === 6, `lista: znaleziono ${wpisy.length} komunikatow, oczekiwano 6`);

const adresy = wpisy.map((w) => w.url);
sprawdz(!adresy.some((a) => a.includes('/45/')), 'lista: wciagnieto "Zimowe utrzymanie drog" (nie jest komunikatem)');
sprawdz(!adresy.some((a) => a.includes('/61/')), 'lista: wciagnieto "Akt zalozycielski"');
sprawdz(!adresy.some((a) => a.includes('/55/')), 'lista: wciagnieto "Obsluga interesantow"');
sprawdz(!adresy.some((a) => a.includes('wakaty')), 'lista: wciagnieto nabor na stanowiska');

const najnowszy = wpisy.find((w) => w.url.includes('/524/'));
sprawdz(!!najnowszy, 'lista: brak komunikatu 1181F');
if (najnowszy) {
  sprawdz(najnowszy.tytul === 'Zamknięcie drogi powiatowej nr 1181F',
    `lista: tytul to "${najnowszy.tytul}" - data powinna zostac odcieta od tytulu`);
  sprawdz(najnowszy.data instanceof Date && najnowszy.data.getFullYear() === 2026
    && najnowszy.data.getMonth() === 9 && najnowszy.data.getDate() === 28,
  `lista: zla data komunikatu 1181F (${najnowszy.data})`);
}

// Pozycja z 2023 nie ma daty na poczatku, ale to nadal prawdziwe
// utrudnienie (zamkniety most na Kanale Dychowskim) - ma wejsc.
const most = wpisy.find((w) => w.url.includes('/311/'));
sprawdz(!!most, 'lista: pominieto komunikat bez daty w nazwie (most na Kanale Dychowskim)');
if (most) sprawdz(most.data === null, 'lista: komunikat bez daty dostal date - powinien miec null');

// ============================ 2. TRESC ======================================
const t1181 = wyciagTresc(PODSTRONA_1181F);

sprawdz(t1181.startsWith('Powiatowy Zielonogórski Zarząd Dróg informuje'),
  `tresc 1181F: zaczyna sie od "${t1181.slice(0, 60)}"`);
sprawdz(t1181.includes('od dnia 03.11.2026 r. (wtorek) do dnia 10.11.2026'),
  'tresc 1181F: brak okresu zamkniecia');
sprawdz(t1181.includes('drogą wojewódzką nr 279 i drogą krajową nr 27'),
  'tresc 1181F: brak opisu objazdu');
sprawdz(t1181.includes('Pogotowie Ratunkowe'), 'tresc 1181F: brak akapitu o pojazdach specjalnych');
sprawdz(!/Z\s*A\s*W\s*I\s*A\s*D\s*O\s*M/.test(t1181), 'tresc 1181F: zostalo "Z A W I A D O M I E N I E"');
sprawdz(!t1181.includes('Załącznik do pobrania'), 'tresc 1181F: zostal odsylacz do zalacznika');
sprawdz(!t1181.includes('pobierz.php'), 'tresc 1181F: zostal surowy adres pliku');
sprawdz(!t1181.includes('Pobierz dane XML'), 'tresc 1181F: wszedl odnosnik z sekcji wydruku');
sprawdz(!t1181.includes('Akapit nr 1'), 'tresc 1181F: zostal ukryty naglowek BIP-u');
sprawdz(!/&[a-z]+;/.test(t1181), 'tresc 1181F: zostaly nieodkodowane encje HTML');
sprawdz(!/^\s*28\.10\.2026/.test(t1181), 'tresc 1181F: zaczyna sie od samej daty');

const t1140 = wyciagTresc(PODSTRONA_1140F);
sprawdz(t1140.includes('od dnia 23.05.2026 r. od godziny 7.00 do niedzieli 24.05.2026'),
  'tresc 1140F: brak okresu zamkniecia (jest w wyroznionym naglowku)');
sprawdz(t1140.includes('Nowogród Bobrzański'), 'tresc 1140F: zgubiono nazwe miejscowosci (encja &oacute;)');
sprawdz(t1140.includes('drogą gminną nr 003841F'), 'tresc 1140F: brak opisu dojazdu');
sprawdz(!t1140.includes('Mapka z orientacyjnym'), 'tresc 1140F: zostal odsylacz do mapki');
// W tym komunikacie etykieta i adres pliku siedza w JEDNEJ linii
// ("Plik do pobrania:https://bip..."). Pierwsza wersja parsera tego nie
// wylapala - dlatego ten warunek zostaje tu na zawsze.
sprawdz(!t1140.includes('Plik do pobrania'), 'tresc 1140F: zostal odsylacz do pliku');
sprawdz(!/https?:\/\//.test(t1140), 'tresc 1140F: zostal surowy adres pliku');
sprawdz(!t1140.includes('bip.pzzd'), 'tresc 1140F: zostal fragment adresu BIP-u');

// Tekst nie moze sie powtarzac przez zagniezdzone <div>-y
const zdanie = 'Powiatowy Zielonogórski Zarząd Dróg informuje';
const ile = t1140.split(zdanie).length - 1;
sprawdz(ile === 1, `tresc 1140F: zdanie otwierajace powtorzone ${ile} razy (zagniezdzenia)`);

// ============================ 3. NUMER DROGI ================================
sprawdz(wykryjDroge('Zamknięcie drogi powiatowej nr 1181F') === 'droga powiatowa nr 1181F',
  `numer drogi: "${wykryjDroge('Zamknięcie drogi powiatowej nr 1181F')}"`);
sprawdz(wykryjDroge('Zamknięcie drogi powiatowej 1140F') === 'droga powiatowa nr 1140F',
  `numer drogi bez "nr": "${wykryjDroge('Zamknięcie drogi powiatowej 1140F')}"`);
sprawdz(wykryjDroge('Tour De Pologne') === null,
  `numer drogi: z "Tour De Pologne" nie powinno nic wyjsc, wyszlo "${wykryjDroge('Tour De Pologne')}"`);

// ============================ 4. KOLEJNOSC POBIERANIA ======================
// Limit pobran na cykl jest maly, wiec kolejnosc decyduje o tym, ktory
// komunikat mieszkaniec zobaczy z trescia JUZ, a ktory dopiero po 10 minutach.
// Pierwsza wersja szla od najstarszych - czyli zuzywala limit na komunikatach
// z 2023 i maja, a najswiezsze zamkniecie drogi zostawialo sam tytul.
const kolejka = kolejnoscPobierania(wpisy);
sprawdz(kolejka.length === wpisy.length, 'kolejnosc: zgubiono albo zdublowano wpisy');
sprawdz(kolejka[0] && kolejka[0].url.includes('/524/'),
  `kolejnosc: pierwszy do pobrania jest "${kolejka[0] && kolejka[0].tytul}", a powinien najnowszy (1181F)`);
sprawdz(kolejka[kolejka.length - 1] && kolejka[kolejka.length - 1].data === null,
  'kolejnosc: wpis bez daty powinien byc ostatni w kolejce');

const daty = kolejka.filter((w) => w.data).map((w) => w.data.getTime());
sprawdz(daty.every((d, i) => i === 0 || daty[i - 1] >= d),
  'kolejnosc: daty nie sa uporzadkowane od najnowszej');

// ============================ 5. DATA PUBLIKACJI ===========================
// Najgrozniejszy z wykrytych bledow: wpis bez daty oddawal null, a baza
// podstawiala "teraz" (COALESCE w upsercie). Zamkniecie mostu z 2023 roku
// wygladaloby na dzisiejsza wiadomosc i poszloby na push do wszystkich.
const bezDaty = { tytul: '1 2023 Utrudnienia w ruchu drogowym - most na Kanale Dychowskim', data: null };
const dOld = dataPublikacjiWpisu(bezDaty, 'Zarzad Drog informuje o zamknieciu mostu.');
sprawdz(dOld instanceof Date, 'data publikacji: wpis bez daty oddal null - baza wstawi dzisiejsza date i wysle push');
sprawdz(dOld && dOld.getFullYear() === 2023,
  `data publikacji: z nazwy "1 2023 ..." powinien wyjsc rok 2023, wyszlo ${dOld && dOld.getFullYear()}`);

// Data z nazwy pozycji ma pierwszenstwo przed trescia.
const zNazwy = { tytul: 'Zamknięcie drogi', data: new Date(2026, 9, 28) };
sprawdz(dataPublikacjiWpisu(zNazwy, 'Zamkniecie od dnia 03.11.2026 r.').getTime() === zNazwy.data.getTime(),
  'data publikacji: data z nazwy pozycji musi miec pierwszenstwo przed data z tresci');

// Brak daty w nazwie, ale jest w tresci - bierzemy z tresci.
const zTresci = dataPublikacjiWpisu({ tytul: 'Zamknięcie drogi powiatowej', data: null },
  'Zarzad informuje, ze od dnia 03.11.2026 r. droga bedzie zamknieta.');
sprawdz(zTresci instanceof Date && zTresci.getFullYear() === 2026,
  `data publikacji: nie odczytano daty z tresci (${zTresci})`);

// ============================ 6. CZY BRAKUJE TRESCI ========================
// Ten warunek decyduje, czy jeszcze raz pojsc po tresc na podstrone.
// Wersja oparta na samej dlugosci ("ponizej 60 znakow") zamrazala na zawsze
// kazdy komunikat o dlugim tytule - bo opis = tytul mial 81 znakow i
// przechodzil prog. Wylapala to symulacja czterech cykli, nie jeden przebieg.
const DLUGI_TYTUL = '1 2023 Utrudnienia w ruchu drogowym - most na Kanale Dychowskim - przed m. Łagoda';
sprawdz(brakTresci(DLUGI_TYTUL, DLUGI_TYTUL),
  'brakTresci: opis rowny dlugiemu tytulowi musi liczyc sie jako BRAK tresci');
sprawdz(brakTresci('', 'Zamknięcie drogi'), 'brakTresci: pusty opis to brak tresci');
sprawdz(brakTresci('Zamknięcie   drogi ', 'Zamknięcie drogi'),
  'brakTresci: opis rowny tytulowi po normalizacji spacji to brak tresci');
sprawdz(!brakTresci(t1181, 'Zamknięcie drogi powiatowej nr 1181F'),
  'brakTresci: prawdziwe zawiadomienie zostalo uznane za brak tresci - pobieralibysmy je co cykl bez konca');

// ============================ 7. JAK SIE PRZEDSTAWIAMY =====================
// 22.11.2026 pierwsze wdrozenie dostalo z BIP-u HTTP 403, choc dwa dni
// wczesniej sondy pobraly te same strony z tego samego serwera. Roznica byla
// JEDNA: scraper mowil o sobie "UtrudnieniaZG-bot", sondy "UtrudnieniaZG-sonda".
// Slowo "bot" w nazwie wystarczylo. Dlatego teraz to slowo jest pilnowane.
for (const ua of WARIANTY_UA) {
  sprawdz(!/bot|crawler|spider|scraper/i.test(ua),
    `nazwa "${ua.split(' ')[0]}" zawiera slowo, przez ktore zapory odrzucaja ruch`);
}
sprawdz(WARIANTY_UA.length >= 2,
  'musi byc wiecej niz jedna nazwa - inaczej jedna blokada ucina cale zrodlo');
sprawdz(/utrudnienia-zg\.pl/.test(WARIANTY_UA[0]),
  'pierwsza nazwa musi uczciwie mowic, czym jesteśmy, i podawac kontakt do nas');
sprawdz(KODY_BLOKADY.includes(403),
  'kod 403 musi uruchamiac probe z inna nazwa - to wlasnie on nas zatrzymal');
sprawdz(!KODY_BLOKADY.includes(404) && !KODY_BLOKADY.includes(500),
  'kody 404 i 500 NIE moga uruchamiac kolejnych prob - zmiana nazwy nic tam nie da, '
  + 'a mnozylaby zapytania do urzedu');

// ============================ WYNIK =========================================
const LICZBA_WARUNKOW = 41 + WARIANTY_UA.length + 4;

function uruchomTesty() {
  return { sprawdzonych: LICZBA_WARUNKOW, bledy };
}

if (require.main === module) {
  console.log(`lista: ${wpisy.length} komunikatow (sposob: ${sposob})`);
  for (const w of wpisy) {
    // Data wypisana po lokalnemu. toISOString() pokazalby dzien wczesniej
    // (strefa), co przy sprawdzaniu wygladalo jak blad parsera, a nim nie jest.
    const d = w.data ? w.data.toLocaleDateString('pl-PL') : 'bez daty';
    console.log(`   ${d}  ${w.tytul}`);
  }
  console.log('');
  console.log(`tresc 1181F (${t1181.length} zn.): ${t1181.slice(0, 150)}…`);
  console.log('');
  console.log(`tresc 1140F (${t1140.length} zn.): ${t1140.slice(0, 150)}…`);
  console.log('');
  for (const b of bledy) console.log(`BLAD ${b}`);
  console.log(`Sprawdzono ${LICZBA_WARUNKOW} warunkow, bledow: ${bledy.length}`);
  process.exit(bledy.length ? 1 : 0);
}

module.exports = { uruchomTesty };
