import type { Edge, Node } from '@xyflow/react';

export type StageStatus = 'unbound' | 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'unknown';
export type StageKind = 'task' | 'gate' | 'note';
export type StageData = {
  label: string;
  description: string;
  kind: StageKind;
  taskId?: string;
  status?: StageStatus;
  agent?: string;
  model?: string;
  detail?: string;
};
export type StageNode = Node<StageData, 'stage'>;
export type Workflow = {
  version: 1;
  id: string;
  name: string;
  description: string;
  runId: string;
  nodes: StageNode[];
  edges: Edge[];
};
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
};
export type RunSnapshot = {
  run: RunSummary;
  tasks: TaskSummary[];
  workers: WorkerSummary[];
  observedAt: string;
};

export const statusLabels: Record<StageStatus, string> = {
  unbound: '미연결', pending: '대기', running: '실행 중', blocked: '확인 필요',
  completed: '완료', failed: '실패', unknown: '상태 미확인',
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

export function projectNodes(nodes: StageNode[], snapshot: RunSnapshot | null, stale: boolean): StageNode[] {
  return nodes.map((node) => {
    const task = snapshot?.tasks.find((item) => item.id === node.data.taskId);
    const worker = snapshot?.workers.find((item) => item.taskId === node.data.taskId);
    return { ...node, data: { ...node.data,
      status: !node.data.taskId ? 'unbound' : stale ? 'unknown' : taskStatus(task, snapshot?.workers ?? []),
      agent: worker?.provider,
      model: worker?.model,
      detail: stale ? 'Orca 상태를 새로 확인할 수 없습니다.' : task?.status,
    } };
  });
}

export function serializableWorkflow(workflow: Workflow): Workflow {
  return { ...workflow, nodes: workflow.nodes.map((node) => ({
    id: node.id, type: 'stage', position: node.position,
    data: { label: node.data.label, description: node.data.description, kind: node.data.kind, taskId: node.data.taskId },
  })), edges: workflow.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.label })) };
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
      data: { label: task.title || task.spec.slice(0, 60), description: task.spec, taskId: task.id, kind: 'task' } };
  });
  return { name: snapshot.run.objective, runId: snapshot.run.id, nodes,
    edges: snapshot.tasks.flatMap((task) => task.deps.filter((dep) => tasks.has(dep)).map((dep) => ({
      id: `${dep}-${task.id}`, source: dep, target: task.id,
    }))) };
}

export function newWorkflow(): Workflow {
  const nodes: StageNode[] = [
    { id: 'brief', type: 'stage', position: { x: 0, y: 140 }, data: { label: '요구사항 정리', description: '목표와 완료 조건을 정의합니다.', kind: 'task' } },
    { id: 'design', type: 'stage', position: { x: 320, y: 140 }, data: { label: '설계', description: '작업 경계와 인터페이스를 정합니다.', kind: 'task' } },
    { id: 'backend', type: 'stage', position: { x: 640, y: 30 }, data: { label: '백엔드 구현', description: 'API와 데이터 계약을 구현합니다.', kind: 'task' } },
    { id: 'frontend', type: 'stage', position: { x: 640, y: 270 }, data: { label: '프론트엔드 구현', description: '사용자 화면과 상호작용을 구현합니다.', kind: 'task' } },
    { id: 'review', type: 'stage', position: { x: 960, y: 140 }, data: { label: '통합 검증', description: '산출물과 완료 증거를 확인합니다.', kind: 'task' } },
    { id: 'approve', type: 'stage', position: { x: 1280, y: 140 }, data: { label: '사용자 검토', description: '최종 결과를 검토합니다.', kind: 'gate' } },
  ];
  return { version: 1, id: crypto.randomUUID(), name: '개발 워크플로', description: '설계부터 검증까지, 작업의 흐름을 한눈에.', runId: '', nodes,
    edges: [['brief', 'design'], ['design', 'backend'], ['design', 'frontend'], ['backend', 'review'], ['frontend', 'review'], ['review', 'approve']]
      .map(([source, target]) => ({ id: `${source}-${target}`, source, target })) };
}
