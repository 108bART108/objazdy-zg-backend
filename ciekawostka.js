const { getDailyFact, deleteDailyFact, saveDailyFact, getRecentFacts } = require('./db');
const { checkSpelling } = require('./polishSpell');

// Model do zadan jezykowych. Haiku generowalo poprawne fakty, ale myliło sie
// w odmianie ("miasto srokow" zamiast "miasto srok", "Niemczyko-polskie").
// Przy jednej ciekawostce dziennie roznica w koszcie jest groszowa, a jakosc
// polszczyzny wyraznie lepsza. MODEL_FALLBACK chroni przed sytuacja, w ktorej
// konto nie ma dostepu do mocniejszego modelu - wtedy dzialamy jak dotad.
const MODEL = process.env.CIEKAWOSTKA_MODEL || 'claude-sonnet-5';
const MODEL_FALLBACK = 'claude-haiku-4-5-20251001';

function todayDate() {
  const now = new Date();
  const warsaw = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  const yyyy = warsaw.getFullYear();
  const mm = String(warsaw.getMonth() + 1).padStart(2, '0');
  const dd = String(warsaw.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

let activeModel = MODEL;

async function callClaude(prompt, useSearch) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Brak ANTHROPIC_API_KEY w zmiennych srodowiskowych');

  const send = async (model) => {
    // Limit musi byc wysoki, bo przy wlaczonym wyszukiwaniu wyniki z
    // internetu zjadaja budzet tokenow ZANIM model napisze ciekawostke.
    // Przy limicie 900 odpowiedzi wracaly puste albo urwane przed
    // znacznikami. Platne sa tokeny faktycznie uzyte, nie sam limit,
    // wiec wyzszy limit nic nie kosztuje, dopoki nie jest potrzebny.
    const body = {
      model,
      max_tokens: useSearch ? 4096 : 2048,
      messages: [{ role: 'user', content: prompt }],
    };
    if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  };

  let res = await send(activeModel);

  // Konto moze nie miec dostepu do wybranego modelu - wtedy raz na zawsze
  // przelaczamy sie na model zapasowy zamiast przerywac generowanie.
  if (!res.ok && (res.status === 404 || res.status === 400) && activeModel !== MODEL_FALLBACK) {
    console.warn(`[ciekawostka] model ${activeModel} niedostepny - przechodze na ${MODEL_FALLBACK}`);
    activeModel = MODEL_FALLBACK;
    res = await send(activeModel);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Pusta odpowiedz prawie zawsze znaczy, ze zabraklo tokenow albo ze model
  // zwrocil wylacznie bloki wyszukiwania. Logujemy powod, zeby nie zgadywac.
  if (!text) {
    const types = (data.content || []).map((b) => b.type).join(', ') || 'brak blokow';
    throw new Error(`Pusta odpowiedz z Anthropic API (stop_reason: ${data.stop_reason}, bloki: ${types})`);
  }
  return text;
}

// KROK 1: generowanie ciekawostki z uzyciem wyszukiwania w internecie.
async function generateFact(avoidList) {
  const avoidText = avoidList.length
    ? `Nie powtarzaj zadnej z ponizszych, juz wykorzystanych ciekawostek (mozesz poruszyc podobny temat, ale sformuluj to inaczej i skup sie na innym szczególe):\n${avoidList.map((f) => `- ${f}`).join('\n')}\n\n`
    : '';

  const prompt = `Wyszukaj w internecie i podaj jedna, krotka (maksymalnie 2 zdania) ciekawostke o miescie Zielona Gora w wojewodztwie lubuskim w Polsce, lub jego najblizszych okolicach. Moze dotyczyc historii, tradycji winiarskiej, przyrody, znanych mieszkancow, geografii, kultury, sportu lub architektury.

WAZNE: zanim odpowiesz, sprawdz fakt w co najmniej jednym wiarygodnym zrodle (np. Wikipedia, oficjalna strona miasta zielona-gora.pl, lokalne portale informacyjne, National Geographic Polska). Nie polegaj wylacznie na swojej wiedzy z treningu - realnie wyszukaj i zweryfikuj.

${avoidText}Wazne zasady:
- Ciekawostka MUSI dotyczyc TYLKO JEDNEGO tematu, miejsca lub wydarzenia. NIE LACZ dwoch roznych, niepowiazanych ze soba faktow w jednym tekscie (np. nie pisz jednoczesnie o planetarium ORAZ o osobnych pomnikach - to dwa rozne tematy, wybierz TYLKO JEDEN).
- Podaj WYLACZNIE tresc ciekawostki, bez wstepu, bez powitania, bez cudzyslowow, bez podpisu, bez linkow.
- Pisz wylacznie o faktach, ktore znalazles i zweryfikowales w wyszukanych zrodlach. Jesli nie jestes pewien dokladnej daty, liczby czy nazwiska, sformuluj zdanie ostrozniej (np. "prawdopodobnie", "w XIX wieku", "kilkaset") zamiast podawac falszywie precyzyjne dane.
- Nie wymyslaj faktow, ktorych nie potwierdzily wyniki wyszukiwania - lepiej podac bardziej ogolna, ale prawdziwa informacje.`;

  const text = await callClaude(prompt, true);
  return text.slice(0, 500);
}

// KROK 2: niezalezna weryfikacja tego, co napisal krok 1 - sprawdza
// poprawnosc jezykowa PO POLSKU oraz wiarygodnosc faktu (z mozliwoscia
// ponownego wyszukania), zanim tekst trafi do publikacji w appce.
async function reviewFact(draftText) {
  const prompt = `Otrzymales nizej ciekawostke o Zielonej Gorze, napisana automatycznie i przeznaczona do publikacji w aplikacji mobilnej. Twoim zadaniem jest jej weryfikacja przed publikacja.

TEKST DO SPRAWDZENIA:
"${draftText}"

Sprawdz TRZY rzeczy:
1. POPRAWNOSC JEZYKOWA: czy tekst jest napisany poprawna polszczyzna, bez bledow gramatycznych, ortograficznych czy dziwnych/nieistniejacych slow.
2. WIARYGODNOSC FAKTU: jesli to potrzebne, wyszukaj w internecie i zweryfikuj, czy opisany fakt jest prawdziwy i mozliwy do potwierdzenia w wiarygodnych zrodlach.
3. JEDEN TEMAT: czy tekst dotyczy TYLKO JEDNEGO tematu/miejsca/wydarzenia. Jesli tekst laczy dwa rozne, niepowiazane fakty - to blad: zostaw TYLKO PIERWSZY, glowny temat.

Mozesz swobodnie opisac swoj tok rozumowania, wyniki wyszukiwania i wnioski - to nie ma znaczenia dla formatu odpowiedzi.

WAZNE - FORMAT ODPOWIEDZI: niezaleznie od tego, co napiszesz jako analize, na sam koniec swojej odpowiedzi MUSISZ umiescic finalny, gotowy do publikacji tekst ciekawostki dokladnie w tym formacie, z dokladnie takimi znacznikami:

<ciekawostka>
(tutaj finalny tekst ciekawostki - jedno lub dwa zdania, bez cudzyslowow, bez wyjasnien)
</ciekawostka>

Tylko zawartosc miedzy znacznikami <ciekawostka> i </ciekawostka> zostanie opublikowana - Twoja analiza poza znacznikami zostanie calkowicie zignorowana. Znaczniki i ich zawartosc sa OBOWIAZKOWE w kazdej odpowiedzi.

Jesli oryginalny tekst byl juz poprawny i wiarygodny - wstaw go w znacznikach bez zmian. Jesli mial bledy jezykowe - popraw je w wersji w znacznikach. Jesli laczyl dwa tematy - w znacznikach zostaw tylko pierwszy. Jesli fakt byl niepewny - w znacznikach umiesc ostrozniejsze sformulowanie lub inny, pewny fakt.`;

  const text = await callClaude(prompt, true);
  const match = text.match(/<ciekawostka>([\s\S]*?)<\/ciekawostka>/i);
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
  // Tylko mocne sygnaly. Wczesniej byly tu tez zwroty wystepujace normalnie
  // w polskiej prozie ("zanim", "okazuje sie") - niepotrzebnie kasowaly
  // poprawne ciekawostki i zuzywaly jedna z trzech prob.
  const suspiciousPhrases = [
    'muszę sprawdzić', 'musze sprawdzic', 'po analizie', 'po dokładnej analizie',
    'po dokladnej analizie', 'sprawdzam', 'sprawdziłem', 'sprawdzilem', 'mogę potwierdzić',
    'moge potwierdzic', 'weryfikacja wykazala', 'weryfikacja wykazała',
    'błędy językowe', 'bledy jezykowe', 'poprawiona wersja', 'oto poprawiona',
    'tekst zawiera', 'tekst jest poprawny', 'bez zmian', 'finalna wersja',
  ];
  const lower = text.toLowerCase();
  return suspiciousPhrases.some((p) => lower.includes(p));
}

// KROK 4: punktowa naprawa. Gdy slownik wylapie konkretne slowo, nie warto
// wyrzucac calej ciekawostki i szukac nowego faktu - taniej i skuteczniej
// jest wskazac modelowi dokladnie to slowo i kazac poprawic wylacznie je.
// Dzieki temu "miasto srokow" staje sie "miasto srok", a sam fakt zostaje.
async function repairFact(text, problems) {
  const prompt = `Ponizszy tekst zawiera bledy jezykowe. Automatyczny slownik jezyka polskiego oznaczyl konkretne problemy - popraw DOKLADNIE te miejsca.

TEKST:
"${text}"

WYKRYTE PROBLEMY:
${problems.map((p) => `- ${p}`).join('\n')}

Zasady:
- Jesli slownik oznaczyl slowo jako nieznane, to najczesciej bledna forma odmiany. Ustal poprawna forme i wstaw ja. Przyklady poprawnych form dopelniacza liczby mnogiej: "srok" (nie "srokow"), "ulic" (nie "ulicow"), "winnic" (nie "winnicow"), "kobiet" (nie "kobietow").
- Jesli slowo w ogole nie istnieje w polszczyznie, zastap je istniejacym slowem o tym samym znaczeniu.
- NIE zmieniaj faktow: dat, liczb, nazwisk, nazw miejsc ani sensu zdania.
- Jesli problemem jest dlugosc, szyk lub brak kropki - popraw to, nie skracajac tresci merytorycznej.

FORMAT ODPOWIEDZI - obowiazkowy. Na samym koncu umiesc poprawiony tekst dokladnie tak:

<poprawiona>
(tutaj poprawiony tekst, bez cudzyslowow i bez komentarzy)
</poprawiona>`;

  const out = await callClaude(prompt, false);
  const match = out.match(/<poprawiona>([\s\S]*?)<\/poprawiona>/i);
  if (!match) {
    console.warn('[ciekawostka] naprawa nie uzyla znacznikow - pomijam');
    return null;
  }
  return match[1].trim().slice(0, 500);
}

// KROK 3: korekta czysto jezykowa. Osobne, waskie zadanie - model nie
// zajmuje sie juz faktami ani tematem, tylko polszczyzna. Waskie zadanie
// daje duzo lepsze wyniki niz proszenie o wszystko naraz w jednym kroku.
async function proofreadFact(text) {
  const prompt = `Jestes korektorem jezyka polskiego. Ponizej znajduje sie krotki tekst przeznaczony do publikacji.

TEKST:
"${text}"

Twoje JEDYNE zadanie to poprawic bledy jezykowe. Zwroc szczegolna uwage na:
- nieistniejace slowa i bledne formy zlozone (np. "Niemczyko-polskie" zamiast "niemiecko-polskie")
- DOPELNIACZ LICZBY MNOGIEJ rzeczownikow zenskich - to najczestszy blad. Rzeczowniki zenskie na -a maja w dopelniaczu liczby mnogiej koncowke ZEROWA, nie "-ow": "sroka" daje "srok" (NIE "srokow"), "ulica" daje "ulic" (NIE "ulicow"), "kobieta" daje "kobiet" (NIE "kobietow"), "winnica" daje "winnic" (NIE "winnicow")
- odmiane imion i nazwisk (np. "malzenstwo Johanna i Franciszek Juchniewiczowie zlecilo" jest bledne - poprawnie "malzenstwo Johanny i Franciszka Juchniewiczow zlecilo")
- zgodnosc rodzaju, liczby i przypadka miedzy podmiotem a orzeczeniem
- szyk zdania, interpunkcje, polskie znaki diakrytyczne

ZANIM podasz wynik, wykonaj kontrole: wypisz kazdy rzeczownik uzyty w liczbie mnogiej i sprawdz jego forme. Dopiero potem zbuduj finalna wersje.

NIE zmieniaj tresci merytorycznej: dat, nazwisk, liczb, nazw miejsc ani sensu zdania. Popraw wylacznie forme jezykowa.

FORMAT ODPOWIEDZI - obowiazkowy. Na samym koncu odpowiedzi umiesc poprawiony tekst dokladnie tak:

<poprawiona>
(tutaj poprawiony tekst, bez cudzyslowow i bez komentarzy)
</poprawiona>

Jesli tekst nie zawiera zadnych bledow - wstaw go w znacznikach bez zmian.`;

  const out = await callClaude(prompt, false);
  const match = out.match(/<poprawiona>([\s\S]*?)<\/poprawiona>/i);
  if (!match) {
    console.warn('[ciekawostka] korektor nie uzyl znacznikow - pomijam krok korekty');
    return null;
  }
  return match[1].trim().slice(0, 500);
}

// Deterministyczna kontrola jezykowa - nie zalezy od zadnego modelu.
// Lapie klasy bledow, ktore faktycznie wystapily w produkcji oraz typowe
// slady nieudanego generowania. To ostatnia bramka przed zapisem do bazy.
const VALID_COMPOUND_PREFIXES = [
  'polsko', 'niemiecko', 'czesko', 'slowacko', 'francusko', 'angielsko',
  'rosyjsko', 'ukrainsko', 'litewsko', 'wlosko', 'hiszpansko', 'austriacko',
  'wegiersko', 'zydowsko', 'slasko', 'luzycko', 'europejsko', 'radziecko',
];

function normalize(s) {
  return s.toLowerCase()
    .replace(/[ąĄ]/g, 'a').replace(/[ćĆ]/g, 'c').replace(/[ęĘ]/g, 'e')
    .replace(/[łŁ]/g, 'l').replace(/[ńŃ]/g, 'n').replace(/[óÓ]/g, 'o')
    .replace(/[śŚ]/g, 's').replace(/[żŻźŹ]/g, 'z');
}

// Kontrola strukturalna - tania, synchroniczna, bez slownika.
function checkStructure(text) {
  const problems = [];
  if (!text || !text.trim()) return ['tekst pusty'];

  const t = text.trim();

  if (t.length < 40) problems.push(`tekst podejrzanie krotki (${t.length} zn.)`);
  if (t.length > 520) problems.push(`tekst podejrzanie dlugi (${t.length} zn.)`);
  if (!/[.!?]$/.test(t)) problems.push('tekst nie konczy sie znakiem konca zdania');

  // Zlozenia typu "Niemczyko-polskie" - pierwszy czlon musi byc znana forma.
  const compounds = t.match(/\b([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{4,})-(?:polski|polsko|niemiecki|niemiecko)/gi) || [];
  for (const c of compounds) {
    const prefix = normalize(c.split('-')[0]);
    if (!VALID_COMPOUND_PREFIXES.includes(prefix)) {
      problems.push(`podejrzana forma zlozona: "${c}"`);
    }
  }

  // Powtorzone slowo ("w w", "i i", "na na")
  if (/\b(\p{L}+)\s+\1\b/iu.test(t)) problems.push('powtorzone slowo');

  // Niedomkniete cudzyslowy i nawiasy
  const openParen = (t.match(/\(/g) || []).length;
  const closeParen = (t.match(/\)/g) || []).length;
  if (openParen !== closeParen) problems.push('niedomkniety nawias');
  if ((t.match(/„/g) || []).length !== (t.match(/”/g) || []).length) problems.push('niedomkniety cudzyslow');

  // Slady techniczne / anglojezyczne, ktore nie maja prawa sie pojawic
  if (/\b(undefined|null|NaN|Error|Here is|Note:|However,)\b/i.test(t)) {
    problems.push('zawiera tresc techniczna lub anglojezyczna');
  }
  if (/<[a-z/]/i.test(t)) problems.push('zawiera znacznik HTML/XML');

  return problems;
}

// Pelna kontrola: struktura + prawdziwy slownik jezyka polskiego.
// Slowa z malej litery, ktorych nie zna slownik, to realne bledy odmiany
// albo wyrazy nieistniejace - odrzucamy tekst. Slowa z wielkiej litery to
// najczesciej nazwy wlasne spoza slownika, wiec tylko je logujemy.
async function checkPolishSanity(text) {
  const problems = checkStructure(text);
  if (!text || !text.trim()) return problems;

  try {
    const spell = await checkSpelling(text);
    if (!spell.available) {
      console.warn(`[ciekawostka] slownik niedostepny (${spell.reason}) - pomijam kontrole ortografii`);
      return problems;
    }
    if (spell.unknownLower.length) {
      problems.push(`slowa nieznane slownikowi: ${spell.unknownLower.join(', ')}`);
    }
    if (spell.unknownUpper.length) {
      console.log(`[ciekawostka] nazwy wlasne spoza slownika (dopuszczone): ${spell.unknownUpper.join(', ')}`);
    }
  } catch (err) {
    console.warn('[ciekawostka] blad kontroli ortografii:', err.message);
  }

  return problems;
}

const MAX_ATTEMPTS = 3;

// Pelny cykl: generowanie -> weryfikacja faktu -> korekta jezykowa ->
// deterministyczna kontrola. Jesli ktorykolwiek etap zawiedzie, NIE
// publikujemy niezweryfikowanego szkicu - probujemy od nowa.
//
// To jest zmiana wzgledem poprzedniej wersji, gdzie kazda sciezka awaryjna
// konczyla sie publikacja surowego tekstu z kroku 1. Wlasnie tedy przeszedl
// blad "Niemczyko-polskie malzenstwo Johanna i Franciszek Juchniewiczowie":
// recenzent odpadl na jednym z filtrow, a kod opublikowal nieprzejrzana
// wersje robocza.
async function generateFactViaClaude(avoidList) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const draft = await generateFact(avoidList);

      const reviewed = await reviewFact(draft);
      if (!reviewed || looksLikeMetaCommentary(reviewed)) {
        console.warn(`[ciekawostka] proba ${attempt}/${MAX_ATTEMPTS}: weryfikacja odpadla - generuje od nowa`);
        continue;
      }

      // Korekta jezykowa jest dodatkowa warstwa - jesli zawiedzie, idziemy
      // dalej z tekstem po weryfikacji (on juz przeszedl kontrole faktow).
      let candidate = reviewed;
      const proofed = await proofreadFact(reviewed);
      if (proofed && !looksLikeMetaCommentary(proofed)) candidate = proofed;

      let problems = await checkPolishSanity(candidate);

      // Jedna proba punktowej naprawy wskazanych bledow. Naprawiony tekst
      // przechodzi dokladnie te same kontrole - przyjmujemy go tylko wtedy,
      // gdy jest calkowicie czysty.
      if (problems.length) {
        console.warn(`[ciekawostka] proba ${attempt}/${MAX_ATTEMPTS}: kontrola znalazla bledy (${problems.join('; ')}) - probuje naprawic`);
        const repaired = await repairFact(candidate, problems);
        if (repaired && !looksLikeMetaCommentary(repaired)) {
          const afterRepair = await checkPolishSanity(repaired);
          if (!afterRepair.length) {
            console.log(`[ciekawostka] naprawa udana: "${candidate}" -> "${repaired}"`);
            candidate = repaired;
            problems = [];
          } else {
            console.warn(`[ciekawostka] po naprawie nadal bledy (${afterRepair.join('; ')})`);
          }
        }
      }

      if (problems.length) {
        console.warn(`[ciekawostka] proba ${attempt}/${MAX_ATTEMPTS}: odrzucam tekst "${candidate}"`);
        continue;
      }

      if (attempt > 1) console.log(`[ciekawostka] zaakceptowano w probie ${attempt}`);
      return candidate;
    } catch (err) {
      console.warn(`[ciekawostka] proba ${attempt}/${MAX_ATTEMPTS}: blad - ${err.message}`);
    }
  }

  // Zadna z prob nie dala tekstu, ktory przeszedl wszystkie kontrole.
  // Swiadomie NIE publikujemy nic - frontend pokaze wtedy swoja lokalna
  // ciekawostke zapasowa. Lepiej brak nowej ciekawostki niz ciekawostka
  // z bledem jezykowym widoczna dla wszystkich uzytkownikow.
  console.error(`[ciekawostka] wszystkie ${MAX_ATTEMPTS} proby odrzucone - dzis bez nowej ciekawostki`);
  return null;
}

// Generowanie chodzi w tle i jest pilnowane dwoma zamkami, zeby jedna
// nieudana proba nie zamienila sie w lawine wywolan API: inFlight nie
// pozwala uruchomic dwoch generowan naraz (appke otwiera wielu uzytkownikow
// w tej samej chwili), a COOLDOWN wstrzymuje kolejne podejscie na 20 minut
// po nieudanym. Bez tego kazde wejscie do appki w dniu, w ktorym kontrola
// odrzuca teksty, odpalaloby komplet zapytan z wyszukiwaniem w internecie.
let inFlight = null;
let lastFailedAt = 0;
const COOLDOWN_MS = 20 * 60 * 1000;

// Twardy limit kosztowy. Samonaprawa chodzi co godzine, wiec w dniu, w ktorym
// generowanie uparcie pada (awaria API, zrodla nie do zweryfikowania), bez
// tego limitu poszloby 18 pelnych cykli po trzy proby - kilkaset platnych
// zapytan z wyszukiwaniem w internecie w jedna dobe. Cztery cykle dziennie
// w zupelnosci wystarczaja, zeby odrobic chwilowa awarie, a koszt w najgorszym
// dniu pozostaje przewidywalny. Reczne wymuszenie linkiem limitu nie dotyczy.
const MAX_CYCLES_PER_DAY = 4;
let cycleDate = null;
let cyclesToday = 0;

function budgetLeft() {
  const today = todayDate();
  if (cycleDate !== today) { cycleDate = today; cyclesToday = 0; }
  return cyclesToday < MAX_CYCLES_PER_DAY;
}

function startGeneration() {
  if (inFlight) return inFlight;

  if (!budgetLeft()) {
    console.warn(`[ciekawostka] wyczerpany dzienny limit ${MAX_CYCLES_PER_DAY} prob generowania - kolejna dopiero jutro`);
    return Promise.resolve(null);
  }
  cyclesToday += 1;

  inFlight = generateFactViaClaude(getRecentFacts(20))
    .then((content) => {
      if (content) {
        saveDailyFact(todayDate(), content);
        lastFailedAt = 0;
        console.log('[ciekawostka] zapisano nowa ciekawostke na dzis');
      } else {
        lastFailedAt = Date.now();
      }
      return content;
    })
    .catch((err) => {
      lastFailedAt = Date.now();
      console.error('[ciekawostka] generowanie zakonczone bledem:', err.message);
      return null;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

// Odpowiedz dla appki. Nigdy nie kaze uzytkownikowi czekac na generowanie -
// jesli ciekawostki jeszcze nie ma, uruchamia ja w tle i zwraca null, a
// frontend pokazuje swoja lokalna ciekawostke zapasowa. Przy nastepnym
// otwarciu appki nowa ciekawostka juz tam bedzie.
async function getTodayFact() {
  const date = todayDate();
  const cached = getDailyFact(date);
  if (cached) return { date, content: cached.content, generated: false };

  if (!inFlight && Date.now() - lastFailedAt > COOLDOWN_MS) startGeneration();
  return { date, content: null, generated: false };
}

// Wolane z harmonogramu (patrz server.js). Czeka na wynik, zeby logi Render
// pokazywaly, czy dzienna ciekawostka faktycznie powstala. Jesli juz jest,
// nie robi nic - dzieki temu mozna to wolac co godzine jako samonaprawe
// po dniu, w ktorym generowanie odpadlo na kontroli jezykowej.
async function ensureTodayFact() {
  const date = todayDate();
  if (getDailyFact(date)) return { date, content: getDailyFact(date).content, generated: false };

  if (Date.now() - lastFailedAt < COOLDOWN_MS && !inFlight) {
    console.log('[ciekawostka] po nieudanej probie czekam z kolejna - przerwa karencyjna');
    return { date, content: null, generated: false };
  }

  if (!inFlight && !budgetLeft()) {
    return { date, content: null, generated: false };
  }

  const content = await startGeneration();
  return { date, content: content || null, generated: Boolean(content) };
}

// Usuwa dzisiejsza, juz zapisana ciekawostke i generuje nowa od zera -
// przydatne, jesli dzisiejsza wersja okaze sie wadliwa (np. blad jezykowy,
// ktory przeszedl przez weryfikacje) i chcesz to poprawic od reki, bez
// czekania do jutra.
async function forceRegenerateTodayFact() {
  const date = todayDate();
  deleteDailyFact(date);
  // Reczne wymuszenie pomija przerwe karencyjna - skoro klikasz, to chcesz teraz.
  lastFailedAt = 0;
  const recentFacts = getRecentFacts(20);
  const content = await generateFactViaClaude(recentFacts);
  if (!content) {
    lastFailedAt = Date.now();
    throw new Error('Nie udalo sie wygenerowac ciekawostki, ktora przeszlaby kontrole jezykowa - sprobuj ponownie');
  }
  saveDailyFact(date, content);
  return { date, content, generated: true };
}

module.exports = {
  getTodayFact, ensureTodayFact, forceRegenerateTodayFact, checkPolishSanity,
};
