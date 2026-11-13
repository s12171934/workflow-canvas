import { calculate } from './core.ts';
import type { StageNode, WorkflowEdge } from './model.ts';
export type Size = { width: number; height: number };
export const layoutGap = { column: 70, row: 34, component: 60, band: 90, wrapAfter: 2000, padding: 24, header: 44 } as const;
type Box = { id: string; width: number; height: number; virtual?: boolean; ports?: number };
type Link = { source: string; target: string; port?: number };
export function estimatedSize(node: Pick<StageNode, 'data' | 'width' | 'height' | 'measured'>): Size {
  return calculate('estimatedSize', [node]);
}
export function autoLayout(nodes: StageNode[], edges: WorkflowEdge[], sizeOf: (node: StageNode) => Size = estimatedSize): StageNode[] {
  const sizes = sizeOf === estimatedSize ? undefined : Object.fromEntries(nodes.map(node => [node.id, sizeOf(node)]));
  return calculate('autoLayout', [nodes, edges, sizes]);
}
export function layered(boxes: Box[], links: Link[]): { positions: Map<string, { x: number; y: number }>; size: Size } {
  const result = calculate<{ positions: Record<string, { x: number; y: number }>; size: Size }>('layered', [boxes, links]);
  return { ...result, positions: new Map(Object.entries(result.positions)) };
}
