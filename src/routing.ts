import { calculate } from './core.ts';
import type { Rect } from './model.ts';
export type Point = { x: number; y: number };
export const routeGap = { stub: 20, pad: 12, bend: 40, radius: 8 } as const;
export function simplify(points: Point[]): Point[] { return calculate('simplify', [points]); }
export function routeEdge(source: Point, target: Point, obstacles: Rect[]): Point[] { return calculate('routeEdge', [source, target, obstacles]); }
export function roundedPath(points: Point[], radius: number = routeGap.radius): string { return calculate('roundedPath', [points, radius]); }
export function midpoint(points: Point[]): Point { return calculate('midpoint', [points]); }
