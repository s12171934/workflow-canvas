import { test } from 'node:test';
import assert from 'node:assert/strict';
import { midpoint, roundedPath, routeEdge, routeGap, type Point } from './routing.ts';
import type { Rect } from './model.ts';

/** Does any segment of the route pass through a card's interior? */
function hits(points: Point[], rects: Rect[]): boolean {
  return points.slice(1).some((b, index) => {
    const a = points[index];
    return rects.some((rect) => {
      const l = rect.x, r = rect.x + rect.width, t = rect.y, bottom = rect.y + rect.height;
      if (a.y === b.y) return a.y > t && a.y < bottom && Math.min(a.x, b.x) < r && Math.max(a.x, b.x) > l;
      return a.x > l && a.x < r && Math.min(a.y, b.y) < bottom && Math.max(a.y, b.y) > t;
    });
  });
}
const orthogonal = (points: Point[]) => points.slice(1).every((b, index) => b.x === points[index].x || b.y === points[index].y);

test('a clear forward edge keeps the plain middle turn', () => {
  const route = routeEdge({ x: 0, y: 0 }, { x: 200, y: 100 }, []);
  assert.deepEqual(route, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
});

test('a straight edge stays straight when nothing is in the way', () => {
  assert.deepEqual(routeEdge({ x: 0, y: 50 }, { x: 400, y: 50 }, [{ x: 100, y: 200, width: 100, height: 100 }]), [{ x: 0, y: 50 }, { x: 400, y: 50 }]);
});

test('an edge goes around a card standing between its ends', () => {
  const card = { x: 150, y: 0, width: 254, height: 150 };
  const route = routeEdge({ x: 0, y: 75 }, { x: 600, y: 75 }, [card]);
  assert.ok(orthogonal(route));
  assert.ok(!hits(route, [{ x: card.x - routeGap.pad + 1, y: card.y - routeGap.pad + 1, width: card.width + 2 * routeGap.pad - 2, height: card.height + 2 * routeGap.pad - 2 }]));
  assert.deepEqual(route[0], { x: 0, y: 75 });
  assert.deepEqual(route.at(-1), { x: 600, y: 75 });
});

test('the middle turn moves off a card sitting on it', () => {
  // Source (0,0)-(254,150) right handle (254,75); target at x 700 lower down; a card blocks the middle column.
  const cards = [{ x: 0, y: 0, width: 254, height: 150 }, { x: 700, y: 300, width: 254, height: 150 }, { x: 400, y: 100, width: 150, height: 300 }];
  const route = routeEdge({ x: 254, y: 75 }, { x: 700, y: 375 }, cards);
  assert.ok(orthogonal(route));
  assert.ok(!hits(route, cards));
});

test('a loop edge back to an earlier card goes around both ends', () => {
  const source = { x: 400, y: 0, width: 254, height: 150 }, target = { x: 0, y: 0, width: 254, height: 150 };
  const route = routeEdge({ x: 654, y: 75 }, { x: 0, y: 75 }, [source, target]);
  assert.ok(orthogonal(route));
  assert.ok(!hits(route, [source, target]));
});

test('a walled-in end still gets a route', () => {
  const route = routeEdge({ x: 0, y: 0 }, { x: 300, y: 0 }, [{ x: -1000, y: -1000, width: 3000, height: 990 }, { x: -1000, y: 10, width: 3000, height: 990 }]);
  assert.ok(route.length >= 2);
});

test('rounded path and label point', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.equal(roundedPath(points), 'M 0 0 L 92 0 Q 100 0 100 8 L 100 100');
  assert.deepEqual(midpoint(points), { x: 100, y: 0 });
});
