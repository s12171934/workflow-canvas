import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { autoLayout, estimatedSize } from './layout.ts';
import type { StageNode, WorkflowEdge } from './model.ts';

const stage = (id: string, extra: Partial<StageNode> = {}, data: Partial<StageNode['data']> = {}): StageNode =>
  ({ id, type: 'stage', position: { x: 0, y: 0 }, ...extra, data: { label: id, description: '', kind: 'worker', ...data } });
const edge = (source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge => ({ id: `${source}-${target}`, source, target, ...extra });

/** Absolute rectangles (group children are relative to their group). */
function rects(nodes: StageNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const at = (node: StageNode): { x: number; y: number } => {
    const parent = node.parentId ? at(byId.get(node.parentId)!) : { x: 0, y: 0 };
    return { x: parent.x + node.position.x, y: parent.y + node.position.y };
  };
  return new Map(nodes.map((node) => [node.id, { ...at(node), ...estimatedSize(node) }]));
}
function overlaps(nodes: StageNode[]): string[] {
  const all = [...rects(nodes)];
  const found: string[] = [];
  const contains = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
  for (let i = 0; i < all.length; i += 1) for (let j = i + 1; j < all.length; j += 1) {
    const [ia, a] = all[i], [ib, b] = all[j];
    if (contains(a, b) || contains(b, a)) continue;
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) found.push(`${ia}/${ib}`);
  }
  return found;
}

test('lays a DAG out left to right without overlaps, centring a stage between what it joins', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => stage(id));
  const out = autoLayout(nodes, [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]);
  const at = new Map(out.map((node) => [node.id, node.position]));
  assert.ok(at.get('a')!.x < at.get('b')!.x && at.get('b')!.x === at.get('c')!.x && at.get('c')!.x < at.get('d')!.x);
  assert.deepEqual(overlaps(out), []);
  const middle = (at.get('b')!.y + at.get('c')!.y) / 2;
  assert.ok(Math.abs(at.get('a')!.y - middle) <= 1 && Math.abs(at.get('d')!.y - middle) <= 1);
  // Columns follow card widths, not a fixed grid.
  assert.equal(at.get('b')!.x - at.get('a')!.x, 254 + 70);
});

test('keeps branch outputs in port order, ignores loop edges, and pulls a source next to what it feeds', () => {
  const nodes = [stage('start'), stage('pick', {}, { kind: 'branch', outputs: [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }] }),
    stage('no-path'), stage('yes-path'), stage('end'), stage('late-input')];
  const edges = [edge('start', 'pick'), edge('pick', 'no-path', { sourceHandle: 'no' }), edge('pick', 'yes-path', { sourceHandle: 'yes' }),
    edge('no-path', 'end'), edge('yes-path', 'end'), edge('end', 'start', { loop: { max: 2, exit: 'no' } }), edge('late-input', 'end')];
  const at = new Map(autoLayout(nodes, edges).map((node) => [node.id, node.position]));
  assert.ok(at.get('yes-path')!.y < at.get('no-path')!.y);
  assert.ok(at.get('start')!.x < at.get('pick')!.x && at.get('pick')!.x < at.get('end')!.x);
  assert.equal(at.get('late-input')!.x, at.get('yes-path')!.x);
});

test('lays group contents out inside the group and shrinks it to fit; cycles do not hang', () => {
  const nodes = [stage('g', { type: 'group', width: 2000, height: 1500 }, { kind: 'group', scope: 'project', path: '' }),
    stage('in1', { parentId: 'g' }), stage('in2', { parentId: 'g' }), stage('before'), stage('after')];
  const out = autoLayout(nodes, [edge('before', 'in1'), edge('in1', 'in2'), edge('in2', 'after'), edge('after', 'before')]);
  const box = rects(out);
  const group = box.get('g')!;
  for (const id of ['in1', 'in2']) {
    const inner = box.get(id)!;
    assert.ok(inner.x >= group.x && inner.y >= group.y && inner.x + inner.width <= group.x + group.width && inner.y + inner.height <= group.y + group.height, id);
  }
  assert.ok(group.width < 2000 && group.height < 1500);
  assert.deepEqual(overlaps(out), []);
});

test('memo groups carry what lies inside them; unconnected nodes are packed below', () => {
  const nodes = [stage('f', { type: 'frame', position: { x: -20, y: -60 }, width: 900, height: 400 }, { kind: 'frame' }),
    stage('x'), stage('y', { position: { x: 320, y: 0 } }), stage('outside', { position: { x: 2000, y: 0 } }), stage('memo', { position: { x: 3000, y: 0 } }, { kind: 'note' })];
  const out = autoLayout(nodes, [edge('x', 'y'), edge('y', 'outside')]);
  const box = rects(out), frame = box.get('f')!;
  for (const id of ['x', 'y']) assert.ok(box.get(id)!.x > frame.x && box.get(id)!.x + box.get(id)!.width < frame.x + frame.width, id);
  assert.ok(box.get('outside')!.x >= frame.x + frame.width);
  assert.ok(box.get('memo')!.y > Math.max(frame.y + frame.height, box.get('outside')!.y + box.get('outside')!.height));
  assert.deepEqual(overlaps(out), []);
});

test('every example lays out without overlaps and no wider than a few screens', () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const graph = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const out = autoLayout(graph.nodes, graph.edges);
    assert.deepEqual(overlaps(out), [], file);
    const all = [...rects(out).values()];
    const width = Math.max(...all.map((r) => r.x + r.width)) - Math.min(...all.map((r) => r.x));
    const height = Math.max(...all.map((r) => r.y + r.height)) - Math.min(...all.map((r) => r.y));
    assert.ok(width / height < 4, `${file} ${width}x${height}`);
  }
});

test('a resized memo keeps its own size; an untouched one fits its text', () => {
  assert.deepEqual(estimatedSize(stage('memo', { width: 420, height: 260 }, { kind: 'note' })), { width: 420, height: 260 });
  assert.deepEqual(estimatedSize(stage('memo', {}, { kind: 'note' })), { width: 254, height: 110 });
});
