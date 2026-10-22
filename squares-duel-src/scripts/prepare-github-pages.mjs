import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'dist-pages');
const repository = 'le0n-97/le0n-97.github.io';
const repositoryDirectory = 'squares-duel';
const targetUrl = 'https://le0n-97.github.io/squares-duel/';
const apiOrigin = 'https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site';
const index = await readFile(path.join(source, 'index.html'), 'utf8');
if (!index.includes('/squares-duel/assets/') || !index.includes('/squares-duel/favicon.svg')) {
  throw new Error('Build the production Pages configuration before exporting.');
}

// Export only the public browser build into a fresh directory. Server sources,
// local records, Git history, credentials and runtime files stay in this checkout.
const files = [];
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${relative}`);
    if (entry.isDirectory()) {
      if (relative !== 'assets') throw new Error(`Unexpected build directory: ${relative}`);
      await collect(path.join(directory, entry.name), `${relative}/`);
    } else if (entry.isFile()) {
      if (!/\.(?:html|css|js|svg|txt|png|ico|woff2?)$/.test(relative)) {
        throw new Error(`Unexpected public build file: ${relative}`);
      }
      files.push(relative);
    }
  }
}
await collect(source);
const scripts = await Promise.all(files.filter(file => file.endsWith('.js')).map(file => readFile(path.join(source, file), 'utf8')));
if (!scripts.some(script => script.includes(apiOrigin))) throw new Error('Pages build is not connected to the production game service.');
if (scripts.some(script => /AARDVARKS|cloudflare:workers|\/api\/admin\/records|SELECT state, revision FROM rooms/.test(script))) {
  throw new Error('Server-only content appeared in the public browser build.');
}
const destination = path.join(root, 'outputs', 'github-pages', randomUUID());
await mkdir(destination, { recursive: true });
const manifest = {};
for (const relative of files.sort()) {
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(source, relative), target);
  manifest[relative] = createHash('sha256').update(await readFile(target)).digest('hex');
}
await writeFile(path.join(destination, '.nojekyll'), '');
await writeFile(path.join(destination, 'README.md'), `# Squares Duel\n\nPublic browser build for [Squares Duel](${targetUrl}), hosted in the ${repositoryDirectory}/ directory of [${repository}](https://github.com/${repository}).\n\nThe former website has closed. Its API continues to provide the database, room service, chat and username/password accounts used by this GitHub Pages frontend. Sign-in is required to create or join a room, spectate or chat. Guest play is disabled. Sign in with the same account to reconnect to an existing room on another device.\n\nThis directory contains browser assets only. Server code, account data, game records and credentials are not included. The SCOWL dictionary license is available in [dictionary-license.txt](dictionary-license.txt).\n\nThe complete application source is maintained in [squares-duel-src](https://github.com/le0n-97/le0n-97.github.io/tree/main/squares-duel-src). GitHub Actions checks source changes and regenerates this directory before publishing. Keep the existing homepage and other repository files when publishing updates.\n`);
await writeFile(path.join(destination, 'asset-checksums.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ directory: destination, repository, repositoryDirectory, targetUrl, apiOrigin, files: files.length }));
