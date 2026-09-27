const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Clone Git utilisé pour publier reports/. Dans l'image Docker, le code de
// l'appli (ROOT) n'est pas un clone exploitable : GIT_REPO_DIR pointe alors
// vers un volume monté contenant un vrai clone (voir docker-compose.yml).
const GIT_REPO_DIR = process.env.GIT_REPO_DIR || ROOT;

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, 'data'),
  GIT_REPO_DIR,
  REPORTS_DIR: path.join(GIT_REPO_DIR, 'reports'),

  // Catalogue des cartes : https://api.riftcodex.com (1 page = 100 cartes max)
  RIFTCODEX_API: 'https://api.riftcodex.com',
  // Prix TCGplayer (USD) republiés quotidiennement par https://tcgcsv.com
  TCGCSV_API: 'https://tcgcsv.com/tcgplayer',
  TCGPLAYER_CATEGORY_ID: 89, // "Riftbound League of Legends Trading Card Game"
  // Riftcodex renvoie 403 sans User-Agent explicite
  USER_AGENT: 'riftbound-inventory/1.0 (+https://github.com/wokioz/riftbound)',

  AUTH_USER: process.env.AUTH_USER || '',
  AUTH_PASSWORD: process.env.AUTH_PASSWORD || '',

  GIT_PUBLISH: process.env.GIT_PUBLISH === '1',
  GIT_BRANCH: process.env.GIT_BRANCH || 'main',
  // URL SSH utilisée pour cloner automatiquement GIT_REPO_DIR s'il est vide au démarrage (Docker)
  GIT_REPO_URL: process.env.GIT_REPO_URL || '',
};
