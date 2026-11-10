import { asksAtRun, reportsResults, forwardEdges, loopBody, spawnsRuns, spawnsSubcoordinators, maxSpawnItems, resolveVariables, substituteVariables, variableRefs, createsWorktree, gateOutputs, defaultWorkerModel, launchesWorker, isBranch, isExecutable, isGroup, membershipOf, newWorktreeToken, orderNodes, parentWorktree, resolvedParentPath, topologicalOrder, waves, worktreeRepo, type FlowStage, type StageNode, type Workflow, type Cleanup, defaultCleanup } from '../src/model.ts';

export type BriefInput = {
  graph: Workflow;
  /** The coordinator was started inside this group's worktree, prepared by the server (absent: it starts in the project). */
  preparedGroup?: string;
  /** Saved workflows reachable through workflow-link nodes, by id. */
  linked?: Map<string, Workflow>;
  count: number;
  apiBase: string;
  /** The project the user picked for this run: where ungrouped stages run, and the repo for worktrees that name none. */
  workspace: string;
  /** Worktree names typed in the run dialog, by (link-prefixed) group id; empty means ask during the run. */
  inputs?: Record<string, string>;
  /** Clean-up chosen in the run dialog. */
  cleanup?: Cleanup;
  /** Set when an Orca automation started this run; recorded on every execution so the canvas can show it. */
  automation?: { id: string; name: string };
  artifactDir: string;
  /** Where the coordinator appends execution-log events (POST). */
  logUrl?: string;
  /** Execution-log id of this 실행 request: the coordinator names it when registering, since requests may overlap. */
  launchId?: string;
  /** Setting values of this run (defaults applied): they replace {{key}} in instructions, here and in linked workflows. */
  values?: Record<string, string>;
  /** Prepared by another run's sub-coordinator spawn link: this coordinator is also that run's worker (`parentName` names the link). */
  subcoordinator?: { parentName: string };
};

/** How deep workflow links may nest; deeper links are refused before a coordinator starts. */
export const maxLinkDepth = 3;

/** Loads every workflow reachable through link nodes, refusing missing targets, cycles and deep nesting. */
export async function linkedWorkflows(graph: Workflow, load: (id: string) => Promise<Workflow>): Promise<Map<string, Workflow>> {
  const found = new Map<string, Workflow>();
  async function visit(workflow: Workflow, chain: string[]) {
    for (const node of workflow.nodes.filter((item) => item.data.kind === 'workflow')) {
      const id = node.data.workflowId;
      if (!id) throw new Error(`'${node.data.label}' 링크 노드에 연결할 워크플로를 고르세요.`);
      if (chain.includes(id)) throw new Error(`'${node.data.label}' 링크가 자기 자신을 다시 부릅니다(순환).`);
      if (chain.length > maxLinkDepth) throw new Error(`워크플로 링크는 ${maxLinkDepth}단계까지만 중첩할 수 있습니다.`);
      let target = found.get(id);
      if (!target) {
        try { target = await load(id); } catch { throw new Error(`'${node.data.label}' 링크가 가리키는 워크플로를 찾지 못했습니다.`); }
        found.set(id, target);
      }
      await visit(target, [...chain, id]);
    }
  }
  await visit(graph, [graph.id]);
  return found;
}

/** Refuses groups that cannot be prepared at run time, in the graph and every linked workflow. */
export function checkGroups(workflows: Workflow[]) {
  for (const workflow of workflows) {
    for (const group of workflow.nodes.filter(isGroup)) {
      const where = workflows.length > 1 ? `'${workflow.name}'의 ` : '';
      const holdsWork = workflow.nodes.some((node) => isExecutable(node) && membershipOf(workflow, node).worktrees.concat(membershipOf(workflow, node).project ?? []).some((item) => item.id === group.id));
      if (!holdsWork) continue;
      if (!createsWorktree(group) && !group.data.path) throw new Error(`${where}'${group.data.label}' 그룹의 대상을 고르세요.`);
      if (group.data.parentPath?.trim() && parentWorktree(workflow, group)) {
        throw new Error(`${where}'${group.data.label}' 그룹은 다른 워크트리 그룹 안에 있어 그 워크트리의 하위로 만들어집니다. 「부모 워크트리」를 비우세요.`);
      }
      if (createsWorktree(group) && group.data.nameSource === 'agent') {
        const namer = workflow.nodes.find((node) => node.id === group.data.nameFrom && isExecutable(node));
        if (!namer) throw new Error(`${where}'${group.data.label}' 그룹의 워크트리 이름을 정할 단계를 고르세요.`);
        if (membershipOf(workflow, namer).worktrees.some((item) => item.id === group.id)) {
          throw new Error(`${where}'${group.data.label}' 워크트리 이름을 정할 단계는 그 그룹 밖에 있어야 합니다.`);
        }
      }
    }
  }
}

/**
 * Refuses spawn links that could not be carried out: the one worker in front reports the items (a branch output may lead
 * there too — it brings no items), and the target takes each item as its single run-time worktree name.
 */
export function checkSpawns(workflows: Workflow[], linked: Map<string, Workflow>) {
  for (const workflow of workflows) {
    const where = workflows.length > 1 ? `'${workflow.name}'의 ` : '';
    const executable = new Map(workflow.nodes.filter(isExecutable).map((node) => [node.id, node]));
    for (const node of workflow.nodes.filter(spawnsRuns)) {
      const name = `${where}'${node.data.label || '링크'}'`;
      const sources = workflow.edges.filter((edge) => edge.target === node.id && executable.has(edge.source)).map((edge) => executable.get(edge.source)!);
      const reporters = sources.filter((source) => !isBranch(source));
      if (!sources.length || reporters.length > 1 || (reporters.length === 1 && !reportsResults(reporters[0]))) {
        throw new Error(`${name} 링크가 항목마다 따로 실행하려면 항목 목록을 보고할 워커 하나만(또는 출력을 읽는 스크립트 드라이버 하나만) 앞에 연결해야 합니다. 분기 출력에서 오는 연결은 빈 항목으로 더할 수 있습니다.`);
      }
      if (sources.length > 1 && node.data.join !== 'any') throw new Error(`${name} 링크에 들어오는 연결이 여럿이면 합류 방식을 「하나라도 오면 진행」으로 두세요.`);
      const target = node.data.workflowId ? linked.get(node.data.workflowId) : undefined;
      const inputs = target?.nodes.filter(asksAtRun) ?? [];
      if (target && inputs.length !== 1) {
        throw new Error(`${name} 링크의 대상 '${target.name}'에는 항목을 받을 「실행 시 입력」 워크트리 그룹이 정확히 하나 있어야 합니다(지금 ${inputs.length}개).`);
      }
    }
  }
}

/** Refuses expanding (wait/start) a linked workflow that loops: rounds are tracked per top-level stage. Spawn it instead. */
export function checkLoops(workflows: Workflow[], linked: Map<string, Workflow>) {
  for (const workflow of workflows) {
    for (const node of workflow.nodes.filter((item) => item.data.kind === 'workflow' && !spawnsRuns(item))) {
      const target = node.data.workflowId ? linked.get(node.data.workflowId) : undefined;
      if (target?.edges.some((edge) => edge.loop)) {
        throw new Error(`'${node.data.label || '링크'}' 링크가 펼칠 '${target.name}'에 되돌아가기 연결이 있습니다. 반복하는 워크플로는 「항목마다 따로 실행」으로 연결하거나 링크 없이 실행하세요.`);
      }
    }
  }
}

/** Refuses {{key}} in instructions that the workflow does not declare as a setting (each workflow declares what it uses). */
export function checkVariables(workflows: Workflow[]) {
  for (const workflow of workflows) {
    const where = workflows.length > 1 ? `'${workflow.name}'의 ` : '';
    const declared = new Set((workflow.variables ?? []).map((item) => item.key));
    for (const group of workflow.nodes.filter((node) => createsWorktree(node) && node.data.parentPath)) {
      const unknown = variableRefs(group.data.parentPath!).filter((key) => !declared.has(key));
      if (unknown.length) throw new Error(`${where}'${group.data.label}' 그룹의 부모 워크트리 ${unknown.map((key) => `{{${key}}}`).join(', ')} 이(가) 워크플로 설정값에 없습니다.`);
    }
    for (const node of workflow.nodes.filter(isExecutable)) {
      const unknown = variableRefs(node.data.description).filter((key) => !declared.has(key));
      if (unknown.length) throw new Error(`${where}'${node.data.label || '단계'}' 지침의 ${unknown.map((key) => `{{${key}}}`).join(', ')} 이(가) 워크플로 설정값에 없습니다. 설정값을 추가하거나 지침을 고치세요.`);
    }
  }
}

/**
 * Refuses a coordinator location the server could not prepare before the coordinator exists: it must be a worktree group whose
 * name is known up front (fixed or given at run time), one worktree for every execution, and not under a worktree made during the run.
 */
export function checkCoordinatorGroup(workflow: Workflow) {
  if (!workflow.coordinatorGroup) return;
  const group = workflow.nodes.find((node) => node.id === workflow.coordinatorGroup);
  if (!group || !isGroup(group) || (group.data.scope !== 'worktree' && group.data.scope !== 'project')) throw new Error('코디네이터 위치로 고른 프로젝트·워크트리 그룹이 없습니다.');
  const name = `'${group.data.label}'`;
  // A project group: the coordinator starts in its path, like the stages inside it.
  if (group.data.scope === 'project') { if (!group.data.path) throw new Error(`${name} 그룹의 대상을 고르세요.`); return; }
  if (!createsWorktree(group)) { if (!group.data.path) throw new Error(`${name} 그룹의 대상을 고르세요.`); return; }
  if (group.data.nameSource === 'agent') throw new Error(`코디네이터 위치 ${name} 의 이름을 이전 단계가 정하면 코디네이터를 띄우기 전에 만들 수 없습니다. 이름을 직접 지정하거나 실행 시 입력으로 받으세요.`);
  if (group.data.perExecution) throw new Error(`코디네이터 위치 ${name} 는 「실행마다 따로 만들기」를 끄세요. 코디네이터는 하나입니다.`);
  for (let parent = parentWorktree(workflow, group); parent; parent = parentWorktree(workflow, parent)) {
    if (createsWorktree(parent)) throw new Error(`코디네이터 위치 ${name} 가 실행 중에 만들어질 '${parent.data.label}' 안에 있습니다. 바깥 그룹을 기존 워크트리로 고르거나 「부모 워크트리」를 쓰세요.`);
  }
}

type WorktreeSpec = {
  location: string; group: string; mode: 'existing' | 'create'; repo: string; parent?: string;
  /** No parent group: the worktree to create it under, from the group's 「부모 워크트리」 (settings applied). */
  parentPath?: string;
  /** The coordinator's own worktree: the server prepared it and started the coordinator inside it. */
  prepared?: true;
  existing?: { path: string; name?: string; branch?: string };
  name?: { source: 'fixed'; value: string } | { source: 'agent'; fromStage: string } | { source: 'input'; value?: string; prompt?: string };
  baseBranch?: string; perExecution?: boolean;
};

/** Refuses branch nodes the coordinator could not decide, in the graph and every linked workflow. */
export function checkBranches(workflows: Workflow[]) {
  for (const workflow of workflows) {
    const where = workflows.length > 1 ? `'${workflow.name}'의 ` : '';
    const executable = new Map(workflow.nodes.filter(isExecutable).map((node) => [node.id, node]));
    for (const node of workflow.nodes.filter(isBranch)) {
      const name = `${where}'${node.data.label || '분기'}'`;
      const outputs = node.data.outputs ?? [];
      if (outputs.length < 2) throw new Error(`${name} 분기에 출력을 두 개 이상 만드세요.`);
      if (outputs.some((output) => !output.label.trim())) throw new Error(`${name} 분기의 출력마다 조건을 적으세요.`);
      const sources = workflow.edges.filter((edge) => edge.target === node.id && executable.has(edge.source)).map((edge) => executable.get(edge.source)!);
      if (!sources.length) throw new Error(`${name} 분기 앞에 판정 근거가 될 단계를 연결하세요.`);
      if ((node.data.judge ?? 'previous') === 'previous' && (sources.length !== 1 || !reportsResults(sources[0]))) {
        throw new Error(`${name} 분기를 직전 단계 워커가 판정하려면 앞에 워커 하나만(또는 JSON 줄로 판정을 내는 스크립트 드라이버 하나만) 연결해야 합니다.`);
      }
    }
    // A gate asked in the worker before it needs exactly that one worker in front.
    for (const node of workflow.nodes.filter((item) => item.data.kind === 'gate' && item.data.asker === 'previous')) {
      const sources = workflow.edges.filter((edge) => edge.target === node.id && executable.has(edge.source)).map((edge) => executable.get(edge.source)!);
      if (sources.length !== 1 || sources[0].data.kind !== 'worker') {
        throw new Error(`${where}'${node.data.label || '게이트'}' 게이트를 직전 워커 터미널에서 물으려면 앞에 워커 하나만 연결해야 합니다.`);
      }
    }
  }
}

/** Refuses script drivers the coordinator could not run: no command, or a regex without a pattern. */
export function checkScripts(workflows: Workflow[]) {
  for (const workflow of workflows) {
    const where = workflows.length > 1 ? `'${workflow.name}'의 ` : '';
    for (const node of workflow.nodes.filter((item) => item.data.kind === 'script')) {
      const name = `${where}'${node.data.label || '스크립트 드라이버'}'`;
      if (!node.data.command?.trim()) throw new Error(`${name} 스크립트 드라이버에 실행할 명령을 적으세요.`);
      if (node.data.parse === 'regex' && !node.data.itemPattern) throw new Error(`${name} 스크립트 드라이버의 항목 정규식을 적으세요.`);
    }
  }
}

export type PreflightReport = {
  /** True when every check that 실행 runs passed: the workflow would be accepted (run-time settings aside). */
  ok: boolean;
  /** Each 실행 check in the order 실행 runs them. A failed check names only its first problem, as 실행 does. */
  checks: { name: string; ok: boolean; message?: string }[];
  /** Not refused by 실행, but likely a mistake: a branch output that leads nowhere, a stage connected to nothing. */
  warnings: string[];
  /** Linked workflows that were loaded, by id. */
  linked: string[];
};

/**
 * Runs the checks 실행 runs before a coordinator starts, without starting one, and keeps going after a failure so
 * one report covers every check. Run-time settings (project, inputs, required values) are not part of it.
 */
export async function preflight(graph: Workflow, load: (id: string) => Promise<Workflow>): Promise<PreflightReport> {
  const checks: PreflightReport['checks'] = [];
  const attempt = (name: string, check: () => void) => {
    try { check(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, message: (error as Error).message }); }
  };
  let linked = new Map<string, Workflow>();
  try { linked = await linkedWorkflows(graph, load); checks.push({ name: 'links', ok: true }); }
  catch (error) { checks.push({ name: 'links', ok: false, message: (error as Error).message }); }
  const all = [graph, ...linked.values()];
  attempt('stages', () => { if (!graph.nodes.some(isExecutable)) throw new Error('실행할 단계가 없습니다.'); });
  attempt('groups', () => checkGroups(all));
  attempt('branches', () => checkBranches(all));
  attempt('spawns', () => checkSpawns(all, linked));
  attempt('scripts', () => checkScripts(all));
  attempt('variables', () => checkVariables(all));
  attempt('loops', () => checkLoops(all, linked));
  attempt('coordinator', () => checkCoordinatorGroup(graph));
  attempt('flow', () => { flowOf(graph, linked); });
  const warnings: string[] = [];
  for (const workflow of all) {
    const where = all.length > 1 ? `'${workflow.name}'의 ` : '';
    const stages = workflow.nodes.filter(isExecutable);
    for (const branch of workflow.nodes.filter(isBranch)) {
      for (const output of branch.data.outputs ?? []) {
        if (!workflow.edges.some((edge) => edge.source === branch.id && edge.sourceHandle === output.id)) {
          warnings.push(`${where}'${branch.data.label || '분기'}' 분기의 출력 '${output.label || output.id}'(${output.id}) 에 이어진 단계가 없습니다.`);
        }
      }
    }
    if (stages.length > 1) {
      for (const stage of stages) {
        if (!workflow.edges.some((edge) => edge.source === stage.id || edge.target === stage.id)) warnings.push(`${where}'${stage.data.label || '단계'}' 이(가) 어느 단계와도 연결되지 않아 실행 시작과 함께 따로 돕니다.`);
      }
    }
  }
  return { ok: checks.every((check) => check.ok), checks, warnings, linked: [...linked.keys()] };
}

type BriefStage = {
  nodeId: string; label: string; kind: string; instructions: string; location: string;
  /** Longest-path depth: stages with the same wave may run side by side. Stages are listed in topological order. */
  wave: number;
  /** `output`: the edge leaves this output of a branch, so it is taken only when the branch chooses it. */
  after: { nodeId: string; output?: string; condition?: string }[];
  branch?: { mode: string; judge: string; outputs: { id: string; label: string }[];
    /** Outputs that go back: the stage they return to, how often at most, the output taken after that, and the stages run again. */
    loops?: { edge: string; output: string; to: string; max: number; exit: string; body: string[] }[] };
  /** 'any': paths that split at a branch meet here; the stage runs if at least one arrives. Absent: every path is needed. */
  join?: 'any';
  /** This worker also decides these branches (judge 'previous'): it reports `decision: <output id>`. */
  decides?: { nodeId: string; mode: string; outputs: { id: string; label: string }[];
    /** A gate asked in this worker's terminal: what to ask the user (the gate's instructions). */
    ask?: string }[];
  /** This stage's agent decides (or creates) the worktree used at this location. */
  namesWorktree?: string[];
  /** Stages that start a worker: the model (always set; the default when the node names none) and effort (omitted = model default). */
  model?: string;
  effort?: string;
  /** `wait: false`: stages after this link do not wait for its sub-graph; they follow the link's own predecessors. */
  workflow?: { id: string; name: string; wait: boolean; stages: BriefStage[] };
  /**
   * A link that is not expanded: it requests one separate 실행 of the target per item its predecessor reports.
   * `as: subcoordinator`: each item's coordinator is started by this coordinator as its worker (`title`: its terminal name).
   */
  spawn?: { workflowId: string; name: string; input: string; as?: 'subcoordinator'; title?: string };
  /** This worker reports the items for these spawn links (`items:` line of worker_done). */
  reportsItems?: string[];
  /** kind 'script': what the coordinator runs and how it reads the output (see ScriptParse in model.ts). */
  script?: { command: string; parse: string; itemPattern?: string; detach: boolean; timeoutSec: number };
};

type BriefContext = { linked: Map<string, Workflow>; project: string; inputs: Record<string, string>; worktrees: WorktreeSpec[]; preparedGroup?: string;
  /** Setting values for this level: the run's, with a linked workflow's own defaults filling keys the run does not set. */
  values: Record<string, string> };

/** Location key of a group in the brief: a token for groups created at run time, else the picked path. */
function groupLocation(group: StageNode, prefix: string) {
  return createsWorktree(group) ? newWorktreeToken(`${prefix}${group.id}`) : group.data.path || '';
}

function stagesOf(graph: Workflow, ctx: BriefContext, fallback: string, prefix = ''): BriefStage[] {
  const executable = new Set(graph.nodes.filter(isExecutable).map((node) => node.id));
  const namers = new Map<string, string[]>();
  // Worktree groups, outermost first, so a parent worktree is always prepared before its children.
  for (const group of orderNodes(graph.nodes.filter((node) => isGroup(node) && node.data.scope === 'worktree'))) {
    const parent = parentWorktree(graph, group);
    const base = { location: groupLocation(group, prefix), group: group.data.label, repo: worktreeRepo(graph, group) || ctx.project,
      ...(parent ? { parent: groupLocation(parent, prefix) } : {}) };
    if (!createsWorktree(group)) {
      ctx.worktrees.push({ ...base, mode: 'existing', ...(!prefix && ctx.preparedGroup === group.id ? { prepared: true as const } : {}), existing: { path: group.data.path ?? '',
        ...(group.data.worktreeName ? { name: group.data.worktreeName } : {}), ...(group.data.branch ? { branch: group.data.branch } : {}) } });
      continue;
    }
    const source = group.data.nameSource ?? 'fixed';
    const name: WorktreeSpec['name'] = source === 'agent' ? { source, fromStage: `${prefix}${group.data.nameFrom}` }
      : source === 'input' ? { source, ...(ctx.inputs[`${prefix}${group.id}`] ? { value: ctx.inputs[`${prefix}${group.id}`] } : {}), ...(group.data.inputPrompt ? { prompt: group.data.inputPrompt } : {}) }
      : { source, value: group.data.worktreeName || `wf-${group.id.slice(0, 8)}` };
    if (source === 'agent' && group.data.nameFrom) namers.set(group.data.nameFrom, [...(namers.get(group.data.nameFrom) ?? []), base.location]);
    const parentPath = parent ? '' : resolvedParentPath(group, ctx.values);
    ctx.worktrees.push({ ...base, mode: 'create', name, ...(group.data.baseBranch ? { baseBranch: group.data.baseBranch } : {}), perExecution: !!group.data.perExecution,
      ...(parentPath ? { parentPath } : {}), ...(!prefix && ctx.preparedGroup === group.id ? { prepared: true as const } : {}) });
  }
  const stageEdges = forwardEdges(graph.edges).filter((edge) => executable.has(edge.source) && executable.has(edge.target));
  const { order } = topologicalOrder([...executable], stageEdges);
  const wave = waves(order, stageEdges);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // A declared setting left empty becomes an empty string in instructions, not a raw {{key}} the worker might read as a value.
  const textValues = { ...Object.fromEntries((graph.variables ?? []).map((item) => [item.key, ''])), ...ctx.values };
  return order.map((id) => byId.get(id)!).map((node: StageNode) => {
    // Innermost worktree group wins, then a project group, then the fallback (the run project, or the link's own location).
    const { project, worktrees } = membershipOf(graph, node);
    const inner = worktrees[worktrees.length - 1];
    const location = inner ? groupLocation(inner, prefix) : project?.data.path || fallback;
    const target = node.data.kind === 'workflow' && node.data.workflowId ? ctx.linked.get(node.data.workflowId) : undefined;
    const sub = spawnsRuns(node) ? undefined : target;
    const spawnTarget = spawnsRuns(node) ? target : undefined;
    const feeds = stageEdges.filter((edge) => edge.source === node.id).map((edge) => byId.get(edge.target)!).filter(spawnsRuns);
    return {
      nodeId: `${prefix}${node.id}`, label: node.data.label, kind: node.data.kind, instructions: substituteVariables(node.data.description, textValues), location,
      wave: wave.get(node.id) ?? 0,
      after: stageEdges.filter((edge) => edge.target === node.id).map((edge) => {
        const source = byId.get(edge.source)!;
        // Leaving a gate means it was approved; leaving a branch means that output was chosen.
        const output = source.data.kind === 'gate' ? gateOutputs[0]
          : isBranch(source) ? source.data.outputs?.find((item) => item.id === edge.sourceHandle) : undefined;
        return { nodeId: `${prefix}${edge.source}`, ...(output ? { output: output.id } : {}),
          ...(edge.label || output ? { condition: String(edge.label || output!.label) } : {}) };
      }),
      ...(isBranch(node) ? { branch: { mode: node.data.mode ?? 'exclusive', judge: node.data.judge ?? 'previous',
        outputs: (node.data.outputs ?? []).map((output) => ({ id: output.id, label: output.label })),
        ...(() => {
          const loops = graph.edges.filter((edge) => edge.loop && edge.source === node.id && edge.sourceHandle).map((edge) => {
            const body = new Set(loopBody(graph.edges, edge));
            return { edge: edge.id, output: edge.sourceHandle!, to: `${prefix}${edge.target}`, max: edge.loop!.max, exit: edge.loop!.exit,
              body: order.filter((id) => body.has(id)).map((id) => `${prefix}${id}`) };
          });
          return loops.length ? { loops } : {};
        })() } } : {}),
      ...(node.data.kind === 'gate' ? { branch: { mode: 'exclusive', judge: node.data.asker === 'previous' ? 'previous' : node.data.asker === 'auto' ? 'auto' : 'user', outputs: gateOutputs } } : {}),
      ...(node.data.join === 'any' ? { join: 'any' as const } : {}),
      ...(() => {
        const decides = stageEdges.filter((edge) => edge.source === node.id).map((edge) => byId.get(edge.target)!)
          .filter((target) => (isBranch(target) && (target.data.judge ?? 'previous') === 'previous') || (target.data.kind === 'gate' && target.data.asker === 'previous'))
          .map((target) => target.data.kind === 'gate'
            ? { nodeId: `${prefix}${target.id}`, mode: 'exclusive', outputs: gateOutputs, ask: target.data.description || target.data.label || '진행해도 될까요?' }
            : { nodeId: `${prefix}${target.id}`, mode: target.data.mode ?? 'exclusive', outputs: (target.data.outputs ?? []).map((output) => ({ id: output.id, label: output.label })) });
        return decides.length ? { decides } : {};
      })(),
      ...(namers.has(node.id) ? { namesWorktree: namers.get(node.id) } : {}),
      ...(launchesWorker(node) ? { model: node.data.workerModel || defaultWorkerModel, ...(node.data.effort ? { effort: node.data.effort } : {}) } : {}),
      ...(sub ? { workflow: { id: sub.id, name: sub.name, wait: node.data.linkMode !== 'start', stages: stagesOf(sub, { ...ctx, values: { ...resolveVariables(sub.variables).values, ...ctx.values } }, location, `${prefix}${node.id}.`) } } : {}),
      ...(spawnTarget ? { spawn: { workflowId: spawnTarget.id, name: spawnTarget.name, input: spawnTarget.nodes.find(asksAtRun)?.id ?? '',
        ...(spawnsSubcoordinators(node) ? { as: 'subcoordinator' as const, title: spawnTarget.name.slice(0, 24) } : {}) } } : {}),
      ...(feeds.length ? { reportsItems: feeds.map((item) => `${prefix}${item.id}`) } : {}),
      ...(node.data.kind === 'script' ? { script: { command: substituteVariables(node.data.command ?? '', textValues), parse: node.data.parse ?? 'none',
        ...(node.data.parse === 'regex' && node.data.itemPattern ? { itemPattern: node.data.itemPattern } : {}),
        detach: !!node.data.detach, timeoutSec: node.data.timeoutSec ?? (node.data.detach ? 86400 : 600) } } : {}),
    };
  });
}

/** Expands workflow links into one graph of brief stage ids: a link's first stages follow the link's predecessors, its successors follow its last stages. */
function flatten(stages: BriefStage[]): FlowStage[] {
  // What a stage after a link really follows: the link's last stages, or (a link that only starts) the link's own predecessors.
  const sinks = new Map<string, FlowStage['after']>();
  const expanded = new Map<string, FlowStage[]>();
  const resolve = (after: BriefStage['after']): FlowStage['after'] => after.flatMap((item) => sinks.get(item.nodeId)
    ?? [{ id: item.nodeId, ...(item.output ? { output: item.output } : {}) }]);
  // Stages come in topological order, so a link's predecessors are resolved before the link itself.
  for (const stage of stages) {
    if (!stage.workflow) continue;
    const sub = flatten(stage.workflow.stages);
    const referenced = new Set(sub.flatMap((item) => item.after.map((after) => after.id)));
    sinks.set(stage.nodeId, stage.workflow.wait ? sub.filter((item) => !referenced.has(item.id)).map((item) => ({ id: item.id })) : resolve(stage.after));
    expanded.set(stage.nodeId, sub);
  }
  return stages.flatMap((stage): FlowStage[] => stage.workflow
    ? expanded.get(stage.nodeId)!.map((item) => item.after.length ? item : { ...item, after: resolve(stage.after) })
    : [{ id: stage.nodeId, after: resolve(stage.after), label: stage.label, question: stage.instructions,
      ...(stage.branch ? { branch: { mode: stage.branch.mode as 'exclusive' | 'inclusive', outputs: stage.branch.outputs.map((output) => output.id) },
        judge: stage.branch.judge as 'previous' | 'worker' | 'user' | 'auto', outputLabels: Object.fromEntries(stage.branch.outputs.map((output) => [output.id, output.label])) } : {}),
      ...(stage.kind === 'gate' ? { veto: ['reject'] } : {}), ...(stage.join ? { join: stage.join } : {}),
      ...(stage.branch?.loops ? { loops: stage.branch.loops } : {}) }]);
}
/** The executable graph of a run, links expanded, with brief stage ids (the keys of decisions and skipped). */
export function flowOf(graph: Workflow, linked: Map<string, Workflow>): FlowStage[] {
  return flatten(stagesOf(graph, { linked, project: '', inputs: {}, worktrees: [], values: resolveVariables(graph.variables).values }, ''));
}

/**
 * Builds the coordinator brief for one "실행" request.
 * The canvas never runs workers itself: a supervised Orca coordinator agent owns the Run,
 * judges the natural-language conditions in node instructions, and reports bindings back
 * through the canvas API so the graph can observe the executions.
 */
export function buildBrief({ graph, preparedGroup, linked = new Map(), count, apiBase, workspace, artifactDir, logUrl, launchId, inputs = {}, cleanup = defaultCleanup, automation, values, subcoordinator }: BriefInput): string {
  const automationJson = automation ? `,"automation":${JSON.stringify(automation)}` : '';
  const settings = values ?? resolveVariables(graph.variables).values;
  const ctx: BriefContext = { linked, project: workspace, inputs, worktrees: [], values: settings, ...(preparedGroup ? { preparedGroup } : {}) };
  const stages = stagesOf(graph, ctx, workspace);
  const worktrees = ctx.worktrees;
  const spawnsSub = (list: BriefStage[]): boolean => list.some((stage) => stage.spawn?.as === 'subcoordinator' || (stage.workflow ? spawnsSub(stage.workflow.stages) : false));
  const subSpawnSection = spawnsSub(stages) ? `
   - **하위 코디네이터로 띄우기(\`spawn.as\` 가 \`subcoordinator\` 인 링크)**: 요청은 위와 같지만 캔버스는 에이전트를 띄우지 않는다. 항목마다 실행 등록·브리프·워크트리만 준비해 \`status: "prepared"\` 와 \`launch\`(하위 실행 로그 id)·\`brief\`(브리프 절대경로)·\`worktree\`(하위 코디네이터 위치 절대경로)를 돌려준다. 하위 코디네이터는 **너의 워커**로 띄운다. 위 "기다리지 않는다" 대신 아래를 따른다.
     - 선행이 끝나면 링크 Task 를 \`task-update --status dispatched\` 로 둔다. 항목이 있으면 위 요청을 보내고, 분기 출력으로 왔으면(빈 항목) 요청을 보내지 않는다.
     - 응답의 \`prepared\` 항목마다(\`failed\` 는 띄우지 않고, \`already\` 는 이미 띄운 하위로 친다):
       1. spec 을 Write 도구로 파일에 쓴다: "<brief> 를 읽고 그대로 수행한다. 너는 「<spawn.name>」 실행의 코디네이터이고, 동시에 상위 코디네이터가 띄운 워커다(브리프의 하위 코디네이터 절을 따른다)."
       2. \`orca orchestration task-create --run <run_id> --parent <링크 Task> --task-title "<spawn.title> <항목>" --display-name "<spawn.title> <항목>" --spec "$(cat <파일>)"\` 로 링크 Task 의 자식 Task 를 만든다.
       3. \`orca orchestration worker-start --run <run_id> --task <자식 Task> --worktree path:<worktree> --agent claude --model claude-opus-5-5\` 로 띄운다(하위 코디네이터는 캔버스 코디네이터와 같은 모델이다. \`--effort\` 는 넣지 않는다).
       4. 받은 터미널을 \`orca terminal rename --terminal <터미널> --title "<spawn.title> <항목>"\` 로 바꾼다.
       결과를 산출물 \`<n>-<링크 nodeId>.txt\`(2회차 이상이면 \`<n>-<링크 nodeId>-r<회차>.txt\`)에 항목마다 한 줄 \`<항목> · launch <launch> · task <자식 Task> · dispatch <dispatch id> · terminal <터미널> · <status>[ · <error>]\` 로 쓰고, 이 실행의 하위 목록 \`<n>-<링크 nodeId>-children.txt\`(회차를 넘어 하나로 유지한다)에 같은 줄을 \`open\` 표시와 함께 덧붙인다. 워커를 띄우지 못한 항목은 자식 Task 를 \`failed\` 로 닫고 두 파일에 \`failed\` 로 적는다.
     - **링크 Task 를 닫는 시점 — 하나라도 끝나면.** 하위 목록에 아직 \`open\` 인 하위 코디네이터(앞 회차에 띄운 것 포함)가 있으면, 그중 **하나**의 worker_done 이 올 때까지 링크 Task 를 열어 두고 \`check --wait\` 반복을 계속한다(다른 실행·단계의 진행은 그대로 한다). 하나가 오면 링크 Task 를 \`task-update --status completed --result "요청 <n>건 · 실패 <k>건 · 끝남 <항목>"\` 으로 닫고, 같은 줄을 링크 산출물 끝에 쓴 뒤 다음 단계를 띄운다. 이 링크 Task 를 \`dispatched\` 로 두기 전에 이미 끝났지만 아직 어느 링크 결과에도 \`끝남\` 으로 적지 않은 하위가 있으면 기다리지 않고 그것으로 닫는다. 열린 하위가 하나도 없으면(모두 실패했거나 끝남) 바로 \`끝남 없음\` 으로 닫는다. 빈 항목으로 왔어도 같은 규칙이다.
     - **하위의 worker_done**(언제 오든, 앞 회차 것 포함): 자식 Task 가 아직 열려 있으면 보고의 outcome 대로 닫고(\`completed\`·\`failed\`), 하위 목록의 그 줄을 \`done\`·\`failed\` 와 끝난 시각·본문 첫 줄로 고친다. 실행 로그 \`worker\` 에 "<spawn.title> <항목>: <본문 첫 줄>" 을 남기고 그 워커를 \`worker-release\` 한다. 자식 Task 가 실패로 끝나도 이 실행을 멈추지 않고 그 Task 에 의존하는 단계도 없다 — 판단은 뒤 단계가 산출물(하위 그래프가 남긴 \`_index\` 줄 등)로 한다.
     - 하위 코디네이터 터미널이 worker_done 없이 닫히면(죽은 워커 규칙) 자식 Task 를 \`failed\` 로 닫고 \`failed\` 로 끝난 것으로 친다. 링크 Task 와 뒤 단계를 실패로 만들지 않는다.
     - 하위가 \`ask\`·escalation 을 보내면 실행 로그 \`note\`(escalation 은 \`error\`)에 남긴다. 그래프 지침으로 답할 수 있으면 \`reply\` 로 답하고, 사용자 판단이 필요하면 "그 실행의 캔버스 결정 카드로 넘겨라" 로 답한다. 단계 지침이 하위에 지시를 전하라고 하면(예: 계약 정정) \`orca orchestration send --to dispatch:<dispatch id> --subject "<요지>" --body "<지시>"\` 로 보낸다.
     - 이 실행이 끝날 때(절차 6) 열린 하위가 남아 있으면 기다리지 않고 마무리 보고에 열린 하위 목록을 적는다. 그래도 코디네이터 터미널은 닫지 않는다(하위의 worker_done 을 받을 곳이 사라진다) — \`check --wait\` 반복으로 남은 worker_done 을 위처럼 처리하고, 모두 끝나면 완료 시 정리 규칙대로 마친다.` : '';
  const subSection = subcoordinator ? `
## 하위 코디네이터로 기동됨
이 실행은 「${subcoordinator.parentName.replace(/`/g, "'")}」 링크가 준비했고, 그 실행의 코디네이터(상위 코디네이터)가 너를 **워커로** 띄웠다. 너는 상위 Run 의 워커이면서 이 실행의 코디네이터다. 이 절은 아래 절차보다 우선한다.
- 이 실행용 Run 은 아래 절차 1 대로 \`run-create\` 로 따로 만든다. 그 뒤 모든 \`task-*\`·\`gate-*\`·\`worker-*\`·\`check\` 명령에 \`--run <run_id>\`(자기 Run)를 붙인다. \`run-use\` 는 쓰지 않는다(다른 바인딩이 풀린다).
- 메일은 두 갈래다. 자기 Run 의 워커 보고는 \`check --run <run_id>\`, 상위 코디네이터가 보낸 메일은 plain \`check\`(\`--run\` 없이)로 받는다.
- 기다림은 \`check --wait --run <run_id> --timeout-ms 30000\` 반복이다(절차 5 의 \`check --wait\` 는 모두 이것이다). **턴을 끝내서 기다리지 않는다** — 워커가 보고 없이 턴을 끝내면 상위에 escalation 이 쌓이고 세 번이면 이 Task 가 실패 처리된다. 반복마다 plain \`check\`(대기 없이)로 상위 메일을 확인하고, 상위가 보낸 지시(예: 계약 정정)는 해당 단계 워커에게 전달하고 실행 로그 \`note\` 에 남긴다.
- 사용자에게 직접 묻지 않는다(질문 도구도 쓰지 않는다). 사용자 결정은 아래 게이트 규칙 그대로 캔버스 결정 카드로 받는다.
- 실행이 끝나면(완료·막힘·중단 어느 쪽이든. 사용자 결정이 열려 있으면 아직 끝나지 않은 것이다) 마무리 보고와 실행 로그 \`report\` 뒤 상위에 **worker_done** 을 한 번 보낸다. 명령은 너를 띄운 워커 프리앰블의 것(\`--task-id\`·\`--dispatch-id\`)을 그대로 쓴다. 본문 3줄: 결과 한 줄(완료/막힘/중단 + 배치 단위, 즉 실행 시 입력 값), 근거 경로(그래프가 남긴 \`_index\` 등 보고 파일), 판단할 것. 완료가 아니면 프리앰블이 정한 대로 실패 outcome(\`--outcome failed\`)으로 보낸다.
- 자기 터미널을 닫지 않는다(상위가 release 한다). 정리 규칙의 워크트리 삭제가 네가 시작한 워크트리를 지우게 되면 그것은 하지 않고 보고에 남긴다.
` : '';
  const worktreeSection = worktrees.length ? `
## 워크트리
단계의 \`location\` 이 아래 표의 \`location\` 과 같으면 그 워크트리에서 작업한다. 표 순서대로(바깥 워크트리 먼저) 준비한다. \`new-worktree:\` 로 시작하는 location 은 실행 중에 만들어질 워크트리다.

\`\`\`json
${JSON.stringify(worktrees, null, 2)}
\`\`\`

0. **이미 준비된 워크트리**: \`prepared: true\` 인 워크트리는 캔버스 서버가 실행 전에 준비했고, 너(코디네이터)는 그 안에서 시작했다. 다시 찾거나 만들지 말고 너의 현재 작업 디렉터리(\`pwd\`, \`orca worktree current\`)를 그 경로로 쓴다. 아래 1~3 은 나머지 워크트리에만 적용한다.
1. **이름 정하기**
   - \`mode: existing\`: \`existing.path\` 가 실제로 있으면 그대로 쓴다. 없으면(지워졌으면) \`existing.name\` 으로 아래 3의 방법으로 다시 만든다(\`existing.branch\` 가 있으면 \`--branch\` 로 넘긴다).
   - \`name.source: fixed\`: \`name.value\` 를 쓴다.
   - \`name.source: agent\`: \`name.fromStage\` 단계의 워커가 worker_done 첫 줄에 \`worktree: <이름 또는 절대 경로>\` 로 보고한다. 실제 워크트리의 절대 경로면 그대로 쓰고(에이전트가 직접 만든 경우), 이름이면 그 이름으로 만든다. 그 단계가 끝나기 전에는 이 워크트리를 쓰는 단계를 띄우지 않는다.
   - \`name.source: input\`: \`name.value\` 가 있으면 쓴다. 없으면 이 터미널에서 사용자에게 \`name.prompt\`(없으면 "<group> 워크트리 이름") 로 묻고 답을 쓴다.
   - \`perExecution: true\` 면 이름 뒤에 \`-<실행 번호>\` 를 붙인다. 아니면 모든 실행이 같은 이름을 쓴다.
   - 이름에는 영문·숫자·\`.\`·\`_\`·\`-\` 만 쓴다. 다른 문자는 \`-\` 로 바꾸고, \`-\` 로 시작하지 않게 한다.
2. **재사용**: 만들기 전에 \`orca worktree list --repo path:<repo> --json\` 에서 displayName 이나 branch 가 같은 워크트리를 찾는다. 있으면 새로 만들지 않고 그 경로를 쓴다(이전 실행이나 병렬 실행이 만든 것). 같은 이름은 이 Run 에서 한 번만 만든다. 병렬 실행이 같은 이름을 요구하면 먼저 만든 것을 기다렸다가 재사용한다.
3. **만들기**: \`orca worktree create --repo path:<repo> --name <이름> [--base-branch <baseBranch>] [--parent-worktree path:<부모 경로> | --no-parent] --setup inherit --json\`
   - \`parent\` 가 있으면 그 location 이 이 실행에서 가리키는 경로를 \`--parent-worktree path:<경로>\` 로 넘겨 **하위 워크트리**로 만든다. 부모를 먼저 준비한다.
   - \`parentPath\` 가 있으면 그 경로를 \`--parent-worktree path:<parentPath>\` 로 넘겨 그 워크트리의 **하위 워크트리**로 만든다. 그 경로가 없으면 만들지 말고 멈춰 보고한다.
   - 둘 다 없으면 \`--no-parent\`.
4. 확정된 경로를 그 실행에서 해당 location 대신 쓴다. 진행하지 않을 단계만 있는 워크트리는 만들지 않는다. 만든 워크트리는 지우지 않고, 마무리 보고에 실행별 워크트리 경로와 재사용 여부를 남긴다.
` : '';
  return `# 워크플로 실행 코디네이터 브리프

너는 ${automation ? `Orca 자동화 「${automation.name}」` : 'workflow-canvas 의 "실행" 버튼'}으로 기동된 **Orca 오케스트레이션 코디네이터**다.${automation ? `
이 실행은 자동화로 시작되었다. 실행 목록을 등록할 때 모든 실행에 \`"automation":${JSON.stringify(automation).replace(/`/g, '')}\` 를 그대로 넣는다(캔버스가 적용된 자동화를 표시한다). 사용자가 자리에 없을 수 있으니, 사용자 입력이 필요한 곳(게이트·실행 중 입력)에서는 묻고 기다리되 다른 실행은 계속 진행한다.` : ''}
사용자가 감독(supervision)을 요청했다. 아래 그래프를 **${count}회 병렬 실행**하고 끝까지 감독한다.

## 먼저 할 일
1. \`orca-orchestration-rules\` 와 \`orchestration\` 스킬을 로드하고 \`orca skills get orchestration\` 으로 버전에 맞는 가이드를 읽는다. 명령과 플래그는 그 가이드만 따른다.
2. 사용자에게 보이는 모든 텍스트는 한국어로 쓴다.
${subSection}
## 그래프
- 워크플로: ${graph.name} (id \`${graph.id}\`)
- 실행 프로젝트: \`${workspace}\` (사용자가 실행할 때 고른 프로젝트. 그룹 밖 단계는 여기서 작업한다)
${graph.variables?.length ? `- 실행 설정값: 이 실행에 주어진 값이다. 단계 지침의 \`{{키}}\` 는 이미 이 값으로 바뀌어 있다. 워커 spec 에는 지침을 그대로 쓰면 되고, 값을 바꾸거나 추측해 채우지 않는다. 값이 "(없음)" 인 설정은 주어지지 않은 것이다.
${graph.variables.map((item) => `  - \`${item.key}\` ${item.label}: ${settings[item.key] ? `\`${settings[item.key].replace(/`/g, "'")}\`` : '(없음)'}`).join('\n')}
` : ''}- 단계 목록(JSON). 위상 순서로 나열되어 있다. \`after\` 는 선행 단계, \`wave\` 는 단계 깊이(같은 wave 는 동시에 돌 수 있다), \`location\` 은 그 단계의 워커가 작업할 경로다(그룹 노드가 정한 Orca 프로젝트·워크트리). \`model\`·\`effort\` 는 그 단계 워커를 띄울 때 쓸 모델과 추론 수준이다(\`effort\` 가 없으면 모델 기본값). \`condition\` 은 연결 설명으로 **참고 정보일 뿐 진행 여부를 바꾸지 않는다.**
- 단계 종류(\`kind\`):
  - \`worker\`: 워커 하나가 지침을 수행한다.
  - 들어오는 연결이 여럿인 단계: 기본은 **모두 필요**다. 앞 경로 중 하나라도 건너뛰어지면(고르지 않은 분기 출력, 건너뛴 단계) 이 단계도 건너뛴다. \`join: any\` 인 단계는 분기에서 갈라진 경로가 다시 모이는 곳이라 하나라도 오면 진행한다. 어느 쪽이든 건너뜀 계산은 캔버스가 하고, 너는 건너뛰지 않은 선행이 모두 끝났을 때 띄운다.
  - \`script\`: 스크립트 드라이버. **워커를 띄우지 않는다.** 아래 "스크립트 단계" 대로 네가 \`script.command\` 를 그 단계의 \`location\` 에서 그대로 실행하고, 종료 코드와 출력으로 단계를 닫는다. 명령을 고치거나 해석해 바꾸지 않는다.
  - \`gate\`: 사용자 개입 게이트. 워커를 띄우지 않는다. 출력이 \`approve\`(통과)·\`reject\`(거절) 두 개인 사용자 결정이다. 게이트에서 나가는 연결은 모두 \`approve\` 출력이다. \`branch.judge\` 가 \`user\` 면 코디네이터(캔버스 결정 대기 카드)가 묻고, \`previous\` 면 직전 워커가 자기 터미널에서 사용자에게 묻는다(그 워커의 \`decides\` 에 \`ask\` 로 들어 있다). \`auto\` 면 묻지 않는다 — 자동 승인 게이트다.
  - \`branch\`: 분기. 어느 출력으로 갈지 판정만 한다. \`branch.mode\` 가 \`exclusive\` 면 출력 하나, \`inclusive\` 면 조건에 맞는 출력 모두(하나 이상)를 고른다. \`branch.judge\` 가 판정 주체다: \`previous\` 직전 워커, \`worker\` 판정 전용 워커, \`user\` 사용자. \`after\` 항목에 \`output\` 이 있으면 그 분기가 그 출력을 골랐을 때만 이어지는 연결이다.
  - \`workflow\` 이고 \`spawn\` 이 있는 단계: **펼치지 않는다.** 대상 워크플로를 항목마다 **따로 실행 요청**하는 단계다. 워커를 띄우지 않는다. 아래 "항목마다 따로 실행" 을 따른다.
  - \`workflow\`: 다른 워크플로로의 링크. \`workflow.stages\` 를 그 자리에 펼쳐 실행한다. 펼친 첫 단계들은 링크의 선행 단계를 deps 로 갖는다. \`workflow.wait\` 가 \`true\` 면 링크의 후행 단계는 펼친 마지막 단계들을 deps 로 갖고(끝날 때까지 대기), \`false\` 면 펼친 단계를 기다리지 않고 링크의 선행 단계를 deps 로 갖는다(시작만 하고 진행. 펼친 단계는 따로 끝까지 돌고, 실행은 그것까지 끝나야 끝난다). 펼친 단계의 \`nodeId\` 는 \`<링크 nodeId>.<하위 nodeId>\` 꼴이다.

\`\`\`json
${JSON.stringify(stages, null, 2)}
\`\`\`

${worktreeSection}
## 절차
1. \`orchestration run-create\` 로 새 Run 을 만든다. objective: "${graph.name.replace(/"/g, "'")} ×${count}".
2. 실행 #1~#${count} 각각에 대해 단계마다 Task 를 \`task-create\` 로 만든다.
   - title·display-name: "<단계 이름> #<n>"
   - deps: 같은 실행 안의 선행 단계 Task
   - spec: 아래 "워커 spec 규칙"을 따른다.
   - spec 본문은 Write 도구로 파일에 먼저 쓰고 Task 하나마다 \`--spec "$(cat <파일>)"\` 로 넘긴다. 여러 Task 를 한 Bash 에 묶거나, 따옴표 없는 heredoc(\`<<EOF\`)·겹친 \`$( )\` 를 쓰지 않는다 — Claude Code 는 구문을 파싱하지 못한 Bash 를 bypass 모드에서도 권한 요청으로 멈추고, 답이 없으면 약 2분 뒤 자동 차단한다.
3. Task 를 모두 만들면 **워커를 띄우기 전에** 캔버스에 실행 목록을 등록한다(한 번만):
   \`\`\`sh
   curl -s -X PUT -H 'Content-Type: application/json' ${apiBase}/api/workflows/${graph.id}/executions \\
     --data '{"runId":"<run_id>",${launchId ? `"launch":"${launchId}",` : ''}"executions":[{"id":"<run_id>-1","label":"#1","bindings":{"<nodeId>":"<task_id>", ...},"links":{"<링크 nodeId>":{"<하위 경로>":"<task_id>", ...}}${automationJson.replace(/'/g, '')}}, ...]}'
   \`\`\`
   - \`bindings\` 에는 최상위 \`worker\`·\`gate\`·\`branch\` 단계와 \`spawn\` 링크 단계만 넣는다. 링크 아래 펼친 단계는 \`links\` 에 **최상위 링크 nodeId** 를 키로, 그 아래 \`nodeId\` 에서 링크 접두사를 뗀 경로(예: \`sub\`, 중첩이면 \`sub.inner\`)를 키로 넣는다. 링크가 없으면 \`links\` 는 생략한다.
   - 실행 id 는 \`<run_id>-<n>\` 이다(같은 워크플로의 다른 요청이 동시에 돌 수 있어 Run 마다 달라야 한다). 아래 \`<실행 id>\` 는 이 값이다.${launchId ? `
   - \`launch\` 는 이 실행 요청의 실행 로그 ID 다. 그대로 보낸다.` : ''}
   응답이 200 이 아니면 오류 메시지를 읽고 고쳐서 다시 보낸다.
4. 각 실행에서 선행 단계가 없는 단계부터 \`worker-start --task <task_id> --worktree path:<그 단계의 location> --agent claude --model <그 단계의 model> [--effort <그 단계의 effort>]\` 로 띄운다. \`effort\` 가 없으면 \`--effort\` 를 빼고, 단계마다 정해진 값을 바꾸지 않는다. 모든 실행의 첫 물결을 먼저 띄운 뒤 기다린다. 띄우자마자 탭 이름을 "${graph.name.slice(0, 30)} #<n> · <단계 이름>" 으로 바꾼다.
5. \`check --wait --timeout-ms 30000\` 을 반복하며 각 \`worker_done\` 을 처리한다. 진행 규칙은 정해져 있다. 네가 조건을 해석해 바꾸지 않는다.
   - **병렬·합류**: 분기가 아닌 연결은 모두 병렬이다. 한 단계는 \`after\` 의 선행 단계 Task 가 **모두 completed** 일 때 띄운다(건너뜀으로 닫힌 Task 도 completed 다). 선행이 여럿이면 마지막 것이 끝날 때까지 기다린다.
   - 단계를 띄울 때 \`location\`·\`model\`·\`effort\` 가 모두 직전 단계와 같으면 같은 터미널을 재사용하고(\`--terminal\`), 하나라도 다르면 새로 띄운다(\`--worktree path:<location> --model <model> [--effort <effort>]\`. \`--model\`·\`--effort\` 는 \`--terminal\` 과 함께 쓸 수 없다). 탭 이름을 바꾼다. 이어서 띄울 단계가 없는 워커는 release 한다.
   - **죽은 워커**: \`check\` 가 시간이 다 될 때마다 \`worker-list\` 로 진행 중(dispatched) Task 의 워커 터미널이 살아 있는지 본다. 터미널이 닫혔거나(exited·없음) 워크트리가 사라졌는데 worker_done 이 없으면 **더 기다리지 않는다.** 그 Task 를 \`task-update --status failed --result "<사유>"\` 로 닫고 실행 로그 \`error\` 에 남긴 뒤, 그 단계에 의존하는 단계는 띄우지 않는다(그 실행은 실패로 끝난다). 산출물 파일이 이미 있으면 사유에 경로를 적는다. 같은 단계를 다시 띄우지 않는다.
   - **워커 판정 분기(kind \`branch\`, judge \`previous\`·\`worker\`)**: 선행 단계가 끝나면 판정을 받는다.
     - \`previous\`: 직전 워커의 worker_done 첫 줄 \`decision: <출력 id>[,<출력 id>...]\` 를 쓴다. 분기 Task 에는 워커를 띄우지 않는다.
     - \`worker\`: 분기 Task 에 그 단계의 \`model\`·\`effort\` 로 워커를 띄운다. spec 은 분기 지침과 출력 목록(id·조건)이고, 근거로 선행 단계의 산출물을 읽게 한다. 그 워커의 worker_done 첫 줄 \`decision:\` 을 쓴다.
     - 판정을 아래 "판정 등록" 으로 캔버스에 등록하고 "판정 반영" 을 한다.
     - 응답이 400·409 이거나 \`decision:\` 이 없거나 출력 목록에 없는 값이면 **추측해서 진행하지 않는다.** 분기 Task 를 blocked 로 두고 사용자 결정으로 넘긴다(아래와 같이 게이트를 걸고 캔버스에서 받는다). 판정을 다시 받으려고 워커를 재실행하지 않는다.
   - **워커에서 묻는 게이트(kind \`gate\`, judge \`previous\`)**: 질문은 직전 워커가 자기 터미널에서 사용자에게 한다. 너는 게이트를 걸지 않고 묻지도 않는다. 그 워커는 사용자가 답할 때까지 worker_done 을 보내지 않으므로, 그동안 \`check --wait\` 반복을 계속한다(그 워커를 release 하지 않는다).
     - 워커의 worker_done 첫 줄 \`decision: approve|reject\` 를 "판정 등록" 으로 보내고 "판정 반영" 을 한다. 409 면 사용자가 캔버스에서 먼저 고른 것이므로 등록된 판정을 따른다.
     - 반복 중 등록된 판정을 확인할 때, 이런 게이트에 판정이 먼저 생겼으면(사용자가 캔버스 카드에서 고름) 그 워커에게 "사용자가 캔버스에서 <출력 id> 를 골랐다. 묻기를 멈추고 그 결정으로 worker_done 을 보내라" 를 메시지로 보낸다. 워커 보고를 기다렸다가 "판정 반영" 을 한다.
     - 워커가 \`decision:\` 없이 끝나면 추측하지 않고, 이 게이트를 아래 사용자 결정과 같은 방법으로 다시 묻는다.
   - **자동 승인 게이트(kind \`gate\`, judge \`auto\`)**: 사용자가 묻지 않기로 정한 게이트다. 묻지 않고 게이트도 걸지 않는다. 선행 단계가 끝나면 곧바로 \`approve\` 를 "판정 등록" 으로 보내고 "판정 반영" 을 한 뒤, 실행 로그 \`gate\` 에 "<단계 이름> #<n>: 자동 승인" 을 남긴다. 등록이 409 면(사용자가 캔버스에서 먼저 고름) 등록된 판정을 따른다.
   - **사용자 결정(kind \`gate\` judge \`user\`, 그리고 judge \`user\` 인 \`branch\`)**: 자동으로 고르지 않는다. 그리고 **답을 기다리며 멈추지 않는다.** 결정은 여러 실행·여러 단계에서 서로 다른 시점에 생기므로, 하나를 묻고 기다리면 그동안 다른 워커 보고와 다른 결정이 모두 막힌다.
     - 선행 단계가 끝나면 먼저 아래 decisions 조회로 판정이 이미 등록됐는지 본다(대시보드 등 캔버스 밖에서 미리 고를 수 있다). 있으면 게이트를 걸지 않고 곧바로 "판정 반영" 을 한다.
     - 없으면 그 Task 에 \`gate-create\` 로 결정 게이트를 건다(질문은 단계 지침, 선택지는 \`branch.outputs\` 의 조건). 실행 로그에 \`gate\` 를 남기고, 이 터미널에 "결정 대기 · <단계 이름> #<n> · 캔버스에서 고르거나 여기에 답하세요" 한 줄을 출력한다.
     - **질문 도구(AskUserQuestion 등)로 묻거나, 답을 받으려고 턴을 끝내지 않는다.** 곧바로 \`check --wait --timeout-ms 30000\` 반복으로 돌아간다.
     - 사용자는 캔버스의 결정 대기 카드에서 고른다. 캔버스가 판정을 등록한다. \`check\` 가 깨거나 시간이 다 될 때마다, 결정 대기 중인 실행마다 등록된 판정을 확인한다:
       \`\`\`sh
       curl -s ${apiBase}/api/workflows/${graph.id}/executions/<실행 id>/decisions
       \`\`\`
       새로 생긴 판정은 \`gate-resolve --resolution "<출력 id>"\` 로 게이트를 닫고 "판정 반영" 을 한다.
     - 사용자가 이 터미널에 직접 답하면 그 답을 "판정 등록" 으로 보낸다. 409 면 캔버스에서 먼저 고른 것이므로 등록된 판정을 따른다.
   - **스크립트 단계(kind \`script\`)**: 선행 단계가 모두 끝나면 Task 를 dispatched 로 두고 실행한다. 출력은 \`${artifactDir}/<실행 번호>-<nodeId>.out\`(표준 출력), \`.err\`(표준 오류), \`.exit\`(종료 코드 한 줄)에 남긴다.
     - 명령은 Write 도구로 \`${artifactDir}/<실행 번호>-<nodeId>.sh\` 에 그대로 쓰고(첫 줄 \`cd <location>\`, 끝에 출력·종료 코드를 위 파일로 남기는 줄), \`sh <그 파일>\` 로 돌린다. 명령을 한 줄 Bash 에 직접 넣지 않는다.
     - \`script.detach: false\`: 이 터미널에서 돌리고 \`script.timeoutSec\` 초를 넘기면 멈추고 실패로 닫는다.
     - \`script.detach: true\`: \`orca terminal create --worktree path:<location> --title "<단계 이름> #<n>" --command "sh <그 파일>"\` 로 따로 띄우고 기다리지 않는다. \`check\` 가 깨거나 시간이 다 될 때마다 \`.exit\` 파일이 생겼는지 본다. \`script.timeoutSec\` 초가 지나도 없으면 실패로 닫는다.
     - 종료 코드가 0 이 아니면 \`task-update --status failed --result "<exit N · .err 마지막 줄>"\` 로 닫고, 그 단계에 의존하는 단계는 띄우지 않는다. 다시 돌리지 않는다.
     - 0 이면 \`script.parse\` 대로 출력을 읽는다. 항목과 판정은 출력에서만 얻는다 — 고치거나 더하거나 빼지 않는다.
       - \`jsonl\`: 표준 출력의 줄마다 JSON 객체다(JSON 이 아닌 줄은 무시). \`item\` 이 있는 줄 중 \`"selected": false\` 가 아닌 것의 \`item\` 이 항목이다. \`{"decision": "<출력 id>[,<출력 id>...]"}\` 줄이 있으면 그것이 이 단계의 판정이다(\`decides\` 의 분기·게이트).
       - \`regex\`: 표준 출력의 줄마다 \`script.itemPattern\` 을 찾아, 맞은 줄의 첫 캡처 그룹(없으면 맞은 부분)이 항목이다.
       - \`none\`: 항목도 판정도 없다.
     - \`task-update --status completed --result "<exit 0 · 항목 N개 · 출력 파일 경로>"\` 로 닫는다. 항목·판정은 아래 "항목마다 따로 실행" 과 판정 규칙에서 워커의 \`items:\`·\`decision:\` 줄과 똑같이 쓴다. 고르지 않은 줄(\`"selected": false\`)은 실행 로그 \`note\` 에 \`<item>: <reason>\` 으로 남긴다.
   - **항목마다 따로 실행(\`spawn\` 이 있는 단계)**: 선행 워커가 끝나면, 그 worker_done 의 \`items: <항목>, <항목>, ...\` 줄을 항목 목록으로 읽는다(줄이 없거나 비었으면 빈 목록). 선행 단계가 스크립트 드라이버면 위 "스크립트 단계" 에서 읽은 항목을 쓴다. 항목을 고치거나 더하지 않는다. 한 번에 ${maxSpawnItems}개까지 보낸다.
     \`\`\`sh
     curl -s -X POST -H 'Content-Type: application/json' ${apiBase}/api/workflows/${graph.id}/executions/<실행 id>/spawn \\
       --data '{"node":"<링크 nodeId>","project":"${workspace}","items":["<항목>", ...]}'
     \`\`\`
     분기 출력으로 이 링크에 왔으면(그 분기의 \`after\` 연결로 도착하고 항목을 보고할 워커는 건너뜀) 항목은 빈 목록이다 — 요청을 보내지 않는다. \`spawn.as\` 가 없으면 캔버스가 항목마다 대상 워크플로의 코디네이터를 따로 띄우고(항목 = 대상의 실행 시 입력 워크트리 이름) \`results\` 를 돌려준다. 이 실행에서 이미 요청한 항목은 다시 띄우지 않는다(링크가 되돌아가기 구간 안에 있으면 회차마다 새로 요청할 수 있다. 같은 입력의 대상 실행이 아직 돌고 있으면 그 항목은 실패로 돌아온다). 응답 \`results\` 를 그대로 산출물 \`<n>-<링크 nodeId>.txt\` 에 쓰고, 링크 Task 를 \`task-update --status completed --result "요청 <성공 수>건 · 실패 <실패 수>건"\` 으로 닫은 뒤 다음 단계를 띄운다. 일부 항목이 실패해도 막지 않는다(뒤 단계가 산출물로 처리한다). 요청 자체가 400 이면 오류를 실행 로그 \`error\` 로 남기고 링크 Task 를 blocked 로 둔다. 따로 띄운 실행은 이 실행의 일부가 아니다 — 기다리지 않고, 정리하지도 않는다.${subSpawnSection}
   - **되돌아가기(\`branch.loops\` 의 출력)**: 판정은 다른 출력과 똑같이 "판정 등록" 으로 보낸다. 응답이 회차를 알려 준다.
     - 응답에 \`loop\` 가 있으면 되돌아간 것이다: 분기 Task 를 \`task-update --status completed --result "decision: <출력 id> · <loop.pass - 1>회차 종료"\` 로 닫고, \`loop.restart\` 의 단계(순서대로)마다 **새 Task** 를 만든다 — title·display-name "<단계 이름> #<n> · <loop.pass>회차", deps 는 같은 회차에 새로 만든 선행 단계 Task(첫 단계 \`loop.to\` 는 deps 없음). \`restart\` 에는 되돌아가기 구간 밖이지만 앞 회차에서 건너뜀으로 닫혀 이번 회차에 다시 닿을 수 있게 된 단계도 들어 있다 — 그 단계도 같은 방법으로 새 Task 를 만든다. 앞 회차 Task 는 그대로 둔다. 만든 Task 를 아래처럼 등록한 뒤 진행 규칙대로 \`loop.to\` 부터 띄운다. 이후 이 단계들의 완료·판정은 새 Task 기준이다.
       \`\`\`sh
       curl -s -X PATCH -H 'Content-Type: application/json' ${apiBase}/api/workflows/${graph.id}/executions/<실행 id>/bindings \\
         --data '{"bindings":{"<nodeId>":"<새 task_id>", ...}}'
       \`\`\`
     - 응답에 \`exhausted\` 가 있으면 최대 반복 횟수를 다 써서 판정이 \`exhausted.output\` 으로 바뀌어 기록된 것이다. 그 출력으로 판정 반영을 하고, 실행 로그 \`note\` 에 남긴다.
   - **판정 등록**: 응답의 \`skippedTasks\` 는 지금까지의 판정으로 더 이상 갈 수 없게 된 단계의 Task 다.
     \`\`\`sh
     curl -s -X POST -H 'Content-Type: application/json' ${apiBase}/api/workflows/${graph.id}/executions/<실행 id>/decisions \\
       --data '{"node":"<분기·게이트 nodeId>","outputs":["<출력 id>"]}'
     \`\`\`
   - **판정 반영**: \`skippedTasks\` 의 Task 를 모두 \`task-update --status completed --result skipped\` 로 닫고(합류 단계의 deps 를 풀기 위해서다. 캔버스는 이 Task 들을 건너뜀으로 표시한다. 이미 닫은 것은 넘어간다), 분기·게이트 Task 를 \`task-update --status completed --result "decision: <출력 id>"\` 로 닫은 뒤 진행 규칙대로 다음 단계를 띄운다. 게이트를 거절(\`reject\`)하면 뒤 단계가 모두 건너뜀이 된다.
6. 모든 실행이 끝나면(모든 단계가 completed(건너뜀 포함)이거나, 실패한 Task 때문에 더 띄울 단계가 없으면) 아래 "완료 시 정리" 를 따른 뒤 마무리 보고를 한다. 사용자 결정이 남아 있으면 끝내지 않고 5의 반복을 계속한다. 마무리 보고 뒤에는 사용자에게 후속 작업을 묻거나 제안하지 않는다 — 남은 확인은 보고에만 적는다.

${logUrl ? `## 실행 로그
캔버스가 실행 로그를 남긴다. Task 상태 변화는 캔버스가 직접 기록하므로, 너는 **판단과 사람 개입**만 기록한다. 아래 때마다 한 번씩 보낸다:
- \`worker\`: worker_done 을 처리할 때. 메시지는 "<단계 이름> #<n>: <결과 한 줄> → <진행/중단 판단과 근거>".
- \`gate\`: 결정 게이트를 걸 때, 그리고 사용자가 터미널에 직접 답했을 때(캔버스에서 고른 결정은 캔버스가 기록한다).
- \`error\`: 워커 실패·재시도·escalation, 명령 실패.
- \`note\`: 워크트리 생성·재사용, 정리 결과 등 그 밖의 판단.
- \`report\`: 마무리 보고 요약(한두 줄).

\`\`\`sh
curl -s -X POST -H 'Content-Type: application/json' ${logUrl} \\
  --data '{"type":"worker","taskId":"<task_id>","message":"..."}'
\`\`\`
\`taskId\` 는 해당하면 넣고, 아니면 뺀다. message 는 2000자 이하. 실패해도 실행은 계속한다.

` : ''}## 워커 spec 규칙
- 단계 지침을 그대로 Change 로 쓰고, Target·Constraints·Ownership·Acceptance 를 채운다.
- 작업 위치: 그 단계의 \`location\`. 그 밖의 파일은 수정하지 않는다. 워커는 자기 \`location\` 워크트리를 지우거나 그 안의 터미널을 닫지 않는다(자기 터미널이 함께 닫혀 worker_done 을 보낼 수 없다). 지침이 그런 정리를 요구하면 하지 말고 worker_done 에 "코디네이터 정리 필요" 로 보고한다.
- 단계에 \`namesWorktree\` 가 있으면 spec 에 "작업을 마치면 이후 단계가 쓸 워크트리 이름(영문·숫자·\`.\`·\`_\`·\`-\`)을 정하거나 직접 만들고, worker_done 첫 줄에 \`worktree: <이름 또는 절대 경로>\` 로 보고한다" 를 넣는다.
- 산출물·로그는 \`${artifactDir}/<n>-<nodeId>.txt\` 에 쓴다.
- 단계에 \`decides\` 가 있으면 spec 에 그 분기의 출력 목록(id·조건)과 "작업을 마치면 조건에 맞는 출력을 고르고(\`mode: exclusive\` 면 하나만) worker_done 첫 줄에 \`decision: <출력 id>\` 로 보고한다. 판정은 한 번만 내고 재실행해 결과를 고르지 않는다" 를 넣는다. \`namesWorktree\` 도 있으면 \`worktree:\` 줄을 그다음 줄에 쓴다.
- \`decides\` 항목에 \`ask\` 가 있으면(이 워커 뒤의 게이트를 이 워커가 묻는다) spec 에 다음을 넣는다: "작업을 마치면 worker_done 을 보내기 전에 이 터미널에서 사용자에게 \`ask\` 를 묻는다. 결과 요약과 산출물 경로를 함께 보여 주고, 통과(approve)·거절(reject) 중 하나를 고르게 한다. 사용자가 답할 때까지 기다리며, 그사이 사용자가 묻거나 고쳐 달라는 것은 작업 범위 안에서 반영한다. 답을 받으면 worker_done 첫 줄에 \`decision: approve\` 또는 \`decision: reject\` 로 보고한다. 코디네이터가 사용자가 이미 골랐다고 알려 오면 묻기를 멈추고 그 결정으로 보고한다."
- 단계에 \`reportsItems\` 가 있으면 spec 에 "작업을 마치면 다음 단계가 따로 실행할 항목(각각 대상 워크플로의 워크트리 이름이 된다 — 영문·숫자·\`.\`·\`_\`·\`-\`)을 worker_done 에 \`items: <항목>, <항목>, ...\` 한 줄로 보고한다. 없으면 \`items:\` 만 쓴다" 를 넣는다. \`decision:\`·\`worktree:\` 줄이 있으면 그다음 줄에 쓴다.
- 되돌아가기로 다시 띄우는 단계(2회차 이상)의 spec 에는 "<회차>회차다. 이 단계의 앞 회차 산출물과, 되돌아오게 한 분기를 판정한 단계의 산출물을 먼저 읽고 그 지적을 반영한다" 를 넣고, 산출물은 \`${artifactDir}/<n>-<nodeId>-r<회차>.txt\` 에 쓴다(1회차는 위 이름 그대로).
- worker_done 본문은 3줄 이하: 결과, 산출물 경로, 결정이 필요한 것.

## 완료 시 정리 (사용자가 실행할 때 고른 설정)
- 워커 세션: ${cleanup.sessions ? '**정리한다.** 끝난 워커는 \`worker-release\` 로 터미널을 정리하고, \`worker-list --terminal-state reclaimable\` 이 빌 때까지 확인한다.' : '**남겨 둔다.** 끝난 워커는 \`worker-retain\` 으로 터미널을 남겨 사용자가 볼 수 있게 한다. 진행하지 않은 분기의 워커만 release 한다.'}
- 워크트리: ${cleanup.worktrees ? '**이번 Run 에서 새로 만든 워크트리만 지운다.** 모든 실행이 끝난 뒤 \`orca worktree rm --worktree path:<경로>\` 로 지운다. 재사용한 워크트리와 기존 선택 워크트리는 지우지 않는다. 커밋·푸시되지 않은 변경이 있거나 실패·확인 필요로 끝난 실행의 워크트리는 지우지 않고(\`--force\` 금지) 보고에 남긴다. 네가 그 워크트리 안에서 시작했다면 그 삭제는 마무리 보고와 \`report\` 기록 뒤 맨 마지막에 한다(지우면 네 터미널도 닫힌다).' : '**남겨 둔다.** 만든 워크트리는 지우지 않는다. 워크트리 정리는 이 실행 밖(다른 플로·드라이버)의 몫이다.'}
- 코디네이터: ${cleanup.coordinator ? '**마무리 보고 뒤 종료한다.** 보고를 \`' + artifactDir + '/report.md\` 에도 저장하고 실행 로그 \`report\` 를 보낸 뒤, 자기 터미널(\`$ORCA_TERMINAL_HANDLE\`)을 \`orca terminal close --terminal <handle>\` 로 닫는다. 실패한 단계·남은 확인·남긴 워크트리가 있어도 닫는다 — 그것은 보고와 실행 로그에 남고, 사용자는 캔버스에서 다시 실행한다. 닫지 않고 기다리는 것은 사용자 결정이 아직 열려 있을 때뿐이다(그때는 실행이 끝나지 않았다). 닫지 못하면 캔버스 서버가 실행 종료 뒤 대신 닫는다.' : '**남겨 둔다.** 마무리 보고 뒤 터미널을 닫지 않는다.'}

## 마무리 보고 (이 터미널에)
실행별 한 줄 표(실행 · 단계별 결과 · 근거 파일). 해결되지 않은 것이 있으면 따로 적는다.
`;
}
