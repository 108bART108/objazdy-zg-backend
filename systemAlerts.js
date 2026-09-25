const webpush = require('web-push');
const { getAllSubscriptions } = require('./db');

// Wysyla powiadomienie push WYLACZNIE do subskrybentow kategorii "system"
// (czyli do administratora), nigdy do zwyklych uzytkownikow appki.
// Uzywane do alertow technicznych, np. gdy ktores zrodlo danych przestalo
// zwracac wpisy - dzieki temu nie trzeba czekac na cotygodniowy raport ani
// samemu zauwazac, ze jakas kategoria przestala sie aktualizowac.
async function sendSystemAlert(title, body) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('[alert] brak kluczy VAPID - alert tylko w logach:', title, '-', body);
    return;
  }
  webpush.setVapidDetails(
    'mailto:info@utrudnienia-zg.pl',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const subs = getAllSubscriptions().filter((s) => (s.categories || '').split(',').includes('system'));
  if (!subs.length) {
    console.warn('[alert] brak subskrybentow "system" - alert tylko w logach:', title, '-', body);
    return;
  }

  const payload = JSON.stringify({
    title,
    body: body.slice(0, 180),
    url: 'https://utrudnienia-zg.pl',
  });

  for (const sub of subs) {
    try {
      await webpush.sendNotification(JSON.parse(sub.subscription_json), payload);
    } catch (err) {
      console.error('[alert] blad wysylki alertu:', err.statusCode || err.message);
    }
  }
}

module.exports = { sendSystemAlert };
