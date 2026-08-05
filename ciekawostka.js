const { getDailyFact, saveDailyFact, getRecentFacts } = require('./db');

// Uzywamy taniego, szybkiego modelu - to prosty, krotki tekst faktograficzny,
// nie potrzeba do tego najmocniejszego modelu.
const MODEL = 'claude-haiku-4-5-20251001';

function todayDate() {
  // Data w strefie Europe/Warsaw, format YYYY-MM-DD, zeby "dzien" zmienial sie
  // o polnocy czasu polskiego, a nie UTC.
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

  const prompt = `Podaj jedna, krotka (maksymalnie 2-3 zdania) ciekawostke o miescie Zielona Gora w wojewodztwie lubuskim w Polsce, lub jego najblizszych okolicach. Moze dotyczyc historii, tradycji winiarskiej, przyrody, znanych mieszkancow, geografii, kultury, sportu lub architektury.

${avoidText}Wazne zasady:
- Podaj WYLACZNIE tresc ciekawostki, bez wstepu, bez powitania, bez cudzyslowow, bez podpisu.
- Pisz wylacznie o faktach, ktorych jestes naprawde pewien. Jesli nie jestes pewien dokladnej daty, liczby czy nazwiska, sformuluj zdanie ostrozniej (np. "prawdopodobnie", "w XIX wieku", "kilkaset") zamiast podawac falszywie precyzyjne dane.
- Nie wymyslaj faktow, ktorych nie jestes pewien - lepiej podac bardziej ogolna, ale prawdziwa informacje.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  const text = textBlock ? textBlock.text.trim() : '';
  if (!text) throw new Error('Pusta odpowiedz z Anthropic API');
  return text;
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
