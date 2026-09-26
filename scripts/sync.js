// Utilisé par le timer systemd : node scripts/sync.js
const { runSync } = require('../src/jobs');

runSync().catch((err) => {
  console.error(err);
  process.exit(1);
});
