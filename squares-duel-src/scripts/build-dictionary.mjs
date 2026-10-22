// Reproducible, dependency-free conversion of the official SCOWL release.
// Usage: node scripts/build-dictionary.mjs [--archive /path/to/scowl-2020.12.07.tar.gz]
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = 'SCOWL-2020.12.07-ABZ-v1-60-80';
const archiveUrl = 'https://deb.debian.org/debian/pool/main/s/scowl/scowl_2020.12.07.orig.tar.gz';
const archiveHash = '5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc';
const categories = ['english', 'american', 'british', 'british_z', 'variant_1', 'british_variant_1'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const archiveArg = process.argv.indexOf('--archive');
if (archiveArg !== -1 && !process.argv[archiveArg + 1]) throw new Error('--archive requires a path');
let archive;
if (archiveArg !== -1) archive = await readFile(path.resolve(process.argv[archiveArg + 1]));
else {
  const response = await fetch(archiveUrl);
  if (!response.ok) throw new Error(`SCOWL download failed: HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
}
if (sha256(archive) !== archiveHash) throw new Error('SCOWL archive checksum does not match the pinned release');

// Read only the known release paths directly; no archive files are executed or extracted.
const tar = gunzipSync(archive);
const files = new Map();
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  const fileName = prefix ? `${prefix}/${name}` : name;
  const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
  const dataStart = offset + 512;
  if (dataStart + size > tar.length) throw new Error('Truncated SCOWL archive');
  if (header[156] === 0 || header[156] === 48) files.set(fileName, tar.subarray(dataStart, dataStart + size));
  offset = dataStart + Math.ceil(size / 512) * 512;
}
const main = new Set();
const all = new Set();
const inputs = [];
for (const [fileName, data] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  const match = /^scowl-2020\.12\.07\/final\/([^/]+)-words\.(\d+)$/.exec(fileName);
  if (!match || !categories.includes(match[1]) || Number(match[2]) > 80) continue;
  const size = Number(match[2]);
  const words = data.toString('latin1').split(/\r?\n/).filter(word => /^[a-z]{4,16}$/.test(word));
  inputs.push({ file: fileName.replace('scowl-2020.12.07/', ''), sha256: sha256(data), accepted: words.length });
  for (const sourceWord of words) {
    const word = sourceWord.toUpperCase();
    all.add(word);
    if (size <= 60) main.add(word);
  }
}
if (inputs.length !== 54 || main.size < 70_000 || all.size < 200_000) throw new Error(`Unexpected SCOWL category coverage: ${inputs.length} files, ${main.size} main words, ${all.size} total words`);
const mainWords = [...main].sort();
const bonusWords = [...all].filter(word => !main.has(word)).sort();
const mainCompact = mainWords.join('\n');
const bonusCompact = bonusWords.join('\n');
const license = files.get('scowl-2020.12.07/Copyright');
if (!license) throw new Error('SCOWL Copyright file missing');
const wordHistogram = words => Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 4, words.filter(word => word.length === i + 4).length]));
const manifest = {
  id: version,
  project: 'SCOWL (Spell Checker Oriented Word Lists)',
  upstreamVersion: '2020.12.07',
  upstreamTag: 'rel-2020.12.07',
  upstreamRepository: 'https://github.com/en-wl/wordlist/tree/rel-2020.12.07',
  upstreamRelease: 'https://sourceforge.net/projects/wordlist/files/SCOWL/2020.12.07/',
  archiveUrl,
  archiveSha256: archiveHash,
  archiveBytes: archive.length,
  license: 'SCOWL collective MIT-like license and included source notices; complete text in public/dictionary-license.txt',
  transformation: {
    categories,
    subcategory: 'words only; excludes upper, proper-names, abbreviations, contractions, and special lists',
    normalization: 'Accept only lowercase ASCII a-z, length 4 through 16, then uppercase, deduplicate and sort. No accents removed; no punctuation or names lowercased.',
    main: 'Union of selected categories at sizes 10, 20, 35, 40, 50, 55 and 60',
    bonus: 'Selected category sizes 70 and 80, excluding every main word',
    spelling: 'American and British (-ise and -ize), including level-1 near-equal spelling variants',
  },
  output: {
    mainWords: mainWords.length,
    bonusWords: bonusWords.length,
    mainSha256: sha256(mainCompact),
    bonusSha256: sha256(bonusCompact),
    mainByLength: wordHistogram(mainWords),
    bonusByLength: wordHistogram(bonusWords),
  },
  inputs,
};
const source = `// Generated by scripts/build-dictionary.mjs; do not edit by hand.\n// SCOWL 2020.12.07, Copyright Kevin Atkinson and contributors.\n// Full source notices: public/dictionary-license.txt; provenance: data/dictionary-sources.json.\n// Server-only dictionary: do not import into client components.\nexport const DICTIONARY_VERSION = ${JSON.stringify(version)};\nexport const MAIN_WORDS_COMPACT = \`${mainCompact}\`;\nexport const BONUS_WORDS_COMPACT = \`${bonusCompact}\`;\n`;
const licensePreamble = `Squares Duel random-board dictionary\n\nSource: SCOWL 2020.12.07 (Kevin Atkinson and contributors)\nhttps://github.com/en-wl/wordlist/tree/rel-2020.12.07\nhttps://sourceforge.net/projects/wordlist/files/SCOWL/2020.12.07/\n\nThe game uses lowercase ASCII words of 4–16 letters, uppercased for display.\nOrdinary words: SCOWL sizes up to 60. Bonus words: incremental sizes 70 and 80.\nAmerican and British (-ise and -ize) spellings and level-1 variants are accepted.\nProper-name, uppercase, abbreviation, contraction, and special lists are excluded.\nThis is an independent game dictionary, not the official Squares answer dictionary.\n\nPinned archive SHA-256: ${archiveHash}\nReproduction instructions: node scripts/build-dictionary.mjs\nProvenance and per-file checksums: data/dictionary-sources.json in the source.\n\nThe full original SCOWL Copyright notice follows unchanged:\n\n`;
await mkdir(path.join(root, 'data'), { recursive: true });
await Promise.all([
  writeFile(path.join(root, 'lib/dictionary-data.ts'), source),
  writeFile(path.join(root, 'data/dictionary-sources.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  writeFile(path.join(root, 'public/dictionary-license.txt'), Buffer.concat([Buffer.from(licensePreamble), license])),
]);
console.log(JSON.stringify({ version, ...manifest.output, sourceBytes: Buffer.byteLength(source) }, null, 2));
