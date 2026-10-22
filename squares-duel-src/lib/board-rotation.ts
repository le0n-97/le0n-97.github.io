// Indices stay in the shared board's coordinates; only the local view rotates.
export function rotateIndex(index: number, quarterTurns: number): number {
  let row = Math.floor(index / 4);
  let column = index % 4;
  const turns = ((quarterTurns % 4) + 4) % 4;
  for (let turn = 0; turn < turns; turn++) [row, column] = [column, 3 - row];
  return row * 4 + column;
}

export function displayedBoardIndices(quarterTurns: number): number[] {
  return Array.from({ length: 16 }, (_, position) => rotateIndex(position, -quarterTurns));
}
