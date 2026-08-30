const { getDailyFact, saveDailyFact, getRecentFacts } = require('./db');

// Uzywamy taniego, szybkiego modelu - to prosty, krotki tekst faktograficzny.
const MODEL = 'claude-haiku-4-5-20251001';

function todayDate() {
  const now = new Date();
  const warsaw = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  const yyyy = warsaw.getFullYear();
  const mm = String(warsaw.getMonth() + 1).padStart(2, '0');
  const dd = String(warsaw.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function generateFactViaClaude(avoidList) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Brak ANTHROPIC_API_KEY w zmiennych srodowiskowych');

  const avoidText = avoidList.length
    ? `Nie powtarzaj zadnej z ponizszych, juz wykorzystanych ciekawostek (mozesz poruszyc podobny temat, ale sformuluj to inaczej i skup sie na innym szczególe):\n${avoidList.map((f) => `- ${f}`).join('\n')}\n\n`
    : '';

  const prompt = `Wyszukaj w internecie i podaj jedna, krotka (maksymalnie 2-3 zdania) ciekawostke o miescie Zielona Gora w wojewodztwie lubuskim w Polsce, lub jego najblizszych okolicach. Moze dotyczyc historii, tradycji winiarskiej, przyrody, znanych mieszkancow, geografii, kultury, sportu lub architektury.

WAZNE: zanim odpowiesz, sprawdz fakt w co najmniej jednym wiarygodnym zrodle (np. Wikipedia, oficjalna strona miasta zielona-gora.pl, lokalne portale informacyjne, National Geographic Polska). Nie polegaj wylacznie na swojej wiedzy z treningu - realnie wyszukaj i zweryfikuj.

${avoidText}Wazne zasady:
- Podaj WYLACZNIE tresc ciekawostki, bez wstepu, bez powitania, bez cudzyslowow, bez podpisu, bez linkow.
- Pisz wylacznie o faktach, ktore znalazles i zweryfikowales w wyszukanych zrodlach. Jesli nie jestes pewien dokladnej daty, liczby czy nazwiska, sformuluj zdanie ostrozniej (np. "prawdopodobnie", "w XIX wieku", "kilkaset") zamiast podawac falszywie precyzyjne dane.
- Nie wymyslaj faktow, ktorych nie potwierdzily wyniki wyszukiwania - lepiej podac bardziej ogolna, ale prawdziwa informacje.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  // Odpowiedz moze skladac sie z kilku blokow tekstu (jesli model przeplatal
  // wyszukiwanie z pisaniem) - laczymy wszystkie w jedna calosc.
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) throw new Error('Pusta odpowiedz z Anthropic API');
  return text.slice(0, 500);
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

module.exports = { getTodayFact };
