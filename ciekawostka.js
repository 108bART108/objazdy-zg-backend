const { getDailyFact, deleteDailyFact, saveDailyFact, getRecentFacts } = require('./db');

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
    max_tokens: 700,
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

  if (!lastBlock) throw new Error('Pusta odpowiedz z Anthropic API');
  return { lastBlock, fullText };
}

// KROK 1: generowanie ciekawostki z uzyciem wyszukiwania w internecie.
async function generateFact(avoidList) {
  const avoidText = avoidList.length
    ? `ZAKAZ POWTORZEN - ponizej lista tematow juz wykorzystanych w ostatnich tygodniach. Wybierz temat CALKOWICIE INNY. Nie wystarczy przeformulowac zdania czy zmienic szczegolu - chodzi o INNY OBIEKT, INNE WYDARZENIE, INNA OSOBE lub INNE MIEJSCE:\n${avoidList.map((f) => `- ${f}`).join('\n')}\n\n`
    : '';

  const today = new Date().toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw' });

  const prompt = `Dzisiaj jest ${today}. Wyszukaj w internecie i podaj jedna, krotka (maksymalnie 2 zdania) ciekawostke o miescie Zielona Gora w wojewodztwie lubuskim w Polsce, lub jego najblizszych okolicach.

TEMAT moze dotyczyc:
- historii, tradycji winiarskiej, przyrody, znanych mieszkancow, geografii, kultury, sportu lub architektury,
- ALBO biezacych wydarzen w miescie (cos co wlasnie sie dzieje lub niedawno sie wydarzylo),
- ALBO wydarzen ZAPLANOWANYCH na najblizsze tygodnie (np. festiwal, wystawa, koncert, impreza miejska, rocznica) - w takim przypadku podaj konkretny termin, zeby mieszkaniec wiedzial, kiedy to bedzie.

WAZNE: zanim odpowiesz, sprawdz fakt w co najmniej jednym wiarygodnym zrodle (np. Wikipedia, oficjalna strona miasta zielona-gora.pl, lokalne portale informacyjne, National Geographic Polska). Nie polegaj wylacznie na swojej wiedzy z treningu - realnie wyszukaj i zweryfikuj.

${avoidText}Wazne zasady:
- Ciekawostka MUSI dotyczyc TYLKO JEDNEGO tematu, miejsca lub wydarzenia. NIE LACZ dwoch roznych, niepowiazanych ze soba faktow w jednym tekscie (np. nie pisz jednoczesnie o planetarium ORAZ o osobnych pomnikach - to dwa rozne tematy, wybierz TYLKO JEDEN).
- ODPOWIEDZ MA ZAWIERAC WYLACZNIE GOTOWA TRESC CIEKAWOSTKI. Absolutnie NIE pisz o tym, co zamierzasz zrobic, czego szukasz, ani czego nie udalo Ci sie znalezc (zakazane sa zdania typu "Wyszukam teraz...", "Sprawdzam...", "Nie znalazlem..."). Pierwsze slowo Twojej odpowiedzi ma byc juz pierwszym slowem ciekawostki.
- Bez wstepu, bez powitania, bez cudzyslowow, bez podpisu, bez linkow.
- Pisz wylacznie o faktach, ktore znalazles i zweryfikowales w wyszukanych zrodlach. Jesli nie jestes pewien dokladnej daty, liczby czy nazwiska, sformuluj zdanie ostrozniej (np. "prawdopodobnie", "w XIX wieku", "kilkaset") zamiast podawac falszywie precyzyjne dane.
- SZCZEGOLNA OSTROZNOSC PRZY SUPERLATYWACH. Slowa takie jak "pierwszy", "jedyny", "najstarszy", "najwiekszy", "jedno z zaledwie trzech na swiecie" to najczestsze zrodlo falszywych twierdzen - brzmia efektownie, ale rzadko daja sie potwierdzic. Uzyj takiego sformulowania TYLKO wtedy, gdy znalazles je WPROST w wiarygodnym zrodle. Jesli zrodlo tego nie potwierdza jednoznacznie - napisz ostrozniej ("jedna z najstarszych", "jedna z nielicznych") albo opisz fakt bez superlatywu. Prawdziwa, skromniejsza informacja jest lepsza niz efektowna, ale niepewna.
- Nie wymyslaj faktow, ktorych nie potwierdzily wyniki wyszukiwania - lepiej podac bardziej ogolna, ale prawdziwa informacje.`;

  // Bierzemy TYLKO ostatni blok tekstowy - wczesniejsze bloki to
  // zapowiedzi wyszukiwania ("Wyszukuje informacje o..."), ktore nie sa
  // czescia odpowiedzi.
  const { lastBlock } = await callClaude(prompt, true);
  return lastBlock.slice(0, 500);
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
async function reviewFact(draftText) {
  const prompt = `Otrzymales nizej ciekawostke o Zielonej Gorze, napisana automatycznie i przeznaczona do publikacji w aplikacji mobilnej. Twoim zadaniem jest jej weryfikacja przed publikacja.

TEKST DO SPRAWDZENIA:
"${draftText}"

Sprawdz PIEC rzeczy:
1. POPRAWNOSC JEZYKOWA: czy tekst jest napisany poprawna polszczyzna, bez bledow gramatycznych, ortograficznych czy dziwnych/nieistniejacych slow.
2. WIARYGODNOSC FAKTU: jesli to potrzebne, wyszukaj w internecie i zweryfikuj, czy opisany fakt jest prawdziwy i mozliwy do potwierdzenia w wiarygodnych zrodlach.
3. JEDEN TEMAT: czy tekst dotyczy TYLKO JEDNEGO tematu/miejsca/wydarzenia. Jesli tekst laczy dwa rozne, niepowiazane fakty - to blad: zostaw TYLKO PIERWSZY, glowny temat.
4. BRAK NARRACJI WLASNEGO PROCESU: czy tekst NIE zaczyna sie (ani nie zawiera nigdzie) zdaniem opisujacym co model "zamierza zrobic" albo "wlasnie robi" (np. "Wyszukam teraz...", "Sprawdzam...", "Poszukajmy..."). To jest BLAD tego samego kalibru co blad jezykowy - taka narracja NIE JEST czescia ciekawostki i musi zostac usunieta, zostaw wylacznie sama tresc faktu.
5. SUPERLATYWY - SPRAWDZ JE OSOBNO I OBOWIAZKOWO. Znajdz w tekscie kazde twierdzenie typu "pierwszy", "jedyny", "najstarszy", "najwiekszy", "jedno z zaledwie X na swiecie", "jedyny w Polsce" itp. Dla KAZDEGO z nich WYSZUKAJ W INTERNECIE potwierdzenie. Jesli zrodlo nie potwierdza takiego twierdzenia WPROST - zlagodz je w wersji finalnej ("jedna z najstarszych", "jedna z nielicznych") albo usun superlatyw i zostaw sam fakt. Nie zostawiaj efektownego, ale niepotwierdzonego twierdzenia - to najczestsze zrodlo bledow merytorycznych w tego typu tekstach.

Mozesz swobodnie opisac swoj tok rozumowania, wyniki wyszukiwania i wnioski - to nie ma znaczenia dla formatu odpowiedzi.

WAZNE - FORMAT ODPOWIEDZI: niezaleznie od tego, co napiszesz jako analize, na sam koniec swojej odpowiedzi MUSISZ umiescic finalny, gotowy do publikacji tekst ciekawostki dokladnie w tym formacie, z dokladnie takimi znacznikami:

<ciekawostka>
(tutaj finalny tekst ciekawostki - jedno lub dwa zdania, bez cudzyslowow, bez wyjasnien)
</ciekawostka>

Tylko zawartosc miedzy znacznikami <ciekawostka> i </ciekawostka> zostanie opublikowana - Twoja analiza poza znacznikami zostanie calkowicie zignorowana. Znaczniki i ich zawartosc sa OBOWIAZKOWE w kazdej odpowiedzi.

Jesli oryginalny tekst byl juz poprawny i wiarygodny - wstaw go w znacznikach bez zmian. Jesli mial bledy jezykowe - popraw je w wersji w znacznikach. Jesli laczyl dwa tematy - w znacznikach zostaw tylko pierwszy. Jesli fakt byl niepewny - w znacznikach umiesc ostrozniejsze sformulowanie lub inny, pewny fakt. Jesli zawieral superlatyw, ktorego nie udalo sie potwierdzic w zrodlach - w znacznikach umiesc wersje zlagodzona lub bez tego superlatywu.`;

  // Tu przeszukujemy PELNY tekst (wszystkie bloki), bo tresc wyznaczaja
  // jednoznaczne znaczniki <ciekawostka> - nie ma ryzyka, ze skleimy
  // zapowiedz wyszukiwania z trescia, a znaczniki moga trafic do innego
  // bloku niz ostatni.
  const { fullText } = await callClaude(prompt, true);
  const match = fullText.match(/<ciekawostka>([\s\S]*?)<\/ciekawostka>/i);
  if (!match) {
    console.warn('[ciekawostka] recenzent nie uzyl wymaganych znacznikow - odrzucam odpowiedz');
    return null;
  }
  return match[1].trim().slice(0, 500);
}

// Prosty, niezalezny od modelu filtr bezpieczenstwa: jesli odpowiedz modelu
// "recenzenta" mimo instrukcji zawiera slady opisywania wlasnego procesu
// myslowego (zamiast samej gotowej ciekawostki), odrzucamy ja i uzywamy
// oryginalnego szkicu z kroku 1. Lepiej opublikowac niezrecenzowany, ale
// czysty tekst, niz przypadkowo pokazac uzytkownikom "tok myslenia" AI.
function looksLikeMetaCommentary(text) {
  if (!text) return true;
  if (text.length > 550) return true;
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

// Pojedyncza proba wygenerowania ciekawostki (generowanie + recenzja +
// wszystkie filtry). Zwraca gotowy tekst albo rzuca blad, jesli wynik nie
// nadaje sie do publikacji.
async function attemptGenerateFact(avoidList) {
  const draft = await generateFact(avoidList);
  let result;
  try {
    const reviewed = await reviewFact(draft);
    // reviewed === null: recenzent nie uzyl wymaganych znacznikow <ciekawostka>
    // - odrzucamy cala odpowiedz i uzywamy czystego szkicu z kroku 1.
    if (!reviewed) {
      result = draft;
    } else if (looksLikeMetaCommentary(reviewed)) {
      // Dodatkowa siatka bezpieczenstwa: nawet wewnatrz znacznikow model
      // teoretycznie mogl wpisac fragment swojej analizy - sprawdzamy to
      // heurystycznie jako druga linia obrony.
      console.warn('[ciekawostka] tresc w znacznikach wygladala podejrzanie - uzywam czystego szkicu z kroku 1');
      result = draft;
    } else {
      result = reviewed;
    }
  } catch (err) {
    // Jesli krok weryfikacji z jakiegos powodu zawiedzie (np. chwilowy
    // blad API), lepiej opublikowac niezweryfikowany, ale sensowny
    // szkic niz nic nie pokazac uzytkownikom.
    console.warn('[ciekawostka] blad weryfikacji, uzywam wersji roboczej:', err.message);
    result = draft;
  }

  // Trzecia, programistyczna linia obrony - niezaleznie od tego, KTORA
  // sciezka powyzej dala wynik, na koniec zawsze probujemy obciac
  // ewentualne zdanie-narracje na poczatku, zanim tekst trafi do bazy.
  const stripped = stripLeadingSuspiciousSentence(result);
  if (stripped !== result) {
    console.warn('[ciekawostka] obcieto podejrzane zdanie na poczatku tekstu przed publikacja');
  }

  if (looksLikeMetaCommentary(stripped)) {
    throw new Error('tekst wyglada na wyciek procesu modelu');
  }

  // Programistyczna kontrola powtorzen - niezalezna od tego, czy model
  // zastosowal sie do listy "nie powtarzaj" w promptcie.
  const duplicateOf = isTooSimilarToRecent(stripped, avoidList);
  if (duplicateOf) {
    throw new Error(`temat powtarza sie z wczesniejsza ciekawostka: "${duplicateOf.slice(0, 80)}..."`);
  }

  return stripped;
}

// Glowna funkcja - probuje kilka razy, zanim sie podda. Dzieki temu
// pojedyncza nieudana proba (wyciek procesu modelu albo powtorzony temat)
// nie oznacza od razu braku ciekawostki na dany dzien - kolejne podejscie
// zwykle konczy sie sukcesem.
const MAX_ATTEMPTS = 3;
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

async function getTodayFact() {
  const date = todayDate();
  const cached = getDailyFact(date);
  if (cached) return { date, content: cached.content, generated: false };

  const recentFacts = getRecentFacts(60);
  const content = await generateFactViaClaude(recentFacts);
  saveDailyFact(date, content);
  return { date, content, generated: true };
}

// Usuwa dzisiejsza, juz zapisana ciekawostke i generuje nowa od zera -
// przydatne, jesli dzisiejsza wersja okaze sie wadliwa (np. blad jezykowy,
// ktory przeszedl przez weryfikacje) i chcesz to poprawic od reki, bez
// czekania do jutra.
async function forceRegenerateTodayFact() {
  const date = todayDate();
  deleteDailyFact(date);
  const recentFacts = getRecentFacts(60);
  const content = await generateFactViaClaude(recentFacts);
  saveDailyFact(date, content);
  return { date, content, generated: true };
}

module.exports = { getTodayFact, forceRegenerateTodayFact };
