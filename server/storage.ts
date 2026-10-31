import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workflow } from '../src/model.ts';
import { serializableWorkflow } from '../src/model.ts';

export function validId(id: string): boolean { return /^[a-zA-Z0-9_-]{1,128}$/.test(id); }

export function validateWorkflow(value: unknown): Workflow {
  if (!value || typeof value !== 'object') throw new Error('워크플로 JSON 객체가 필요합니다.');
  const graph = value as Workflow;
  if (graph.version !== 1 || !validId(graph.id) || typeof graph.name !== 'string' || !graph.name.trim() || graph.name.length > 500
    || typeof graph.description !== 'string' || graph.description.length > 10000 || typeof graph.runId !== 'string'
    || (graph.runId !== '' && !validId(graph.runId)) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || graph.nodes.length > 500 || graph.edges.length > 2000) throw new Error('워크플로 형식 또는 크기가 올바르지 않습니다.');
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || !validId(node.id) || ids.has(node.id) || node.type !== 'stage' || !node.position
      || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)
      || !node.data || typeof node.data.label !== 'string' || node.data.label.length > 500
      || typeof node.data.description !== 'string' || node.data.description.length > 20000
      || !['task', 'gate', 'note'].includes(node.data.kind)
      || (node.data.taskId !== undefined && node.data.taskId !== '' && (typeof node.data.taskId !== 'string' || !validId(node.data.taskId)))) {
      throw new Error('노드 ID·위치·속성이 올바르지 않습니다.');
    }
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || !validId(edge.id) || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target)
      || (edge.label !== undefined && (typeof edge.label !== 'string' || edge.label.length > 500))) {
      throw new Error('연결의 ID 또는 대상 노드가 올바르지 않습니다.');
    }
    edgeIds.add(edge.id);
  }
  return serializableWorkflow(graph);
}

export function createStorage(directory: string) {
  return {
    async list() {
      await mkdir(directory, { recursive: true });
      const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
      const items = await Promise.all(files.map(async (file) => {
        try {
          const graph = validateWorkflow(JSON.parse(await readFile(join(directory, file), 'utf8')));
          return { id: graph.id, name: graph.name };
        } catch { return null; }
      }));
      return items.filter((item) => item !== null);
    },
    async load(id: string) {
      if (!validId(id)) throw new Error('올바르지 않은 워크플로 ID입니다.');
      return validateWorkflow(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')));
    },
    async save(value: unknown) {
      const graph = validateWorkflow(value);
      await mkdir(directory, { recursive: true });
      const temp = join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(graph, null, 2), { mode: 0o600 });
        await rename(temp, join(directory, `${graph.id}.json`));
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
      return graph;
    },
  };
}
