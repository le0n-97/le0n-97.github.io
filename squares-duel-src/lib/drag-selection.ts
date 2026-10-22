export type DragPoint = { x: number; y: number };
export type DragTarget = DragPoint & { index: number; radius: number };

// Keep tile corners neutral so a diagonal stroke cannot claim a side neighbor.
export const DRAG_HIT_RADIUS = 0.36;

export function traceDragSegment(from: DragPoint, to: DragPoint, targets: DragTarget[]): number[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const hits: { index: number; entry: number }[] = [];
  for (const target of targets) {
    const ox = from.x - target.x;
    const oy = from.y - target.y;
    const outside = ox * ox + oy * oy - target.radius * target.radius;
    if (outside <= 0) {
      hits.push({ index: target.index, entry: 0 });
      continue;
    }
    if (lengthSquared === 0) continue;
    const projection = ox * dx + oy * dy;
    const discriminant = projection * projection - lengthSquared * outside;
    if (discriminant < 0) continue;
    const entry = (-projection - Math.sqrt(discriminant)) / lengthSquared;
    if (entry >= 0 && entry <= 1) hits.push({ index: target.index, entry });
  }
  return hits.sort((a, b) => a.entry - b.entry).map(hit => hit.index);
}
