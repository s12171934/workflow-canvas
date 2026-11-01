import { effortLevels, forwardEdges, isExecutable, topologicalOrder, waves, workerModels, defaultWorkerModel, kindNames,
  type StageNode, type Workflow } from '../src/model.ts';

// Natural-language generation runs in Orca: the canvas server writes a prompt file, Orca launches a Claude agent in the
// chosen project, and the agent sends its result back through the canvas API. The server validates every result; the
// agent fixes and resends on a 400. Nothing here calls a model directly.

export type GenerationKind = 'workflow' | 'brief';
export type Generation = {
  id: string; kind: GenerationKind; status: 'pending' | 'done' | 'failed'; createdAt: number; project: string;
  /** brief: the node the instructions are for (in the canvas's current graph). */
  nodeId?: string;
  /** workflow: the saved workflow the agent produced. brief: the generated instructions. */
  workflowId?: string; description?: string; label?: string; error?: string;
};

/** Generations still pending after this long are reported as failed (the agent was closed or got stuck). */
export const generationTimeoutMs = 30 * 60_000;
export const maxPromptLength = 10_000;

const stageKinds = ['worker', 'gate', 'branch', 'workflow', 'note'] as const;
const resultFormat = (url: string, file: string) => `결과는 JSON 파일(\`${file}\`)로 쓰고 아래처럼 보낸다:

\`\`\`sh
curl -s -w '\\n%{http_code}\\n' -X PUT -H 'Content-Type: application/json' ${url} --data @${file}
\`\`\`

- 200 이면 끝이다. 사용자에게 "캔버스에 반영했습니다" 한 줄만 말하고 멈춘다.
- 400 이면 응답의 \`error\` 를 읽고 고쳐서 다시 보낸다(최대 5번).
- 도저히 만들 수 없으면 \`{"error":"<이유>"}\` 를 보내고 멈춘다.
- 이 프로젝트의 파일은 읽기만 하고 수정하지 않는다. 사용자에게 보이는 모든 텍스트는 한국어로 쓴다.`;

export function workflowPrompt(input: { request: string; resultUrl: string; resultFile: string; saved: { id: string; name: string }[] }): string {
  return `# 워크플로 자동 생성

너는 workflow-canvas 의 「자연어로 워크플로 만들기」로 Orca 에서 기동된 에이전트다. 사용자의 요청을 실행 가능한 워크플로 그래프(JSON)로 만들어 캔버스에 보낸다. 필요하면 현재 프로젝트(작업 디렉터리)를 읽어 단계를 구체화한다.

## 사용자 요청
${input.request}

## 그래프 규칙
- 각 단계는 Orca 코디네이터가 Task 로 만들고, \`worker\` 단계마다 워커 에이전트 하나가 \`description\` 을 지침으로 받아 수행한다.
- 연결(\`edges\`)은 선행 → 후행이다. 분기가 아닌 연결은 모두 병렬이고, 들어오는 연결이 여럿이면 모두 끝나야 진행한다. 순환은 만들 수 없다 — 단, 반복(보완 후 재검토 등)은 「하나만」 분기의 출력에서 앞 단계로 가는 되돌아가기 연결로 만든다: \`{"source":"<분기>","target":"<앞 단계>","sourceHandle":"<반복 출력>","loop":{"max":3,"exit":"<반복을 다 쓰면 갈 같은 분기의 다른 출력>"}}\`. 반복 출력에는 이 연결 하나만 두고, 반복 구간에 워크플로 링크를 두지 않는다. 재검토용 노드를 따로 복제하지 않는다.
- 단계 종류(\`kind\`):
  - \`worker\`: 워커 하나가 지침을 수행. \`description\` 은 그 워커가 이것만 읽고 일할 수 있는 브리프다(목표, 작업 범위, 제약, 완료 조건, 산출물).
  - \`gate\`: 사용자 승인. \`description\` 은 사용자에게 물을 내용. 출력은 통과·거절이고 거절하면 뒤 단계를 모두 건너뛴다. \`asker: "previous"\` 면 앞에 연결된 워커 하나가 자기 터미널에서 묻는다(앞에 워커가 정확히 하나여야 함). 없으면 캔버스에서 묻는다.
  - \`branch\`: 조건에 따라 출력 하나(\`mode: "exclusive"\`) 또는 여럿(\`"inclusive"\`)으로만 진행. \`outputs\` 는 두 개 이상 \`[{"id":"pass","label":"<이 출력을 고르는 조건>"}]\`. \`judge\` 는 \`previous\`(앞의 워커 하나가 판정, 앞에 워커가 정확히 하나여야 함)·\`worker\`(판정 전용 워커)·\`user\`(사용자). 분기에서 나가는 연결에는 \`sourceHandle\` 로 출력 id 를 적는다.
  - \`workflow\`: 저장된 다른 워크플로를 그 자리에 펼쳐 실행. \`workflowId\` 는 아래 목록에서만 고른다. \`linkMode: "start"\` 면 뒤 단계가 기다리지 않는다. \`linkMode: "spawn"\` 이면 펼치지 않고, 앞의 워커 하나가 worker_done 에 \`items: a, b\` 로 보고한 항목마다 대상 워크플로를 따로 실행한다(항목 = 대상의 「실행 시 입력」 워크트리 이름. 대상에 그런 그룹이 정확히 하나 있어야 한다).
  - \`note\`: 실행과 무관한 메모.
- 분기에서 갈라진 경로가 다시 모이는 단계는 \`join: "any"\` 로 둔다(하나라도 오면 진행).
- 워커·판정 워커 단계는 필요할 때만 \`workerModel\`(${workerModels.join(', ')}; 없으면 ${defaultWorkerModel})과 \`effort\`(${effortLevels.join(', ')}; 없으면 모델 기본)를 지정한다. 단순 작업은 가벼운 모델, 설계·검토처럼 깊은 판단은 높은 effort.
- 프로젝트·워크트리 그룹은 만들지 않는다(사용자가 캔버스에서 묶는다). 위치(position)도 쓰지 않는다(캔버스가 배치한다).
- 단계는 요청을 이루는 데 필요한 만큼만. 한 워커가 할 수 있는 일을 쪼개지 않는다.

## 저장된 워크플로 (링크 대상)
${input.saved.length ? input.saved.map((item) => `- \`${item.id}\` ${item.name}`).join('\n') : '- (없음)'}

## 결과 형식
\`\`\`json
{
  "name": "<워크플로 이름>",
  "description": "<한 줄 설명>",
  "nodes": [{ "id": "<영문·숫자·_·- 로 된 고유 id>", "kind": "worker", "label": "<단계 이름>", "description": "<지침>" }],
  "edges": [{ "source": "<id>", "target": "<id>", "sourceHandle": "<분기 출력 id, 분기에서 나갈 때만>", "label": "<선택: 연결 설명>", "loop": { "max": 3, "exit": "<선택: 되돌아가기 연결만>" } }]
}
\`\`\`

${resultFormat(input.resultUrl, input.resultFile)}
`;
}

/** Instructions for one stage, written with the stages around it in view. */
export function briefPrompt(input: { request: string; resultUrl: string; resultFile: string; graph: Workflow; nodeId: string }): string {
  const { graph, nodeId } = input;
  const node = graph.nodes.find((item) => item.id === nodeId)!;
  const executable = graph.nodes.filter(isExecutable);
  const { order } = topologicalOrder(executable.map((item) => item.id), forwardEdges(graph.edges));
  const byId = new Map(graph.nodes.map((item) => [item.id, item]));
  const line = (item: StageNode) => `- ${item.id === nodeId ? '**[이 단계]** ' : ''}${item.data.label || '(이름 없음)'} (${kindNames[item.data.kind]})${item.data.description ? `: ${item.data.description.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
  const before = graph.edges.filter((edge) => edge.target === nodeId).map((edge) => byId.get(edge.source)).filter(Boolean) as StageNode[];
  const after = graph.edges.filter((edge) => edge.source === nodeId).map((edge) => byId.get(edge.target)).filter(Boolean) as StageNode[];
  const role = node.data.kind === 'gate' ? '사용자에게 물을 내용(무엇을 확인하고 어떤 기준으로 통과·거절할지)'
    : node.data.kind === 'branch' ? `판정 지침(무엇을 근거로 출력을 고를지). 출력: ${(node.data.outputs ?? []).map((output) => `${output.id}=${output.label}`).join(', ') || '(없음)'}`
    : node.data.kind === 'workflow' ? '링크한 워크플로에 덧붙일 추가 지침'
    : node.data.kind === 'note' ? '메모 내용'
    : '워커 브리프. 워커가 이것만 읽고 일할 수 있어야 한다: 목표, 작업 범위(건드릴 곳과 건드리지 않을 곳), 제약, 완료 조건, 산출물. 앞 단계 산출물을 쓰면 무엇을 받는지, 뒤 단계가 무엇을 기대하는지도 적는다';
  return `# 단계 지침 자동 생성

너는 workflow-canvas 의 「자연어로 지침 생성」으로 Orca 에서 기동된 에이전트다. 워크플로의 한 단계에 들어갈 지침을 써서 캔버스에 보낸다. 현재 프로젝트(작업 디렉터리)의 코드와 문서를 읽어 지침을 구체적으로 만든다(경로·명령·검증 방법).

## 사용자 요청
${input.request}

## 대상 단계
- 이름: ${node.data.label || '(이름 없음)'} · 종류: ${kindNames[node.data.kind]}
- 쓸 것: ${role}
- 지금 지침: ${node.data.description ? `\n\n${node.data.description}\n` : '(비어 있음)'}

## 워크플로 「${graph.name}」
${graph.description ? `${graph.description}\n\n` : ''}단계(실행 순서):
${order.map((id) => line(byId.get(id)!)).join('\n') || '- (없음)'}

- 바로 앞 단계: ${before.map((item) => item.data.label).join(', ') || '없음'}
- 바로 뒤 단계: ${after.map((item) => item.data.label).join(', ') || '없음'}

## 결과 형식
\`\`\`json
{ "description": "<지침, 20000자 이하>", "label": "<선택: 더 나은 단계 이름, 500자 이하>" }
\`\`\`
코디네이터가 이 지침을 워커 spec 의 Change 로 그대로 쓰고 작업 위치·산출물 경로는 따로 정하므로, 지침에는 일의 내용에 집중한다.

${resultFormat(input.resultUrl, input.resultFile)}
`;
}

/**
 * Turns what the agent sent into a workflow document: known fields only, fresh edge ids, and a left-to-right layout by
 * longest path. Validation (ids, branches, cycles) is left to the caller's validateWorkflow / checkBranches.
 */
export function generatedWorkflow(raw: unknown, id: string): Workflow {
  if (!raw || typeof raw !== 'object') throw new Error('JSON 객체를 보내세요.');
  const body = raw as Record<string, unknown>;
  if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('name 이 필요합니다.');
  if (!Array.isArray(body.nodes) || !body.nodes.length) throw new Error('nodes 에 단계가 하나 이상 필요합니다.');
  if (!Array.isArray(body.edges)) throw new Error('edges 배열이 필요합니다(없으면 []).');
  const str = (value: unknown) => typeof value === 'string' ? value : undefined;
  const nodes: StageNode[] = body.nodes.map((item: Record<string, unknown>, index) => {
    if (!item || typeof item !== 'object') throw new Error(`nodes[${index}] 가 객체가 아닙니다.`);
    const kind = str(item.kind) ?? 'worker';
    if (!(stageKinds as readonly string[]).includes(kind)) throw new Error(`nodes[${index}].kind 는 ${stageKinds.join('·')} 중 하나여야 합니다.`);
    const pick = (keys: string[]) => Object.fromEntries(keys.filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
    const data = { label: str(item.label) ?? '', description: str(item.description) ?? '', kind,
      ...pick(['workerModel', 'effort', 'join']),
      ...(kind === 'branch' ? pick(['mode', 'judge', 'outputs']) : {}),
      ...(kind === 'gate' ? pick(['asker']) : {}),
      ...(kind === 'workflow' ? pick(['workflowId', 'linkMode']) : {}) } as StageNode['data'];
    return { id: String(item.id ?? ''), type: 'stage', position: { x: 0, y: 0 }, data };
  });
  const edges = body.edges.map((item: Record<string, unknown>, index) => {
    if (!item || typeof item !== 'object') throw new Error(`edges[${index}] 가 객체가 아닙니다.`);
    return { id: `e${index + 1}`, source: String(item.source ?? ''), target: String(item.target ?? ''),
      ...(str(item.sourceHandle) ? { sourceHandle: str(item.sourceHandle) } : {}), ...(str(item.label) ? { label: str(item.label) } : {}),
      ...(item.loop && typeof item.loop === 'object' ? { loop: { max: Number((item.loop as Record<string, unknown>).max), exit: String((item.loop as Record<string, unknown>).exit ?? '') } } : {}) };
  });
  // Every edge leaving a gate is its 'approve' output; the canvas draws it from the single port.
  for (const edge of edges) if (nodes.find((node) => node.id === edge.source)?.data.kind === 'gate') delete (edge as { sourceHandle?: string }).sourceHandle;
  const { order } = topologicalOrder(nodes.map((node) => node.id), forwardEdges(edges));
  const wave = waves(order, forwardEdges(edges));
  const rows = new Map<number, number>();
  for (const node of nodes) {
    const column = wave.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    node.position = { x: column * 320, y: row * 190 };
  }
  return { version: 1, id, name: body.name.trim().slice(0, 500), description: (str(body.description) ?? '').slice(0, 10000), runId: '', nodes, edges };
}
