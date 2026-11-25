// Zrodlo #1: oficjalny RSS Urzedu Miasta Zielona Gora (WordPress).
// WordPress domyslnie wystawia kanal RSS pod adresem /feed/ dla kazdego
// tagu/kategorii/calej strony, wiec to najbardziej stabilne zrodlo -
// nie zalezy od zmian w HTML/CSS strony, jak zwykly scraping.

const Parser = require('rss-parser');
const parser = new Parser();
const { detectCategory, extractStreet } = require('./classify');
const { sendSystemAlert } = require('./systemAlerts');
const { LIMIT_ZRODLA } = require('./sanitize');

// DWA RODZAJE KANALOW, celowo:
//
// 1. Kanaly tagowe - wszystko, co redakcja oznaczyla jako drogowe. Tu nie
//    filtrujemy niczego: skoro czlowiek nadal artykulowi tag "drogi w
//    Zielonej Gorze", to wiemy, ze dotyczy on ruchu.
//
// 2. Kanal glowny - WSZYSTKIE artykuly ze strony miasta, przepuszczone
//    przez filtr tresci.
//
// Powod istnienia punktu 2: 2.11.2026 okazalo sie, ze komunikaty "Rusza
// przebudowa zielonogorskiego deptaka" oraz "Zmiany w organizacji ruchu na
// Fabrycznej" nie trafily do appki, bo redakcja opublikowala je wylacznie w
// kategorii "Aktualnosci", bez tagu drogowego. Opieranie sie tylko na tagach
// oznacza, ze o tym, czy mieszkaniec dowie sie o zamknietej ulicy, decyduje
// to, czy ktos w urzedzie pamietal o zaznaczeniu wlasciwego pola. Kanal
// glowny usuwa te zaleznosc.
const FEEDS = [
  { etykieta: 'tag:drogi-w-zielonej-gorze', url: 'https://www.zielona-gora.pl/tag/drogi-w-zielonej-gorze/feed/', name: 'UM Zielona Gora', filtruj: false },
  { etykieta: 'tag:ofensywa-drogowa', url: 'https://www.zielona-gora.pl/tag/ofensywa-drogowa/feed/', name: 'UM Zielona Gora', filtruj: false },
  { etykieta: 'kanal glowny', url: 'https://www.zielona-gora.pl/feed/', name: 'UM Zielona Gora', filtruj: true },
];

// Sygnaly, ze artykul dotyczy utrudnien w miescie.
//
// Wzorce sa celowo WASKIE i wielowyrazowe. Samo slowo "ruch" bylo by
// pulapka: artykul o Swiecie Niepodleglosci zachecajacy do "ruchu na
// swiezym powietrzu" trafilby wtedy do appki o utrudnieniach. Dlatego
// szukamy "organizacji ruchu", "sterowania ruchem" czy "ograniczen w
// ruchu" - a nie samego rdzenia.
// Rzeczowniki, ktore robia z "remontu" remont DROGI, a nie budynku.
// "ul\\." jest tu osobno, bo urzad pisze "Remont ul. Warynskiego", a nie
// "ulicy"; podobnie oznaczenia DW i DK.
// "deptak" dopisany po tescie, ktory wylapal, ze "Rusza przebudowa
// zielonogorskiego deptaka" przestalo wchodzic. Deptak to nie budynek -
// jego przebudowa dotyczy pieszych i jest utrudnieniem. Tak samo tunel,
// kladka czy bulwar: wszystko, czym ludzie sie PORUSZAJA.
//
// Swiadomie NIE ma tu slowa "plac": "przebudowa placu zabaw" to nie
// utrudnienie w ruchu, a "plac budowy" jest juz osobnym wzorcem nizej.
const RZECZOWNIK_DROGOWY = '(ul\\.|ulic|drog|alej|alei|chodnik|[śs]cie[żz]k'
  + '|deptak|bulwar|promenad|tunel|k[łl]adk'
  + '|most|wiaduk|rond|skrzy[żz]|nawierzchni|jezdni|parking|torowisk'
  + '|obwodnic|przejazd|zjazd|w[ęe]z[łl]|DW\\s*\\d|DK\\s*\\d)';
const PRACE_BUDOWLANE = '(remont|przebudow|modernizacj)';
const ODLEGLOSC = '[\\s\\S]{0,40}';

const WZORZEC_UTRUDNIENIA = new RegExp([
  // organizacja i ograniczenia ruchu
  'organizacj\\w* ruchu', 'sterowani\\w* ruchem', 'ograniczeni\\w* w ruchu',
  'ruch\\w* drogow', 'wy[łl][ąa]czon\\w* z ruchu', 'nieprzejezdn',
  // roboty i ich skutki
  // Remont, przebudowa i modernizacja licza sie TYLKO blisko slowa
  // drogowego - w dowolnej kolejnosci ("remont ul. Lipowej", ale tez
  // "drogi do remontu").
  //
  // Goly wzorzec "remont" wpuscil 24.11.2026 do zakladki "drogi" artykul
  // "BWA i dawna szkola muzyczna do modernizacji" - 400 slow o remoncie
  // galerii sztuki, bo padlo w nim zdanie "Remont przejdzie rowniez sama
  // galeria". Mieszkaniec szukajacy zamknietej ulicy dostawal tekst
  // o sali projekcyjnej i panelach fotowoltaicznych. "modernizacj" bylo
  // juz wczesniej zawezone, ale "remont" i "przebudow" nie - poprawiamy
  // wszystkie trzy tak samo.
  `${PRACE_BUDOWLANE}\\w*${ODLEGLOSC}${RZECZOWNIK_DROGOWY}`,
  `${RZECZOWNIK_DROGOWY}\\w*${ODLEGLOSC}${PRACE_BUDOWLANE}`,
  'roboty drogowe', 'prace drogowe', 'prace budowlane',
  'objazd', 'zamkni[ęe]ci\\w* (ulic|drog|przejazd|skrzy[żz]|parking)',
  'zw[ęe][żz]eni', 'utrudnieni',
  // BUDOWA (nie tylko PRZEbudowa). Komunikat "Ofensywa drogowa. Budowa w
  // Raculi" z 12.11.2026 nie przeszedl przez zaden z powyzszych wzorcow:
  // "budowa ulicy" to nie "przebudowa", a "roboty" to nie "roboty drogowe".
  // Celowo wymagamy po slowie "budowa" obiektu drogowego lub sieciowego -
  // samo "budowa" wpuscilaby do appki budowe przedszkola czy hali.
  'budow\\w* (ulic|drog|sieci|ronda|skrzy[żz]|chodnik|[śs]cie[żz]k'
    + '|kanaliz|wodoci|mostu|wiaduk|parking|torow|w[ęe]z[łl]a|obwodnic)',
  'teren\\w* budowy', 'plac\\w* budowy',
  'inwestycj\\w* drogow', 'ofensywa drogowa',
  'robot\\w* (drogow|budowlan|ziemn|brukarsk)',
  'prace (remontow|modernizacyjn|brukarsk|ziemn|naprawcz)',
  'nawierzchni', 'frezowani', 'przy[łl][ąa]cz',
  // infrastruktura drogowa
  'skrzy[żz]owani', 'rondo', 'sygnalizacj\\w* [śs]wietln', 'przejazd kolejow',
  // bezposrednie zwroty do kierowcow i pieszych
  'kierowcy musz', 'kierowcy, uwaga', 'dla kierowc[óo]w', 'piesi musz',
  // awarie i przerwy
  'awari', 'przerw\\w* w dostawie', 'brak wody', 'wy[łl][ąa]czeni\\w* pr[ąa]du',
].join('|'), 'i');

function dotyczyUtrudnienia(tytul, opis) {
  return WZORZEC_UTRUDNIENIA.test(`${tytul} ${opis || ''}`);
}

// Kazdy kanal moze zepsuc sie osobno, a pozostale to zamaskuja: appka nadal
// pokazuje wpisy, wiec zrodlo "umZgora" wyglada na zdrowe, tylko czesc
// komunikatow po cichu przestaje docierac. Taki byl blad, przez ktory
// powstal kanal glowny - i taki sam moze dotknac kanalow tagowych.
//
// Dlatego pilnujemy KAZDEGO kanalu osobno. Poprzednia wersja
// obserwowala wylacznie kanal glowny, wiec kanal tagowy mogl od miesiecy
// zwracac blad 404 (np. po zmianie nazwy tagu w urzedzie) albo pusta liste
// i nikt by sie o tym nie dowiedzial - pozostale kanaly nadal dawaly wpisy,
// wiec zrodlo "umZgora" wygladalo na zdrowe. Scraper chodzi co 10 minut.
const BLEDY_PRZED_ALERTEM = 8;   // ok. 80 minut pod rzad bledu pobierania
const PUSTE_PRZED_ALERTEM = 36;  // ok. 6 godzin pod rzad pustej odpowiedzi

const stanKanalow = new Map();

function stan(etykieta) {
  if (!stanKanalow.has(etykieta)) {
    stanKanalow.set(etykieta, { bledy: 0, puste: 0, zgloszony: false });
  }
  return stanKanalow.get(etykieta);
}

// wynik: 'ok' | 'blad' | 'pusty'
function odnotujWynikKanalu(feed, wynik, szczegol) {
  const s = stan(feed.etykieta);

  if (wynik === 'ok') {
    if (s.zgloszony) console.log(`[umZgora] kanal "${feed.etykieta}" znowu dziala`);
    s.bledy = 0; s.puste = 0; s.zgloszony = false;
    return;
  }

  if (wynik === 'blad') { s.bledy++; s.puste = 0; } else { s.puste++; s.bledy = 0; }

  const przekroczony = (wynik === 'blad' && s.bledy >= BLEDY_PRZED_ALERTEM)
    || (wynik === 'pusty' && s.puste >= PUSTE_PRZED_ALERTEM);
  if (!przekroczony || s.zgloszony) return;

  s.zgloszony = true;
  const cykli = wynik === 'blad' ? s.bledy : s.puste;
  const opis = wynik === 'blad'
    ? `nie udaje sie pobrac kanalu (${szczegol || 'blad pobierania'})`
    : 'kanal odpowiada, ale nie zawiera ani jednego artykulu';

  console.error(`[umZgora] kanal "${feed.etykieta}" od ${cykli} cykli: ${opis}`);
  sendSystemAlert(
    `Kanal "${feed.etykieta}" strony miasta nie dostarcza komunikatow`,
    `Od ${cykli} cykli ${opis}.\nAdres: ${feed.url}\n\n`
    + 'Czesc komunikatow moze nie trafiac do appki. Sprawdz, czy adres kanalu '
    + 'nadal istnieje - urzad mogl zmienic nazwe tagu albo przeniesc go do kategorii.'
  ).catch(() => { /* alert jest dodatkiem, nie moze przerwac scrapowania */ });
}

async function fetchUmZgora() {
  const results = [];
  const widzianeAdresy = new Set();
  let pominietych = 0;

  const podsumowanie = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const wpisowWKanale = (parsed.items || []).length;
      let dodanych = 0;

      // Pusty kanal to nie to samo co blad: adres odpowiada poprawnie, tylko
      // nie ma w nim ani jednego artykulu. Tak wyglada tag, ktory urzad
      // skasowal albo przemianowal - i dokladnie tak wyglada cisza, ktorej
      // nie widac z zewnatrz.
      odnotujWynikKanalu(feed, wpisowWKanale === 0 ? 'pusty' : 'ok');

      for (const item of parsed.items || []) {
        // Ten sam artykul bywa w kanale tagowym i glownym - bierzemy raz.
        if (!item.link || widzianeAdresy.has(item.link)) continue;

        // WordPress wystawia w kanale DWIE wersje tresci:
        //   <description>      -> zajawka, ucinana przez CMS i zakonczona "[...]"
        //   <content:encoded>  -> CALY artykul
        // rss-parser udostepnia je jako contentSnippet i content:encodedSnippet
        // (oba juz bez znacznikow HTML). Braliśmy zajawke, przez co opisy
        // w appce urywaly sie w polowie zdania na "[...]" - i zadne nasze
        // limity nie mogly tego naprawic, bo tresc przychodzila juz ucieta.
        // Pelna wersja nic nie kosztuje: jest w tej samej odpowiedzi.
        const pelnaTresc = (item['content:encodedSnippet'] || '').trim();
        const zajawka = (item.contentSnippet || '').trim();
        const tresc = pelnaTresc.length > zajawka.length ? pelnaTresc : zajawka;
        // Pelna tresc artykulu konczy sie redakcyjna stopka: inicjalami
        // autora i podpisem zdjecia, czasem z powtorzonym leadem
        // ("... (rk) Fot. Wladyslaw Czulak/Pod koniec pazdziernika...").
        // Dla mieszkanca to szum, wiec ucinamy go od miejsca, w ktorym
        // sie zaczyna. Wzorzec jest celowo waski - wymaga pary
        // "(inicjaly) Fot." albo samych inicjalow na samym koncu.
        const opis = tresc
          .replace(/\s+/g, ' ')
          .replace(/\s*\([a-ząćęłńóśźż]{2,4}\)\s*Fot\..*$/i, '')
          .replace(/\s*\([a-ząćęłńóśźż]{2,4}\)\s*$/i, '')
          .trim()
          .slice(0, LIMIT_ZRODLA);

        // O tym, CZY wpuscic artykul i do KTOREJ zakladki trafi, decyduje
        // dalej sam poczatek tekstu - tak jak wtedy, gdy mielismy wylacznie
        // zajawke. Gdyby decydowala cala tresc, przypadkowe "awaria" czy
        // "wodociag" w szostym akapicie artykulu o czyms innym zmienialoby
        // kategorie albo wpuszczalo do appki tekst o koncercie, w ktorym
        // raz pada slowo "remont". Pelna tresc sluzy do CZYTANIA, nie do
        // klasyfikowania.
        const poczatek = opis.slice(0, 400);

        // Kanal glowny zawiera cale zycie miasta: forum senioralne, koncerty,
        // swieta. Do appki o utrudnieniach wpuszczamy tylko to, co faktycznie
        // dotyczy ruchu, awarii lub przerw w dostawach.
        // Kanaly tagowe tez filtrujemy, choc tag ustawia sam urzad.
        //
        // Dotad im ufalismy bez sprawdzania - skoro magistrat oznaczyl
        // artykul tagiem "drogi w Zielonej Gorze", to pewnie dotyczy drog.
        // 24.11.2026 okazalo sie, ze niekoniecznie: do zakladki "drogi"
        // wszedl 400-slowny tekst o remoncie galerii BWA i dawnej szkoly
        // muzycznej. Mieszkaniec szukajacy zamknietej ulicy dostawal opis
        // sali projekcyjnej i paneli fotowoltaicznych.
        //
        // Roznica wzgledem kanalu glownego jest w LOGOWANIU, nie w progu.
        // Z kanalu glownego odpadaja dziesiatki artykulow i wypisujemy
        // tylko ich liczbe. Z kanalu tagowego odrzucenie powinno byc
        // rzadkie, wiec wypisujemy TYTUL - zeby bledne odrzucenie dalo sie
        // zauwazyc i poprawic, zamiast gubic komunikat po cichu. W tym
        // projekcie cicha strata komunikatu jest grozniejsza niz nadmiar.
        if (!dotyczyUtrudnienia(item.title, poczatek)) {
          pominietych++;
          if (!feed.filtruj) {
            console.warn(`[umZgora] ${feed.etykieta}: pomijam wpis niezwiazany z utrudnieniami `
              + `- "${item.title}"`);
          }
          continue;
        }

        widzianeAdresy.add(item.link);
        dodanych++;
        const text = `${item.title} ${poczatek}`;
        results.push({
          source_url: item.link,
          source_name: feed.name,
          category: detectCategory(text),
          title: item.title,
          street: extractStreet(item.title),
          description: opis,
          published_at: item.isoDate || item.pubDate || new Date().toISOString(),
        });
      }
      podsumowanie.push(`${feed.etykieta}: ${wpisowWKanale} w kanale, ${dodanych} nowych`);
    } catch (err) {
      console.error(`[umZgora] blad pobierania ${feed.url}:`, err.message);
      odnotujWynikKanalu(feed, 'blad', err.message);
      podsumowanie.push(`${feed.etykieta}: BLAD (${err.message})`);
    }
  }

  // Jedna linia na cykl, ale pokazuje kazdy kanal z osobna. Bez tego nie da
  // sie z logow odroznic sytuacji "kanal tagowy nie zwraca nic" od "kanal
  // tagowy zwraca to samo, co glowny".
  console.log(`[umZgora] ${podsumowanie.join(' | ')}`);

  if (pominietych) {
    console.log(`[umZgora] z kanalu glownego pominieto ${pominietych} artykulow niezwiazanych z utrudnieniami`);
  }
  return results;
}

module.exports = { fetchUmZgora, dotyczyUtrudnienia };
