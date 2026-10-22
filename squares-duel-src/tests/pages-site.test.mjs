import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, stageWebsite, syncGeneratedGame } from '../scripts/pages-site.mjs';

const fixtureBase = fileURLToPath(new URL('../.sites-runtime/pages-site-tests/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(fixtureBase, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtureBase, 'site-'));
  t.after(async () => {
    const target = path.resolve(directory);
    if (!target.startsWith(path.resolve(fixtureBase) + path.sep)) throw new Error('Unsafe fixture cleanup.');
    await fs.rm(target, { recursive: true, force: true });
  });
  const repository = path.join(directory, 'repository');
  await fs.mkdir(repository);
  execFileSync('git', ['init', '-q', repository]);
  return { directory, repository };
}
async function write(root, relative, content) {
  const target = inside(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}
async function game(root, filename = 'assets/new.js') {
  const assets = { 'index.html': '<html>game</html>', [filename]: 'console.log("game")' };
  const manifest = {};
  for (const [name, content] of Object.entries(assets)) {
    await write(root, name, content);
    manifest[name] = createHash('sha256').update(content).digest('hex');
  }
  await write(root, 'asset-checksums.json', JSON.stringify(manifest));
  await write(root, '.nojekyll', '');
  return manifest;
}
function track(repository) { execFileSync('git', ['-c', `safe.directory=${repository}`, 'add', '.'], { cwd: repository }); }

test('website staging preserves personal site bytes and excludes source, workflows and developer documents', async t => {
  const { directory, repository } = await fixture(t);
  await write(repository, 'index.html', '<html>unchanged personal homepage</html>');
  await write(repository, 'post/hello/index.html', 'existing post');
  await write(repository, 'favicon.ico', Buffer.from([0, 1, 254, 255]));
  await write(repository, 'squares-duel-src/app/api/account/route.ts', 'server-only source');
  await write(repository, '.github/workflows/squares-duel.yml', 'workflow source');
  await write(repository, 'README.md', 'development instructions');
  track(repository);
  const build = path.join(directory, 'game');
  await game(build);
  const output = await stageWebsite(repository, build, 'a'.repeat(40));
  assert.deepEqual(await fs.readFile(path.join(output, 'index.html')), await fs.readFile(path.join(repository, 'index.html')));
  assert.deepEqual(await fs.readFile(path.join(output, 'favicon.ico')), Buffer.from([0, 1, 254, 255]));
  assert.equal(await fs.readFile(path.join(output, 'post/hello/index.html'), 'utf8'), 'existing post');
  for (const relative of ['squares-duel-src', '.github', 'README.md']) await assert.rejects(fs.stat(path.join(output, relative)), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'squares-duel/deployment.json'), 'utf8')).sourceCommit, 'a'.repeat(40));
});

test('publication refuses tampered browser builds before updating generated files', async t => {
  const { directory, repository } = await fixture(t);
  const current = path.join(repository, 'squares-duel');
  await game(current, 'assets/old.js');
  const build = path.join(directory, 'game');
  await game(build);
  await write(build, 'assets/new.js', 'tampered');
  await assert.rejects(syncGeneratedGame(repository, build), /checksum/);
  assert.equal(await fs.readFile(path.join(current, 'assets/old.js'), 'utf8'), 'console.log("game")');
});

test('updating generated game files removes stale assets while retaining the personal homepage', async t => {
  const { directory, repository } = await fixture(t);
  await write(repository, 'index.html', 'personal homepage');
  await game(path.join(repository, 'squares-duel'), 'assets/old.js');
  const build = path.join(directory, 'game');
  await game(build);
  await syncGeneratedGame(repository, build);
  assert.equal(await fs.readFile(path.join(repository, 'index.html'), 'utf8'), 'personal homepage');
  assert.equal(await fs.readFile(path.join(repository, 'squares-duel/assets/new.js'), 'utf8'), 'console.log("game")');
  await assert.rejects(fs.stat(path.join(repository, 'squares-duel/assets/old.js')), { code: 'ENOENT' });
});

test('a malicious old manifest cannot remove or overwrite files outside the game directory', async t => {
  const { directory, repository } = await fixture(t);
  await write(repository, 'index.html', 'personal homepage');
  const current = path.join(repository, 'squares-duel');
  await game(current);
  await write(current, 'asset-checksums.json', JSON.stringify({ 'index.html': '0'.repeat(64), '../index.html': '0'.repeat(64) }));
  const build = path.join(directory, 'game');
  await game(build);
  await assert.rejects(syncGeneratedGame(repository, build));
  assert.equal(await fs.readFile(path.join(repository, 'index.html'), 'utf8'), 'personal homepage');
});

test('tracked credential files cannot be copied into the public website', async t => {
  const { directory, repository } = await fixture(t);
  await write(repository, 'index.html', 'personal homepage');
  await write(repository, '.env.production', 'example-only fixture');
  track(repository);
  const build = path.join(directory, 'game');
  await game(build);
  await assert.rejects(stageWebsite(repository, build, 'a'.repeat(40)), /Private file/);
});

test('publication paths reject traversal and absolute names', () => {
  for (const relative of ['../index.html', '/index.html', 'assets/../index.html', 'assets\\index.html', 'assets//index.html', '.']) assert.throws(() => inside(fixtureBase, relative));
  assert.equal(inside(fixtureBase, 'assets/new.js'), path.join(fixtureBase, 'assets', 'new.js'));
});

test('website staging uses exact Git bytes even when Windows checkout line endings differ', async t => {
  const { directory, repository } = await fixture(t);
  await write(repository, 'index.html', 'first\nsecond\n');
  track(repository);
  await write(repository, 'index.html', 'first\r\nsecond\r\n');
  const build = path.join(directory, 'game');
  await game(build);
  const output = await stageWebsite(repository, build, 'a'.repeat(40));
  assert.equal(await fs.readFile(path.join(output, 'index.html'), 'utf8'), 'first\nsecond\n');
});
