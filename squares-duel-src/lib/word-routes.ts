const neighbours = Array.from({ length: 16 }, (_, tile) =>
  Array.from({ length: 16 }, (_, next) => next).filter(next => next !== tile
    && Math.abs(Math.floor(tile / 4) - Math.floor(next / 4)) <= 1
    && Math.abs(tile % 4 - next % 4) <= 1));

type WordRoute = { path: number[]; usableMask: number; bonus: boolean };
const routeCache = new Map<string, Map<string, WordRoute>>();

// Index order defines one stable canonical route, independent of how a player
// selected the word or rotated their view.
export function canonicalWordPath(board: readonly string[], word: string): number[] | null {
  if (!word || word.length > 16 || board.length !== 16) return null;
  const failed = new Set<number>();
  const path: number[] = [];
  const visit = (tile: number, offset: number, used: number): boolean => {
    const bit = 1 << tile;
    if ((used & bit) || board[tile] !== word[offset]) return false;
    const mask = used | bit;
    const key = mask * 16 + tile;
    if (failed.has(key)) return false;
    path.push(tile);
    if (offset === word.length - 1) return true;
    for (const next of neighbours[tile]) if (visit(next, offset + 1, mask)) return true;
    path.pop();
    failed.add(key);
    return false;
  };
  for (let tile = 0; tile < 16; tile++) if (visit(tile, 0, 0)) return [...path];
  return null;
}

export function wordRoutes(board: readonly string[], words: readonly string[], bonus: readonly string[]) {
  const key = `${board.join('')}:${words.join(',')}:${bonus.join(',')}`;
  const cached = routeCache.get(key);
  if (cached) {
    routeCache.delete(key);
    routeCache.set(key, cached);
    return cached;
  }
  const routes = new Map<string, WordRoute>();
  for (const [list, isBonus] of [[words, false], [bonus, true]] as const) for (const word of list) {
    const path = canonicalWordPath(board, word);
    if (!path) throw new Error('A puzzle answer has no valid board route.');
    const usableMask = path.reduce((mask, tile) => mask | (1 << tile), 0);
    routes.set(word, { path, usableMask, bonus: isBonus });
  }
  routeCache.set(key, routes);
  if (routeCache.size > 32) routeCache.delete(routeCache.keys().next().value!);
  return routes;
}
