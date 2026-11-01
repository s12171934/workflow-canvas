import { mkdir, readFile, readdir, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workflow } from '../src/model.ts';
import { effortLevels, maxBranchOutputs, maxGroupDepth, workerModelPattern, serializableWorkflow, topologicalOrder, validTrigger, worktreeNamePattern } from '../src/model.ts';

export function validId(id: string): boolean { return /^[a-zA-Z0-9_-]{1,128}$/.test(id); }

/** Absolute path without control characters; empty allowed when `allowEmpty`. */
function validPath(value: unknown, allowEmpty: boolean): boolean {
  return typeof value === 'string' && value.length <= 1024 && (value === '' ? allowEmpty : value.startsWith('/')) && !/[\u0000-\u001f]/.test(value);
}

export function validateWorkflow(value: unknown): Workflow {
  if (!value || typeof value !== 'object') throw new Error('워크플로 JSON 객체가 필요합니다.');
  const graph = value as Workflow;
  if (graph.version !== 1 || !validId(graph.id) || typeof graph.name !== 'string' || !graph.name.trim() || graph.name.length > 500
    || typeof graph.description !== 'string' || graph.description.length > 10000 || typeof graph.runId !== 'string'
    || (graph.runId !== '' && !validId(graph.runId)) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || graph.nodes.length > 500 || graph.edges.length > 2000) throw new Error('워크플로 형식 또는 크기가 올바르지 않습니다.');
  const ids = new Set<string>();
  const groups = new Set<string>();
  // v1 documents used 'task' for agent work; it is now a worker node.
  graph.nodes = graph.nodes.map((node) => node?.data?.kind === ('task' as string) ? { ...node, data: { ...node.data, kind: 'worker' } } : node);
  for (const node of graph.nodes) {
    const group = node?.data?.kind === 'group';
    const frame = node?.data?.kind === 'frame';
    if (!node || !validId(node.id) || ids.has(node.id) || node.type !== (group ? 'group' : frame ? 'frame' : 'stage') || !node.position
      || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)
      || !node.data || typeof node.data.label !== 'string' || node.data.label.length > 500
      || typeof node.data.description !== 'string' || node.data.description.length > 20000
      || !['worker', 'gate', 'branch', 'note', 'workflow', 'group', 'frame'].includes(node.data.kind)
      || (node.data.workerModel !== undefined && (typeof node.data.workerModel !== 'string' || !workerModelPattern.test(node.data.workerModel)))
      || (node.data.effort !== undefined && !(effortLevels as readonly string[]).includes(node.data.effort))
      || (node.data.linkMode !== undefined && (node.data.kind !== 'workflow' || !['wait', 'start'].includes(node.data.linkMode)))
      || (node.data.asker !== undefined && (node.data.kind !== 'gate' || !['coordinator', 'previous'].includes(node.data.asker)))
      || (node.data.taskId !== undefined && node.data.taskId !== '' && (typeof node.data.taskId !== 'string' || !validId(node.data.taskId)))
      || (node.data.workflowId !== undefined && node.data.workflowId !== '' && (typeof node.data.workflowId !== 'string' || !validId(node.data.workflowId)))) {
      throw new Error('노드 ID·위치·속성이 올바르지 않습니다.');
    }
    if (group && (!['project', 'worktree'].includes(node.data.scope ?? '') || !validPath(node.data.path ?? '', true)
      || (node.data.ref !== undefined && (typeof node.data.ref !== 'string' || node.data.ref.length > 512 || /[\u0000-\u001f]/.test(node.data.ref)))
      || (node.data.worktreeMode !== undefined && (!['existing', 'create'].includes(node.data.worktreeMode) || node.data.scope !== 'worktree'))
      || (node.data.repoPath !== undefined && !validPath(node.data.repoPath, true))
      // Both reach `orca worktree create` argv: never let them start with '-' or carry '..'.
      || (node.data.baseBranch !== undefined && (typeof node.data.baseBranch !== 'string' || !/^(?!-)[A-Za-z0-9._/-]{0,200}$/.test(node.data.baseBranch) || node.data.baseBranch.includes('..')))
      || (node.data.worktreeName !== undefined && node.data.worktreeName !== '' && (typeof node.data.worktreeName !== 'string' || !worktreeNamePattern.test(node.data.worktreeName)))
      || (node.data.branch !== undefined && (typeof node.data.branch !== 'string' || !/^(?!-)[A-Za-z0-9._/-]{0,200}$/.test(node.data.branch) || node.data.branch.includes('..')))
      || (node.data.nameSource !== undefined && !['fixed', 'agent', 'input'].includes(node.data.nameSource))
      || (node.data.nameFrom !== undefined && (typeof node.data.nameFrom !== 'string' || !validId(node.data.nameFrom)))
      || (node.data.inputPrompt !== undefined && (typeof node.data.inputPrompt !== 'string' || node.data.inputPrompt.length > 500))
      || (node.data.perExecution !== undefined && typeof node.data.perExecution !== 'boolean')
      || (node.width !== undefined && !(Number.isFinite(node.width) && node.width > 0 && node.width < 20000))
      || (node.height !== undefined && !(Number.isFinite(node.height) && node.height > 0 && node.height < 20000)))) {
      throw new Error('그룹 노드의 대상(프로젝트·워크트리)과 경로가 올바르지 않습니다.');
    }
    if (frame && (node.parentId !== undefined
      || (node.width !== undefined && !(Number.isFinite(node.width) && node.width > 0 && node.width < 20000))
      || (node.height !== undefined && !(Number.isFinite(node.height) && node.height > 0 && node.height < 20000)))) {
      throw new Error('메모 그룹은 다른 그룹 안에 넣을 수 없고, 크기가 올바라야 합니다.');
    }
    if (node.data.join !== undefined && !['all', 'any'].includes(node.data.join)) throw new Error('합류 방식은 all 또는 any 여야 합니다.');
    if (node.data.kind === 'branch') {
      const outputs = node.data.outputs;
      const outputIds = new Set<string>();
      if ((node.data.mode !== undefined && !['exclusive', 'inclusive'].includes(node.data.mode))
        || (node.data.judge !== undefined && !['previous', 'worker', 'user'].includes(node.data.judge))
        || (outputs !== undefined && (!Array.isArray(outputs) || outputs.length > maxBranchOutputs
          || outputs.some((output) => !output || !validId(output.id) || outputIds.has(output.id) || !outputIds.add(output.id)
            || typeof output.label !== 'string' || output.label.length > 200)))) {
        throw new Error(`분기 노드의 방식·판정 주체·출력(최대 ${maxBranchOutputs}개)이 올바르지 않습니다.`);
      }
    }
    ids.add(node.id);
    if (group) groups.add(node.id);
  }
  // The naming stage must be a real, executable stage of this workflow.
  if (graph.nodes.some((node) => node.data.kind === 'group' && node.data.nameFrom
    && !graph.nodes.some((item) => item.id === node.data.nameFrom && ['worker', 'gate', 'workflow'].includes(item.data.kind)))) {
    throw new Error('워크트리 이름을 정할 단계가 이 워크플로에 없습니다.');
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    if (node.parentId === undefined) continue;
    if (!groups.has(node.parentId)) throw new Error('노드는 그룹 노드 안에만 넣을 수 있습니다.');
    // A project group never nests; a worktree group sits in a project or another worktree (a child worktree).
    if (node.data.kind === 'group' && node.data.scope !== 'worktree') throw new Error('프로젝트 그룹은 다른 그룹 안에 넣을 수 없습니다.');
    let depth = 0;
    for (let parent: string | undefined = node.parentId; parent; parent = byId.get(parent)?.parentId) {
      if (parent === node.id || ++depth > maxGroupDepth) throw new Error(`그룹은 ${maxGroupDepth}단계까지 중첩할 수 있고 순환할 수 없습니다.`);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || !validId(edge.id) || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target)
      || (edge.label !== undefined && (typeof edge.label !== 'string' || edge.label.length > 500))) {
      throw new Error('연결의 ID 또는 대상 노드가 올바르지 않습니다.');
    }
    edgeIds.add(edge.id);
    // A branch edge leaves one of its outputs; deleting an output must take its edges with it.
    const source = byId.get(edge.source)!;
    if (source.data.kind === 'branch' && !(source.data.outputs ?? []).some((output) => output.id === edge.sourceHandle)) {
      throw new Error(`'${source.data.label || '분기'}' 에서 나가는 연결은 분기의 출력에서 시작해야 합니다.`);
    }
  }
  const { cycle } = topologicalOrder(graph.nodes.map((node) => node.id), graph.edges);
  if (cycle) {
    const name = (id: string) => byId.get(id)?.data.label || id;
    throw new Error(`연결이 순환합니다: ${cycle.map(name).join(' → ')}. 반복은 연결로 만들 수 없습니다.`);
  }
  if (graph.cleanup !== undefined && (!graph.cleanup || typeof graph.cleanup !== 'object'
    || (['coordinator', 'worktrees', 'sessions'] as const).some((key) => typeof graph.cleanup![key] !== 'boolean'))) {
    throw new Error('완료 시 정리 설정이 올바르지 않습니다.');
  }
  const validCleanup = (value: unknown) => !!value && typeof value === 'object'
    && (['coordinator', 'worktrees', 'sessions'] as const).every((key) => typeof (value as Record<string, unknown>)[key] === 'boolean');
  const validInputs = (value: unknown) => value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, name]) => validId(key) && typeof name === 'string' && (name === '' || worktreeNamePattern.test(name))));
  if (graph.automations !== undefined) {
    const automationIds = new Set<string>();
    if (!Array.isArray(graph.automations) || graph.automations.length > 20 || graph.automations.some((item) => !item || !validId(item.id)
      || automationIds.has(item.id) || !automationIds.add(item.id)
      || (item.orcaId !== undefined && (typeof item.orcaId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(item.orcaId)))
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || /[\u0000-\u001f]/.test(item.name)
      || !validTrigger(item.trigger) || (item.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time))
      || (item.day !== undefined && !(Number.isInteger(item.day) && item.day >= 0 && item.day <= 6))
      || !validPath(item.project, false) || !(Number.isInteger(item.count) && item.count >= 1 && item.count <= 20)
      || !validCleanup(item.cleanup) || !validInputs(item.inputs))) {
      throw new Error('자동화 설정이 올바르지 않습니다.');
    }
  }
  if (graph.workspace !== undefined && !validPath(graph.workspace, true)) {
    throw new Error('작업 위치는 절대 경로여야 합니다.');
  }
  if (graph.executions !== undefined) {
    if (!Array.isArray(graph.executions) || graph.executions.length > 100) throw new Error('실행 목록 형식 또는 크기가 올바르지 않습니다.');
    const executionIds = new Set<string>();
    for (const execution of graph.executions) {
      if (!execution || !validId(execution.id) || executionIds.has(execution.id) || typeof execution.label !== 'string'
        || !execution.label.trim() || execution.label.length > 200 || !execution.bindings || typeof execution.bindings !== 'object'
        || Array.isArray(execution.bindings)
        || Object.entries(execution.bindings).some(([nodeId, taskId]) => !ids.has(nodeId) || typeof taskId !== 'string' || !validId(taskId))
        || (execution.links !== undefined && (!execution.links || typeof execution.links !== 'object' || Array.isArray(execution.links)
          || Object.entries(execution.links).some(([nodeId, tasks]) => !ids.has(nodeId) || !tasks || typeof tasks !== 'object' || Array.isArray(tasks)
            || Object.keys(tasks).length > 500
            || Object.entries(tasks).some(([path, taskId]) => !/^[a-zA-Z0-9_.-]{1,400}$/.test(path) || typeof taskId !== 'string' || !validId(taskId)))))
        || (execution.decisions !== undefined && (!execution.decisions || typeof execution.decisions !== 'object' || Array.isArray(execution.decisions)
          || Object.keys(execution.decisions).length > 500
          || Object.entries(execution.decisions).some(([path, outputs]) => !/^[a-zA-Z0-9_.-]{1,400}$/.test(path) || !Array.isArray(outputs)
            || !outputs.length || outputs.length > maxBranchOutputs || outputs.some((output) => typeof output !== 'string' || !validId(output)))))
        || (execution.skipped !== undefined && (!Array.isArray(execution.skipped) || execution.skipped.length > 2000
          || execution.skipped.some((path) => typeof path !== 'string' || !/^[a-zA-Z0-9_.-]{1,400}$/.test(path))))
        || (execution.automation !== undefined && (!execution.automation || !validId(execution.automation.id)
          || typeof execution.automation.name !== 'string' || execution.automation.name.length > 100))) {
        throw new Error('실행 ID·이름·Task 연결이 올바르지 않습니다.');
      }
      executionIds.add(execution.id);
    }
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
          const path = join(directory, file);
          const graph = validateWorkflow(JSON.parse(await readFile(path, 'utf8')));
          return { id: graph.id, name: graph.name, modified: (await stat(path)).mtimeMs };
        } catch { return null; }
      }));
      // Most recently saved first, so the canvas opens the document the user worked on last.
      return items.filter((item) => item !== null).sort((a, b) => b.modified - a.modified)
        .map(({ id, name }) => ({ id, name }));
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
    async remove(id: string) {
      if (!validId(id)) throw new Error('올바르지 않은 워크플로 ID입니다.');
      await unlink(join(directory, `${id}.json`));
    },
  };
}
