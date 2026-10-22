import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncGeneratedGame } from './pages-site.mjs';

const repository = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const expected = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(expected ?? '') || !process.env.GITHUB_ACTIONS || !process.argv[2]) throw new Error('This publisher runs only in GitHub Actions.');
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
const output = async value => { if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${value}\n`); };
git('fetch', '--no-tags', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== expected || git('rev-parse', 'origin/main') !== expected) {
  await output('false');
  console.log('A newer source commit is available; its workflow will publish.');
} else {
  const metadata = JSON.parse(await readFile(path.resolve(process.argv[2], 'squares-duel/deployment.json'), 'utf8'));
  if (metadata.sourceCommit !== expected) throw new Error('Website artifact belongs to a different source commit.');
  await syncGeneratedGame(repository, path.resolve(process.argv[2], 'squares-duel'));
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('add', '--', 'squares-duel');
  const changes = git('diff', '--cached', '--name-only');
  if (changes.split('\n').filter(Boolean).some(file => !file.startsWith('squares-duel/'))) throw new Error('Only generated game files can be committed.');
  if (changes) {
    git('commit', '-m', `Build Squares Duel from ${expected.slice(0, 12)}`);
    // Fast-forward only: a concurrent human push cannot be overwritten.
    git('push', 'origin', 'HEAD:main');
  }
  await output('true');
}
