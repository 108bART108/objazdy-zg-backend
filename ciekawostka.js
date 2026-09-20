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
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) throw new Error('Pusta odpowiedz z Anthropic API');
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

Sprawdz CZTERY rzeczy:
1. POPRAWNOSC JEZYKOWA: czy tekst jest napisany poprawna polszczyzna, bez bledow gramatycznych, ortograficznych czy dziwnych/nieistniejacych slow.
2. WIARYGODNOSC FAKTU: jesli to potrzebne, wyszukaj w internecie i zweryfikuj, czy opisany fakt jest prawdziwy i mozliwy do potwierdzenia w wiarygodnych zrodlach.
3. JEDEN TEMAT: czy tekst dotyczy TYLKO JEDNEGO tematu/miejsca/wydarzenia. Jesli tekst laczy dwa rozne, niepowiazane fakty - to blad: zostaw TYLKO PIERWSZY, glowny temat.
4. BRAK NARRACJI WLASNEGO PROCESU: czy tekst NIE zaczyna sie (ani nie zawiera nigdzie) zdaniem opisujacym co model "zamierza zrobic" albo "wlasnie robi" (np. "Wyszukam teraz...", "Sprawdzam...", "Poszukajmy..."). To jest BLAD tego samego kalibru co blad jezykowy - taka narracja NIE JEST czescia ciekawostki i musi zostac usunieta, zostaw wylacznie sama tresc faktu.

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
  const suspiciousPhrases = [
    'zanim', 'muszę sprawdzić', 'musze sprawdzic', 'po analizie', 'po dokładnej analizie',
    'po dokladnej analizie', 'sprawdzam', 'sprawdziłem', 'sprawdzilem', 'mogę potwierdzić',
    'moge potwierdzic', 'weryfikacja', 'okazuje się', 'okazuje sie', 'błędy językowo',
    'bledy jezykowo', 'poprawiona wersja', 'oto poprawiona', 'tekst zawiera',
    // Warianty "narracji zamiaru" - model opisuje CO ZAMIERZA zrobic zamiast
    // od razu podac gotowa tresc (np. "Wyszukam teraz ciekawostke o...").
    // Dokladnie taki wyciek trafil kiedys do publikacji, mimo istniejacego
    // filtra - stad ta rozszerzona lista.
    'wyszukam', 'poszukam', 'znajdę teraz', 'znajde teraz', 'sprawdzę teraz',
    'sprawdze teraz', 'teraz sprawdzę', 'teraz sprawdze', 'przeszukam',
    'poszukajmy', 'sprawdźmy', 'sprawdzmy', 'pozwól, że', 'pozwol, ze',
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

async function generateFactViaClaude(avoidList) {
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

  // OSTATECZNA BRAMKA: jesli tekst nadal wyglada podejrzanie (albo caly
  // stal sie za krotki po obcieciu) - NIE publikujemy niczego. Zamiast
  // zgadywac kolejny wzorzec bledu, ktorego jeszcze nie znamy, wolimy
  // rzucic blad i nie zapisac nic do bazy (getTodayFact po prostu nie
  // ustawi cache na dzis - kolejna proba, reczna albo z nastepnego crona,
  // moze sie udac). Lepszy brak ciekawostki dzisiaj niz opublikowanie
  // kolejnego wariantu wycieku, ktorego filtr jeszcze nie rozpoznaje.
  if (looksLikeMetaCommentary(stripped)) {
    throw new Error('Wygenerowany tekst wyglada na niepoprawny (mozliwy wyciek procesu modelu) i zostal odrzucony przed publikacja - sprobuj ponownie.');
  }

  return stripped;
}

async function getTodayFact() {
  const date = todayDate();
  const cached = getDailyFact(date);
  if (cached) return { date, content: cached.content, generated: false };

  const recentFacts = getRecentFacts(20);
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
  const recentFacts = getRecentFacts(20);
  const content = await generateFactViaClaude(recentFacts);
  saveDailyFact(date, content);
  return { date, content, generated: true };
}

module.exports = { getTodayFact, forceRegenerateTodayFact };
