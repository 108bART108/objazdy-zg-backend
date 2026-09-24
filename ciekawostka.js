const { getDailyFact, deleteDailyFact, saveDailyFact, getRecentFacts, getLatestFact } = require('./db');

const MODEL = 'claude-haiku-4-5-20251001';

function todayDate() {
  const now = new Date();
  const warsaw = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  const yyyy = warsaw.getFullYear();
  const mm = String(warsaw.getMonth() + 1).padStart(2, '0');
  const dd = String(warsaw.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function callClaude(prompt, useSearch) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Brak ANTHROPIC_API_KEY w zmiennych srodowiskowych');

  const body = {
    model: MODEL,
    // Wiecej miejsca: dluzsza tresc (2-4 zdania) + znaczniki + zrodlo.
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();

  // KLUCZOWE: gdy model korzysta z web_search, API zwraca odpowiedz w
  // KILKU osobnych blokach, w kolejnosci:
  //   1. blok "text" z zapowiedzia ("Wyszukuje informacje o...")
  //   2. blok "server_tool_use" (samo wyszukiwanie)
  //   3. blok "web_search_tool_result" (wyniki)
  //   4. blok "text" z WLASCIWA odpowiedzia
  //
  // Sklejanie WSZYSTKICH blokow "text" (tak bylo wczesniej) powodowalo,
  // ze zapowiedz wyszukiwania trwale przyklejala sie przed trescia -
  // stad publikowane "Wyszukuje informacje o Zielonej Gorze. Budynek
  // Planetarium...". To nie byl blad modelu, tylko bledny odczyt
  // odpowiedzi po naszej stronie.
  //
  // Bierzemy wiec TYLKO OSTATNI blok tekstowy - to jest finalna
  // odpowiedz modelu, juz po zakonczeniu wyszukiwania.
  const textBlocks = (data.content || []).filter((b) => b.type === 'text' && b.text && b.text.trim());
  if (!textBlocks.length) throw new Error('Pusta odpowiedz z Anthropic API');

  const lastBlock = textBlocks[textBlocks.length - 1].text
    .replace(/\s+/g, ' ')
    .trim();

  // Pelny tekst (wszystkie bloki) jest potrzebny tylko tam, gdzie tresc
  // wyciagamy przez jednoznaczne znaczniki <ciekawostka> - tam sklejenie
  // jest bezpieczne, bo znaczniki same wyznaczaja granice tresci.
  const fullText = textBlocks.map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim();

  // Adresy stron, ktore wyszukiwarka FAKTYCZNIE zwrocila w tym wywolaniu.
  // Sluza do weryfikacji zrodla: link podany przez model musi pochodzic
  // z tej listy - inaczej mogl zostac zmyslony.
  const searchUrls = [];
  for (const block of data.content || []) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r && r.url) searchUrls.push(r.url);
      }
    }
  }

  if (!lastBlock) throw new Error('Pusta odpowiedz z Anthropic API');
  return { lastBlock, fullText, searchUrls };
}

// KROK 1: generowanie ciekawostki z uzyciem wyszukiwania w internecie.
async function generateFact(avoidList) {
  const avoidText = avoidList.length
    ? `ZAKAZ POWTORZEN - ponizej lista tematow juz wykorzystanych w ostatnich tygodniach. Wybierz temat CALKOWICIE INNY. Nie wystarczy przeformulowac zdania czy zmienic szczegolu - chodzi o INNY OBIEKT, INNE WYDARZENIE, INNA OSOBE lub INNE MIEJSCE:\n${avoidList.map((f) => `- ${f}`).join('\n')}\n\n`
    : '';

  const today = new Date().toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw' });

  const prompt = `Dzisiaj jest ${today}. Wyszukaj w internecie i podaj jedna ciekawostke o miescie Zielona Gora w wojewodztwie lubuskim w Polsce, lub jego najblizszych okolicach.

DLUGOSC I BUDOWA: 3-4 zdania, okolo 300-500 znakow. Pierwsze zdanie podaje glowny fakt. Kolejne zdania daja KONTEKST: tlo historyczne, szczegoly, liczby, dlaczego to ciekawe albo co z tego wynika dla mieszkanca. Czytelnik ma sie czegos naprawde dowiedziec, a nie dostac jedno suche zdanie.

TEMAT moze dotyczyc:
- historii, tradycji winiarskiej, przyrody, znanych mieszkancow, geografii, kultury, sportu lub architektury,
- ALBO biezacych wydarzen w miescie (cos co wlasnie sie dzieje lub niedawno sie wydarzylo),
- ALBO wydarzen ZAPLANOWANYCH na najblizsze tygodnie (np. festiwal, wystawa, koncert, impreza miejska, rocznica) - w takim przypadku podaj konkretny termin, zeby mieszkaniec wiedzial, kiedy to bedzie.

CZAS WYDARZEN - PORÓWNAJ Z DZISIEJSZA DATA (${today}):
- Wydarzenie, ktore JUZ SIE ODBYLO, opisuj WYLACZNIE w czasie przeszlym ("odbyl sie", "zwyciezyl", "zgromadzil"). Nigdy nie pisz "odbedzie sie" o czyms, co juz minelo.
- Jako NADCHODZACE przedstawiaj tylko wydarzenia, ktorych termin jest PO dzisiejszej dacie.
- Jesli nie masz pewnosci, czy wydarzenie juz sie odbylo - wybierz inny temat.

WAZNE: zanim odpowiesz, sprawdz fakt w co najmniej jednym wiarygodnym zrodle (np. Wikipedia, oficjalna strona miasta zielona-gora.pl, lokalne portale informacyjne, National Geographic Polska). Nie polegaj wylacznie na swojej wiedzy z treningu - realnie wyszukaj i zweryfikuj.

${avoidText}Wazne zasady:
- Ciekawostka MUSI dotyczyc TYLKO JEDNEGO tematu, miejsca lub wydarzenia. NIE LACZ dwoch roznych, niepowiazanych ze soba faktow w jednym tekscie (np. nie pisz jednoczesnie o planetarium ORAZ o osobnych pomnikach - to dwa rozne tematy, wybierz TYLKO JEDEN).
- W TRESCI CIEKAWOSTKI nie pisz o tym, co zamierzasz zrobic, czego szukasz, ani czego nie udalo Ci sie znalezc (zakazane sa zdania typu "Wyszukam teraz...", "Sprawdzam...", "Nie znalazlem..."). Tresc zaczyna sie od wielkiej litery i od razu od faktu.
- W tresci: bez wstepu, bez powitania, bez cudzyslowow, bez podpisu, bez linkow (link podajesz osobno, patrz nizej).
- ZRODLO JEST OBOWIAZKOWE. Podaj pelny adres URL KONKRETNEJ strony (nie strony glownej serwisu), na ktorej ZNALAZLES ten fakt w wynikach wyszukiwania. Adres musi pochodzic z Twoich wynikow wyszukiwania - nie wolno go zgadywac ani skladac z pamieci. Wybieraj wiarygodne zrodla: oficjalne strony instytucji i miasta (zielona-gora.pl), uczelnie, muzea, znane portale informacyjne (np. lokalne media, gazety), Wikipedia. NIE uzywaj forow, mediow spolecznosciowych, anonimowych blogow ani stron z tresciami generowanymi automatycznie. Strona musi potwierdzac WSZYSTKIE konkretne dane z ciekawostki (daty, liczby, nazwy).
- KONKRETNOSC JEST OBOWIAZKOWA. Ciekawostka musi zawierac co najmniej jeden KONKRETNY szczegol: nazwe wlasna, gatunek, liczbe, date, miejsce albo nazwisko. Czytelnik po przeczytaniu ma WIEDZIEC, o co dokladnie chodzi. ZLE (za ogolne, bezwartosciowe): "Artykul naukowcow dotyczacy populacji zwierzat z Zielonej Gory zostal opublikowany w czasopismie, przyciagajac uwage srodowiska naukowego" - nie wiadomo jakie zwierzeta, co odkryto, ani dlaczego to ciekawe. DOBRZE: "W zielonogorskich parkach zyje okolo 200 nietoperzy z gatunku mroczek pozny, ktore zimuja w piwnicach dawnych kamienic". Unikaj pustych zwrotow typu "przyciagajac uwage", "cieszy sie zainteresowaniem", "jest wartym uwagi miejscem" - one nie niosa zadnej informacji.
- Pisz wylacznie o faktach, ktore znalazles i zweryfikowales w wyszukanych zrodlach. Jesli nie jestes pewien dokladnej daty, liczby czy nazwiska, sformuluj zdanie ostrozniej (np. "prawdopodobnie", "w XIX wieku", "kilkaset") zamiast podawac falszywie precyzyjne dane.
- SZCZEGOLNA OSTROZNOSC PRZY SUPERLATYWACH. Slowa takie jak "pierwszy", "jedyny", "najstarszy", "najwiekszy", "jedno z zaledwie trzech na swiecie" to najczestsze zrodlo falszywych twierdzen - brzmia efektownie, ale rzadko daja sie potwierdzic. Uzyj takiego sformulowania TYLKO wtedy, gdy znalazles je WPROST w wiarygodnym zrodle. Jesli zrodlo tego nie potwierdza jednoznacznie - napisz ostrozniej ("jedna z najstarszych", "jedna z nielicznych") albo opisz fakt bez superlatywu. UWAGA: ta ostroznosc dotyczy WYLACZNIE przesadzonych twierdzen o wyjatkowosci - NIE jest usprawiedliwieniem dla pisania ogolnikow. Nadal masz podac konkretne szczegoly (patrz zasada o konkretnosci powyzej), tylko bez nieuzasadnionych superlatywow.
- Nie wymyslaj faktow, ktorych nie potwierdzily wyniki wyszukiwania.

FORMAT ODPOWIEDZI - na koniec odpowiedzi umiesc dokladnie:
<ciekawostka>
(tresc ciekawostki, 3-4 zdania)
</ciekawostka>
<zrodlo>
(pelny adres URL strony zrodlowej, zaczynajacy sie od https://)
</zrodlo>

Wszystko poza tymi znacznikami zostanie zignorowane.`;

  // Tresc i zrodlo wyciagamy ze znacznikow - wszystko poza nimi (w tym
  // ewentualne zapowiedzi wyszukiwania) jest ignorowane.
  const { fullText, searchUrls } = await callClaude(prompt, true);
  const parsed = parseTaggedFact(fullText);
  if (!parsed) throw new Error('model nie uzyl wymaganych znacznikow <ciekawostka>/<zrodlo>');
  return { ...parsed, searchUrls };
}

// Wyciaga tresc i zrodlo ze znacznikow. Zwraca null, jesli brakuje tresci.
function parseTaggedFact(fullText) {
  const textMatch = fullText.match(/<ciekawostka>([\s\S]*?)<\/ciekawostka>/i);
  if (!textMatch) return null;
  const sourceMatch = fullText.match(/<zrodlo>([\s\S]*?)<\/zrodlo>/i);
  const rawSource = sourceMatch ? sourceMatch[1].trim() : '';
  const urlMatch = rawSource.match(/https?:\/\/[^\s<>"')\]]+/i);
  return {
    text: textMatch[1].replace(/\s+/g, ' ').trim().slice(0, 900),
    sourceUrl: urlMatch ? urlMatch[0].replace(/[.,;:]+$/, '') : null,
  };
}

// Programistyczna kontrola KONKRETNOSCI - niezalezna od tego, czy model
// zastosowal sie do instrukcji. Odrzucamy teksty, ktore nic nie mowia
// czytelnikowi: albo sa zbudowane z pustych zwrotow, albo nie zawieraja
// zadnego konkretu (liczby, daty, nazwy wlasnej).
const EMPTY_PHRASES = [
  'przyciągając uwagę', 'przyciagajac uwage', 'cieszy się zainteresowaniem',
  'cieszy sie zainteresowaniem', 'wartym uwagi', 'warte uwagi',
  'zwraca uwagę', 'zwraca uwage', 'budzi zainteresowanie',
  'jest interesującym', 'jest interesujacym', 'stanowi ciekawy',
  'zasługuje na uwagę', 'zasluguje na uwage',
];

function looksTooVague(text) {
  if (!text) return true;
  const lower = text.toLowerCase();

  // Puste zwroty-wypelniacze
  if (EMPTY_PHRASES.some((p) => lower.includes(p))) return true;

  // Czy jest JAKIKOLWIEK konkret? Liczba (rok, ilosc) albo nazwa wlasna
  // (slowo z wielkiej litery, min. 3 litery). Pierwsze slowo tez liczymy -
  // nazwa wlasna czesto otwiera zdanie ("Falubaz...", "Palmiarnia...").
  // Glowna ochrone przed ogolnikami daje i tak lista pustych zwrotow wyzej.
  const hasNumber = /\d/.test(text);
  const words = text.split(/\s+/);
  const properNouns = words.filter((w) => /^[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]{2,}/.test(w));
  // "Zielona"/"Gorze" wystepuja prawie zawsze - nie licza sie jako konkret.
  const meaningfulProperNouns = properNouns.filter(
    (w) => !/^(Zielon|Gór|Gor|Polsc|Polsk|Lubusk)/.test(w)
  );

  if (!hasNumber && meaningfulProperNouns.length === 0) return true;

  return false;
}

// Programistyczna kontrola powtorzen - nie polegamy wylacznie na tym, ze
// model zastosuje sie do listy "nie powtarzaj". Porownujemy znaczace slowa
// (rzeczowniki/nazwy wlasne - w przyblizeniu: slowa dluzsze niz 5 znakow)
// nowej ciekawostki z kazda z poprzednich. Jesli pokrywaja sie w duzym
// stopniu, uznajemy to za powtorzenie tematu i odrzucamy.
const STOPWORDS = new Set([
  'zielona', 'zielonej', 'gora', 'gorze', 'gory', 'górze', 'góra', 'góry',
  'miasta', 'miescie', 'mieście', 'miasto', 'ktora', 'ktory', 'ktore',
  'która', 'który', 'które', 'ktorym', 'którym', 'jednym', 'jedna', 'jeden',
  'zostal', 'została', 'zostala', 'zostały', 'zostaly', 'najstarszych',
  'wojewodztwie', 'województwie', 'lubuskim', 'polsce', 'roku', 'wieku',
]);

// Uproszczony "rdzen" slowa - przycinamy do pierwszych 6 znakow, zeby
// polska fleksja nie ukrywala powtorzen: "kopula"/"kopula", "planetarium"/
// "planetariow", "nachylenia"/"nachylenie" to dla czlowieka ten sam temat,
// ale dla porownania doslownego - rozne slowa. To celowo prymitywna metoda
// (nie prawdziwy stemmer), ale wystarczajaca do wykrywania powtorzen tematu.
function stem(word) {
  return word.length > 6 ? word.slice(0, 6) : word;
}

function significantWords(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^\wżźćąśęłóńĄŚĘŁÓŃŻŹĆ\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 5 && !STOPWORDS.has(w))
      .map(stem)
  );
}

function isTooSimilarToRecent(candidate, recentFacts) {
  const candidateWords = significantWords(candidate);
  if (candidateWords.size === 0) return false;

  for (const past of recentFacts) {
    const pastWords = significantWords(past);
    if (pastWords.size === 0) continue;
    let shared = 0;
    for (const w of candidateWords) {
      if (pastWords.has(w)) shared++;
    }
    // Ponad 40% znaczacych slow wspolnych z ktoramkolwiek poprzednia
    // ciekawostka = najprawdopodobniej ten sam temat.
    const overlap = shared / Math.min(candidateWords.size, pastWords.size);
    if (overlap > 0.4) {
      return past;
    }
  }
  return null;
}

// KROK 2: niezalezna weryfikacja tego, co napisal krok 1 - sprawdza
// poprawnosc jezykowa PO POLSKU oraz wiarygodnosc faktu (z mozliwoscia
// ponownego wyszukania), zanim tekst trafi do publikacji w appce.
async function reviewFact(draft) {
  const today = new Date().toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw' });
  const prompt = `Dzisiaj jest ${today}. Otrzymales nizej ciekawostke o Zielonej Gorze, napisana automatycznie i przeznaczona do publikacji w aplikacji mobilnej, razem z podanym zrodlem. Twoim zadaniem jest jej NIEZALEZNA weryfikacja przed publikacja - nie ufaj autorowi, sprawdz wszystko sam.

TEKST DO SPRAWDZENIA:
"${draft.text}"

PODANE ZRODLO:
${draft.sourceUrl || '(brak zrodla)'}

Sprawdz OSIEM rzeczy:
1. POPRAWNOSC JEZYKOWA: czy tekst jest napisany poprawna polszczyzna, bez bledow gramatycznych, ortograficznych czy dziwnych/nieistniejacych slow.
2. WIARYGODNOSC FAKTU: jesli to potrzebne, wyszukaj w internecie i zweryfikuj, czy opisany fakt jest prawdziwy i mozliwy do potwierdzenia w wiarygodnych zrodlach.
3. JEDEN TEMAT: czy tekst dotyczy TYLKO JEDNEGO tematu/miejsca/wydarzenia. Jesli tekst laczy dwa rozne, niepowiazane fakty - to blad: zostaw TYLKO PIERWSZY, glowny temat.
4. BRAK NARRACJI WLASNEGO PROCESU: czy tekst NIE zaczyna sie (ani nie zawiera nigdzie) zdaniem opisujacym co model "zamierza zrobic" albo "wlasnie robi" (np. "Wyszukam teraz...", "Sprawdzam...", "Poszukajmy..."). To jest BLAD tego samego kalibru co blad jezykowy - taka narracja NIE JEST czescia ciekawostki i musi zostac usunieta, zostaw wylacznie sama tresc faktu.
5. SUPERLATYWY - SPRAWDZ JE OSOBNO I OBOWIAZKOWO. Znajdz w tekscie kazde twierdzenie typu "pierwszy", "jedyny", "najstarszy", "najwiekszy", "jedno z zaledwie X na swiecie", "jedyny w Polsce" itp. Dla KAZDEGO z nich WYSZUKAJ W INTERNECIE potwierdzenie. Jesli zrodlo nie potwierdza takiego twierdzenia WPROST - zlagodz je w wersji finalnej ("jedna z najstarszych", "jedna z nielicznych") albo usun superlatyw i zostaw sam fakt. Nie zostawiaj efektownego, ale niepotwierdzonego twierdzenia - to najczestsze zrodlo bledow merytorycznych w tego typu tekstach.
6. KONKRETNOSC - CZY CZYTELNIK CZEGOKOLWIEK SIE DOWIADUJE. Zadaj sobie pytanie: czy po przeczytaniu tego tekstu wiem, o co DOKLADNIE chodzi? Tekst MUSI zawierac konkretny szczegol: nazwe wlasna, gatunek, liczbe, date, miejsce albo nazwisko. Jesli tekst jest ogolnikowy i nic nie mowi (np. "Artykul naukowcow dotyczacy populacji zwierzat z Zielonej Gory zostal opublikowany w czasopismie, przyciagajac uwage srodowiska naukowego" - nie wiadomo jakie zwierzeta ani co odkryto), to JEST TO BLAD. W takim przypadku WYSZUKAJ W INTERNECIE brakujace szczegoly i w znacznikach umiesc wersje KONKRETNA. Jesli nie da sie znalezc szczegolow - napisz w znacznikach CALKIEM INNA, konkretna ciekawostke o Zielonej Gorze. Usun tez puste zwroty typu "przyciagajac uwage", "cieszy sie zainteresowaniem" - one nie niosa informacji. Tekst powinien miec 3-4 zdania z kontekstem - jesli jest za krotki (jedno suche zdanie), dopisz na podstawie zrodel tlo i szczegoly.
7. CZAS WZGLEDEM DZISIEJSZEJ DATY (${today}). Jesli tekst dotyczy wydarzenia z konkretna data - sprawdz, czy ta data jest PRZED czy PO dzisiejszym dniu. Wydarzenie, ktore juz sie odbylo, NIE MOZE byc opisane w czasie przyszlym ("odbedzie sie", "rozpocznie sie"). Jesli tak jest - przepisz tekst w czasie przeszlym, najlepiej z wynikiem lub przebiegiem wydarzenia (wyszukaj go). Jesli nie da sie ustalic, czy wydarzenie juz sie odbylo - napisz inna ciekawostke.
8. ZRODLO - SPRAWDZ JE NIEZALEZNIE. Wyszukaj w internecie podany adres albo temat i ustal: (a) czy strona istnieje i pochodzi z wiarygodnego serwisu (oficjalna instytucja, uczelnia, muzeum, znane medium, Wikipedia - NIE forum, social media, anonimowy blog, farma tresci), (b) czy ta konkretna strona potwierdza WSZYSTKIE dane z tekstu (daty, liczby, nazwy). Potwierdz fakt w CO NAJMNIEJ DWOCH niezaleznych zrodlach. Jesli podane zrodlo jest niewiarygodne albo nie potwierdza faktu - znajdz lepsze zrodlo i podaj je. Jesli faktu nie da sie potwierdzic w dwoch niezaleznych zrodlach - usun niepotwierdzone dane albo napisz inna, dobrze udokumentowana ciekawostke. Adres zrodla musi pochodzic z Twoich wynikow wyszukiwania - nie zgaduj adresow.

Mozesz swobodnie opisac swoj tok rozumowania, wyniki wyszukiwania i wnioski - to nie ma znaczenia dla formatu odpowiedzi.

WAZNE - FORMAT ODPOWIEDZI: niezaleznie od tego, co napiszesz jako analize, na sam koniec swojej odpowiedzi MUSISZ umiescic finalny, gotowy do publikacji tekst ciekawostki dokladnie w tym formacie, z dokladnie takimi znacznikami:

<ciekawostka>
(tutaj finalny tekst ciekawostki - 3-4 zdania, zaczynajacy sie wielka litera, bez cudzyslowow, bez wyjasnien, bez linkow)
</ciekawostka>
<zrodlo>
(pelny adres URL zweryfikowanego zrodla, zaczynajacy sie od https://)
</zrodlo>

Tylko zawartosc miedzy znacznikami zostanie opublikowana - Twoja analiza poza znacznikami zostanie calkowicie zignorowana. Oba znaczniki sa OBOWIAZKOWE w kazdej odpowiedzi.

Jesli oryginalny tekst byl juz poprawny i wiarygodny - wstaw go w znacznikach bez zmian. Jesli mial bledy jezykowe - popraw je w wersji w znacznikach. Jesli laczyl dwa tematy - w znacznikach zostaw tylko pierwszy. Jesli fakt byl niepewny - w znacznikach umiesc ostrozniejsze sformulowanie lub inny, pewny fakt. Jesli zawieral superlatyw, ktorego nie udalo sie potwierdzic w zrodlach - w znacznikach umiesc wersje zlagodzona lub bez tego superlatywu.`;

  // Tu przeszukujemy PELNY tekst (wszystkie bloki), bo tresc wyznaczaja
  // jednoznaczne znaczniki <ciekawostka> - nie ma ryzyka, ze skleimy
  // zapowiedz wyszukiwania z trescia, a znaczniki moga trafic do innego
  // bloku niz ostatni.
  const { fullText, searchUrls } = await callClaude(prompt, true);
  const parsed = parseTaggedFact(fullText);
  if (!parsed) {
    console.warn('[ciekawostka] recenzent nie uzyl wymaganych znacznikow - odrzucam odpowiedz');
    return null;
  }
  return { ...parsed, searchUrls };
}

// Prosty, niezalezny od modelu filtr bezpieczenstwa: jesli odpowiedz modelu
// "recenzenta" mimo instrukcji zawiera slady opisywania wlasnego procesu
// myslowego (zamiast samej gotowej ciekawostki), odrzucamy ja i uzywamy
// oryginalnego szkicu z kroku 1. Lepiej opublikowac niezrecenzowany, ale
// czysty tekst, niz przypadkowo pokazac uzytkownikom "tok myslenia" AI.
function looksLikeMetaCommentary(text) {
  if (!text) return true;
  if (text.length > 950) return true;
  if (text.includes('**')) return true;
  const suspiciousPhrases = [
    'zanim', 'muszę sprawdzić', 'musze sprawdzic', 'po analizie', 'po dokładnej analizie',
    'po dokladnej analizie', 'sprawdzam', 'sprawdziłem', 'sprawdzilem', 'mogę potwierdzić',
    'moge potwierdzic', 'weryfikacja', 'okazuje się', 'okazuje sie', 'błędy językowo',
    'bledy jezykowo', 'poprawiona wersja', 'oto poprawiona', 'tekst zawiera',
    // Warianty "narracji zamiaru" - model opisuje CO ZAMIERZA zrobic zamiast
    // od razu podac gotowa tresc (np. "Wyszukam teraz ciekawostke o...").
    // Dokladnie taki wyciek trafil kiedys do publikacji, mimo istniejacego
    // filtra - stad ta rozszerzona lista.
    'wyszukam', 'wyszukuję', 'wyszukuje', 'poszukam', 'poszukuję', 'poszukuje',
    'znajdę teraz', 'znajde teraz', 'sprawdzę teraz',
    'sprawdze teraz', 'teraz sprawdzę', 'teraz sprawdze', 'przeszukam',
    'poszukajmy', 'sprawdźmy', 'sprawdzmy', 'pozwól, że', 'pozwol, ze',
    'szukam informacji', 'zbieram informacje', 'analizuję', 'analizuje',
    // Warianty "opisu wlasnej porazki" - model, zamiast dostarczyc tresc,
    // opisuje ze nie ma czego opublikowac (dokladnie taki przypadek
    // przeciekl mimo powyzszych fraz - "Tekst nie zawiera mozliwej do
    // publikacji tresci - sklada sie wylacznie z narracji procesu...").
    'nie zawiera', 'brak faktu', 'brak konkretnego', 'nie udało', 'nie udalo',
    'nie jest możliwe', 'nie jest mozliwe', 'nie znalazłem', 'nie znalazlem',
    'nie znalazłam', 'nie znalazlam', 'nie mogę', 'nie moge', 'nie potrafię',
    'nie potrafie', 'przepraszam', 'jako model', 'jako asystent', 'narracji',
    'do opublikowania', 'do publikacji treści', 'do publikacji tresci',
  ];
  const lower = text.toLowerCase();
  if (suspiciousPhrases.some((p) => lower.includes(p))) return true;
  // Zbyt krotki tekst (po ewentualnym obcieciu) to tez sygnal ze cos jest
  // nie tak - prawdziwa ciekawostka to co najmniej jedno pelne zdanie.
  if (text.trim().length < 30) return true;
  return false;
}

// Automatyczne obciecie zdania-narracji NA POCZATKU tekstu (np. "Wyszukam
// teraz ciekawostke o Zielonej Gorze. Wieza Glodowa...") - dziala nawet
// gdy zarowno krok generowania, jak i recenzji, przepuszcza taki wyciek.
// To ostatnia, programistyczna linia obrony, niezalezna od tego czy model
// zastosowal sie do instrukcji w promptach.
function stripLeadingSuspiciousSentence(text) {
  if (!text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  while (sentences.length > 1 && looksLikeMetaCommentary(sentences[0])) {
    sentences.shift();
  }
  return sentences.join(' ').trim();
}

// ===================== WERYFIKACJA ZRODLA (w kodzie) =====================
// Model moze zapewniac, ze sprawdzil zrodlo - ale tego nie zakladamy. Kazdy
// link przechodzi przez cztery niezalezne sprawdzenia w naszym kodzie:
//  1. czy to poprawny, konkretny adres (nie strona glowna, nie social media),
//  2. czy wyszukiwarka FAKTYCZNIE zwrocila ten adres (a nie model go zmyslil),
//  3. czy strona realnie istnieje i odpowiada (pobieramy ja),
//  4. czy tresc strony zawiera kluczowe slowa i wszystkie lata z ciekawostki.
const BLOCKED_SOURCE_HOSTS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'pinterest.com', 'reddit.com', 'wykop.pl', 'threads.net', 'linkedin.com',
];

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return null;
  }
}

function checkSourceUrlShape(sourceUrl) {
  if (!sourceUrl) throw new Error('brak zrodla');
  let url;
  try { url = new URL(sourceUrl); } catch { throw new Error(`niepoprawny adres zrodla: ${sourceUrl}`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('zrodlo musi byc adresem http(s)');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (BLOCKED_SOURCE_HOSTS.some((b) => host === b || host.endsWith(`.${b}`))) {
    throw new Error(`zrodlo z serwisu spolecznosciowego nie jest akceptowane: ${host}`);
  }
  if (url.pathname.replace(/\/+$/, '') === '') {
    throw new Error('zrodlo wskazuje strone glowna serwisu zamiast konkretnego artykulu');
  }
}

function checkSourceWasFound(sourceUrl, knownUrls) {
  const target = normalizeUrl(sourceUrl);
  const known = new Set(knownUrls.map(normalizeUrl).filter(Boolean));
  if (!known.has(target)) {
    throw new Error(`zrodlo nie pochodzi z wynikow wyszukiwania (mozliwie zmyslone): ${sourceUrl}`);
  }
}

async function checkSourceContent(sourceUrl, factText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let res;
  try {
    res = await fetch(sourceUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UtrudnieniaZG-weryfikacja/1.0; +https://utrudnienia-zg.pl)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    throw new Error(`zrodlo niedostepne (${err.name === 'AbortError' ? 'przekroczony czas' : err.message}): ${sourceUrl}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`zrodlo zwrocilo blad HTTP ${res.status}: ${sourceUrl}`);

  const html = (await res.text()).slice(0, 2000000);
  const page = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  // Kluczowe slowa ciekawostki musza wystepowac na stronie.
  const stems = [...significantWords(factText)];
  const matched = stems.filter((st) => page.includes(st));
  const required = Math.min(3, stems.length);
  if (matched.length < required) {
    throw new Error(`tresc zrodla nie pasuje do ciekawostki (wspolne slowa: ${matched.length}/${stems.length}): ${sourceUrl}`);
  }

  // Kazdy rok podany w ciekawostce musi wystepowac na stronie - to lapie
  // najczestszy rodzaj zmyslonego szczegolu (bledna data).
  const years = [...new Set(factText.match(/\b(1[0-9]{3}|20[0-9]{2})\b/g) || [])];
  const missingYears = years.filter((y) => !page.includes(y));
  if (missingYears.length) {
    throw new Error(`zrodlo nie potwierdza dat z ciekawostki (brak: ${missingYears.join(', ')}): ${sourceUrl}`);
  }
}

// ===================== ZGODNOSC CZASU Z DZISIEJSZA DATA =====================
// Lapie bledy typu "final odbedzie sie 18 lipca", gdy dzis jest wrzesien.
const MONTH_INDEX = {
  stycznia: 0, lutego: 1, marca: 2, kwietnia: 3, maja: 4, czerwca: 5, lipca: 6,
  sierpnia: 7, 'września': 8, wrzesnia: 8, 'października': 9, pazdziernika: 9,
  listopada: 10, grudnia: 11,
};
const FUTURE_VERBS = /(odbędzie|odbedzie|odbędą|odbeda|rozpocznie|rozpoczną|rozpoczna|zostanie otwart|zostaną otwart|potrwa|wystąpi|wystapi|zagra|zagrają|zagraja|będzie można|bedzie mozna|zaplanowan|nadchodząc|nadchodzac)/i;

function checkTemporalConsistency(text) {
  if (!FUTURE_VERBS.test(text)) return;
  const warsawNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  const today = new Date(warsawNow.getFullYear(), warsawNow.getMonth(), warsawNow.getDate());
  const re = /(\d{1,2})\s+(stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|wrzesnia|października|pazdziernika|listopada|grudnia)(?:\s+(\d{4}))?/giu;
  const datesThisYear = [];
  let m;
  while ((m = re.exec(text))) {
    const year = m[3] ? Number(m[3]) : today.getFullYear();
    if (year !== today.getFullYear()) continue; // daty historyczne pomijamy
    datesThisYear.push(new Date(year, MONTH_INDEX[m[2].toLowerCase()], Number(m[1])));
  }
  if (!datesThisYear.length) return;
  const anyUpcoming = datesThisYear.some((d) => d >= today);
  if (!anyUpcoming) {
    throw new Error('tekst zapowiada w czasie przyszlym wydarzenie, ktore juz sie odbylo');
  }
}

// Pojedyncza proba wygenerowania ciekawostki (generowanie + obowiazkowa
// recenzja + wszystkie kontrole w kodzie). Zwraca { content, sourceUrl }
// albo rzuca blad, jesli wynik nie nadaje sie do publikacji.
async function attemptGenerateFact(avoidList) {
  const draft = await generateFact(avoidList);

  // Recenzja jest OBOWIAZKOWA - to ona niezaleznie sprawdza fakt i zrodlo.
  // Jesli sie nie powiedzie, nie publikujemy niesprawdzonego szkicu -
  // cala proba jest odrzucana i nastepuje kolejna.
  const reviewed = await reviewFact(draft);
  if (!reviewed) throw new Error('recenzja nie zwrocila wyniku w wymaganym formacie');

  let content = reviewed.text;
  const sourceUrl = reviewed.sourceUrl || draft.sourceUrl;

  // Linia obrony przed wyciekiem procesu modelu do tresci.
  const stripped = stripLeadingSuspiciousSentence(content);
  if (stripped !== content) {
    console.warn('[ciekawostka] obcieto podejrzane zdanie na poczatku tekstu przed publikacja');
  }
  content = stripped;

  if (looksLikeMetaCommentary(content)) {
    throw new Error('tekst wyglada na wyciek procesu modelu');
  }
  // Mala litera na poczatku = najpewniej urwany poczatek zdania.
  if (/^[a-ząćęłńóśźż]/.test(content)) {
    throw new Error('tekst zaczyna sie mala litera - prawdopodobnie urwany');
  }
  if (looksTooVague(content)) {
    throw new Error('tekst jest zbyt ogolnikowy - brak konkretow albo puste zwroty');
  }
  if (content.length < 150) {
    throw new Error(`tekst za krotki (${content.length} znakow) - brak kontekstu`);
  }
  checkTemporalConsistency(content);

  const duplicateOf = isTooSimilarToRecent(content, avoidList);
  if (duplicateOf) {
    throw new Error(`temat powtarza sie z wczesniejsza ciekawostka: "${duplicateOf.slice(0, 80)}..."`);
  }

  // Weryfikacja zrodla - na koncu, bo wymaga pobrania strony.
  checkSourceUrlShape(sourceUrl);
  checkSourceWasFound(sourceUrl, [...(draft.searchUrls || []), ...(reviewed.searchUrls || [])]);
  await checkSourceContent(sourceUrl, content);

  return { content, sourceUrl };
}

// Glowna funkcja - probuje kilka razy, zanim sie podda. Dzieki temu
// pojedyncza nieudana proba (wyciek procesu modelu albo powtorzony temat)
// nie oznacza od razu braku ciekawostki na dany dzien - kolejne podejscie
// zwykle konczy sie sukcesem.
const MAX_ATTEMPTS = 4;
async function generateFactViaClaude(avoidList) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const fact = await attemptGenerateFact(avoidList);
      if (attempt > 1) {
        console.log(`[ciekawostka] sukces w probie ${attempt}/${MAX_ATTEMPTS}`);
      }
      return fact;
    } catch (err) {
      lastError = err;
      console.warn(`[ciekawostka] proba ${attempt}/${MAX_ATTEMPTS} nieudana: ${err.message}`);
    }
  }
  throw new Error(`Nie udalo sie wygenerowac poprawnej ciekawostki po ${MAX_ATTEMPTS} probach. Ostatni powod: ${lastError ? lastError.message : 'nieznany'}`);
}

// ============ GENEROWANIE W TLE, BEZ KAZANIA UZYTKOWNIKOWI CZEKAC ============
// Pelna weryfikacja (2 zapytania z wyszukiwaniem + pobranie strony zrodlowej,
// do 4 prob) trwa nawet ponad minute - o wiele dluzej niz appka czeka na
// odpowiedz. Dlatego:
//  - generowanie uruchamiamy najwyzej RAZ naraz (inFlight), zeby 10 osob
//    wchodzacych rano nie uruchomilo 10 rownoleglych, platnych generowan,
//  - uzytkownik nigdy na nie nie czeka: dostaje od reki ostatnia dostepna
//    ciekawostke, a nowa podmienia sie przy kolejnym wejsciu,
//  - po nieudanej probie robimy przerwe, zeby nie ponawiac jej przy kazdym
//    wejsciu do appki.
let inFlightGeneration = null;
let lastFailureAt = 0;
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

function startGenerationInBackground() {
  if (inFlightGeneration) return inFlightGeneration;

  const date = todayDate();
  inFlightGeneration = (async () => {
    const started = Date.now();
    const recentFacts = getRecentFacts(60);
    const { content, sourceUrl } = await generateFactViaClaude(recentFacts);
    saveDailyFact(date, content, sourceUrl);
    console.log(`[ciekawostka] wygenerowano ciekawostke na ${date} w ${Math.round((Date.now() - started) / 1000)}s`);
    return { date, content, source_url: sourceUrl, generated: true };
  })();

  inFlightGeneration
    .catch((err) => {
      lastFailureAt = Date.now();
      console.error('[ciekawostka] generowanie nieudane:', err.message);
    })
    .finally(() => { inFlightGeneration = null; });

  return inFlightGeneration;
}

// wait=true (cron, start serwera, reczna regeneracja): czekamy na wynik.
// wait=false (zwykle wejscie uzytkownika do appki): nie czekamy.
async function getTodayFact({ wait = false } = {}) {
  const date = todayDate();
  const cached = getDailyFact(date);
  if (cached) return { date, content: cached.content, source_url: cached.source_url || null, generated: false };

  const inCooldown = !wait && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS;
  if (!inCooldown) {
    const generation = startGenerationInBackground();
    if (wait) return generation;
  }

  // Nie kazemy uzytkownikowi czekac - pokazujemy ostatnia dostepna tresc.
  const previous = getLatestFact();
  if (previous) {
    return {
      date: previous.fact_date,
      content: previous.content,
      source_url: previous.source_url || null,
      generated: false,
    };
  }

  // Baza jest pusta (pierwsze uruchomienie) - nie ma czego pokazac,
  // wiec jednak czekamy na wynik.
  return startGenerationInBackground();
}

// Usuwa dzisiejsza, juz zapisana ciekawostke i generuje nowa od zera -
// przydatne, jesli dzisiejsza wersja okaze sie wadliwa (np. blad jezykowy,
// ktory przeszedl przez weryfikacje) i chcesz to poprawic od reki, bez
// czekania do jutra.
async function forceRegenerateTodayFact() {
  const date = todayDate();
  lastFailureAt = 0; // reczna regeneracja zawsze probuje od nowa
  deleteDailyFact(date);
  const recentFacts = getRecentFacts(60);
  const { content, sourceUrl } = await generateFactViaClaude(recentFacts);
  saveDailyFact(date, content, sourceUrl);
  return { date, content, source_url: sourceUrl, generated: true };
}

module.exports = { getTodayFact, forceRegenerateTodayFact };
