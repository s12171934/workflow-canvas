import { mkdir, readFile, readdir, rename, stat, writeFile, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workflow } from '../src/model.ts';
import { spawnsRuns, effortLevels, maxScriptTimeout, scriptParses, forwardEdges, loopBody, maxLoopRounds, linkModes, spawnAsModes, maxBranchOutputs, maxSpawnItems, maxVariables, validVariableValue, variableKeyPattern, maxGroupDepth, workerModelPattern, isBranch, serializableWorkflow, topologicalOrder, validTrigger, worktreeNamePattern, validTags, maxTags, maxTagLength } from '../src/model.ts';

export function validId(id: string): boolean { return /^[a-zA-Z0-9_-]{1,128}$/.test(id); }

/** Loop passes an execution may keep: every loop edge can run up to maxLoopRounds passes. */
const maxHistoryPasses = 1000;
/** Spawn link results, per link node: what an execution (or one finished loop pass of it) requested. */
function validSpawned(spawned: unknown, ids: Set<string>): boolean {
  return !!spawned && typeof spawned === 'object' && !Array.isArray(spawned)
    && Object.entries(spawned as Record<string, unknown>).every(([nodeId, results]) => ids.has(nodeId) && Array.isArray(results) && results.length <= maxSpawnItems * 10
      && results.every((result) => !!result && typeof result.item === 'string' && worktreeNamePattern.test(result.item) && typeof result.at === 'string'
        && result.at.length <= 40 && typeof result.workflowId === 'string' && validId(result.workflowId)
        && (result.launch === undefined || (typeof result.launch === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(result.launch)))
        && (result.error === undefined || (typeof result.error === 'string' && result.error.length <= 500))
        && (result.brief === undefined || validPath(result.brief, false)) && (result.worktree === undefined || validPath(result.worktree, false))));
}
function validRegex(pattern: string): boolean {
  try { new RegExp(pattern); return true; } catch { return false; }
}

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
  if (graph.tags !== undefined && !validTags(graph.tags)) throw new Error(`태그는 ${maxTags}개까지, 겹치지 않게 ${maxTagLength}자 이하로 적으세요.`);
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
      || !['worker', 'gate', 'branch', 'script', 'note', 'workflow', 'group', 'frame'].includes(node.data.kind)
      || (node.data.workerModel !== undefined && (typeof node.data.workerModel !== 'string' || !workerModelPattern.test(node.data.workerModel)))
      || (node.data.effort !== undefined && !(effortLevels as readonly string[]).includes(node.data.effort))
      || (node.data.linkMode !== undefined && (node.data.kind !== 'workflow' || !(linkModes as string[]).includes(node.data.linkMode)))
      || (node.data.spawnAs !== undefined && (node.data.kind !== 'workflow' || !(spawnAsModes as string[]).includes(node.data.spawnAs)))
      || (node.data.asker !== undefined && (node.data.kind !== 'gate' || !['coordinator', 'previous', 'auto'].includes(node.data.asker)))
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
      // An absolute path or a {{setting}}: resolved per run, it reaches `--parent-worktree path:` argv.
      || (node.data.parentPath !== undefined && (typeof node.data.parentPath !== 'string' || node.data.parentPath.length > 1024
        || /[\u0000-\u001f]/.test(node.data.parentPath) || (node.data.parentPath.trim() !== '' && !/^\s*(\/|\{\{)/.test(node.data.parentPath))
        || (node.data.parentPath.trim() !== '' && node.data.worktreeMode !== 'create')))
      || (node.width !== undefined && !(Number.isFinite(node.width) && node.width > 0 && node.width < 20000))
      || (node.height !== undefined && !(Number.isFinite(node.height) && node.height > 0 && node.height < 20000)))) {
      throw new Error('그룹 노드의 대상(프로젝트·워크트리)과 경로가 올바르지 않습니다.');
    }
    if (frame && ((node.width !== undefined && !(Number.isFinite(node.width) && node.width > 0 && node.width < 20000))
      || (node.height !== undefined && !(Number.isFinite(node.height) && node.height > 0 && node.height < 20000)))) {
      throw new Error('메모 그룹의 크기가 올바르지 않습니다.');
    }
    if (node.data.join !== undefined && !['all', 'any'].includes(node.data.join)) throw new Error('합류 방식은 all 또는 any 여야 합니다.');
    const scriptFields = ['command', 'parse', 'itemPattern', 'detach', 'timeoutSec'] as const;
    if (node.data.kind !== 'script' ? scriptFields.some((key) => node.data[key] !== undefined)
      : (node.data.command !== undefined && (typeof node.data.command !== 'string' || node.data.command.length > 20000 || /\u0000/.test(node.data.command)))
        || (node.data.parse !== undefined && !(scriptParses as string[]).includes(node.data.parse))
        || (node.data.itemPattern !== undefined && (typeof node.data.itemPattern !== 'string' || node.data.itemPattern.length > 500
          || node.data.parse !== 'regex' || !validRegex(node.data.itemPattern)))
        || (node.data.detach !== undefined && typeof node.data.detach !== 'boolean')
        || (node.data.timeoutSec !== undefined && !(Number.isInteger(node.data.timeoutSec) && node.data.timeoutSec > 0 && node.data.timeoutSec <= maxScriptTimeout))) {
      throw new Error('스크립트 드라이버 노드의 명령·출력 해석·정규식·제한 시간이 올바르지 않습니다.');
    }
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
  if (graph.coordinatorGroup !== undefined && (typeof graph.coordinatorGroup !== 'string'
    || !graph.nodes.some((node) => node.id === graph.coordinatorGroup && node.data.kind === 'group' && (node.data.scope === 'worktree' || node.data.scope === 'project')))) {
    throw new Error('코디네이터 위치는 이 워크플로의 프로젝트 그룹이나 워크트리 그룹이어야 합니다.');
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
  const name = (id: string) => byId.get(id)?.data.label || id;
  const { cycle } = topologicalOrder(graph.nodes.map((node) => node.id), forwardEdges(graph.edges));
  if (cycle) {
    throw new Error(`연결이 순환합니다: ${cycle.map(name).join(' → ')}. 반복하려면 분기의 출력에서 앞 단계로 「되돌아가기」 연결을 쓰세요.`);
  }
  // A loop goes back from an output of an exclusive branch to a stage before it, with a limit and an output to take after it.
  for (const edge of graph.edges.filter((item) => item.loop !== undefined)) {
    const source = byId.get(edge.source)!;
    const loop = edge.loop;
    const where = `'${name(edge.source)}' → '${name(edge.target)}' 되돌아가기 연결`;
    if (!loop || typeof loop !== 'object' || !Number.isInteger(loop.max) || loop.max < 1 || loop.max > maxLoopRounds || typeof loop.exit !== 'string') {
      throw new Error(`${where}에는 최대 반복 횟수(1~${maxLoopRounds})와 초과 시 출력이 필요합니다.`);
    }
    if (source.data.kind !== 'branch' || (source.data.mode ?? 'exclusive') !== 'exclusive' || !edge.sourceHandle) {
      throw new Error(`${where}은 「하나만」 고르는 분기의 출력에서 시작해야 합니다.`);
    }
    if (loop.exit === edge.sourceHandle || !(source.data.outputs ?? []).some((output) => output.id === loop.exit)) {
      throw new Error(`${where}의 초과 시 출력은 같은 분기의 다른 출력이어야 합니다.`);
    }
    if (graph.edges.some((other) => other.id !== edge.id && other.source === edge.source && other.sourceHandle === edge.sourceHandle)) {
      throw new Error(`${where}이 나가는 출력에는 다른 연결을 둘 수 없습니다.`);
    }
    const body = loopBody(graph.edges, edge);
    if (!body.includes(edge.source)) throw new Error(`${where}은 분기보다 앞에 있는(분기로 이어지는) 단계로만 돌아갈 수 있습니다.`);
    // A spawn link starts separate executions and keeps no Tasks in this one; each pass archives what it requested and
    // asks again. A link that expands its graph here (wait·start) would have to re-run another workflow's Tasks.
    const link = body.map((id) => byId.get(id)!).find((node) => node.data.kind === 'workflow' && !spawnsRuns(node));
    if (link) throw new Error(`${where}이 반복하는 구간에 워크플로 링크 '${name(link.id)}' 를 둘 수 없습니다. 「항목마다 따로 실행」 링크만 둘 수 있습니다.`);
  }
  if (graph.cleanup !== undefined && (!graph.cleanup || typeof graph.cleanup !== 'object'
    || (['coordinator', 'worktrees', 'sessions'] as const).some((key) => typeof graph.cleanup![key] !== 'boolean'))) {
    throw new Error('완료 시 정리 설정이 올바르지 않습니다.');
  }
  const validCleanup = (value: unknown) => !!value && typeof value === 'object'
    && (['coordinator', 'worktrees', 'sessions'] as const).every((key) => typeof (value as Record<string, unknown>)[key] === 'boolean');
  const validInputs = (value: unknown) => value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, name]) => validId(key) && typeof name === 'string' && (name === '' || worktreeNamePattern.test(name))));
  if (graph.variables !== undefined) {
    const keys = new Set<string>();
    if (!Array.isArray(graph.variables) || graph.variables.length > maxVariables || graph.variables.some((item) => !item
      || typeof item.key !== 'string' || !variableKeyPattern.test(item.key) || keys.has(item.key) || !keys.add(item.key)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100
      || (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 500))
      || (item.default !== undefined && !validVariableValue(item.default))
      || (item.required !== undefined && typeof item.required !== 'boolean'))) {
      throw new Error(`설정값은 ${maxVariables}개까지, 키는 영문 소문자로 시작하는 소문자·숫자·_ 40자 이하로 겹치지 않게, 이름은 100자 이하로 적으세요.`);
    }
  }
  const declared = new Set((graph.variables ?? []).map((item) => item.key));
  // A fanout worker runs one worker per model: a list of model ids, or a declared setting that gives one, or both.
  // It reports no single decision or item list, so a branch or gate it would judge and a spawn link it would feed are refused.
  for (const node of graph.nodes) {
    const fanout = node.data.fanout;
    if (fanout === undefined) continue;
    const where = `'${node.data.label || node.id}' 의 모델별 병렬 워커`;
    if (node.data.kind !== 'worker' || !fanout || typeof fanout !== 'object' || !Array.isArray(fanout.models)
      || fanout.models.some((model) => typeof model !== 'string' || !workerModelPattern.test(model))
      || (fanout.variable !== undefined && (typeof fanout.variable !== 'string' || !declared.has(fanout.variable)))) {
      throw new Error(`${where}는 워커 노드에만 두고, 모델 id 목록과 선언된 설정값 키로 적으세요.`);
    }
    if (!fanout.models.length && !fanout.variable) throw new Error(`${where}에는 모델이 1개 이상 있거나 모델 목록 설정값이 연결돼야 합니다.`);
    if (node.data.workerModel !== undefined) throw new Error(`${where}에는 단일 모델(workerModel)을 함께 둘 수 없습니다.`);
    const next = graph.edges.filter((edge) => edge.source === node.id && !edge.loop).map((edge) => byId.get(edge.target)!);
    const judged = next.find((target) => (isBranch(target) && (target.data.judge ?? 'previous') === 'previous')
      || (target.data.kind === 'gate' && target.data.asker === 'previous') || spawnsRuns(target));
    if (judged) throw new Error(`${where}는 판정·항목을 하나로 보고하지 않으므로 '${judged.data.label || judged.id}' 의 판정 주체나 항목 보고 단계가 될 수 없습니다.`);
  }
  if (graph.automations !== undefined) {
    const automationIds = new Set<string>();
    if (!Array.isArray(graph.automations) || graph.automations.length > 20 || graph.automations.some((item) => !item || !validId(item.id)
      || automationIds.has(item.id) || !automationIds.add(item.id)
      || (item.orcaId !== undefined && (typeof item.orcaId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(item.orcaId)))
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || /[\u0000-\u001f]/.test(item.name)
      || !validTrigger(item.trigger) || (item.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time))
      || (item.day !== undefined && !(Number.isInteger(item.day) && item.day >= 0 && item.day <= 6))
      || !validPath(item.project, false) || !(Number.isInteger(item.count) && item.count >= 1 && item.count <= 20)
      || !validCleanup(item.cleanup) || !validInputs(item.inputs)
      || (item.values !== undefined && (!item.values || typeof item.values !== 'object' || Array.isArray(item.values)
        || Object.entries(item.values).some(([key, value]) => !declared.has(key) || !validVariableValue(value)))))) {
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
          || typeof execution.automation.name !== 'string' || execution.automation.name.length > 100))
        || (execution.runId !== undefined && (typeof execution.runId !== 'string' || !validId(execution.runId)))
        || !validInputs(execution.inputs)
        || (execution.loops !== undefined && (!execution.loops || typeof execution.loops !== 'object' || Array.isArray(execution.loops)
          || Object.entries(execution.loops).some(([edgeId, count]) => !validId(edgeId) || !Number.isInteger(count) || count < 0 || count > maxLoopRounds)))
        || (execution.history !== undefined && (!Array.isArray(execution.history) || execution.history.length > maxHistoryPasses
          || execution.history.some((pass) => !pass || !validId(pass.edge) || !Number.isInteger(pass.pass) || !Array.isArray(pass.nodes)
            || pass.nodes.some((id) => typeof id !== 'string' || !validId(id)) || !pass.bindings || typeof pass.bindings !== 'object'
            || Object.entries(pass.bindings).some(([nodeId, taskId]) => !validId(nodeId) || typeof taskId !== 'string' || !validId(taskId))
            || (pass.decisions !== undefined && (!pass.decisions || typeof pass.decisions !== 'object'
              || Object.entries(pass.decisions).some(([path, outputs]) => !/^[a-zA-Z0-9_.-]{1,400}$/.test(path) || !Array.isArray(outputs) || outputs.some((output) => typeof output !== 'string' || !validId(output)))))
            || (pass.spawned !== undefined && !validSpawned(pass.spawned, ids)))))
        || (execution.values !== undefined && (!execution.values || typeof execution.values !== 'object' || Array.isArray(execution.values)
          || Object.entries(execution.values).some(([key, value]) => !variableKeyPattern.test(key) || !validVariableValue(value))))
        || (execution.spawned !== undefined && !validSpawned(execution.spawned, ids))) {
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
          return { id: graph.id, name: graph.name, ...(graph.tags?.length ? { tags: graph.tags } : {}), modified: (await stat(path)).mtimeMs };
        } catch { return null; }
      }));
      // Most recently saved first, so the canvas opens the document the user worked on last.
      return items.filter((item) => item !== null).sort((a, b) => b.modified - a.modified)
        .map(({ modified: _modified, ...item }) => item);
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
    /**
     * Copies bundled example workflows into the data directory once each.
     * An example is skipped when a document with its id exists or when it was seeded before
     * (recorded in `.examples.json`), so a deleted or edited example is never brought back.
     * Seeded files get an old mtime so they do not replace the last-used document at startup.
     */
    async seed(examples: string) {
      const files = (await readdir(examples).catch(() => [] as string[])).filter((file) => file.endsWith('.json')).sort();
      if (files.length === 0) return [];
      await mkdir(directory, { recursive: true });
      const record = join(directory, '.examples.json');
      const seeded = new Set<string>(await readFile(record, 'utf8').then((text) => JSON.parse(text) as string[]).catch(() => []));
      const existing = new Set((await readdir(directory)).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)));
      const added: string[] = [];
      for (const file of files) {
        let graph: Workflow;
        try { graph = validateWorkflow(JSON.parse(await readFile(join(examples, file), 'utf8'))); } catch { continue; }
        if (seeded.has(graph.id)) continue;
        seeded.add(graph.id);
        if (existing.has(graph.id)) continue;
        await this.save(graph);
        await utimes(join(directory, `${graph.id}.json`), 0, 0);
        added.push(graph.id);
      }
      await writeFile(record, JSON.stringify([...seeded].sort(), null, 2), { mode: 0o600 });
      return added;
    },
    async remove(id: string) {
      if (!validId(id)) throw new Error('올바르지 않은 워크플로 ID입니다.');
      await unlink(join(directory, `${id}.json`));
    },
  };
}
