const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ROOT, GIT_PUBLISH, GIT_BRANCH } = require('./config');

const run = promisify(execFile);
const git = (...args) => run('git', args, { cwd: ROOT });

// Commit + push du dossier reports/. "[skip ci]" évite de relancer le déploiement.
async function publishReports() {
  if (!GIT_PUBLISH) return 'désactivé (GIT_PUBLISH != 1)';
  await git('add', 'reports');
  const { stdout } = await git('status', '--porcelain', '--', 'reports');
  if (!stdout.trim()) return 'aucun changement';
  const date = new Date().toISOString().slice(0, 10);
  await git('commit', '-m', `chore(reports): mise à jour du ${date} [skip ci]`, '--', 'reports');
  await git('pull', '--rebase', 'origin', GIT_BRANCH);
  await git('push', 'origin', `HEAD:${GIT_BRANCH}`);
  return 'poussé';
}

module.exports = { publishReports };
