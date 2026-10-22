import { MAIN_WORDS_COMPACT, BONUS_WORDS_COMPACT, DICTIONARY_VERSION } from './dictionary-data';
import { puzzles } from './puzzles';

export type GeneratedPuzzle = {
  board: string[];
  words: string[];
  bonus: string[];
  generatorVersion: string;
};
type WordCount = 'any' | 'small' | 'medium' | 'large';
type GeneratorOptions = { random?: () => number; maxAttempts?: number };

// Dice supply English letter frequencies for the remaining cells. A randomly
// chosen ordinary long word is embedded along a random self-avoiding route;
// the complete solved board must then satisfy both count and quality limits.
// Q remains a single letter, as it does on the existing Squares board.
const DICE = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS', 'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW', 'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ',
] as const;
const MAX_ATTEMPTS = 160;
const GENERATOR_VERSION = `long-dice-v2:${DICTIONARY_VERSION}`;
const NEIGHBORS = Uint16Array.from({ length: 16 }, (_, tile) => {
  let mask = 0;
  for (let next = 0; next < 16; next++) {
    if (next !== tile && Math.abs((next >> 2) - (tile >> 2)) <= 1 && Math.abs((next & 3) - (tile & 3)) <= 1) mask |= 1 << next;
  }
  return mask;
});

export function canonicalBoardSignature(board: unknown): string | null {
  if (typeof board !== 'string' && !Array.isArray(board)) return null;
  let letters: string[] = typeof board === 'string' ? board.trim().toUpperCase().split('') : [...board];
  if (letters.length !== 16 || letters.some(letter => typeof letter !== 'string' || !/^[A-Z]$/i.test(letter))) return null;
  letters = letters.map(letter => letter.toUpperCase());
  let least = letters.join('');
  for (let turn = 0; turn < 4; turn++) {
    const straight = letters.join('');
    const mirrored = letters.map((_, index) => letters[(index & ~3) + 3 - (index & 3)]).join('');
    if (straight < least) least = straight;
    if (mirrored < least) least = mirrored;
    letters = Array.from({ length: 16 }, (_, index) => letters[(3 - (index & 3)) * 4 + (index >> 2)]);
  }
  return least;
}

type Trie = { first: Uint32Array; next: Uint32Array; letter: Uint8Array; terminal: Int32Array };
let cachedTrie: Trie | undefined;
let cachedLongWordSeeds: Uint32Array[] | undefined;

function dictionaryWord(data: string, offset: number) {
  const end = data.indexOf('\n', offset);
  return data.slice(offset, end < 0 ? data.length : end);
}

function getLongWordSeeds() {
  if (cachedLongWordSeeds) return cachedLongWordSeeds;
  const offsets: number[][] = [[], [], []];
  for (let offset = 0; offset < MAIN_WORDS_COMPACT.length;) {
    const word = dictionaryWord(MAIN_WORDS_COMPACT, offset);
    // Avoid favouring an eight-letter plural of a seven-letter word merely to
    // satisfy the long-word requirement. The finished dictionary still includes
    // every valid plural and every other accepted word.
    if (word.length >= 8 && word.length <= 10 && !word.endsWith('S')) offsets[word.length - 8].push(offset);
    offset += word.length + 1;
  }
  cachedLongWordSeeds = offsets.map(group => Uint32Array.from(group));
  return cachedLongWordSeeds;
}

// The checked-in dictionary strings contain unique, sorted uppercase ASCII
// lines. Merge without splitting/copying hundreds of thousands of words. Each
// terminal stores its word's text offset; a word in both lists is ordinary.
function forEachDictionaryWord(visit: (word: string, terminal: number) => void) {
  let ordinary = 0, extra = 0;
  let main: string | undefined = MAIN_WORDS_COMPACT.length ? dictionaryWord(MAIN_WORDS_COMPACT, ordinary) : undefined;
  let bonus: string | undefined = BONUS_WORDS_COMPACT.length ? dictionaryWord(BONUS_WORDS_COMPACT, extra) : undefined;
  while (main !== undefined || bonus !== undefined) {
    if (main !== undefined && (bonus === undefined || main <= bonus)) {
      visit(main, ordinary + 1);
      if (main === bonus) {
        extra += bonus.length + 1;
        bonus = extra < BONUS_WORDS_COMPACT.length ? dictionaryWord(BONUS_WORDS_COMPACT, extra) : undefined;
      }
      ordinary += main.length + 1;
      main = ordinary < MAIN_WORDS_COMPACT.length ? dictionaryWord(MAIN_WORDS_COMPACT, ordinary) : undefined;
    } else {
      visit(bonus!, -(extra + 1));
      extra += bonus!.length + 1;
      bonus = extra < BONUS_WORDS_COMPACT.length ? dictionaryWord(BONUS_WORDS_COMPACT, extra) : undefined;
    }
  }
}

function commonPrefix(a: string, b: string) {
  let length = 0;
  while (length < a.length && length < b.length && a.charCodeAt(length) === b.charCodeAt(length)) length++;
  return length;
}

function getTrie(): Trie {
  if (cachedTrie) return cachedTrie;
  // Count shared prefixes first, then allocate exactly 13 bytes per node. This
  // avoids the large peak heap of object/Map tries and growing dense arrays.
  let count = 1, previous = '';
  forEachDictionaryWord(word => { count += word.length - commonPrefix(previous, word); previous = word; });
  const trie: Trie = {
    first: new Uint32Array(count), next: new Uint32Array(count),
    letter: new Uint8Array(count), terminal: new Int32Array(count),
  };
  const prefixNodes = new Uint32Array(17);
  let created = 1;
  previous = '';
  forEachDictionaryWord((word, terminal) => {
    const shared = commonPrefix(previous, word);
    for (let depth = shared; depth < word.length; depth++) {
      const parent = prefixNodes[depth], node = created++;
      trie.letter[node] = word.charCodeAt(depth) - 65;
      trie.next[node] = trie.first[parent];
      trie.first[parent] = node;
      prefixNodes[depth + 1] = node;
    }
    trie.terminal[prefixNodes[word.length]] = terminal;
    previous = word;
  });
  cachedTrie = trie;
  return trie;
}

/** Solve the complete dictionary; a tile can occur at most once in a path. */
export function solveBoard(board: readonly string[]): { words: string[]; bonus: string[] } {
  if (board.length !== 16 || board.some(letter => !/^[A-Z]$/.test(letter))) throw new Error('棋盘需要 16 个英文字母。');
  const trie = getTrie();
  const letterTiles = new Uint16Array(26);
  board.forEach((letter, tile) => { letterTiles[letter.charCodeAt(0) - 65] |= 1 << tile; });
  const foundMain = new Set<number>(), foundBonus = new Set<number>();
  const search = (node: number, tile: number, used: number) => {
    const terminal = trie.terminal[node];
    if (terminal > 0) foundMain.add(terminal - 1);
    else if (terminal < 0) foundBonus.add(-terminal - 1);
    const available = NEIGHBORS[tile] & ~used;
    for (let child = trie.first[node]; child; child = trie.next[child]) {
      let nextTiles = available & letterTiles[trie.letter[child]];
      while (nextTiles) {
        const bit = nextTiles & -nextTiles;
        search(child, 31 - Math.clz32(bit), used | bit);
        nextTiles ^= bit;
      }
    }
  };
  for (let child = trie.first[0]; child; child = trie.next[child]) {
    let starts = letterTiles[trie.letter[child]];
    while (starts) {
      const bit = starts & -starts;
      search(child, 31 - Math.clz32(bit), bit);
      starts ^= bit;
    }
  }
  return {
    words: [...foundMain].map(offset => dictionaryWord(MAIN_WORDS_COMPACT, offset)).sort(),
    bonus: [...foundBonus].map(offset => dictionaryWord(BONUS_WORDS_COMPACT, offset)).sort(),
  };
}

function randomIndexFactory(random?: () => number) {
  if (random) return (bound: number) => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机数必须介于 0 和 1 之间。');
    return Math.floor(value * bound);
  };
  const values = new Uint32Array(64);
  let cursor = values.length;
  return (bound: number) => {
    // Reject the incomplete tail so shuffles and die faces have no modulo bias.
    // A 32-bit draw also supports the thousands of possible long-word seeds.
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
    let value: number;
    do {
      if (cursor === values.length) { crypto.getRandomValues(values); cursor = 0; }
      value = values[cursor++];
    } while (value >= limit);
    return value % bound;
  };
}

function randomPath(length: number, pick: (bound: number) => number): number[] | null {
  const first = pick(16), path = [first];
  let budget = 256;
  const visit = (tile: number, used: number): boolean => {
    if (path.length === length) return true;
    let available = NEIGHBORS[tile] & ~used;
    while (available && budget > 0) {
      budget--;
      let count = 0;
      for (let mask = available; mask; mask &= mask - 1) count++;
      let selected = pick(count), choices = available;
      while (selected-- > 0) choices &= choices - 1;
      const bit = choices & -choices, next = 31 - Math.clz32(bit);
      available ^= bit;
      path.push(next);
      if (visit(next, used | bit)) return true;
      path.pop();
    }
    return false;
  };
  return visit(first, 1 << first) ? path : null;
}

function hasLongWordVariety(words: readonly string[]) {
  let sixOrMore = 0, sevenOrMore = 0, eightOrMore = false;
  for (const word of words) {
    if (word.length >= 6) sixOrMore++;
    if (word.length >= 7) sevenOrMore++;
    if (word.length >= 8) eightOrMore = true;
  }
  return eightOrMore && sevenOrMore >= 2 && sixOrMore >= 3;
}

const STATIC_SIGNATURES = new Set(puzzles.map(puzzle => canonicalBoardSignature(puzzle.board)!));

export function generateBoard(wordCount: WordCount = 'any', recentBoards: readonly string[] = [], options: GeneratorOptions = {}): GeneratedPuzzle {
  if (!['any', 'small', 'medium', 'large'].includes(wordCount)) throw new Error('请选择有效的词量档位。');
  const min = wordCount === 'medium' ? 41 : wordCount === 'large' ? 56 : 30;
  const max = wordCount === 'small' ? 40 : wordCount === 'medium' ? 55 : 70;
  const recent = new Set(recentBoards.slice(0, 64).map(canonicalBoardSignature).filter((signature): signature is string => signature !== null));
  const pick = randomIndexFactory(options.random);
  if (options.maxAttempts !== undefined && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1)) throw new Error('随机棋盘的重试次数无效。');
  const attempts = Math.min(MAX_ATTEMPTS, options.maxAttempts ?? MAX_ATTEMPTS);
  const seedGroups = getLongWordSeeds();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const dice = Array.from({ length: 16 }, (_, index) => index);
    for (let last = 15; last > 0; last--) {
      const swap = pick(last + 1);
      [dice[last], dice[swap]] = [dice[swap], dice[last]];
    }
    const board = dice.map(die => DICE[die][pick(6)]);
    const seeds = seedGroups[pick(seedGroups.length)];
    const seed = dictionaryWord(MAIN_WORDS_COMPACT, seeds[pick(seeds.length)]);
    const path = randomPath(seed.length, pick);
    if (!path) continue;
    path.forEach((tile, index) => { board[tile] = seed[index]; });
    const signature = canonicalBoardSignature(board)!;
    if (STATIC_SIGNATURES.has(signature) || recent.has(signature)) continue;
    const solved = solveBoard(board);
    if (solved.words.length >= min && solved.words.length <= max && hasLongWordVariety(solved.words)) return { board, ...solved, generatorVersion: GENERATOR_VERSION };
  }
  throw new Error('暂时未能生成同时符合词量和长词要求的随机棋盘，请重试。');
}
