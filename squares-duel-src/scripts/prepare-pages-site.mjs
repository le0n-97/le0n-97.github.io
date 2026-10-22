import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageWebsite } from './pages-site.mjs';

const application = fileURLToPath(new URL('../', import.meta.url));
const repository = path.dirname(path.resolve(application));
if (path.basename(application.replace(/[\\/]$/, '')) !== 'squares-duel-src') throw new Error('Run from the GitHub source checkout.');
const exported = JSON.parse(execFileSync(process.execPath, [path.join(application, 'scripts/prepare-github-pages.mjs')], { cwd: application, encoding: 'utf8' }).trim());
const commit = process.env.GITHUB_SHA ?? execFileSync('git', ['-c', `safe.directory=${repository}`, 'rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit.');
const directory = await stageWebsite(repository, exported.directory, commit);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `directory=${directory}\n`);
console.log(JSON.stringify({ directory, sourceCommit: commit }));
