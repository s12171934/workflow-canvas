import { createsWorktree, gateOutputs, defaultWorkerModel, launchesWorker, isBranch, isExecutable, isGroup, membershipOf, newWorktreeToken, orderNodes, parentWorktree, topologicalOrder, waves, worktreeRepo, type FlowStage, type StageNode, type Workflow, type Cleanup, defaultCleanup } from '../src/model.ts';

export type BriefInput = {
  graph: Workflow;
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

type WorktreeSpec = {
  location: string; group: string; mode: 'existing' | 'create'; repo: string; parent?: string;
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
      if ((node.data.judge ?? 'previous') === 'previous' && (sources.length !== 1 || sources[0].data.kind !== 'worker')) {
        throw new Error(`${name} 분기를 직전 단계 워커가 판정하려면 앞에 워커 하나만 연결해야 합니다.`);
      }
    }
  }
}

type BriefStage = {
  nodeId: string; label: string; kind: string; instructions: string; location: string;
  /** Longest-path depth: stages with the same wave may run side by side. Stages are listed in topological order. */
  wave: number;
  /** `output`: the edge leaves this output of a branch, so it is taken only when the branch chooses it. */
  after: { nodeId: string; output?: string; condition?: string }[];
  branch?: { mode: string; judge: string; outputs: { id: string; label: string }[] };
  /** 'any': paths that split at a branch meet here; the stage runs if at least one arrives. Absent: every path is needed. */
  join?: 'any';
  /** This worker also decides these branches (judge 'previous'): it reports `decision: <output id>`. */
  decides?: { nodeId: string; mode: string; outputs: { id: string; label: string }[] }[];
  /** This stage's agent decides (or creates) the worktree used at this location. */
  namesWorktree?: string[];
  /** Stages that start a worker: the model (always set; the default when the node names none) and effort (omitted = model default). */
  model?: string;
  effort?: string;
  workflow?: { id: string; name: string; stages: BriefStage[] };
};

type BriefContext = { linked: Map<string, Workflow>; project: string; inputs: Record<string, string>; worktrees: WorktreeSpec[] };

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
      ctx.worktrees.push({ ...base, mode: 'existing', existing: { path: group.data.path ?? '',
        ...(group.data.worktreeName ? { name: group.data.worktreeName } : {}), ...(group.data.branch ? { branch: group.data.branch } : {}) } });
      continue;
    }
    const source = group.data.nameSource ?? 'fixed';
    const name: WorktreeSpec['name'] = source === 'agent' ? { source, fromStage: `${prefix}${group.data.nameFrom}` }
      : source === 'input' ? { source, ...(ctx.inputs[`${prefix}${group.id}`] ? { value: ctx.inputs[`${prefix}${group.id}`] } : {}), ...(group.data.inputPrompt ? { prompt: group.data.inputPrompt } : {}) }
      : { source, value: group.data.worktreeName || `wf-${group.id.slice(0, 8)}` };
    if (source === 'agent' && group.data.nameFrom) namers.set(group.data.nameFrom, [...(namers.get(group.data.nameFrom) ?? []), base.location]);
    ctx.worktrees.push({ ...base, mode: 'create', name, ...(group.data.baseBranch ? { baseBranch: group.data.baseBranch } : {}), perExecution: !!group.data.perExecution });
  }
  const stageEdges = graph.edges.filter((edge) => executable.has(edge.source) && executable.has(edge.target));
  const { order } = topologicalOrder([...executable], stageEdges);
  const wave = waves(order, stageEdges);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return order.map((id) => byId.get(id)!).map((node: StageNode) => {
    // Innermost worktree group wins, then a project group, then the fallback (the run project, or the link's own location).
    const { project, worktrees } = membershipOf(graph, node);
    const inner = worktrees[worktrees.length - 1];
    const location = inner ? groupLocation(inner, prefix) : project?.data.path || fallback;
    const sub = node.data.kind === 'workflow' && node.data.workflowId ? ctx.linked.get(node.data.workflowId) : undefined;
    return {
      nodeId: `${prefix}${node.id}`, label: node.data.label, kind: node.data.kind, instructions: node.data.description, location,
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
        outputs: (node.data.outputs ?? []).map((output) => ({ id: output.id, label: output.label })) } } : {}),
      ...(node.data.kind === 'gate' ? { branch: { mode: 'exclusive', judge: 'user', outputs: gateOutputs } } : {}),
      ...(node.data.join === 'any' ? { join: 'any' as const } : {}),
      ...(() => {
        const decides = stageEdges.filter((edge) => edge.source === node.id).map((edge) => byId.get(edge.target)!)
          .filter((target) => isBranch(target) && (target.data.judge ?? 'previous') === 'previous')
          .map((target) => ({ nodeId: `${prefix}${target.id}`, mode: target.data.mode ?? 'exclusive', outputs: (target.data.outputs ?? []).map((output) => ({ id: output.id, label: output.label })) }));
        return decides.length ? { decides } : {};
      })(),
      ...(namers.has(node.id) ? { namesWorktree: namers.get(node.id) } : {}),
      ...(launchesWorker(node) ? { model: node.data.workerModel || defaultWorkerModel, ...(node.data.effort ? { effort: node.data.effort } : {}) } : {}),
      ...(sub ? { workflow: { id: sub.id, name: sub.name, stages: stagesOf(sub, ctx, location, `${prefix}${node.id}.`) } } : {}),
    };
  });
}

/** Expands workflow links into one graph of brief stage ids: a link's first stages follow the link's predecessors, its successors follow its last stages. */
function flatten(stages: BriefStage[]): FlowStage[] {
  const sinks = new Map<string, string[]>();
  const expanded = new Map<string, FlowStage[]>();
  for (const stage of stages) {
    if (!stage.workflow) continue;
    const sub = flatten(stage.workflow.stages);
    const referenced = new Set(sub.flatMap((item) => item.after.map((after) => after.id)));
    sinks.set(stage.nodeId, sub.filter((item) => !referenced.has(item.id)).map((item) => item.id));
    expanded.set(stage.nodeId, sub);
  }
  const resolve = (after: BriefStage['after']) => after.flatMap((item) => sinks.has(item.nodeId)
    ? sinks.get(item.nodeId)!.map((id) => ({ id })) : [{ id: item.nodeId, ...(item.output ? { output: item.output } : {}) }]);
  return stages.flatMap((stage): FlowStage[] => stage.workflow
    ? expanded.get(stage.nodeId)!.map((item) => item.after.length ? item : { ...item, after: resolve(stage.after) })
    : [{ id: stage.nodeId, after: resolve(stage.after), label: stage.label, question: stage.instructions,
      ...(stage.branch ? { branch: { mode: stage.branch.mode as 'exclusive' | 'inclusive', outputs: stage.branch.outputs.map((output) => output.id) },
        judge: stage.branch.judge as 'previous' | 'worker' | 'user', outputLabels: Object.fromEntries(stage.branch.outputs.map((output) => [output.id, output.label])) } : {}),
      ...(stage.kind === 'gate' ? { veto: ['reject'] } : {}), ...(stage.join ? { join: stage.join } : {}) }]);
}
/** The executable graph of a run, links expanded, with brief stage ids (the keys of decisions and skipped). */
export function flowOf(graph: Workflow, linked: Map<string, Workflow>): FlowStage[] {
  return flatten(stagesOf(graph, { linked, project: '', inputs: {}, worktrees: [] }, ''));
}

/**
 * Builds the coordinator brief for one "실행" request.
 * The canvas never runs workers itself: a supervised Orca coordinator agent owns the Run,
 * judges the natural-language conditions in node instructions, and reports bindings back
 * through the canvas API so the graph can observe the executions.
 */
export function buildBrief({ graph, linked = new Map(), count, apiBase, workspace, artifactDir, logUrl, inputs = {}, cleanup = defaultCleanup, automation }: BriefInput): string {
  const automationJson = automation ? `,"automation":${JSON.stringify(automation)}` : '';
  const ctx: BriefContext = { linked, project: workspace, inputs, worktrees: [] };
  const stages = stagesOf(graph, ctx, workspace);
  const worktrees = ctx.worktrees;
  const worktreeSection = worktrees.length ? `
## 워크트리
단계의 \`location\` 이 아래 표의 \`location\` 과 같으면 그 워크트리에서 작업한다. 표 순서대로(바깥 워크트리 먼저) 준비한다. \`new-worktree:\` 로 시작하는 location 은 실행 중에 만들어질 워크트리다.

\`\`\`json
${JSON.stringify(worktrees, null, 2)}
\`\`\`

1. **이름 정하기**
   - \`mode: existing\`: \`existing.path\` 가 실제로 있으면 그대로 쓴다. 없으면(지워졌으면) \`existing.name\` 으로 아래 3의 방법으로 다시 만든다(\`existing.branch\` 가 있으면 \`--branch\` 로 넘긴다).
   - \`name.source: fixed\`: \`name.value\` 를 쓴다.
   - \`name.source: agent\`: \`name.fromStage\` 단계의 워커가 worker_done 첫 줄에 \`worktree: <이름 또는 절대 경로>\` 로 보고한다. 실제 워크트리의 절대 경로면 그대로 쓰고(에이전트가 직접 만든 경우), 이름이면 그 이름으로 만든다. 그 단계가 끝나기 전에는 이 워크트리를 쓰는 단계를 띄우지 않는다.
   - \`name.source: input\`: \`name.value\` 가 있으면 쓴다. 없으면 이 터미널에서 사용자에게 \`name.prompt\`(없으면 "<group> 워크트리 이름") 로 묻고 답을 쓴다.
   - \`perExecution: true\` 면 이름 뒤에 \`-<실행 번호>\` 를 붙인다. 아니면 모든 실행이 같은 이름을 쓴다.
   - 이름에는 영문·숫자·\`.\`·\`_\`·\`-\` 만 쓴다. 다른 문자는 \`-\` 로 바꾸고, \`-\` 로 시작하지 않게 한다.
2. **재사용**: 만들기 전에 \`orca worktree list --repo path:<repo> --json\` 에서 displayName 이나 branch 가 같은 워크트리를 찾는다. 있으면 새로 만들지 않고 그 경로를 쓴다(이전 실행이나 병렬 실행이 만든 것). 같은 이름은 이 Run 에서 한 번만 만든다. 병렬 실행이 같은 이름을 요구하면 먼저 만든 것을 기다렸다가 재사용한다.
3. **만들기**: \`orca worktree create --repo path:<repo> --name <이름> [--base-branch <baseBranch>] [--parent-worktree path:<부모 경로> | --no-parent] --setup inherit --json\`
   - \`parent\` 가 있으면 그 location 이 이 실행에서 가리키는 경로를 \`--parent-worktree path:<경로>\` 로 넘겨 **하위 워크트리**로 만든다. 부모를 먼저 준비한다. \`parent\` 가 없으면 \`--no-parent\`.
4. 확정된 경로를 그 실행에서 해당 location 대신 쓴다. 진행하지 않을 단계만 있는 워크트리는 만들지 않는다. 만든 워크트리는 지우지 않고, 마무리 보고에 실행별 워크트리 경로와 재사용 여부를 남긴다.
` : '';
  return `# 워크플로 실행 코디네이터 브리프

너는 ${automation ? `Orca 자동화 「${automation.name}」` : 'workflow-canvas 의 "실행" 버튼'}으로 기동된 **Orca 오케스트레이션 코디네이터**다.${automation ? `
이 실행은 자동화로 시작되었다. 실행 목록을 등록할 때 모든 실행에 \`"automation":${JSON.stringify(automation).replace(/`/g, '')}\` 를 그대로 넣는다(캔버스가 적용된 자동화를 표시한다). 사용자가 자리에 없을 수 있으니, 사용자 입력이 필요한 곳(게이트·실행 중 입력)에서는 묻고 기다리되 다른 실행은 계속 진행한다.` : ''}
사용자가 감독(supervision)을 요청했다. 아래 그래프를 **${count}회 병렬 실행**하고 끝까지 감독한다.

## 먼저 할 일
1. \`orca-orchestration-rules\` 와 \`orchestration\` 스킬을 로드하고 \`orca skills get orchestration\` 으로 버전에 맞는 가이드를 읽는다. 명령과 플래그는 그 가이드만 따른다.
2. 사용자에게 보이는 모든 텍스트는 한국어로 쓴다.

## 그래프
- 워크플로: ${graph.name} (id \`${graph.id}\`)
- 실행 프로젝트: \`${workspace}\` (사용자가 실행할 때 고른 프로젝트. 그룹 밖 단계는 여기서 작업한다)
- 단계 목록(JSON). 위상 순서로 나열되어 있다. \`after\` 는 선행 단계, \`wave\` 는 단계 깊이(같은 wave 는 동시에 돌 수 있다), \`location\` 은 그 단계의 워커가 작업할 경로다(그룹 노드가 정한 Orca 프로젝트·워크트리). \`model\`·\`effort\` 는 그 단계 워커를 띄울 때 쓸 모델과 추론 수준이다(\`effort\` 가 없으면 모델 기본값). \`condition\` 은 연결 설명으로 **참고 정보일 뿐 진행 여부를 바꾸지 않는다.**
- 단계 종류(\`kind\`):
  - \`worker\`: 워커 하나가 지침을 수행한다.
  - 들어오는 연결이 여럿인 단계: 기본은 **모두 필요**다. 앞 경로 중 하나라도 건너뛰어지면(고르지 않은 분기 출력, 건너뛴 단계) 이 단계도 건너뛴다. \`join: any\` 인 단계는 분기에서 갈라진 경로가 다시 모이는 곳이라 하나라도 오면 진행한다. 어느 쪽이든 건너뜀 계산은 캔버스가 하고, 너는 건너뛰지 않은 선행이 모두 끝났을 때 띄운다.
  - \`gate\`: 사용자 개입 게이트. 워커를 띄우지 않는다. 출력이 \`approve\`(통과)·\`reject\`(거절) 두 개인 사용자 결정이다. 게이트에서 나가는 연결은 모두 \`approve\` 출력이다.
  - \`branch\`: 분기. 어느 출력으로 갈지 판정만 한다. \`branch.mode\` 가 \`exclusive\` 면 출력 하나, \`inclusive\` 면 조건에 맞는 출력 모두(하나 이상)를 고른다. \`branch.judge\` 가 판정 주체다: \`previous\` 직전 워커, \`worker\` 판정 전용 워커, \`user\` 사용자. \`after\` 항목에 \`output\` 이 있으면 그 분기가 그 출력을 골랐을 때만 이어지는 연결이다.
  - \`workflow\`: 다른 워크플로로의 링크. \`workflow.stages\` 를 그 자리에 펼쳐 실행한다. 펼친 첫 단계들은 링크의 선행 단계를 deps 로 갖고, 링크의 후행 단계는 펼친 마지막 단계들을 deps 로 갖는다. 펼친 단계의 \`nodeId\` 는 \`<링크 nodeId>.<하위 nodeId>\` 꼴이다.

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
3. Task 를 모두 만들면 **워커를 띄우기 전에** 캔버스에 실행 목록을 등록한다(한 번만):
   \`\`\`sh
   curl -s -X PUT -H 'Content-Type: application/json' ${apiBase}/api/workflows/${graph.id}/executions \\
     --data '{"runId":"<run_id>","executions":[{"id":"exec-1","label":"#1","bindings":{"<nodeId>":"<task_id>", ...},"links":{"<링크 nodeId>":{"<하위 경로>":"<task_id>", ...}}${automationJson.replace(/'/g, '')}}, ...]}'
   \`\`\`
   - \`bindings\` 에는 최상위 \`worker\`·\`gate\`·\`branch\` 단계만 넣는다. 링크 아래 펼친 단계는 \`links\` 에 **최상위 링크 nodeId** 를 키로, 그 아래 \`nodeId\` 에서 링크 접두사를 뗀 경로(예: \`sub\`, 중첩이면 \`sub.inner\`)를 키로 넣는다. 링크가 없으면 \`links\` 는 생략한다.
   응답이 200 이 아니면 오류 메시지를 읽고 고쳐서 다시 보낸다.
4. 각 실행에서 선행 단계가 없는 단계부터 \`worker-start --task <task_id> --worktree path:<그 단계의 location> --agent claude --model <그 단계의 model> [--effort <그 단계의 effort>]\` 로 띄운다. \`effort\` 가 없으면 \`--effort\` 를 빼고, 단계마다 정해진 값을 바꾸지 않는다. 모든 실행의 첫 물결을 먼저 띄운 뒤 기다린다. 띄우자마자 탭 이름을 "${graph.name.slice(0, 30)} #<n> · <단계 이름>" 으로 바꾼다.
5. \`check --wait --timeout-ms 30000\` 을 반복하며 각 \`worker_done\` 을 처리한다. 진행 규칙은 정해져 있다. 네가 조건을 해석해 바꾸지 않는다.
   - **병렬·합류**: 분기가 아닌 연결은 모두 병렬이다. 한 단계는 \`after\` 의 선행 단계 Task 가 **모두 completed** 일 때 띄운다(건너뜀으로 닫힌 Task 도 completed 다). 선행이 여럿이면 마지막 것이 끝날 때까지 기다린다.
   - 단계를 띄울 때 \`location\`·\`model\`·\`effort\` 가 모두 직전 단계와 같으면 같은 터미널을 재사용하고(\`--terminal\`), 하나라도 다르면 새로 띄운다(\`--worktree path:<location> --model <model> [--effort <effort>]\`. \`--model\`·\`--effort\` 는 \`--terminal\` 과 함께 쓸 수 없다). 탭 이름을 바꾼다. 이어서 띄울 단계가 없는 워커는 release 한다.
   - **워커 판정 분기(kind \`branch\`, judge \`previous\`·\`worker\`)**: 선행 단계가 끝나면 판정을 받는다.
     - \`previous\`: 직전 워커의 worker_done 첫 줄 \`decision: <출력 id>[,<출력 id>...]\` 를 쓴다. 분기 Task 에는 워커를 띄우지 않는다.
     - \`worker\`: 분기 Task 에 그 단계의 \`model\`·\`effort\` 로 워커를 띄운다. spec 은 분기 지침과 출력 목록(id·조건)이고, 근거로 선행 단계의 산출물을 읽게 한다. 그 워커의 worker_done 첫 줄 \`decision:\` 을 쓴다.
     - 판정을 아래 "판정 등록" 으로 캔버스에 등록하고 "판정 반영" 을 한다.
     - 응답이 400·409 이거나 \`decision:\` 이 없거나 출력 목록에 없는 값이면 **추측해서 진행하지 않는다.** 분기 Task 를 blocked 로 두고 사용자 결정으로 넘긴다(아래와 같이 게이트를 걸고 캔버스에서 받는다). 판정을 다시 받으려고 워커를 재실행하지 않는다.
   - **사용자 결정(kind \`gate\`, 그리고 judge \`user\` 인 \`branch\`)**: 자동으로 고르지 않는다. 그리고 **답을 기다리며 멈추지 않는다.** 결정은 여러 실행·여러 단계에서 서로 다른 시점에 생기므로, 하나를 묻고 기다리면 그동안 다른 워커 보고와 다른 결정이 모두 막힌다.
     - 선행 단계가 끝나면 그 Task 에 \`gate-create\` 로 결정 게이트를 건다(질문은 단계 지침, 선택지는 \`branch.outputs\` 의 조건). 실행 로그에 \`gate\` 를 남기고, 이 터미널에 "결정 대기 · <단계 이름> #<n> · 캔버스에서 고르거나 여기에 답하세요" 한 줄을 출력한다.
     - **질문 도구(AskUserQuestion 등)로 묻거나, 답을 받으려고 턴을 끝내지 않는다.** 곧바로 \`check --wait --timeout-ms 30000\` 반복으로 돌아간다.
     - 사용자는 캔버스의 결정 대기 카드에서 고른다. 캔버스가 판정을 등록한다. \`check\` 가 깨거나 시간이 다 될 때마다, 결정 대기 중인 실행마다 등록된 판정을 확인한다:
       \`\`\`sh
       curl -s ${apiBase}/api/workflows/${graph.id}/executions/<실행 id>/decisions
       \`\`\`
       새로 생긴 판정은 \`gate-resolve --resolution "<출력 id>"\` 로 게이트를 닫고 "판정 반영" 을 한다.
     - 사용자가 이 터미널에 직접 답하면 그 답을 "판정 등록" 으로 보낸다. 409 면 캔버스에서 먼저 고른 것이므로 등록된 판정을 따른다.
   - **판정 등록**: 응답의 \`skippedTasks\` 는 지금까지의 판정으로 더 이상 갈 수 없게 된 단계의 Task 다.
     \`\`\`sh
     curl -s -X POST -H 'Content-Type: application/json' ${apiBase}/api/workflows/${graph.id}/executions/<실행 id>/decisions \\
       --data '{"node":"<분기·게이트 nodeId>","outputs":["<출력 id>"]}'
     \`\`\`
   - **판정 반영**: \`skippedTasks\` 의 Task 를 모두 \`task-update --status completed --result skipped\` 로 닫고(합류 단계의 deps 를 풀기 위해서다. 캔버스는 이 Task 들을 건너뜀으로 표시한다. 이미 닫은 것은 넘어간다), 분기·게이트 Task 를 \`task-update --status completed --result "decision: <출력 id>"\` 로 닫은 뒤 진행 규칙대로 다음 단계를 띄운다. 게이트를 거절(\`reject\`)하면 뒤 단계가 모두 건너뜀이 된다.
6. 모든 실행의 모든 단계가 completed(건너뜀 포함)가 되면 아래 "완료 시 정리" 를 따른 뒤 마무리 보고를 한다. 사용자 결정이 남아 있으면 끝내지 않고 5의 반복을 계속한다.

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
- 작업 위치: 그 단계의 \`location\`. 그 밖의 파일은 수정하지 않는다.
- 단계에 \`namesWorktree\` 가 있으면 spec 에 "작업을 마치면 이후 단계가 쓸 워크트리 이름(영문·숫자·\`.\`·\`_\`·\`-\`)을 정하거나 직접 만들고, worker_done 첫 줄에 \`worktree: <이름 또는 절대 경로>\` 로 보고한다" 를 넣는다.
- 산출물·로그는 \`${artifactDir}/<n>-<nodeId>.txt\` 에 쓴다.
- 단계에 \`decides\` 가 있으면 spec 에 그 분기의 출력 목록(id·조건)과 "작업을 마치면 조건에 맞는 출력을 고르고(\`mode: exclusive\` 면 하나만) worker_done 첫 줄에 \`decision: <출력 id>\` 로 보고한다. 판정은 한 번만 내고 재실행해 결과를 고르지 않는다" 를 넣는다. \`namesWorktree\` 도 있으면 \`worktree:\` 줄을 그다음 줄에 쓴다.
- worker_done 본문은 3줄 이하: 결과, 산출물 경로, 결정이 필요한 것.

## 완료 시 정리 (사용자가 실행할 때 고른 설정)
- 워커 세션: ${cleanup.sessions ? '**정리한다.** 끝난 워커는 \`worker-release\` 로 터미널을 정리하고, \`worker-list --terminal-state reclaimable\` 이 빌 때까지 확인한다.' : '**남겨 둔다.** 끝난 워커는 \`worker-retain\` 으로 터미널을 남겨 사용자가 볼 수 있게 한다. 진행하지 않은 분기의 워커만 release 한다.'}
- 워크트리: ${cleanup.worktrees ? '**이번 Run 에서 새로 만든 워크트리만 지운다.** 모든 실행이 끝난 뒤 \`orca worktree rm --worktree path:<경로>\` 로 지운다. 재사용한 워크트리와 기존 선택 워크트리는 지우지 않는다. 커밋·푸시되지 않은 변경이 있거나 실패·확인 필요로 끝난 실행의 워크트리는 지우지 않고(\`--force\` 금지) 보고에 남긴다.' : '**남겨 둔다.** 만든 워크트리는 지우지 않는다.'}
- 코디네이터: ${cleanup.coordinator ? '**마무리 보고 뒤 종료한다.** 보고를 \`' + artifactDir + '/report.md\` 에도 저장하고, 해결되지 않은 것(실패·확인 필요·남긴 워크트리)이 없을 때만 자기 터미널(\`$ORCA_TERMINAL_HANDLE\`)을 \`orca terminal close --terminal <handle>\` 로 닫는다. 남은 것이 있으면 닫지 않고 사용자를 기다린다.' : '**남겨 둔다.** 마무리 보고 뒤 터미널을 닫지 않는다.'}

## 마무리 보고 (이 터미널에)
실행별 한 줄 표(실행 · 단계별 결과 · 근거 파일). 해결되지 않은 것이 있으면 따로 적는다.
`;
}
