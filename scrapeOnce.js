require('dotenv').config();
const { scrapeAll } = require('./scrapeAll');

scrapeAll()
  .then((count) => {
    console.log(`Gotowe. Przetworzono ${count} wpisow.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Blad scrapowania:', err);
    process.exit(1);
  });
