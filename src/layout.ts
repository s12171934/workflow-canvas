import { frameContents, isFrame, isGroup, type Rect, type StageNode, type WorkflowEdge } from './model.ts';

/**
 * Compact left-to-right layout (layered / Sugiyama style).
 *
 * - Project·worktree groups and memo groups are laid out as boxes: their contents first, then the box in its parent.
 *   A memo group gathers what lies inside it now (`frameContents`) when that shares its own parent.
 * - Loop edges are ignored; leftover cycles are broken at DFS back edges.
 * - Layers by longest path, sources pulled right next to what they feed; edges spanning several layers get a
 *   virtual point per layer so the ordering keeps them clear of nodes.
 * - Order within a layer by barycenter sweeps (fewest crossings kept); vertical position as close to the
 *   neighbours' average as the order and spacing allow (least-squares, pool-adjacent-violators).
 * - Column width follows the widest node in that column; unconnected parts are stacked, single nodes packed in rows.
 */
export type Size = { width: number; height: number };
export const layoutGap = { column: 70, row: 34, component: 60, band: 90, wrapAfter: 2000, padding: 24, header: 44 } as const;

/** Rendered size of a node when the canvas has not measured it (server side, or before the first paint). */
export function estimatedSize(node: Pick<StageNode, 'data' | 'width' | 'height' | 'measured'>): Size {
  if (node.measured?.width && node.measured?.height) return { width: node.measured.width, height: node.measured.height };
  if (isGroup(node) || isFrame(node)) return { width: node.width ?? 560, height: node.height ?? 320 };
  if (node.data.kind === 'note' && node.width && node.height) return { width: node.width, height: node.height };
  const outputs = node.data.kind === 'branch' ? node.data.outputs?.length ?? 2 : 0;
  return { width: 254, height: node.data.kind === 'note' ? 110 : 150 + outputs * 26 };
}

type Box = { id: string; width: number; height: number; virtual?: boolean; ports?: number };
type Link = { source: string; target: string; port?: number };

export function autoLayout(nodes: StageNode[], edges: WorkflowEdge[], sizeOf: (node: StageNode) => Size = estimatedSize): StageNode[] {
  if (!nodes.length) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Cluster tree: a node's cluster is its group, or the smallest memo group holding it that shares its parent.
  const absolute = absoluteRects(nodes, sizeOf);
  const cluster = new Map<string, string | undefined>(nodes.map((node) => [node.id, node.parentId && byId.has(node.parentId) ? node.parentId : undefined]));
  const frames = nodes.filter(isFrame).sort((a, b) => area(absolute.get(b.id)!) - area(absolute.get(a.id)!));
  for (const frame of frames) {
    for (const id of frameContents(frame.id, nodes, absolute)) {
      if (id === frame.id || cluster.get(id) !== cluster.get(frame.id) || inCluster(cluster, frame.id, id)) continue;
      cluster.set(id, frame.id);
    }
  }
  const children = new Map<string | undefined, StageNode[]>();
  for (const node of nodes) children.set(cluster.get(node.id), [...(children.get(cluster.get(node.id)) ?? []), node]);

  const forward = edges.filter((edge) => !edge.loop && edge.source !== edge.target && byId.has(edge.source) && byId.has(edge.target));
  const placed = new Map<string, { x: number; y: number }>(); // relative to the enclosing cluster's content origin
  const sizes = new Map<string, Size>();

  function arrange(parent: string | undefined): Size {
    const members = children.get(parent) ?? [];
    for (const member of members) {
      if (children.has(member.id)) {
        const inner = arrange(member.id);
        sizes.set(member.id, { width: Math.max(inner.width + 2 * layoutGap.padding, 300), height: Math.max(inner.height + layoutGap.header + layoutGap.padding, 200) });
      } else sizes.set(member.id, (isGroup(member) || isFrame(member)) ? { width: member.width ?? 560, height: member.height ?? 320 } : sizeOf(member));
    }
    const ids = new Set(members.map((member) => member.id));
    // Lift every edge to the members of this cluster that hold its ends.
    const lift = (id: string) => { let at: string | undefined = id; while (at !== undefined && !ids.has(at)) at = cluster.get(at); return at; };
    const links: Link[] = [];
    const seen = new Set<string>();
    for (const edge of forward) {
      const source = lift(edge.source), target = lift(edge.target);
      if (!source || !target || source === target) continue;
      const node = byId.get(edge.source)!;
      const port = source === edge.source && node.data.kind === 'branch' && edge.sourceHandle
        ? Math.max(0, node.data.outputs?.findIndex((output) => output.id === edge.sourceHandle) ?? 0) : undefined;
      const key = `${source}>${target}>${port ?? ''}`;
      if (!seen.has(key)) { seen.add(key); links.push({ source, target, ...(port !== undefined ? { port } : {}) }); }
    }
    const boxes = members.map((member) => ({ id: member.id, ...sizes.get(member.id)!,
      ...(member.data.kind === 'branch' ? { ports: member.data.outputs?.length ?? 2 } : {}) }));
    const result = layered(boxes, links);
    for (const [id, point] of result.positions) placed.set(id, point);
    return result.size;
  }
  arrange(undefined);

  // Back to React Flow coordinates: group children are relative to the group, everything else is absolute.
  const absoluteOf = new Map<string, { x: number; y: number }>();
  const origin = (id: string | undefined): { x: number; y: number } => {
    if (id === undefined) return { x: 0, y: 0 };
    const at = absolutePoint(id);
    return { x: at.x + layoutGap.padding, y: at.y + layoutGap.header };
  };
  function absolutePoint(id: string): { x: number; y: number } {
    const known = absoluteOf.get(id);
    if (known) return known;
    const base = origin(cluster.get(id)), local = placed.get(id) ?? { x: 0, y: 0 };
    const point = { x: base.x + local.x, y: base.y + local.y };
    absoluteOf.set(id, point);
    return point;
  }
  return nodes.map((node) => {
    const at = absolutePoint(node.id);
    const parent = node.parentId && byId.has(node.parentId) ? absolutePoint(node.parentId) : { x: 0, y: 0 };
    const size = sizes.get(node.id)!;
    const box = isGroup(node) || isFrame(node) ? { width: size.width, height: size.height } : {};
    return { ...node, ...box, position: { x: Math.round(at.x - parent.x), y: Math.round(at.y - parent.y) } };
  });
}

const area = (rect: Rect) => rect.width * rect.height;
function inCluster(cluster: Map<string, string | undefined>, inner: string, outer: string): boolean {
  for (let at = cluster.get(inner), depth = 0; at !== undefined && depth < 50; at = cluster.get(at), depth += 1) if (at === outer) return true;
  return false;
}
function absoluteRects(nodes: StageNode[], sizeOf: (node: StageNode) => Size): Map<string, Rect> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rects = new Map<string, Rect>();
  const resolve = (node: StageNode, depth = 0): Rect => {
    const known = rects.get(node.id);
    if (known) return known;
    const parent = node.parentId && depth < 50 ? byId.get(node.parentId) : undefined;
    const base = parent ? resolve(parent, depth + 1) : { x: 0, y: 0 };
    const size = isGroup(node) || isFrame(node) ? { width: node.width ?? node.measured?.width ?? 560, height: node.height ?? node.measured?.height ?? 320 } : sizeOf(node);
    const rect = { x: base.x + node.position.x, y: base.y + node.position.y, ...size };
    rects.set(node.id, rect);
    return rect;
  };
  for (const node of nodes) resolve(node);
  return rects;
}

/** Lays out one cluster's boxes; positions are top-left corners from (0, 0). */
export function layered(boxes: Box[], links: Link[]): { positions: Map<string, { x: number; y: number }>; size: Size } {
  const positions = new Map<string, { x: number; y: number }>();
  if (!boxes.length) return { positions, size: { width: 0, height: 0 } };
  const index = new Map(boxes.map((box, at) => [box.id, at]));
  // Connected components, in input order.
  const parent = boxes.map((_, at) => at);
  const find = (at: number): number => parent[at] === at ? at : (parent[at] = find(parent[at]));
  for (const link of links) parent[find(index.get(link.source)!)] = find(index.get(link.target)!);
  const groups = new Map<number, Box[]>();
  for (const box of boxes) groups.set(find(index.get(box.id)!), [...(groups.get(find(index.get(box.id)!)) ?? []), box]);
  const connected = [...groups.values()].filter((group) => group.length > 1);
  const single = [...groups.values()].filter((group) => group.length === 1).map(([box]) => box);

  const parts: { positions: Map<string, { x: number; y: number }>; size: Size }[] = connected.map((group) => {
    const ids = new Set(group.map((box) => box.id));
    return component(group, links.filter((link) => ids.has(link.source)));
  }).sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height);
  let y = 0, width = 0;
  for (const part of parts) {
    for (const [id, point] of part.positions) positions.set(id, { x: point.x, y: point.y + y });
    y += part.size.height + layoutGap.component;
    width = Math.max(width, part.size.width);
  }
  // Single nodes: rows as wide as the graph above (at least three nodes wide).
  if (single.length) {
    const limit = Math.max(width, 3 * 254 + 2 * layoutGap.column);
    let x = 0, rowHeight = 0;
    for (const box of single) {
      if (x > 0 && x + box.width > limit) { x = 0; y += rowHeight + layoutGap.row; rowHeight = 0; }
      positions.set(box.id, { x, y });
      x += box.width + layoutGap.column; rowHeight = Math.max(rowHeight, box.height);
      width = Math.max(width, x - layoutGap.column);
    }
    y += rowHeight + layoutGap.component;
  }
  return { positions, size: { width, height: Math.max(0, y - layoutGap.component) } };
}

function component(boxes: Box[], links: Link[]): { positions: Map<string, { x: number; y: number }>; size: Size } {
  const ids = boxes.map((box) => box.id);
  const order = new Map(ids.map((id, at) => [id, at]));
  // Break cycles at DFS back edges.
  const out = new Map<string, Link[]>(ids.map((id) => [id, []]));
  for (const link of links) out.get(link.source)!.push(link);
  const state = new Map<string, number>();
  const acyclic: Link[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const link of out.get(id)!) {
      const s = state.get(link.target);
      if (s === 1) continue;
      acyclic.push(link);
      if (!s) visit(link.target);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) visit(id);

  // Longest-path layers, then sources moved right up against their earliest successor.
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const link of acyclic) { preds.get(link.target)!.push(link.source); succs.get(link.source)!.push(link.target); }
  const layer = new Map<string, number>();
  const layerOf = (id: string, depth = 0): number => {
    if (layer.has(id)) return layer.get(id)!;
    const value = depth > ids.length ? 0 : Math.max(-1, ...preds.get(id)!.map((p) => layerOf(p, depth + 1))) + 1;
    layer.set(id, value);
    return value;
  };
  for (const id of ids) layerOf(id);
  for (const id of ids) if (!preds.get(id)!.length && succs.get(id)!.length) layer.set(id, Math.min(...succs.get(id)!.map((s) => layer.get(s)!)) - 1);

  // Virtual points on long edges.
  const size = new Map<string, Box>(boxes.map((box) => [box.id, box]));
  const chainLinks: Link[] = [];
  let virtualCount = 0;
  for (const link of acyclic) {
    let from = link.source, port = link.port;
    for (let at = layer.get(link.source)! + 1; at < layer.get(link.target)!; at += 1) {
      const id = `\u0000v${virtualCount++}`;
      size.set(id, { id, width: 0, height: 8, virtual: true });
      layer.set(id, at);
      chainLinks.push({ source: from, target: id, ...(port !== undefined ? { port } : {}) });
      from = id; port = undefined;
    }
    chainLinks.push({ source: from, target: link.target, ...(port !== undefined ? { port } : {}) });
  }
  const layerCount = Math.max(...layer.values()) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  // Initial order: DFS from sources so chains stay together.
  const up = new Map<string, Link[]>(), down = new Map<string, Link[]>();
  for (const id of size.keys()) { up.set(id, []); down.set(id, []); }
  for (const link of chainLinks) { down.get(link.source)!.push(link); up.get(link.target)!.push(link); }
  const placedInit = new Set<string>();
  const seed = (id: string) => {
    if (placedInit.has(id)) return;
    placedInit.add(id); layers[layer.get(id)!].push(id);
    for (const link of [...down.get(id)!].sort((a, b) => (a.port ?? 0) - (b.port ?? 0))) seed(link.target);
  };
  for (const id of ids) if (!up.get(id)!.length) seed(id);
  for (const id of size.keys()) seed(id);

  // Crossing reduction: barycenter sweeps with port-aware positions, best ordering kept.
  const portOffset = (link: Link) => {
    const ports = size.get(link.source)!.ports;
    return link.port !== undefined && ports ? (link.port + 0.5) / ports - 0.5 : 0;
  };
  const rank = () => { const map = new Map<string, number>(); for (const items of layers) items.forEach((id, at) => map.set(id, at)); return map; };
  const crossings = () => {
    const at = rank(); let count = 0;
    for (let l = 0; l + 1 < layerCount; l += 1) {
      const segments = layers[l].flatMap((id) => down.get(id)!.map((link) => [at.get(id)! + portOffset(link), at.get(link.target)!]));
      for (let i = 0; i < segments.length; i += 1) for (let j = i + 1; j < segments.length; j += 1)
        if ((segments[i][0] - segments[j][0]) * (segments[i][1] - segments[j][1]) < 0) count += 1;
    }
    return count;
  };
  let best = layers.map((items) => [...items]), bestCount = crossings();
  for (let sweep = 0; sweep < 12 && bestCount > 0; sweep += 1) {
    const downward = sweep % 2 === 0;
    for (let step = 0; step < layerCount; step += 1) {
      const l = downward ? step : layerCount - 1 - step;
      const at = rank();
      const center = (id: string) => {
        const list = downward ? up.get(id)!.map((link) => at.get(link.source)! + portOffset(link))
          : down.get(id)!.map((link) => at.get(link.target)! - portOffset(link));
        return list.length ? list.reduce((a, b) => a + b, 0) / list.length : at.get(id)!;
      };
      const keyed = layers[l].map((id) => ({ id, key: center(id), was: at.get(id)! }));
      keyed.sort((a, b) => a.key - b.key || a.was - b.was);
      layers[l] = keyed.map((item) => item.id);
    }
    const count = crossings();
    if (count < bestCount) { bestCount = count; best = layers.map((items) => [...items]); }
  }
  layers.splice(0, layers.length, ...best);

  // Vertical placement: each node near the mean of its neighbours' anchor points, order and spacing kept.
  const y = new Map<string, number>();
  const gapBetween = (a: string, b: string) => size.get(a)!.virtual && size.get(b)!.virtual ? 12 : layoutGap.row;
  const stack = (items: string[]) => { let at = 0; for (const id of items) { y.set(id, at); at += size.get(id)!.height + layoutGap.row; } };
  stack(layers[0]);
  const anchor = (link: Link, side: 'source' | 'target') => {
    const id = link[side], box = size.get(id)!;
    if (side === 'source' && link.port !== undefined && box.ports) return y.get(id)! + box.height * (0.45 + 0.5 * (link.port + 0.5) / box.ports);
    return y.get(id)! + box.height / 2;
  };
  const settle = (items: string[], want: (id: string) => number | undefined) => {
    const desired = items.map((id) => { const w = want(id); return w === undefined ? y.get(id) ?? 0 : w - size.get(id)!.height / 2; });
    // Pool adjacent violators: blocks keep minimal spacing, each block at the mean of what its members want.
    const blocks: { start: number; end: number; sum: number; count: number }[] = [];
    const offset: number[] = [];
    for (let i = 0; i < items.length; i += 1) offset.push(i === 0 ? 0 : offset[i - 1] + size.get(items[i - 1])!.height + gapBetween(items[i - 1], items[i]));
    for (let i = 0; i < items.length; i += 1) {
      blocks.push({ start: i, end: i, sum: desired[i] - offset[i], count: 1 });
      while (blocks.length > 1) {
        const last = blocks[blocks.length - 1], prev = blocks[blocks.length - 2];
        if (prev.sum / prev.count <= last.sum / last.count) break;
        blocks.splice(blocks.length - 2, 2, { start: prev.start, end: last.end, sum: prev.sum + last.sum, count: prev.count + last.count });
      }
    }
    for (const block of blocks) for (let i = block.start; i <= block.end; i += 1) y.set(items[i], block.sum / block.count + offset[i]);
  };
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
  // Where a node's centre should be so its edges run straight (a branch output port is off its centre).
  const portShift = (link: Link) => anchor(link, 'source') - y.get(link.source)! - size.get(link.source)!.height / 2;
  const fromUp = (id: string) => up.get(id)!.map((link) => anchor(link, 'source'));
  const fromDown = (id: string) => down.get(id)!.map((link) => anchor(link, 'target') - portShift(link));
  for (let l = 1; l < layerCount; l += 1) settle(layers[l], (id) => mean(fromUp(id)));
  for (let round = 0; round < 4; round += 1) {
    for (let l = layerCount - 2; l >= 0; l -= 1) settle(layers[l], (id) => mean([...fromDown(id), ...fromUp(id)]));
    for (let l = 1; l < layerCount; l += 1) settle(layers[l], (id) => mean([...fromUp(id), ...fromDown(id)]));
  }

  // Columns as wide as their widest node; a long chain wraps into bands (rows of columns) when that fits a screen better.
  const columnWidth = layers.map((items) => Math.max(0, ...items.map((id) => size.get(id)!.width)));
  const real = layers.map((items) => items.filter((id) => !size.get(id)!.virtual));
  const extent = (from: number, to: number) => {
    const items = real.slice(from, to).flat();
    return { top: Math.min(...items.map((id) => y.get(id)!)), bottom: Math.max(...items.map((id) => y.get(id)! + size.get(id)!.height)) };
  };
  const spanWidth = (from: number, to: number) => columnWidth.slice(from, to).reduce((a, b) => a + b, 0) + (to - from - 1) * layoutGap.column;
  const plan = (count: number) => {
    const target = spanWidth(0, layerCount) / count;
    const bands: [number, number][] = [];
    let start = 0;
    for (let l = 1; l <= layerCount; l += 1) {
      const left = count - bands.length - 1;
      if (l === layerCount || (left > 0 && spanWidth(start, l + 1) > target && layerCount - l >= left)) { bands.push([start, l]); start = l; }
    }
    const width = Math.max(...bands.map(([from, to]) => spanWidth(from, to)));
    const height = bands.reduce((sum, [from, to]) => sum + extent(from, to).bottom - extent(from, to).top, 0) + (bands.length - 1) * layoutGap.band;
    // A band of a single ordinary column reads as a stray card, not a row.
    const thin = bands.some(([from, to]) => to - from < 2 && columnWidth[from] < 600);
    return { bands, width, height, scale: thin ? Infinity : Math.max(width / 16, height / 9) };
  };
  // Only a graph wider than a screen wraps.
  let chosen = plan(1);
  for (let count = 2; chosen.width > layoutGap.wrapAfter && count <= Math.min(layerCount, 8); count += 1) {
    const option = plan(count);
    if (option.scale < chosen.scale * 0.9) chosen = option;
  }
  const positions = new Map<string, { x: number; y: number }>();
  let bandTop = 0;
  for (const [from, to] of chosen.bands) {
    const { top, bottom } = extent(from, to);
    let x = 0;
    for (let l = from; l < to; l += 1) {
      for (const id of real[l]) positions.set(id, { x: x + (columnWidth[l] - size.get(id)!.width) / 2, y: Math.round(y.get(id)! - top + bandTop) });
      x += columnWidth[l] + layoutGap.column;
    }
    bandTop += bottom - top + layoutGap.band;
  }
  return { positions, size: { width: chosen.width, height: Math.round(bandTop - layoutGap.band) } };
}
