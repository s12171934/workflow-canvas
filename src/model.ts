import type { Edge, Node } from '@xyflow/react';
import { autoLayout } from './layout.ts';

export type StageStatus = 'unbound' | 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'unknown' | 'skipped';
/** Normal (executable or annotation) node kinds. `workflow` links to another saved workflow. */
export type StageKind = 'worker' | 'gate' | 'note' | 'workflow' | 'branch' | 'script';
/**
 * Script driver: the coordinator runs `command` itself (no agent) at the stage's location and reads its output.
 * 'jsonl' — one JSON object per line: {"item", "selected"?, "label"?, "reason"?} lines give the items (selected unless
 * `"selected": false`), a {"decision": "<output id>[,…]"} line decides a branch or gate right after it.
 * 'regex' — every line matching `itemPattern` gives an item (its first capture group, else the whole match).
 * 'none' — only the exit code counts. A non-zero exit fails the stage.
 */
export type ScriptParse = 'none' | 'jsonl' | 'regex';
export const scriptParses: ScriptParse[] = ['none', 'jsonl', 'regex'];
export const scriptParseNames: Record<ScriptParse, string> = { none: '종료 코드만', jsonl: 'JSON 줄 (선별 결과)', regex: '정규식으로 항목 추출' };
export const maxScriptTimeout = 86400;
/** Branch: 'exclusive' takes exactly one output, 'inclusive' every output whose condition holds (at least one). */
export type BranchMode = 'exclusive' | 'inclusive';
/** Who decides a branch: the worker of the stage right before it, a judging worker of its own, or the user. */
export type BranchJudge = 'previous' | 'worker' | 'user';
export type BranchOutput = { id: string; label: string };
export const branchModeNames: Record<BranchMode, string> = { exclusive: '하나만', inclusive: '해당하는 것 모두' };
export const branchJudgeNames: Record<BranchJudge, string> = { previous: '직전 단계 워커', worker: '판정 워커', user: '사용자' };
/** Where a gate asks the user: the coordinator (decision card / its terminal), or the terminal of the worker right before it. */
export type GateAsker = 'coordinator' | 'previous' | 'auto';
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
/**
 * Spawn link: who supervises each item's 실행. 'coordinator' (default) — the server launches an independent coordinator;
 * 'subcoordinator' — the server only prepares the 실행 (log, brief, worktree) and this run's coordinator starts it as its own
 * worker (a child Task of the link), which reports back with worker_done.
 */
export type SpawnAs = 'coordinator' | 'subcoordinator';
export const spawnAsModes: SpawnAs[] = ['coordinator', 'subcoordinator'];
export const spawnAsNames: Record<SpawnAs, string> = { coordinator: '독립 코디네이터로 띄우기', subcoordinator: '하위 코디네이터로 띄우기' };
/** A spawn link whose items run as sub-coordinators: workers of this run's coordinator. */
export const spawnsSubcoordinators = (node: Pick<StageNode, 'data'>) => spawnsRuns(node) && node.data.spawnAs === 'subcoordinator';
/** How many separate executions one spawn request may start. */
export const maxSpawnItems = 20;
/** One item a spawn link asked to run: the launch it started, or why it could not. */
export type SpawnResult = { item: string; at: string; workflowId: string; launch?: string; error?: string;
  /** Sub-coordinator links: the brief the coordinator's worker reads, and the worktree the server prepared for it. */
  brief?: string; worktree?: string };
export const gateAskerNames: Record<GateAsker, string> = { coordinator: '코디네이터', previous: '직전 워커', auto: '자동 승인' };
export const maxBranchOutputs = 8;
export type JoinMode = 'all' | 'any';
export const joinNames: Record<JoinMode, string> = { all: '모두 필요', any: '하나라도 오면 진행' };
/** Group nodes fix where their children run: an Orca project (repo) or one Orca worktree. */
export type GroupScope = 'project' | 'worktree';
/** `frame`: a memo group — a resizable box that only gathers nodes visually (moving it moves what lies inside); never executes or sets a location. */
export type NodeKind = StageKind | 'group' | 'frame';
/**
 * Fallback model ids offered per launching node, used only when the server cannot reach the Anthropic Models API
 * (`server/models.ts` serves the newest of each family at /api/models); unset means `defaultWorkerModel`.
 */
export const workerModels = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] as const;
export const defaultWorkerModel = 'claude-opus-5-5';
/** Reasoning effort per launching node; unset means the model's own default (no --effort). */
export const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof effortLevels[number];
/** Model ids reach `worker-start --model` argv: never a leading '-', no spaces. */
export const workerModelPattern = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;
/** Nodes for which the coordinator starts a worker: workers, and branches judged by a worker of their own. */
export const launchesWorker = (node: Pick<StageNode, 'data'>) => node.data.kind === 'worker' || (node.data.kind === 'branch' && node.data.judge === 'worker');
/**
 * A worker node that fans out: one worker per model, all at once on the same instructions (a review round by N reviewers).
 * `models` is the list kept on the canvas; `variable` names a run setting whose comma-separated value, when given, replaces it.
 */
export type ModelFanout = { models: string[]; variable?: string };
export const fansOut = (node: Pick<StageNode, 'data'>) => node.data.kind === 'worker' && !!node.data.fanout;
/** The Orca agent (`worker-start --agent`) that runs a model: GPT·Codex models run in Codex, the rest in Claude Code. */
export function agentOf(model: string): 'claude' | 'codex' { return /^(gpt|codex|o\d)/i.test(model) ? 'codex' : 'claude'; }
/** Models in a setting value: separated by commas or whitespace, empty entries dropped. */
export const parseModelList = (value: string) => value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
/** The models a fanout stage runs with these setting values: the setting's list when it is given, else the node's own list. */
export function fanoutModels(fanout: ModelFanout, values: Record<string, string> = {}): string[] {
  const fromSetting = fanout.variable ? parseModelList(values[fanout.variable] ?? '') : [];
  return fromSetting.length ? fromSetting : fanout.models;
}
/** One worker per listed model, named after it; the same model listed again becomes `<model>-2`, `<model>-3`, … */
export function fanoutWorkers(models: string[]): { name: string; model: string; agent: 'claude' | 'codex' }[] {
  const seen = new Map<string, number>();
  return models.map((model) => {
    const count = (seen.get(model) ?? 0) + 1;
    seen.set(model, count);
    return { name: count === 1 ? model : `${model}-${count}`, model, agent: agentOf(model) };
  });
}
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
  /**
   * 'create' only, for a group not nested in another worktree group: the worktree to create it under (an absolute path,
   * or a setting such as `{{parent_worktree}}`). Empty, or a setting given no value: no parent.
   */
  parentPath?: string;
  /** Display only: the project a create-mode worktree group inherits from its project group. */
  inheritedRepo?: string;
  /** Display only: the selected node's project/worktree groups, shown on its card. */
  membership?: { project?: string; worktrees: string[] };
  /** Display only: this group contains the selected node. */
  ancestor?: boolean;
  /** Display only: how this node relates to the selected stage — the stage itself, a direct predecessor/successor (or both), or unrelated. */
  relation?: Relation;
  /** Display only: how many shown executions are running this stage right now (even when another execution's failure leads its status). */
  live?: number;
  /** kind 'workflow': the linked saved workflow, and whether what follows waits for it (unset: 'wait'). */
  workflowId?: string;
  linkMode?: LinkMode;
  /** Spawn links: how each item's 실행 is supervised (unset: 'coordinator'). */
  spawnAs?: SpawnAs;
  /** Display only: the round a looped stage is on (2 and up), in the selected execution or the furthest visible one. */
  round?: number;
  /** Display only, spawn links: the separate executions requested (by the selected execution, or the visible ones). */
  spawned?: SpawnResult[];
  /** kind 'branch': how many outputs it takes, who decides, and its outputs (each a source handle). */
  mode?: BranchMode;
  judge?: BranchJudge;
  /** kind 'gate': where the user is asked. Unset means 'coordinator'; 'auto' approves without asking (the run log records it). */
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
  /** kind 'worker': run one worker per model in parallel instead of one worker (see `ModelFanout`); `workerModel` is then unset. */
  fanout?: ModelFanout;
  /** kind 'script': the command (a shell script, {{settings}} allowed), how its output is read, and how it runs. */
  command?: string;
  parse?: ScriptParse;
  itemPattern?: string;
  /** Run in its own Orca terminal instead of the coordinator's (long-running drivers); the coordinator polls its exit file. */
  detach?: boolean;
  timeoutSec?: number;
};
export type StageNode = Node<StageData, 'stage' | 'group' | 'frame'>;
export const isGroup = (node: Pick<StageNode, 'data'>) => node.data.kind === 'group';
export const isFrame = (node: Pick<StageNode, 'data'>) => node.data.kind === 'frame';
/** A worktree group whose worktree does not exist yet: the coordinator creates one per execution. */
/** React Flow needs every parent before its children: project groups, then worktree groups, then stages (stable within each). */
export function orderNodes<T extends Pick<StageNode, 'id' | 'data' | 'parentId'>>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = (node: T) => { let d = 0; for (let p = node.parentId; p && d < maxGroupDepth + 1; p = byId.get(p)?.parentId) d += 1; return d; };
  // Top-level memo groups first (they sit under everything), then groups by nesting depth — a memo group inside a group right
  // after its group's level, so it draws over that group but under the groups nested beside it — then stages.
  const rank = (node: T) => isFrame(node) ? (node.parentId ? depth(node) - 0.5 : -1) : isGroup(node) ? depth(node) : maxGroupDepth + 2;
  return nodes.map((node, index) => ({ node, index, rank: rank(node) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ node }) => node);
}
/** Project group + up to this many worktree groups nested inside one another. */
export const maxGroupDepth = 4;
/**
 * What may sit in a group: stages and memo groups in any group; a worktree group in a project or another worktree (it becomes a
 * child worktree); a project group nowhere. Memo groups never hold anything themselves.
 */
export function canNest(child: Pick<StageNode, 'data'>, parent: Pick<StageNode, 'data'>): boolean {
  if (!isGroup(parent)) return false;
  if (!isGroup(child)) return true;
  return child.data.scope === 'worktree';
}
export const createsWorktree = (node: Pick<StageNode, 'data'>) => isGroup(node) && node.data.scope === 'worktree' && node.data.worktreeMode === 'create';
/** Location token for stages in a create-mode group; the coordinator swaps it for the created worktree's path. */
export const newWorktreeToken = (groupId: string) => `new-worktree:${groupId}`;
/** Nodes that become Tasks (or, for links, a sub-graph of Tasks) when the workflow runs. */
export const isExecutable = (node: Pick<StageNode, 'data'>) => ['worker', 'gate', 'workflow', 'branch', 'script'].includes(node.data.kind);
/** Stages that can report items for a spawn link or a decision for the branch/gate after them: a worker or a script that parses its output. */
export const reportsResults = (node: Pick<StageNode, 'data'>) => node.data.kind === 'worker' || (node.data.kind === 'script' && (node.data.parse ?? 'none') !== 'none');
export const isBranch = (node: Pick<StageNode, 'data'>) => node.data.kind === 'branch';
export const kindNames: Record<NodeKind, string> = { worker: '워커', gate: '사용자 개입 게이트', branch: '분기', script: '스크립트 드라이버', note: '메모', workflow: '워크플로 링크', group: '그룹', frame: '메모 그룹' };
export const scopeNames: Record<GroupScope, string> = { project: 'Orca 프로젝트', worktree: '워크트리' };
export type Workflow = {
  version: 1;
  id: string;
  name: string;
  description: string;
  /** Labels the sidebar groups saved workflows by; a workflow with several tags shows under each. */
  tags?: string[];
  runId: string;
  nodes: StageNode[];
  edges: WorkflowEdge[];
  executions?: Execution[];
  /** Default project offered in the run dialog (the run itself always names its project). */
  workspace?: string;
  /** What the coordinator cleans up when the run is done; the run dialog starts from these. */
  cleanup?: Cleanup;
  /** Orca automations that run this workflow on a schedule. */
  automations?: AutomationConfig[];
  /** Settings the run dialog and automations ask for (an epic link, a sheet URL…); stage instructions use them as {{key}}. */
  variables?: WorkflowVariable[];
  /**
   * A worktree group the coordinator runs in. Unset: the coordinator starts in the run's project. Set: the server prepares
   * that worktree (reuses or creates it) before starting the coordinator inside it.
   */
  coordinatorGroup?: string;
};
export const maxTags = 10;
export const maxTagLength = 30;
/** A tag as typed: inner whitespace collapsed, trimmed, cut to the length limit. Empty when nothing usable is left. */
export const cleanTag = (value: string) => value.replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxTagLength);
export const validTags = (value: unknown): value is string[] => Array.isArray(value) && value.length <= maxTags
  && value.every((tag) => typeof tag === 'string' && tag !== '' && cleanTag(tag) === tag) && new Set(value).size === value.length;
/** Sidebar sections: one per tag in name order, then untagged items last (key ''). Item order inside a section is kept. */
export function groupByTag<T extends { tags?: string[] }>(items: T[]): { tag: string; items: T[] }[] {
  const tags = [...new Set(items.flatMap((item) => item.tags ?? []))].sort((a, b) => a.localeCompare(b, 'ko'));
  const sections = tags.map((tag) => ({ tag, items: items.filter((item) => item.tags?.includes(tag)) }));
  const untagged = items.filter((item) => !item.tags?.length);
  return untagged.length ? [...sections, { tag: '', items: untagged }] : sections;
}
/**
 * A loop edge goes back from an output of an exclusive branch to a stage before it. Choosing that output runs the stages
 * from the target to the branch again (a new round), at most `max` times; after that the choice becomes `exit`.
 */
export type EdgeLoop = { max: number; exit: string };
export type WorkflowEdge = Edge & { loop?: EdgeLoop };
export const maxLoopRounds = 200;
/** Edges that are not loops: the graph they form must be acyclic. */
export const forwardEdges = <T extends { loop?: EdgeLoop }>(edges: T[]) => edges.filter((edge) => !edge.loop);
/** Stages a loop runs again: on a forward path from its target to its source, both included. */
export function loopBody(edges: { source: string; target: string; loop?: EdgeLoop }[], loop: { source: string; target: string }): string[] {
  const forward = forwardEdges(edges);
  const reach = (start: string, down: boolean) => {
    const seen = new Set([start]);
    for (let queue = [start], id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const edge of forward) {
        const [from, to] = down ? [edge.source, edge.target] : [edge.target, edge.source];
        if (from === id && !seen.has(to)) { seen.add(to); queue.push(to); }
      }
    }
    return seen;
  };
  const after = reach(loop.target, true);
  const before = reach(loop.source, false);
  return [...after].filter((id) => before.has(id));
}
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
  spawned?: Record<string, SpawnResult[]>;
  /** Loop edge id → how many times the execution went back along it. */
  loops?: Record<string, number>;
  /** Earlier rounds of looped stages: what each pass bound and decided before the loop sent it back. */
  history?: LoopPass[] };
/**
 * One finished pass of a loop body: its stages, their Tasks and decisions (the branch's own loop choice included), and
 * what its spawn links requested — a spawn link inside the body asks for the same items again on the next pass.
 */
export type LoopPass = { edge: string; pass: number; nodes: string[]; bindings: Record<string, string>; decisions?: Record<string, string[]>;
  spawned?: Record<string, SpawnResult[]> };
/** Which round a stage is on in one execution: 1 plus the earlier passes that included it. */
export const stageRound = (execution: Pick<Execution, 'history'>, nodeId: string) =>
  1 + (execution.history ?? []).filter((pass) => pass.nodes.includes(nodeId)).length;
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

/** 요약 보기 order: what needs eyes first (running, waiting on a person, failed), then what is settled. */
export const tallyOrder: StageStatus[] = ['running', 'blocked', 'failed', 'unknown', 'pending', 'completed', 'skipped', 'unbound'];
/** How many of the given statuses fall in each status, in `tallyOrder`, leaving out the empty ones. */
export function tallyStatuses(statuses: StageStatus[]): { status: StageStatus; count: number }[] {
  return tallyOrder.map((status) => ({ status, count: statuses.filter((item) => item === status).length })).filter((item) => item.count > 0);
}
export type ExecutionSummary = { total: number; done: number; tally: { status: StageStatus; count: number }[];
  running: string[]; blocked: string[]; failed: string[] };
/** One execution at a glance: settled stages (completed or skipped) of all, and which stages run, wait, or failed. */
export function summarizeExecution(nodes: StageNode[], execution: Execution, snapshot: RunSnapshot | null, stale: boolean): ExecutionSummary {
  const stages = nodes.filter(isExecutable);
  const statuses = stages.map((node) => nodeExecutionStatus(node, execution, snapshot, stale));
  const names = (status: StageStatus) => stages.filter((_, index) => statuses[index] === status).map((node) => node.data.label || '이름 없는 단계');
  return { total: stages.length, done: statuses.filter((status) => status === 'completed' || status === 'skipped').length,
    tally: tallyStatuses(statuses), running: names('running'), blocked: names('blocked'), failed: names('failed') };
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
    if (!isExecutable(node)) return { ...node, data: { ...node.data, status: undefined, runs: undefined, activeTaskId: undefined, decision: undefined, spawned: undefined, round: undefined, live: undefined } };
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
    const live = executionId === 'all' ? shown.filter((run) => run.status === 'running').length : status === 'running' ? 1 : 0;
    return { ...node, data: { ...node.data, status, runs: executionId === 'all' ? shown : undefined, activeTaskId: taskId, live: live || undefined,
      spawned: requested.length ? requested : undefined,
      round: (() => { const rounds = (selected ? [selected] : executionId === 'all' ? executions.filter((execution) => !visible || visible.has(execution.id)) : [])
        .map((execution) => stageRound(execution, node.id)); const top = Math.max(1, ...rounds); return top > 1 ? top : undefined; })(),
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
      ...(execution.loops && Object.keys(execution.loops).length ? { loops: execution.loops } : {}),
      ...(execution.history?.length ? { history: execution.history } : {}),
      ...(execution.spawned && Object.keys(execution.spawned).some((nodeId) => nodeIds.has(nodeId))
        ? { spawned: Object.fromEntries(Object.entries(execution.spawned).filter(([nodeId]) => nodeIds.has(nodeId))) } : {}) };
  });
  const { executions: _omit, workspace, cleanup, automations, variables, coordinatorGroup, tags, ...rest } = workflow;
  const ordered = orderNodes(workflow.nodes);
  return { ...rest, ...(tags?.length ? { tags } : {}), ...(workspace ? { workspace } : {}),
    ...(coordinatorGroup && groupIds.has(coordinatorGroup) ? { coordinatorGroup } : {}),
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
        ...(node.data.perExecution ? { perExecution: true } : {}), ...(node.data.parentPath?.trim() ? { parentPath: node.data.parentPath.trim() } : {}) });
    } else if (group && node.data.scope === 'worktree') Object.assign(data, { scope: 'worktree', path: node.data.path ?? '',
      ...(node.data.ref ? { ref: node.data.ref } : {}), ...(node.data.repoPath ? { repoPath: node.data.repoPath } : {}),
      ...(node.data.worktreeName ? { worktreeName: node.data.worktreeName } : {}), ...(node.data.branch ? { branch: node.data.branch } : {}) });
    else if (group) Object.assign(data, { scope: node.data.scope ?? 'project', path: node.data.path ?? '', ...(node.data.ref ? { ref: node.data.ref } : {}) });
    else if (node.data.kind === 'workflow') Object.assign(data, node.data.workflowId ? { workflowId: node.data.workflowId } : {}, node.data.linkMode && node.data.linkMode !== 'wait' ? { linkMode: node.data.linkMode } : {},
      node.data.linkMode === 'spawn' && node.data.spawnAs === 'subcoordinator' ? { spawnAs: 'subcoordinator' } : {});
    else if (isBranch(node)) Object.assign(data, { mode: node.data.mode ?? 'exclusive', judge: node.data.judge ?? 'previous',
      outputs: (node.data.outputs ?? []).map((output) => ({ id: output.id, label: output.label })), ...(node.data.taskId ? { taskId: node.data.taskId } : {}) });
    else if (node.data.kind === 'script') {
      const parse = node.data.parse ?? 'none';
      Object.assign(data, { command: node.data.command ?? '', ...(parse !== 'none' ? { parse } : {}),
        ...(parse === 'regex' && node.data.itemPattern ? { itemPattern: node.data.itemPattern } : {}),
        ...(node.data.detach ? { detach: true } : {}), ...(node.data.timeoutSec ? { timeoutSec: node.data.timeoutSec } : {}),
        ...(node.data.taskId ? { taskId: node.data.taskId } : {}) });
    } else if (node.data.taskId) data.taskId = node.data.taskId;
    if (launchesWorker(node)) Object.assign(data, { ...(node.data.workerModel && !fansOut(node) ? { workerModel: node.data.workerModel } : {}), ...(node.data.effort ? { effort: node.data.effort } : {}),
      ...(fansOut(node) ? { fanout: { models: [...node.data.fanout!.models], ...(node.data.fanout!.variable ? { variable: node.data.fanout!.variable } : {}) } } : {}) });
    if (!group && isExecutable(node) && node.data.join === 'any') data.join = 'any';
    if (node.data.kind === 'gate' && (node.data.asker === 'previous' || node.data.asker === 'auto')) data.asker = node.data.asker;
    const width = node.width ?? node.measured?.width;
    const height = node.height ?? node.measured?.height;
    return { id: node.id, type: group ? 'group' : frame ? 'frame' : 'stage', position: node.position, ...(parentId ? { parentId } : {}),
      ...(group || frame ? { width: Math.round(width ?? (frame ? 560 : 640)), height: Math.round(height ?? (frame ? 320 : 360)) } : {}),
      // A note keeps a size only once it has been resized (otherwise it fits its text).
      ...(node.data.kind === 'note' && node.width && node.height ? { width: Math.round(node.width), height: Math.round(node.height) } : {}), data } as StageNode;
  }), edges: workflow.edges.filter((edge) => ![edge.source, edge.target].some((id) => groupIds.has(id) || frameIds.has(id)))
    // Only a branch's edges name an output (its source handle); every other edge leaves the single source port.
    .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.label,
      ...(edge.sourceHandle && branchIds.has(edge.source) ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.loop && branchIds.has(edge.source) ? { loop: { max: edge.loop.max, exit: edge.loop.exit } } : {}) })) };
}

export function fromSnapshot(snapshot: RunSnapshot): Pick<Workflow, 'nodes' | 'edges' | 'runId' | 'name'> {
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const nodes: StageNode[] = snapshot.tasks.map((task) => ({ id: task.id, type: 'stage', position: { x: 0, y: 0 },
    data: { label: task.title || task.spec.slice(0, 60), description: task.spec, taskId: task.id, kind: 'worker' } }));
  const edges = snapshot.tasks.flatMap((task) => task.deps.filter((dep) => tasks.has(dep)).map((dep) => ({
    id: `${dep}-${task.id}`, source: dep, target: task.id,
  })));
  return { name: snapshot.run.objective, runId: snapshot.run.id, nodes: autoLayout(nodes, edges), edges };
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
export type Relation = 'focus' | 'upstream' | 'downstream' | 'both' | 'dim';
/** Stages one connection away from `id`: what feeds it (upstream) and what it feeds (downstream), loops included, itself excluded. */
export function neighbors(edges: Pick<Edge, 'source' | 'target'>[], id: string): { upstream: string[]; downstream: string[] } {
  const upstream = new Set<string>(); const downstream = new Set<string>();
  for (const edge of edges) {
    if (edge.target === id && edge.source !== id) upstream.add(edge.source);
    if (edge.source === id && edge.target !== id) downstream.add(edge.target);
  }
  return { upstream: [...upstream], downstream: [...downstream] };
}
/** The relation of `nodeId` to the focused stage, given its neighbours. */
export function relationTo(nodeId: string, focus: string, near: { upstream: string[]; downstream: string[] }): Relation {
  if (nodeId === focus) return 'focus';
  const up = near.upstream.includes(nodeId); const down = near.downstream.includes(nodeId);
  return up && down ? 'both' : up ? 'upstream' : down ? 'downstream' : 'dim';
}

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
/** A create-mode group's own parent setting, with settings substituted; '' when unset or its setting has no value. */
export function resolvedParentPath(group: Pick<StageNode, 'data'>, values: Record<string, string>): string {
  const text = substituteVariables(group.data.parentPath ?? '', values).trim();
  return text.startsWith('/') && !variableRefs(text).length ? text : '';
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
  const known: NodeKind[] = ['worker', 'gate', 'branch', 'script', 'note', 'workflow', 'group', 'frame'];
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
/** Longest run name (실행 이름) the run dialog accepts. */
export const maxRunTitle = 60;
/** Label of execution `n` of a request named `title`: the name alone when the request runs once, else `<name> #<n>`. */
export const executionLabel = (title: string, n: number, count: number) => count > 1 ? `${title} #${n}` : title;
/** A workflow's open Runs at a glance (sidebar): Tasks running and Tasks waiting on a person. */
export type WorkflowLive = { running: number; blocked: number };
export type RunLogMeta = {
  workflowId: string;
  workflowName: string;
  startedAt: string;
  count?: number;
  /** The name this request's executions go by (Task titles, tabs, canvas chips): typed in the run dialog, else derived. */
  title?: string;
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
  /** Terminal of the coordinator the server started for this launch (absent: an automation's own agent). */
  coordinatorTerminal?: string;
  /** 완료 시 정리 asked the coordinator to close itself: the server closes it when it is still open after the run ends. */
  closeCoordinator?: boolean;
  /** Started by another run's sub-coordinator spawn link: its coordinator is that run's worker and reports back with worker_done. */
  parent?: { workflowId: string; executionId: string; node: string; launch?: string };
  /** This run's coordinator started sub-coordinators as its workers: it closes itself once they have settled, not the server. */
  subcoordinators?: boolean;
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
  requested: '실행 요청', brief: '브리프', coordinator: '코디네이터', 'coordinator-failed': '기동 실패', 'coordinator-closed': '코디네이터 종료', registered: '실행 등록',
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
      tasks: [...new Set([...(execution.history ?? []).flatMap((pass) => Object.values(pass.bindings)), ...Object.values(execution.bindings),
        ...Object.values(execution.links ?? {}).flatMap((tasks) => Object.values(tasks))])],
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
  label?: string; question?: string; judge?: BranchJudge | 'auto'; outputLabels?: Record<string, string>;
  /** Outputs that stop everything after this stage, even a join that another live path reaches (a rejected gate). */
  veto?: string[];
  /** 'any': runs when at least one incoming path is alive (paths meeting again after a branch). Default: every path. */
  join?: JoinMode;
  /** Branch outputs that loop back: the stage they go back to, the stages they run again (flow order), the limit and the fallback. */
  loops?: FlowLoop[] };
export type FlowLoop = { edge: string; output: string; to: string; max: number; exit: string; body: string[] };
/** What one decision did: the execution afterwards, and whether it looped back or ran out of rounds. */
export type DecisionEffect = { execution: Execution;
  /** Went back: stages to run again from `to` (new Tasks needed); the body now runs its pass number `pass`. */
  loop?: { edge: string; to: string; restart: string[]; pass: number; max: number; remaining: number };
  /** The loop output was chosen with no rounds left: `output` (the loop's exit) was recorded instead. */
  exhausted?: { output: string; max: number };
  /** Nothing changed: this decision was already recorded (a retried request). */
  repeated?: boolean };
/**
 * Records a (validated) decision. Choosing a loop output with rounds left archives the loop body's Tasks and decisions as a
 * finished pass and clears them, so the body runs again; with none left, the loop's exit output is recorded instead.
 */
export function applyDecision(flow: FlowStage[], execution: Execution, node: string, outputs: string[]): DecisionEffect {
  const stage = flow.find((item) => item.id === node);
  const loop = stage?.loops?.find((item) => outputs.includes(item.output));
  // The same loop choice again before the new round's Tasks are bound is a retried request, not another round.
  const last = execution.history?.[execution.history.length - 1];
  if (loop && last?.edge === loop.edge && !execution.bindings[node] && !execution.decisions?.[node]
    && JSON.stringify(last.decisions?.[node]) === JSON.stringify(outputs)) {
    const count = execution.loops?.[loop.edge] ?? 0;
    return { execution, loop: { edge: loop.edge, to: loop.to, restart: last.nodes, pass: count + 1, max: loop.max, remaining: loop.max - count }, repeated: true };
  }
  const decide = (chosen: string[]) => {
    const decisions = { ...execution.decisions, [node]: chosen };
    return { ...execution, decisions, skipped: skippedStages(flow, decisions) };
  };
  if (!loop) return { execution: decide(outputs), ...(execution.decisions?.[node] ? { repeated: true } : {}) };
  const count = execution.loops?.[loop.edge] ?? 0;
  if (count >= loop.max) return { execution: decide([loop.exit]), exhausted: { output: loop.exit, max: loop.max } };
  const inBody = new Set(loop.body);
  const kept = { ...execution.decisions };
  for (const id of inBody) delete kept[id];
  const skipped = skippedStages(flow, kept);
  // Stages after the loop that the earlier pass skipped (their Tasks were closed as skipped) are reachable again once the
  // body's decisions are cleared: they get new Tasks with the body, or they would stay closed for good.
  const before = new Set(execution.skipped ?? []);
  const reopened = new Set(flow.map((stage) => stage.id).filter((id) => !inBody.has(id) && before.has(id) && !skipped.includes(id) && execution.bindings[id]));
  const body = new Set([...inBody, ...reopened]);
  const restart = flow.map((stage) => stage.id).filter((id) => body.has(id));
  const part = <T,>(record: Record<string, T> | undefined, inside: boolean) => Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => body.has(id) === inside));
  const decisions = part(execution.decisions, false);
  const spawned: Record<string, SpawnResult[]> = part(execution.spawned, true);
  const pass: LoopPass = { edge: loop.edge, pass: count + 1, nodes: restart, bindings: part(execution.bindings, true),
    decisions: { ...part(execution.decisions, true), [node]: outputs }, ...(Object.keys(spawned).length ? { spawned } : {}) };
  const spawnedKept: Record<string, SpawnResult[]> = part(execution.spawned, false);
  const { spawned: _spawned, ...rest } = execution;
  const next: Execution = { ...rest, ...(Object.keys(spawnedKept).length ? { spawned: spawnedKept } : {}), bindings: part(execution.bindings, false), decisions, skipped: skippedStages(flow, decisions),
    loops: { ...execution.loops, [loop.edge]: count + 1 }, history: [...(execution.history ?? []), pass] };
  return { execution: next, loop: { edge: loop.edge, to: loop.to, restart, pass: count + 2, max: loop.max, remaining: loop.max - count - 1 } };
}
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
