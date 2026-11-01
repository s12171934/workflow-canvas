import type { Edge, Node } from '@xyflow/react';

export type StageStatus = 'unbound' | 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'unknown' | 'skipped';
/** Normal (executable or annotation) node kinds. `workflow` links to another saved workflow. */
export type StageKind = 'worker' | 'gate' | 'note' | 'workflow' | 'branch';
/** Branch: 'exclusive' takes exactly one output, 'inclusive' every output whose condition holds (at least one). */
export type BranchMode = 'exclusive' | 'inclusive';
/** Who decides a branch: the worker of the stage right before it, a judging worker of its own, or the user. */
export type BranchJudge = 'previous' | 'worker' | 'user';
export type BranchOutput = { id: string; label: string };
export const branchModeNames: Record<BranchMode, string> = { exclusive: '하나만', inclusive: '해당하는 것 모두' };
export const branchJudgeNames: Record<BranchJudge, string> = { previous: '직전 단계 워커', worker: '판정 워커', user: '사용자' };
/** Where a gate asks the user: the coordinator (decision card / its terminal), or the terminal of the worker right before it. */
export type GateAsker = 'coordinator' | 'previous';
/**
 * Workflow link: 'wait' — what follows the link waits for its whole sub-graph; 'start' — the sub-graph starts and what follows
 * goes on without it; 'spawn' — not expanded: one separate 실행 of the target per item the worker before it reports
 * (the item is the target's run-time worktree name), and the link is done once they are requested.
 */
export type LinkMode = 'wait' | 'start' | 'spawn';
export const linkModes: LinkMode[] = ['wait', 'start', 'spawn'];
export const linkModeNames: Record<LinkMode, string> = { wait: '끝날 때까지 대기', start: '시작만 하고 진행', spawn: '항목마다 따로 실행' };
/** A link that requests separate executions of its target instead of expanding it. */
export const spawnsRuns = (node: Pick<StageNode, 'data'>) => node.data.kind === 'workflow' && node.data.linkMode === 'spawn';
/** How many separate executions one spawn request may start. */
export const maxSpawnItems = 20;
/** One item a spawn link asked to run: the launch it started, or why it could not. */
export type SpawnResult = { item: string; at: string; workflowId: string; launch?: string; error?: string };
export const gateAskerNames: Record<GateAsker, string> = { coordinator: '코디네이터', previous: '직전 워커' };
export const maxBranchOutputs = 8;
export type JoinMode = 'all' | 'any';
export const joinNames: Record<JoinMode, string> = { all: '모두 필요', any: '하나라도 오면 진행' };
/** Group nodes fix where their children run: an Orca project (repo) or one Orca worktree. */
export type GroupScope = 'project' | 'worktree';
/** `frame`: a memo group — a resizable box that only gathers nodes visually (moving it moves what lies inside); never executes or sets a location. */
export type NodeKind = StageKind | 'group' | 'frame';
/** Agent model ids offered per launching node; unset means `defaultWorkerModel`. */
export const workerModels = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] as const;
export const defaultWorkerModel = 'claude-opus-5-5';
/** Reasoning effort per launching node; unset means the model's own default (no --effort). */
export const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof effortLevels[number];
/** Model ids reach `worker-start --model` argv: never a leading '-', no spaces. */
export const workerModelPattern = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;
/** Nodes for which the coordinator starts a worker: workers, and branches judged by a worker of their own. */
export const launchesWorker = (node: Pick<StageNode, 'data'>) => node.data.kind === 'worker' || (node.data.kind === 'branch' && node.data.judge === 'worker');
export type WorktreeMode = 'existing' | 'create';
export type NameSource = 'fixed' | 'agent' | 'input';
export const nameSourceNames: Record<NameSource, string> = { fixed: '직접 지정', agent: '이전 단계 에이전트가 정함', input: '실행 시 입력' };
/** Characters `orca worktree create --name` accepts here; never leading '-' (argv) or '..'. */
export const worktreeNamePattern = /^(?!-)(?!.*\.\.)[A-Za-z0-9._-]{1,80}$/;
export function safeWorktreeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+/, '').slice(0, 80);
}
/** Create-mode groups whose name the user types when pressing 실행. */
export const asksAtRun = (node: Pick<StageNode, 'data'>) => createsWorktree(node) && node.data.nameSource === 'input';
export type StageData = {
  label: string;
  description: string;
  kind: NodeKind;
  taskId?: string;
  /** kind 'group': what the group points at, and the absolute path its children run in. */
  scope?: GroupScope;
  path?: string;
  /** kind 'group': Orca repo id (project) or worktree id; informational, path is authoritative. */
  ref?: string;
  /** scope 'worktree': pick an existing worktree, or have the coordinator create one per execution. */
  worktreeMode?: WorktreeMode;
  /**
   * Worktree spec. 'create': project to branch from (else the enclosing project group), base ref, and how the name is decided.
   * 'existing': name/branch/project captured when picked, so a worktree deleted since can be recreated under the same name.
   */
  repoPath?: string;
  baseBranch?: string;
  worktreeName?: string;
  /** 'existing' only: branch of the picked worktree. */
  branch?: string;
  /** 'create' only: who decides the name — fixed here, a preceding stage's agent, or the user at run time. */
  nameSource?: NameSource;
  /** nameSource 'agent': the stage whose agent names (or creates) the worktree. */
  nameFrom?: string;
  /** nameSource 'input': what to ask the user. */
  inputPrompt?: string;
  /** 'create' only: one worktree per execution (name-#n) instead of one shared, reused worktree. */
  perExecution?: boolean;
  /** Display only: the project a create-mode worktree group inherits from its project group. */
  inheritedRepo?: string;
  /** Display only: the selected node's project/worktree groups, shown on its card. */
  membership?: { project?: string; worktrees: string[] };
  /** Display only: this group contains the selected node. */
  ancestor?: boolean;
  /** kind 'workflow': the linked saved workflow, and whether what follows waits for it (unset: 'wait'). */
  workflowId?: string;
  linkMode?: LinkMode;
  /** Display only, spawn links: the separate executions requested (by the selected execution, or the visible ones). */
  spawned?: SpawnResult[];
  /** kind 'branch': how many outputs it takes, who decides, and its outputs (each a source handle). */
  mode?: BranchMode;
  judge?: BranchJudge;
  /** kind 'gate': where the user is asked. Unset means 'coordinator'. */
  asker?: GateAsker;
  outputs?: BranchOutput[];
  /**
   * How a stage with several incoming edges treats a skipped one. 'all' (default): it needs every path, so one skipped
   * path skips it. 'any': paths that split at a branch meet again here; it runs if at least one arrives.
   */
  join?: JoinMode;
  /** Display only: the outputs the shown execution took at this branch. */
  decision?: string[];
  status?: StageStatus;
  agent?: string;
  model?: string;
  detail?: string;
  runs?: { id: string; label: string; status: StageStatus; taskId?: string }[];
  /** Task whose state this node shows (node binding or the selected execution's binding). */
  activeTaskId?: string;
  /** Launching nodes (see `launchesWorker`): the worker's model and reasoning effort; unset uses the defaults. */
  workerModel?: string;
  effort?: Effort;
};
export type StageNode = Node<StageData, 'stage' | 'group' | 'frame'>;
export const isGroup = (node: Pick<StageNode, 'data'>) => node.data.kind === 'group';
export const isFrame = (node: Pick<StageNode, 'data'>) => node.data.kind === 'frame';
/** A worktree group whose worktree does not exist yet: the coordinator creates one per execution. */
/** React Flow needs every parent before its children: project groups, then worktree groups, then stages (stable within each). */
export function orderNodes<T extends Pick<StageNode, 'id' | 'data' | 'parentId'>>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = (node: T) => { let d = 0; for (let p = node.parentId; p && d < maxGroupDepth + 1; p = byId.get(p)?.parentId) d += 1; return d; };
  // Memo groups first (they sit under everything), then groups by nesting depth, then stages; stable within each rank.
  const rank = (node: T) => isFrame(node) ? -1 : isGroup(node) ? depth(node) : maxGroupDepth + 2;
  return nodes.map((node, index) => ({ node, index, rank: rank(node) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ node }) => node);
}
/** Project group + up to this many worktree groups nested inside one another. */
export const maxGroupDepth = 4;
/** Where a group may sit: a project nowhere; a worktree in a project or in another worktree (it becomes a child worktree). */
export function canNest(child: Pick<StageNode, 'data'>, parent: Pick<StageNode, 'data'>): boolean {
  if (!isGroup(parent) || isFrame(child)) return false;
  if (!isGroup(child)) return true;
  return child.data.scope === 'worktree';
}
export const createsWorktree = (node: Pick<StageNode, 'data'>) => isGroup(node) && node.data.scope === 'worktree' && node.data.worktreeMode === 'create';
/** Location token for stages in a create-mode group; the coordinator swaps it for the created worktree's path. */
export const newWorktreeToken = (groupId: string) => `new-worktree:${groupId}`;
/** Nodes that become Tasks (or, for links, a sub-graph of Tasks) when the workflow runs. */
export const isExecutable = (node: Pick<StageNode, 'data'>) => ['worker', 'gate', 'workflow', 'branch'].includes(node.data.kind);
export const isBranch = (node: Pick<StageNode, 'data'>) => node.data.kind === 'branch';
export const kindNames: Record<NodeKind, string> = { worker: '워커', gate: '사용자 개입 게이트', branch: '분기', note: '메모', workflow: '워크플로 링크', group: '그룹', frame: '메모 그룹' };
export const scopeNames: Record<GroupScope, string> = { project: 'Orca 프로젝트', worktree: '워크트리' };
export type Workflow = {
  version: 1;
  id: string;
  name: string;
  description: string;
  runId: string;
  nodes: StageNode[];
  edges: Edge[];
  executions?: Execution[];
  /** Default project offered in the run dialog (the run itself always names its project). */
  workspace?: string;
  /** What the coordinator cleans up when the run is done; the run dialog starts from these. */
  cleanup?: Cleanup;
  /** Orca automations that run this workflow on a schedule. */
  automations?: AutomationConfig[];
  /** Settings the run dialog and automations ask for (an epic link, a sheet URL…); stage instructions use them as {{key}}. */
  variables?: WorkflowVariable[];
};
/**
 * One setting of a workflow, like an environment variable: given per 실행 or fixed per automation, written into the brief,
 * and replacing {{key}} in stage instructions. Linked workflows (expanded or spawned) receive the same key's value.
 */
export type WorkflowVariable = { key: string; label: string; description?: string; default?: string; required?: boolean };
export const variableKeyPattern = /^[a-z][a-z0-9_]{0,39}$/;
export const maxVariables = 30;
export const maxVariableValue = 2000;
/** A value is one line of text: no control characters. */
export const validVariableValue = (value: unknown): value is string => typeof value === 'string' && value.length <= maxVariableValue && !/[\u0000-\u001f\u007f]/.test(value);
const variableRef = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;
/** Keys a text refers to as {{key}}. */
export function variableRefs(text: string): string[] {
  return [...new Set([...text.matchAll(variableRef)].map((match) => match[1]))];
}
/** Replaces {{key}} with its value; keys without a value stay as written. */
export function substituteVariables(text: string, values: Record<string, string>): string {
  return text.replace(variableRef, (whole, key: string) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole);
}
/**
 * The values a run uses: what was given (declared keys only), else the default. Returns the required keys left empty too.
 */
export function resolveVariables(variables: WorkflowVariable[] | undefined, given: Record<string, string> = {}): { values: Record<string, string>; missing: WorkflowVariable[] } {
  const values: Record<string, string> = {};
  const missing: WorkflowVariable[] = [];
  for (const variable of variables ?? []) {
    const value = (given[variable.key] ?? '').trim() || (variable.default ?? '').trim();
    if (value) values[variable.key] = value;
    else if (variable.required) missing.push(variable);
  }
  return { values, missing };
}
/**
 * One execution of the graph: maps node IDs to the Task that ran that node in the bound Run.
 * `links` maps a workflow-link node ID to the Tasks of its expanded sub-graph (sub-node path → Task ID).
 */
export type Execution = { id: string; label: string; bindings: Record<string, string>; links?: Record<string, Record<string, string>>;
  /** Branch decisions reported by the coordinator: branch path (link-prefixed) → chosen output ids. */
  decisions?: Record<string, string[]>;
  /** Stage paths (link-prefixed) no taken path reaches, computed by the server from `decisions`. */
  skipped?: string[];
  /** Set when an Orca automation started this execution. */
  automation?: { id: string; name: string };
  /** The Run that holds this execution's Tasks. Absent in older documents: the workflow's `runId`. */
  runId?: string;
  /** Run-time worktree names of the 실행 request that started it (group id → name). Runs with the same inputs never overlap. */
  inputs?: Record<string, string>;
  /** Setting values of the 실행 request that started it (defaults applied). Together with `inputs` they tell requests apart. */
  values?: Record<string, string>;
  /** Spawn links (node id) → the separate executions they requested, in request order. */
  spawned?: Record<string, SpawnResult[]> };
/** Run of an execution: its own, or the workflow's for documents from before executions carried one. */
export const executionRun = (workflow: Pick<Workflow, 'runId'>, execution: Pick<Execution, 'runId'>) => execution.runId || workflow.runId;
/** Every Run the workflow observes: its current Run first, then the Runs of its executions. */
export function workflowRuns(workflow: Pick<Workflow, 'runId' | 'executions'>): string[] {
  return [...new Set([workflow.runId, ...(workflow.executions ?? []).map((execution) => executionRun(workflow, execution))].filter(Boolean))];
}
/** Comparable form of run-time inputs: empty names are dropped (they are asked during the run). */
export function inputsKey(inputs: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(inputs ?? {}).filter(([, value]) => value).sort(([a], [b]) => a.localeCompare(b)));
}
/** What makes two 실행 requests "the same": their run-time inputs and setting values. Only the same never overlap. */
export function requestKey(inputs: Record<string, string> | undefined, values: Record<string, string> | undefined): string {
  return JSON.stringify([inputsKey(inputs), Object.entries(values ?? {}).filter(([, value]) => value).sort(([a], [b]) => a.localeCompare(b))]);
}
/** One snapshot over several Runs: Task and worker ids are unique across Runs, so statuses resolve as for one Run. */
export function mergeSnapshots(snapshots: RunSnapshot[]): RunSnapshot | null {
  if (!snapshots.length) return null;
  return { run: snapshots[0].run, tasks: snapshots.flatMap((item) => item.tasks), workers: snapshots.flatMap((item) => item.workers),
    observedAt: snapshots.map((item) => item.observedAt).sort()[0] };
}
/** Schedule presets `orca automations create --trigger` accepts; anything else must be a 5-field cron. */
export const triggerPresets = ['hourly', 'daily', 'weekdays', 'weekly'] as const;
export const triggerNames: Record<string, string> = { hourly: '매시간', daily: '매일', weekdays: '평일', weekly: '매주' };
export function validTrigger(value: unknown): value is string {
  return typeof value === 'string' && ((triggerPresets as readonly string[]).includes(value) || /^(\S+\s+){4}\S+$/.test(value.trim()) && /^[0-9*\/,\- ]{9,100}$/.test(value.trim()));
}
/** A run of this workflow scheduled through an Orca automation; the settings are fixed when it is created. */
export type AutomationConfig = {
  id: string; orcaId?: string; name: string; trigger: string; time?: string; day?: number;
  project: string; count: number; cleanup: Cleanup; inputs?: Record<string, string>;
  /** Setting values fixed for every run of this automation (declared keys only). */
  values?: Record<string, string>;
};
/** What Orca reports about an automation right now. */
export type AutomationState = { orcaId: string; name: string; enabled: boolean; nextRunAt?: number; lastRunAt?: number; rrule?: string };
/**
 * Clean-up when a run is done. sessions: release worker terminals (else keep them for inspection).
 * worktrees: remove worktrees this run created (never reused or picked ones). coordinator: close the coordinator's terminal.
 */
export type Cleanup = { coordinator: boolean; worktrees: boolean; sessions: boolean };
export const defaultCleanup: Cleanup = { coordinator: false, worktrees: false, sessions: true };
/** Orca locations a group node can point at. */
export type Location = { id: string; name: string; path: string; branch?: string; repoId?: string };
export type Locations = { projects: Location[]; worktrees: Location[] };
export type RunSummary = { id: string; objective: string; updatedAt: string };
export type TaskSummary = {
  id: string;
  title: string;
  spec: string;
  status: string;
  deps: string[];
};
export type WorkerSummary = {
  dispatchId: string;
  taskId: string;
  provider: string;
  model: string;
  liveness: string;
  stage: string;
  outcome: string;
  terminal?: string;
  terminalState?: string;
};
export type RunSnapshot = {
  run: RunSummary;
  tasks: TaskSummary[];
  workers: WorkerSummary[];
  observedAt: string;
};

export const statusLabels: Record<StageStatus, string> = {
  unbound: '미연결', pending: '대기', running: '실행 중', blocked: '확인 필요',
  completed: '완료', failed: '실패', unknown: '상태 미확인', skipped: '건너뜀',
};

export function taskStatus(task: TaskSummary | undefined, workers: WorkerSummary[]): StageStatus {
  if (!task) return 'unknown';
  // Task settlement is authoritative; a completed task may still own a live terminal.
  if (['completed', 'succeeded', 'done'].includes(task.status)) return 'completed';
  if (['failed', 'cancelled', 'canceled', 'abandoned'].includes(task.status)) return 'failed';
  if (['blocked', 'waiting', 'waiting_for_input', 'awaiting_approval'].includes(task.status)) return 'blocked';
  if (['pending', 'queued', 'todo', 'ready'].includes(task.status)) return 'pending';
  if (['running', 'in_progress', 'in-progress', 'dispatched', 'active'].includes(task.status)) {
    const attempts = workers.filter((worker) => worker.taskId === task.id);
    const current = attempts[0]; // CLI returns newest attempts first; never revive an older attempt.
    if (current?.liveness === 'unverifiable' || current?.liveness === 'exited') return 'unknown';
    if (current && ['waiting', 'blocked', 'question', 'escalation'].includes(current.stage)) return 'blocked';
    return 'running';
  }
  return 'unknown';
}

function bindingStatus(taskId: string | undefined, snapshot: RunSnapshot | null, stale: boolean): StageStatus {
  if (!taskId) return 'unbound';
  if (stale) return 'unknown';
  return taskStatus(snapshot?.tasks.find((item) => item.id === taskId), snapshot?.workers ?? []);
}
/** Status of one node in one execution; a workflow link aggregates its sub-graph Tasks. */
export function nodeExecutionStatus(node: StageNode, execution: Execution, snapshot: RunSnapshot | null, stale: boolean): StageStatus {
  // Skipping is decided by the canvas from branch decisions; it wins over the Task, which the coordinator closes as completed.
  const skipped = new Set(execution.skipped ?? []);
  if (node.data.kind === 'workflow' && !spawnsRuns(node)) {
    const tasks = Object.entries(execution.links?.[node.id] ?? {});
    const statuses = tasks.map(([path, taskId]) => skipped.has(`${node.id}.${path}`) ? 'skipped' : bindingStatus(taskId, snapshot, stale));
    return statuses.length && statuses.every((status) => status === 'skipped') ? 'skipped' : aggregateStatus(statuses.filter((status) => status !== 'skipped'));
  }
  if (skipped.has(node.id)) return 'skipped';
  return bindingStatus(execution.bindings[node.id], snapshot, stale);
}
/** The Task to open for a node in one execution: its own Task, or a link's first open sub-Task. */
function nodeExecutionTask(node: StageNode, execution: Execution, snapshot: RunSnapshot | null, stale: boolean): string | undefined {
  if (node.data.kind !== 'workflow' || spawnsRuns(node)) return execution.bindings[node.id];
  const tasks = Object.values(execution.links?.[node.id] ?? {});
  return tasks.find((taskId) => openableStatuses.includes(bindingStatus(taskId, snapshot, stale))) ?? tasks[0];
}
/** Statuses for which the canvas offers to open the worker's terminal. */
export const openableStatuses: StageStatus[] = ['running', 'blocked', 'unknown'];
// Worst-first, so an aggregate never hides a failure or a question behind finished siblings.
const aggregateOrder: StageStatus[] = ['failed', 'blocked', 'unknown', 'running', 'pending', 'completed', 'skipped', 'unbound'];
export function aggregateStatus(statuses: StageStatus[]): StageStatus {
  const bound: StageStatus[] = statuses.filter((status) => status !== 'unbound');
  if (!bound.length) return 'unbound';
  return aggregateOrder.find((status) => bound.includes(status)) ?? 'unknown';
}

/**
 * Statuses that mean the execution still needs attention, so it stays visible. A pending stage is open too: untaken
 * branches and rejected gates are marked skipped, so a stage still pending is one the coordinator has yet to start.
 */
const openStatuses: StageStatus[] = ['running', 'blocked', 'unknown', 'failed', 'pending'];
/** An execution is finished when nothing is open (only completed or skipped stages) and at least one Task completed. */
export function executionFinished(statuses: StageStatus[]): boolean {
  return !statuses.some((status) => openStatuses.includes(status)) && statuses.includes('completed');
}
export function executionStatuses(nodes: StageNode[], execution: Execution, snapshot: RunSnapshot | null, stale: boolean): StageStatus[] {
  return nodes.filter(isExecutable).map((node) => nodeExecutionStatus(node, execution, snapshot, stale));
}

/**
 * Projects observed state onto nodes.
 * - executionId omitted/null: node.data.taskId binding (single-execution documents).
 * - executionId 'all': aggregate over every execution, with per-execution chips in data.runs.
 * - executionId '<id>': that execution's binding.
 */
export function projectNodes(nodes: StageNode[], snapshot: RunSnapshot | null, stale: boolean,
  executions: Execution[] = [], executionId: string | null = null, visible?: Set<string>): StageNode[] {
  const selected = executionId && executionId !== 'all' ? executions.find((item) => item.id === executionId) : undefined;
  return nodes.map((node) => {
    if (!isExecutable(node)) return { ...node, data: { ...node.data, status: undefined, runs: undefined, activeTaskId: undefined, decision: undefined, spawned: undefined } };
    const runs = executions.map((execution) => ({ id: execution.id, label: execution.label,
      taskId: nodeExecutionTask(node, execution, snapshot, stale), status: nodeExecutionStatus(node, execution, snapshot, stale) }));
    const taskId = selected ? nodeExecutionTask(node, selected, snapshot, stale) : executionId === 'all' ? undefined : node.data.taskId;
    const worker = taskId ? snapshot?.workers.find((item) => item.taskId === taskId) : undefined;
    const task = taskId ? snapshot?.tasks.find((item) => item.id === taskId) : undefined;
    // Chips show only visible executions; with none visible the node still reports the overall result.
    const shown = visible ? runs.filter((run) => visible.has(run.id)) : runs;
    const status = executionId === 'all' ? aggregateStatus((shown.length ? shown : runs).map((run) => run.status))
      : selected ? nodeExecutionStatus(node, selected, snapshot, stale) : bindingStatus(taskId, snapshot, stale);
    const requested = spawnsRuns(node) ? (selected ? [selected] : executionId === 'all' ? executions.filter((execution) => !visible || visible.has(execution.id)) : [])
      .flatMap((execution) => execution.spawned?.[node.id] ?? []) : [];
    return { ...node, data: { ...node.data, status, runs: executionId === 'all' ? shown : undefined, activeTaskId: taskId,
      spawned: requested.length ? requested : undefined,
      decision: selected && isBranch(node) ? selected.decisions?.[node.id] : undefined,
      agent: worker?.provider,
      model: worker?.model,
      detail: stale ? 'Orca 상태를 새로 확인할 수 없습니다.' : task?.status,
    } };
  });
}

export function serializableWorkflow(workflow: Workflow): Workflow {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const groupIds = new Set(workflow.nodes.filter(isGroup).map((node) => node.id));
  const frameIds = new Set(workflow.nodes.filter(isFrame).map((node) => node.id));
  const branchIds = new Set(workflow.nodes.filter(isBranch).map((node) => node.id));

  const executions = workflow.executions?.map((execution) => {
    const links = Object.fromEntries(Object.entries(execution.links ?? {})
      .filter(([nodeId, tasks]) => nodeIds.has(nodeId) && Object.keys(tasks).length));
    return { id: execution.id, label: execution.label,
      // Drop bindings for deleted nodes so a saved document never references a missing node.
      bindings: Object.fromEntries(Object.entries(execution.bindings).filter(([nodeId, taskId]) => nodeIds.has(nodeId) && taskId)),
      ...(Object.keys(links).length ? { links } : {}),
      ...(execution.decisions && Object.keys(execution.decisions).length ? { decisions: execution.decisions } : {}),
      ...(execution.skipped?.length ? { skipped: execution.skipped } : {}),
      ...(execution.automation ? { automation: { id: execution.automation.id, name: execution.automation.name } } : {}),
      ...(execution.runId ? { runId: execution.runId } : {}),
      ...(execution.inputs && Object.keys(execution.inputs).length ? { inputs: execution.inputs } : {}),
      ...(execution.values && Object.keys(execution.values).length ? { values: execution.values } : {}),
      ...(execution.spawned && Object.keys(execution.spawned).some((nodeId) => nodeIds.has(nodeId))
        ? { spawned: Object.fromEntries(Object.entries(execution.spawned).filter(([nodeId]) => nodeIds.has(nodeId))) } : {}) };
  });
  const { executions: _omit, workspace, cleanup, automations, variables, ...rest } = workflow;
  const ordered = orderNodes(workflow.nodes);
  return { ...rest, ...(workspace ? { workspace } : {}),
    ...(variables?.length ? { variables: variables.map((item) => ({ key: item.key, label: item.label.trim() || item.key,
      ...(item.description ? { description: item.description } : {}), ...(item.default ? { default: item.default } : {}), ...(item.required ? { required: true } : {}) })) } : {}),
    ...(cleanup ? { cleanup: { coordinator: !!cleanup.coordinator, worktrees: !!cleanup.worktrees, sessions: !!cleanup.sessions } } : {}),
    ...(automations?.length ? { automations } : {}), ...(executions?.length ? { executions } : {}), nodes: ordered.map((node) => {
    const group = isGroup(node);
    const frame = isFrame(node);
    const parentNode = node.parentId && groupIds.has(node.parentId) ? workflow.nodes.find((item) => item.id === node.parentId) : undefined;
    const parentId = parentNode && canNest(node, parentNode) ? parentNode.id : undefined;
    const data: StageData = { label: node.data.label, description: node.data.description, kind: node.data.kind };
    if (group && createsWorktree(node)) {
      const source = node.data.nameSource ?? 'fixed';
      Object.assign(data, { scope: 'worktree', path: '', worktreeMode: 'create', repoPath: node.data.repoPath ?? '', nameSource: source,
        ...(node.data.baseBranch ? { baseBranch: node.data.baseBranch } : {}),
        ...(source === 'fixed' && node.data.worktreeName ? { worktreeName: node.data.worktreeName } : {}),
        ...(source === 'agent' && node.data.nameFrom ? { nameFrom: node.data.nameFrom } : {}),
        ...(source === 'input' && node.data.inputPrompt ? { inputPrompt: node.data.inputPrompt } : {}),
        ...(node.data.perExecution ? { perExecution: true } : {}) });
    } else if (group && node.data.scope === 'worktree') Object.assign(data, { scope: 'worktree', path: node.data.path ?? '',
      ...(node.data.ref ? { ref: node.data.ref } : {}), ...(node.data.repoPath ? { repoPath: node.data.repoPath } : {}),
      ...(node.data.worktreeName ? { worktreeName: node.data.worktreeName } : {}), ...(node.data.branch ? { branch: node.data.branch } : {}) });
    else if (group) Object.assign(data, { scope: node.data.scope ?? 'project', path: node.data.path ?? '', ...(node.data.ref ? { ref: node.data.ref } : {}) });
    else if (node.data.kind === 'workflow') Object.assign(data, node.data.workflowId ? { workflowId: node.data.workflowId } : {}, node.data.linkMode && node.data.linkMode !== 'wait' ? { linkMode: node.data.linkMode } : {});
    else if (isBranch(node)) Object.assign(data, { mode: node.data.mode ?? 'exclusive', judge: node.data.judge ?? 'previous',
      outputs: (node.data.outputs ?? []).map((output) => ({ id: output.id, label: output.label })), ...(node.data.taskId ? { taskId: node.data.taskId } : {}) });
    else if (node.data.taskId) data.taskId = node.data.taskId;
    if (launchesWorker(node)) Object.assign(data, { ...(node.data.workerModel ? { workerModel: node.data.workerModel } : {}), ...(node.data.effort ? { effort: node.data.effort } : {}) });
    if (!group && isExecutable(node) && node.data.join === 'any') data.join = 'any';
    if (node.data.kind === 'gate' && node.data.asker === 'previous') data.asker = 'previous';
    const width = node.width ?? node.measured?.width;
    const height = node.height ?? node.measured?.height;
    return { id: node.id, type: group ? 'group' : frame ? 'frame' : 'stage', position: node.position, ...(parentId ? { parentId } : {}),
      ...(group || frame ? { width: Math.round(width ?? (frame ? 560 : 640)), height: Math.round(height ?? (frame ? 320 : 360)) } : {}), data } as StageNode;
  }), edges: workflow.edges.filter((edge) => ![edge.source, edge.target].some((id) => groupIds.has(id) || frameIds.has(id)))
    // Only a branch's edges name an output (its source handle); every other edge leaves the single source port.
    .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.label,
      ...(edge.sourceHandle && branchIds.has(edge.source) ? { sourceHandle: edge.sourceHandle } : {}) })) };
}

export function fromSnapshot(snapshot: RunSnapshot): Pick<Workflow, 'nodes' | 'edges' | 'runId' | 'name'> {
  const levels = new Map<string, number>();
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  function level(id: string, visiting = new Set<string>()): number {
    if (levels.has(id)) return levels.get(id)!;
    if (visiting.has(id)) return 0;
    const next = new Set(visiting).add(id);
    const dependencies = tasks.get(id)?.deps.filter((dep) => tasks.has(dep)) ?? [];
    const value = dependencies.length ? Math.min(30, 1 + Math.max(...dependencies.map((dep) => level(dep, next)))) : 0;
    levels.set(id, value);
    return value;
  }
  const rows = new Map<number, number>();
  const nodes: StageNode[] = snapshot.tasks.map((task) => {
    const column = level(task.id);
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { id: task.id, type: 'stage', position: { x: column * 320, y: row * 190 },
      data: { label: task.title || task.spec.slice(0, 60), description: task.spec, taskId: task.id, kind: 'worker' } };
  });
  return { name: snapshot.run.objective, runId: snapshot.run.id, nodes,
    edges: snapshot.tasks.flatMap((task) => task.deps.filter((dep) => tasks.has(dep)).map((dep) => ({
      id: `${dep}-${task.id}`, source: dep, target: task.id,
    }))) };
}

export function newWorkflow(): Workflow {
  const nodes: StageNode[] = [
    { id: 'brief', type: 'stage', position: { x: 0, y: 140 }, data: { label: '요구사항 정리', description: '목표와 완료 조건을 정의합니다.', kind: 'worker' } },
    { id: 'design', type: 'stage', position: { x: 320, y: 140 }, data: { label: '설계', description: '작업 경계와 인터페이스를 정합니다.', kind: 'worker' } },
    { id: 'backend', type: 'stage', position: { x: 640, y: 30 }, data: { label: '백엔드 구현', description: 'API와 데이터 계약을 구현합니다.', kind: 'worker' } },
    { id: 'frontend', type: 'stage', position: { x: 640, y: 270 }, data: { label: '프론트엔드 구현', description: '사용자 화면과 상호작용을 구현합니다.', kind: 'worker' } },
    { id: 'review', type: 'stage', position: { x: 960, y: 140 }, data: { label: '통합 검증', description: '산출물과 완료 증거를 확인합니다.', kind: 'worker' } },
    { id: 'approve', type: 'stage', position: { x: 1280, y: 140 }, data: { label: '사용자 검토', description: '최종 결과를 검토합니다.', kind: 'gate' } },
  ];
  return { version: 1, id: crypto.randomUUID(), name: '개발 워크플로', description: '설계부터 검증까지, 작업의 흐름을 한눈에.', runId: '', nodes,
    edges: [['brief', 'design'], ['design', 'backend'], ['design', 'frontend'], ['backend', 'review'], ['frontend', 'review'], ['review', 'approve']]
      .map(([source, target]) => ({ id: `${source}-${target}`, source, target })) };
}

export function groupOf(workflow: Pick<Workflow, 'nodes'>, node: StageNode): StageNode | undefined {
  return node.parentId ? workflow.nodes.find((item) => item.id === node.parentId && isGroup(item)) : undefined;
}
/** The project and worktree groups a node sits in (directly or through a worktree group inside a project). */
/** The project group and the chain of worktree groups (outermost first) a node sits in. */
export function membershipOf(workflow: Pick<Workflow, 'nodes'>, node: StageNode): { project?: StageNode; worktrees: StageNode[] } {
  const result: { project?: StageNode; worktrees: StageNode[] } = { worktrees: [] };
  for (let group = groupOf(workflow, node), depth = 0; group && depth <= maxGroupDepth; group = groupOf(workflow, group), depth += 1) {
    if (group.data.scope === 'worktree') result.worktrees.unshift(group); else result.project ??= group;
  }
  return result;
}
/** Project a worktree group belongs to: its own pick, else the nearest enclosing worktree's project or project group. */
export function worktreeRepo(workflow: Pick<Workflow, 'nodes'>, group: StageNode): string {
  for (let item: StageNode | undefined = group, depth = 0; item && depth <= maxGroupDepth; item = groupOf(workflow, item), depth += 1) {
    if (item.data.scope === 'worktree' ? item.data.repoPath : item.data.path) return (item.data.scope === 'worktree' ? item.data.repoPath : item.data.path) ?? '';
  }
  return '';
}
/** The worktree group this one is nested in (it is created as that worktree's child), if any. */
export function parentWorktree(workflow: Pick<Workflow, 'nodes'>, group: StageNode): StageNode | undefined {
  const parent = groupOf(workflow, group);
  return parent?.data.scope === 'worktree' ? parent : undefined;
}
/**
 * Where a node runs: its group's path (or a new-worktree token for a create-mode group),
 * else the workflow workspace, else the fallback.
 */
export function nodeLocation(workflow: Pick<Workflow, 'nodes' | 'workspace'>, node: StageNode, fallback: string): string {
  const group = groupOf(workflow, node);
  if (group && createsWorktree(group)) return newWorktreeToken(group.id);
  return group?.data.path || workflow.workspace || fallback;
}

export type Rect = { x: number; y: number; width: number; height: number };
/**
 * What a memo group carries when it moves: stages whose centre lies inside it, and groups or memo groups wholly inside it.
 * `rects` are absolute. A node whose parent group is carried is left out — it moves with that parent.
 */
export function frameContents(frameId: string, nodes: Pick<StageNode, 'id' | 'data' | 'parentId'>[], rects: Map<string, Rect>): string[] {
  const frame = rects.get(frameId);
  if (!frame) return [];
  const within = (x: number, y: number) => x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
  const inside = new Set(nodes.filter((node) => {
    const rect = rects.get(node.id);
    if (node.id === frameId || !rect) return false;
    return isGroup(node) || isFrame(node) ? within(rect.x, rect.y) && within(rect.x + rect.width, rect.y + rect.height)
      : within(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }).map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const carriedByParent = (node: Pick<StageNode, 'parentId'>) => { for (let p = node.parentId, d = 0; p && d <= maxGroupDepth; p = byId.get(p)?.parentId, d += 1) if (inside.has(p)) return true; return false; };
  return nodes.filter((node) => inside.has(node.id) && !carriedByParent(node)).map((node) => node.id);
}

/** Brings documents from older canvases or servers up to the current node kinds ('task' → 'worker'; unknown → 'note'). */
export function normalizeNodes(nodes: StageNode[]): StageNode[] {
  const known: NodeKind[] = ['worker', 'gate', 'branch', 'note', 'workflow', 'group', 'frame'];
  return nodes.map((node) => {
    const kind = node.data.kind as string;
    if (known.includes(kind as NodeKind)) return node;
    return { ...node, type: 'stage', data: { ...node.data, kind: kind === 'task' ? 'worker' : 'note' } };
  });
}

// Execution log (one per 실행 request), written by the server and the coordinator.
/** One line of a launch's events.jsonl. */
export type RunEvent = {
  at: string;
  /** requested · brief · coordinator · coordinator-failed · registered · task · note */
  type: string;
  message: string;
  taskId?: string;
  status?: StageStatus;
  from?: StageStatus;
};
/** meta.json of a launch directory (`.executions/<stamp>-<workflow id>/`). */
export type RunLogMeta = {
  workflowId: string;
  workflowName: string;
  startedAt: string;
  count?: number;
  project?: string;
  automation?: { id: string; name: string };
  /** Run-time worktree names this request was started with (group id → name). */
  inputs?: Record<string, string>;
  /** Setting values this request ran with (defaults applied). Spawn links pass them on to the executions they start. */
  values?: Record<string, string>;
  runId?: string;
  /** Executions as the coordinator registered them: each one's Task ids, so results survive a later run replacing the workflow's list. */
  executions?: LoggedExecution[];
  /** The Run was attached after the fact (a launch from before execution logs existed); events are observation times, not real times. */
  adopted?: boolean;
};
export type LoggedExecution = { id: string; label: string; tasks: string[];
  /** Tasks of stages no taken branch reaches; the coordinator closes them as completed, the log shows them as skipped. */
  skipped?: string[] };
export type ExecutionResult = { id: string; label: string; status: StageStatus; finished: boolean;
  /** `skipped`: a branch the finished execution never took (its Task stayed ready). */
  stages: { taskId: string; title: string; status: StageStatus; skipped?: boolean }[] };
/** Overall state of one 실행 request, for the log list. */
export type RunLogOutcome = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'unknown';
export type RunLogSummary = RunLogMeta & { id: string; events: number; last?: RunEvent; files: string[]; outcome: RunLogOutcome };
export type RunLogDetail = { id: string; meta: RunLogMeta; events: RunEvent[]; files: string[]; outcome: RunLogOutcome;
  /** Live per-execution results from Orca; null when the Run is unknown or could not be read. */
  results: ExecutionResult[] | null; resultsError?: string };
export type RunLogFile = { name: string; size: number; truncated: boolean; text: string };

/** Event types the coordinator may append through the API; the rest are written by the server only. */
export const coordinatorEventTypes = ['note', 'gate', 'worker', 'error', 'report'] as const;
export const runEventNames: Record<string, string> = {
  execution: '실행 결과', finished: '전체 종료', adopted: 'Run 연결',
  requested: '실행 요청', brief: '브리프', coordinator: '코디네이터', 'coordinator-failed': '기동 실패', registered: '실행 등록',
  task: 'Task', note: '메모', gate: '게이트', worker: '워커 보고', error: '오류', report: '마무리 보고',
};
/** Results of each logged execution in a Run snapshot. A Task missing from the snapshot counts as unknown. */
export function executionResults(executions: LoggedExecution[], snapshot: RunSnapshot): ExecutionResult[] {
  return executions.map((execution) => {
    const skipped = new Set(execution.skipped ?? []);
    const stages = execution.tasks.map((taskId) => {
      const task = snapshot.tasks.find((item) => item.id === taskId);
      return { taskId, title: task?.title ?? taskId, status: skipped.has(taskId) ? 'skipped' as const : taskStatus(task, snapshot.workers) };
    });
    const statuses = stages.map((stage) => stage.status);
    const finished = executionFinished(statuses);
    return { id: execution.id, label: execution.label, status: aggregateStatus(statuses), finished,
      stages: stages.map((stage) => stage.status === 'skipped' || (finished && stage.status === 'pending') ? { ...stage, skipped: true } : stage) };
  });
}
export function loggedExecutions(executions: Execution[]): LoggedExecution[] {
  return executions.map((execution) => {
    const skipped = executionTasks(execution, execution.skipped ?? []);
    return { id: execution.id, label: execution.label,
      tasks: [...new Set([...Object.values(execution.bindings), ...Object.values(execution.links ?? {}).flatMap((tasks) => Object.values(tasks))])],
      ...(skipped.length ? { skipped } : {}) };
  });
}
/** Task ids bound to these stage paths (`node` or `link.sub.path`) in one execution. */
export function executionTasks(execution: Execution, paths: string[]): string[] {
  return paths.flatMap((path) => {
    if (execution.bindings[path]) return [execution.bindings[path]];
    const dot = path.indexOf('.');
    const task = dot > 0 ? execution.links?.[path.slice(0, dot)]?.[path.slice(dot + 1)] : undefined;
    return task ? [task] : [];
  });
}

// Flow semantics. Plain edges are AND: a stage runs when every predecessor that was not skipped has finished, and
// fan-out is parallel. Only a branch node chooses: its outputs are source handles, and an output it did not take
// skips what lies behind it. A stage is skipped when every incoming edge is dead (its source was skipped, or it
// leaves an output the decided branch did not take). Graphs are acyclic; loops are not expressed by edges.

/** One stage of the flattened execution graph (workflow links expanded, ids link-prefixed). */
export type FlowStage = { id: string; after: { id: string; output?: string }[]; branch?: { mode: BranchMode; outputs: string[] };
  /** Display: stage name, what to ask, and who decides (gates and user branches are decided by the user). */
  label?: string; question?: string; judge?: BranchJudge; outputLabels?: Record<string, string>;
  /** Outputs that stop everything after this stage, even a join that another live path reaches (a rejected gate). */
  veto?: string[];
  /** 'any': runs when at least one incoming path is alive (paths meeting again after a branch). Default: every path. */
  join?: JoinMode };
/** A gate is a user decision with two outputs; every edge leaving it is the 'approve' output. */
export const gateOutputs: BranchOutput[] = [{ id: 'approve', label: '통과' }, { id: 'reject', label: '거절' }];
/** A user decision the canvas can take now: its stage is reached, undecided, and every live predecessor finished. */
export type PendingDecision = { executionId: string; executionLabel: string; node: string; label: string; question: string;
  mode: BranchMode; outputs: BranchOutput[]; taskId?: string;
  /** A gate asked in the terminal of the worker before it: that worker, now waiting for the user. */
  askedBy?: { label: string; taskId?: string } };
/** A gate whose question the worker before it asks in its own terminal (judge 'previous' on a gate). */
const askedInWorker = (stage: FlowStage) => !!stage.veto && stage.judge === 'previous';
/** User decisions of one execution that are open now (gates and user-judged branches whose predecessors finished). */
export function pendingDecisions(flow: FlowStage[], execution: Execution, snapshot: RunSnapshot | null): PendingDecision[] {
  if (!snapshot) return [];
  const decisions = execution.decisions ?? {};
  const skipped = new Set(execution.skipped ?? []);
  const done = (id: string) => skipped.has(id) || executionTasks(execution, [id]).some((taskId) =>
    taskStatus(snapshot.tasks.find((task) => task.id === taskId), snapshot.workers) === 'completed');
  const status = (id: string) => { const [taskId] = executionTasks(execution, [id]);
    return taskId ? taskStatus(snapshot.tasks.find((task) => task.id === taskId), snapshot.workers) : 'unbound'; };
  // A worker-asked gate is open while its worker waits for the user (Orca reports it as needing attention).
  const asking = (stage: FlowStage) => askedInWorker(stage) && stage.after.length === 1 && status(stage.after[0].id) === 'blocked';
  return flow.filter((stage) => stage.branch && !decisions[stage.id] && !skipped.has(stage.id)
    && (stage.judge === 'user' ? stage.after.every((item) => done(item.id)) : asking(stage))).map((stage) => {
    const [taskId] = executionTasks(execution, [stage.id]);
    const asker = askedInWorker(stage) ? flow.find((item) => item.id === stage.after[0].id) : undefined;
    const [askerTask] = asker ? executionTasks(execution, [asker.id]) : [];
    return { executionId: execution.id, executionLabel: execution.label, node: stage.id, label: stage.label ?? stage.id, question: stage.question ?? '',
      mode: stage.branch!.mode, outputs: stage.branch!.outputs.map((id) => ({ id, label: stage.outputLabels?.[id] ?? id })), ...(taskId ? { taskId } : {}),
      ...(asker ? { askedBy: { label: asker.label ?? asker.id, ...(askerTask ? { taskId: askerTask } : {}) } } : {}) };
  });
}

/** Kahn order of `ids` over `edges`. When there is a cycle, `cycle` lists it (first node repeated at the end). */
export function topologicalOrder(ids: string[], edges: { source: string; target: string }[]): { order: string[]; cycle?: string[] } {
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, [] as string[]]));
  const prev = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    next.get(edge.source)!.push(edge.target); prev.get(edge.target)!.push(edge.source);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    order.push(id);
    for (const target of next.get(id)!) { indegree.set(target, indegree.get(target)! - 1); if (indegree.get(target) === 0) queue.push(target); }
  }
  if (order.length === ids.length) return { order };
  // Every node left over still has a left-over predecessor, so walking predecessors must revisit one: that loop is a cycle.
  const rest = new Set(ids.filter((id) => !order.includes(id)));
  const walk: string[] = [];
  let current = [...rest][0];
  while (!walk.includes(current)) { walk.push(current); current = prev.get(current)!.find((id) => rest.has(id))!; }
  const loop = walk.slice(walk.indexOf(current)).reverse();
  // Start the reported loop at the node that comes first in `ids`, so the message is stable.
  const start = loop.indexOf(ids.find((id) => loop.includes(id))!);
  const rotated = [...loop.slice(start), ...loop.slice(0, start)];
  return { order, cycle: [...rotated, rotated[0]] };
}
/** Longest-path depth of each node: stages in the same wave can run side by side. */
export function waves(order: string[], edges: { source: string; target: string }[]): Map<string, number> {
  const wave = new Map(order.map((id) => [id, 0]));
  for (const id of order) for (const edge of edges) if (edge.source === id && wave.has(edge.target)) wave.set(edge.target, Math.max(wave.get(edge.target)!, wave.get(id)! + 1));
  return wave;
}
/** Stages no taken path reaches, given the branch decisions so far. Undecided branches keep all their outputs alive. */
export function skippedStages(flow: FlowStage[], decisions: Record<string, string[]>): string[] {
  const byId = new Map(flow.map((stage) => [stage.id, stage]));
  const { order } = topologicalOrder(flow.map((stage) => stage.id), flow.flatMap((stage) => stage.after.map((item) => ({ source: item.id, target: stage.id }))));
  const skipped = new Set<string>();
  for (const id of order) {
    const stage = byId.get(id)!;
    if (!stage.after.length) continue;
    const vetoed = stage.after.some((item) => byId.get(item.id)?.veto?.some((output) => decisions[item.id]?.includes(output)));
    const live = (item: FlowStage['after'][number]) => !skipped.has(item.id)
      && !(byId.get(item.id)?.branch && decisions[item.id] && item.output && !decisions[item.id].includes(item.output));
    const runs = stage.join === 'any' ? stage.after.some(live) : stage.after.every(live);
    if (vetoed || !runs) skipped.add(id);
  }
  return order.filter((id) => skipped.has(id));
}
/** Why a reported decision cannot be accepted, or undefined when it can. */
export function decisionError(flow: FlowStage[], decisions: Record<string, string[]>, node: string, outputs: string[]): string | undefined {
  const stage = flow.find((item) => item.id === node);
  if (!stage?.branch) return `'${node}' 는 이 워크플로의 분기·게이트 단계가 아닙니다.`;
  if (!outputs.length || new Set(outputs).size !== outputs.length) return '출력을 하나 이상, 중복 없이 고르세요.';
  const unknown = outputs.find((output) => !stage.branch!.outputs.includes(output));
  if (unknown) return `'${unknown}' 는 이 분기의 출력이 아닙니다. 출력: ${stage.branch.outputs.join(', ')}`;
  if (stage.branch.mode === 'exclusive' && outputs.length !== 1) return '이 분기는 출력을 하나만 고를 수 있습니다.';
  if (skippedStages(flow, decisions).includes(node)) return '이 분기는 이미 건너뛴 단계입니다.';
  const previous = decisions[node];
  if (previous && (previous.length !== outputs.length || previous.some((output) => !outputs.includes(output)))) return `이 분기는 이미 ${previous.join(', ')} 로 결정되었습니다.`;
  return undefined;
}
