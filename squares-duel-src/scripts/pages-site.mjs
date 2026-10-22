import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) throw new Error('Invalid publication path.');
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Publication path escaped its directory.');
  return target;
}

async function filesOf(root, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Publication cannot contain symbolic links.');
    if (entry.isDirectory()) files.push(...await filesOf(path.join(root, entry.name), relative + '/'));
    else if (entry.isFile()) files.push(relative);
    else throw new Error('Unexpected publication entry.');
  }
  return files.sort();
}

export async function validateGameBuild(root) {
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Game build must be a directory.');
  const manifest = JSON.parse(await fs.readFile(inside(root, 'asset-checksums.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !manifest['index.html']) throw new Error('Missing game build manifest.');
  for (const [relative, expected] of Object.entries(manifest)) {
    const target = inside(root, relative);
    if (!/^[0-9a-f]{64}$/.test(expected) || !(await fs.lstat(target)).isFile()) throw new Error('Invalid game manifest entry.');
    if (createHash('sha256').update(await fs.readFile(target)).digest('hex') !== expected) throw new Error('Game build checksum mismatch.');
  }
  const files = await filesOf(root);
  const metadata = new Set(['.nojekyll', 'README.md', 'asset-checksums.json', 'deployment.json']);
  if (files.some(file => !Object.hasOwn(manifest, file) && !metadata.has(file))) throw new Error('Unexpected file in game build.');
  return files;
}

export async function stageWebsite(repository, gameBuild, sourceCommit) {
  const gameFiles = await validateGameBuild(gameBuild);
  const output = inside(repository, `.pages-stage/${randomUUID()}`);
  await fs.mkdir(output, { recursive: true });
  const tracked = execFileSync('git', ['-c', `safe.directory=${repository}`, 'ls-files', '-z'], { cwd: repository, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const relative of tracked) {
    if (/^(?:squares-duel-src|squares-duel|\.github|\.pages-stage)(?:\/|$)/.test(relative) || ['README.md', 'AGENTS.md', '_config.yml', '.gitignore', '.gitattributes'].includes(relative)) continue;
    if (relative.split('/').some(part => /^(?:\.git|\.env.*)$/.test(part)) || /\.(?:sqlite3?|db|pem|key)$/i.test(relative)) throw new Error('Private file cannot enter the website.');
    const source = inside(repository, relative);
    if (!(await fs.lstat(source)).isFile()) throw new Error('Public website files must be regular files.');
    const target = inside(output, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Read the indexed Git bytes so a Windows checkout's CRLF conversion cannot
    // change existing personal-site files when the workflow publishes them.
    const bytes = execFileSync('git', ['-c', `safe.directory=${repository}`, 'show', `:${relative}`], { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
    await fs.writeFile(target, bytes);
  }
  if (!(await fs.stat(inside(output, 'index.html'))).isFile()) throw new Error('Personal homepage is missing.');
  for (const relative of gameFiles) {
    const target = inside(output, `squares-duel/${relative}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(inside(gameBuild, relative), target);
  }
  await fs.writeFile(inside(output, '.nojekyll'), '');
  await fs.writeFile(inside(output, 'squares-duel/deployment.json'), JSON.stringify({
    repository: 'le0n-97/le0n-97.github.io', sourceDirectory: 'squares-duel-src', sourceCommit,
    workflow: 'squares-duel.yml', backend: 'existing Sites API; backend releases are separate',
  }, null, 2) + '\n');
  return output;
}

export async function syncGeneratedGame(repository, artifact) {
  const destination = inside(repository, 'squares-duel');
  const newFiles = await validateGameBuild(artifact);
  const oldFiles = await validateGameBuild(destination);
  // Only validated generated files inside squares-duel/ can be replaced or removed.
  for (const relative of oldFiles) if (!newFiles.includes(relative)) await fs.unlink(inside(destination, relative));
  for (const relative of newFiles) {
    const target = inside(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(inside(artifact, relative), target);
  }
}
