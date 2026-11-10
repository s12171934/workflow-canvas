import type { Rect } from './model.ts';

/**
 * Orthogonal edge routing that keeps connections off the cards they do not belong to.
 *
 * An edge leaves its source to the right and enters its target from the left (the canvas handles sit there).
 * - The plain three-segment route (out, across at the middle, in) is kept whenever it is clear: the usual look.
 * - Otherwise an A* search runs over a sparse grid made of the obstacles' padded borders and the two endpoints,
 *   paying for length plus a penalty per bend, so detours stay short and straight.
 * Obstacles are padded so a line never grazes a card; an obstacle that already holds an endpoint's stub is
 * ignored (cards packed tightly), otherwise no route would exist.
 */
export type Point = { x: number; y: number };
export const routeGap = { stub: 20, pad: 12, bend: 40, radius: 8 } as const;

type Box = { l: number; r: number; t: number; b: number };

const padded = (rect: Rect, pad: number): Box => ({ l: rect.x - pad, r: rect.x + rect.width + pad, t: rect.y - pad, b: rect.y + rect.height + pad });
const inside = (box: Box, point: Point) => point.x > box.l && point.x < box.r && point.y > box.t && point.y < box.b;

/** Does the axis-aligned segment a→b pass through a box's interior (touching its border is fine)? */
function crosses(box: Box, a: Point, b: Point): boolean {
  if (a.y === b.y) return a.y > box.t && a.y < box.b && Math.min(a.x, b.x) < box.r && Math.max(a.x, b.x) > box.l;
  if (a.x === b.x) return a.x > box.l && a.x < box.r && Math.min(a.y, b.y) < box.b && Math.max(a.y, b.y) > box.t;
  return true;
}
const clear = (boxes: Box[], points: Point[]) => points.every((point, index) => index === 0 || !boxes.some((box) => crosses(box, points[index - 1], point)));

/** Drop repeated points and the middle of straight runs. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = out[out.length - 2];
    if (before && last && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) out.pop();
    out.push(point);
  }
  return out;
}

/** Route from a right-side source handle to a left-side target handle around the given cards (absolute rects). */
export function routeEdge(source: Point, target: Point, obstacles: Rect[]): Point[] {
  const { stub, pad, bend } = routeGap;
  const start = { x: source.x + stub, y: source.y };
  const end = { x: target.x - stub, y: target.y };
  const boxes = obstacles.map((rect) => padded(rect, pad)).filter((box) => !inside(box, start) && !inside(box, end));
  const wrap = (middle: Point[]) => simplify([source, start, ...middle, end, target]);

  // The usual look first: forward edges turn once at the middle.
  if (end.x >= start.x) {
    const midX = (start.x + end.x) / 2;
    const plain = wrap([{ x: midX, y: start.y }, { x: midX, y: end.y }]);
    if (clear(boxes, plain)) return plain;
  }

  const xs = [...new Set([start.x, end.x, (start.x + end.x) / 2, ...boxes.flatMap((box) => [box.l, box.r])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, (start.y + end.y) / 2, ...boxes.flatMap((box) => [box.t, box.b])])].sort((a, b) => a - b);
  const width = xs.length, height = ys.length;
  const at = (i: number, j: number) => j * width + i;
  const blockedPoint = new Uint8Array(width * height);
  const blockedRight = new Uint8Array(width * height); // segment (i,j)→(i+1,j)
  const blockedDown = new Uint8Array(width * height); // segment (i,j)→(i,j+1)
  for (const box of boxes) {
    for (let j = 0; j < height; j += 1) {
      const y = ys[j];
      for (let i = 0; i < width; i += 1) {
        const x = xs[i];
        if (x > box.l && x < box.r && y > box.t && y < box.b) blockedPoint[at(i, j)] = 1;
        if (i + 1 < width && y > box.t && y < box.b && x >= box.l && xs[i + 1] <= box.r) blockedRight[at(i, j)] = 1;
        if (j + 1 < height && x > box.l && x < box.r && y >= box.t && ys[j + 1] <= box.b) blockedDown[at(i, j)] = 1;
      }
    }
  }

  // Directions: 0 right, 1 down, 2 left, 3 up. A state is a grid point plus the direction it was entered in.
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
  const startAt = at(xs.indexOf(start.x), ys.indexOf(start.y));
  const goalAt = at(xs.indexOf(end.x), ys.indexOf(end.y));
  const goalI = goalAt % width, goalJ = Math.floor(goalAt / width);
  const cost = new Float64Array(width * height * 4).fill(Infinity);
  const from = new Int32Array(width * height * 4).fill(-1);
  const heap = new MinHeap();
  const guess = (i: number, j: number) => Math.abs(xs[i] - xs[goalI]) + Math.abs(ys[j] - ys[goalJ]);
  cost[startAt * 4] = 0;
  heap.push(guess(startAt % width, Math.floor(startAt / width)), startAt * 4);
  let found = -1;
  while (heap.size) {
    const { priority, value: state } = heap.pop();
    const cell = state >> 2, dir = state & 3;
    const i = cell % width, j = Math.floor(cell / width);
    if (priority > cost[state] + guess(i, j) + 1e-9) continue; // stale entry
    if (cell === goalAt) { found = state; break; }
    for (let next = 0; next < 4; next += 1) {
      if (next === (dir + 2) % 4) continue;
      const ni = i + step[next][0], nj = j + step[next][1];
      if (ni < 0 || nj < 0 || ni >= width || nj >= height) continue;
      const target = at(ni, nj);
      if (blockedPoint[target] && target !== goalAt) continue;
      if (next === 0 && blockedRight[cell]) continue;
      if (next === 2 && blockedRight[target]) continue;
      if (next === 1 && blockedDown[cell]) continue;
      if (next === 3 && blockedDown[target]) continue;
      // Entering the target card must end heading right, so arriving any other way costs a bend.
      const g = cost[state] + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (next !== dir ? bend : 0) + (target === goalAt && next !== 0 ? bend : 0);
      const key = target * 4 + next;
      if (g >= cost[key]) continue;
      cost[key] = g; from[key] = state;
      heap.push(g + guess(ni, nj), key);
    }
  }
  if (found < 0) {
    // Boxed in: fall back to the plain shape so the edge still shows.
    if (end.x >= start.x) return wrap([{ x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }]);
    const midY = (start.y + end.y) / 2;
    return wrap([{ x: start.x, y: midY }, { x: end.x, y: midY }]);
  }
  const middle: Point[] = [];
  for (let state = found; state >= 0; state = from[state]) { const cell = state >> 2; middle.unshift({ x: xs[cell % width], y: ys[Math.floor(cell / width)] }); }
  return wrap(middle);
}

/** SVG path through the points with rounded corners. */
export function roundedPath(points: Point[], radius: number = routeGap.radius): string {
  if (!points.length) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1], point = points[index], next = points[index + 1];
    const r = Math.min(radius, Math.hypot(point.x - prev.x, point.y - prev.y) / 2, Math.hypot(next.x - point.x, next.y - point.y) / 2);
    const toward = (other: Point) => { const length = Math.hypot(other.x - point.x, other.y - point.y) || 1; return { x: point.x + (other.x - point.x) / length * r, y: point.y + (other.y - point.y) / length * r }; };
    const a = toward(prev), b = toward(next);
    d += ` L ${a.x} ${a.y} Q ${point.x} ${point.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

/** The point halfway along the route, where the label goes. */
export function midpoint(points: Point[]): Point {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
  let left = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    if (left <= lengths[index]) {
      const a = points[index], b = points[index + 1], t = lengths[index] ? left / lengths[index] : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= lengths[index];
  }
  return points[0] ?? { x: 0, y: 0 };
}

class MinHeap {
  private items: { priority: number; value: number }[] = [];
  get size() { return this.items.length; }
  push(priority: number, value: number) {
    const items = this.items; items.push({ priority, value });
    for (let index = items.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (items[parent].priority <= items[index].priority) break;
      [items[parent], items[index]] = [items[index], items[parent]]; index = parent;
    }
  }
  pop() {
    const items = this.items, top = items[0], last = items.pop()!;
    if (items.length) {
      items[0] = last;
      for (let index = 0; ;) {
        const left = index * 2 + 1, right = left + 1;
        let smallest = index;
        if (left < items.length && items[left].priority < items[smallest].priority) smallest = left;
        if (right < items.length && items[right].priority < items[smallest].priority) smallest = right;
        if (smallest === index) break;
        [items[smallest], items[index]] = [items[index], items[smallest]]; index = smallest;
      }
    }
    return top;
  }
}
