import {
  aggregateStatus, executionFinished, executionRun, isExecutable, nodeExecutionStatus, stageRound, tallyStatuses,
  type Execution, type RunSnapshot, type StageNode, type StageStatus, type Workflow,
} from './model.ts';

export type RunObservation = { snapshot: RunSnapshot | null; error?: string };
export type OverviewData = { graphs: Workflow[]; observations: Record<string, RunObservation>; settled: string[] };
export type OverviewStage = { node: StageNode; status: StageStatus; round: number };
export type OverviewEntry = {
  workflow: Workflow; execution: Execution; runId: string; stages: OverviewStage[];
  status: StageStatus; done: number; observedAt?: string; error?: string;
};
export type WorkflowOverviewStage = OverviewStage & { tally: { status: StageStatus; count: number }[] };
export type WorkflowOverview = {
  workflow: Workflow; executionCount: number; stages: WorkflowOverviewStage[]; status: StageStatus; done: number;
  tally: { status: StageStatus; count: number }[]; decisions: Record<string, string[]>; observedAt?: string; error?: string;
};

/** One graph per workflow, with every open execution contributing counts to the same nodes. */
export function overviewWorkflows(entries: OverviewEntry[]): WorkflowOverview[] {
  const groups = new Map<string, OverviewEntry[]>();
  for (const entry of entries) groups.set(entry.workflow.id, [...(groups.get(entry.workflow.id) ?? []), entry]);
  return [...groups.values()].map((items): WorkflowOverview => {
    const workflow = items[0].workflow;
    const stages = workflow.nodes.filter(isExecutable).map((node) => {
      const samples = items.flatMap((item) => item.stages.filter((stage) => stage.node.id === node.id));
      const statuses = samples.map((stage) => stage.status);
      return { node, status: aggregateStatus(statuses), round: Math.max(1, ...samples.map((stage) => stage.round)), tally: tallyStatuses(statuses) };
    });
    const tally = tallyStatuses(items.flatMap((item) => item.stages.map((stage) => stage.status)));
    const status = (['failed', 'blocked', 'running', 'unknown', 'pending', 'unbound'] as StageStatus[]).find((value) => tally.some((item) => item.status === value)) ?? 'completed';
    const decisions: Record<string, string[]> = {};
    for (const { node } of stages) if (items.every((item) => item.execution.decisions?.[node.id])) {
      decisions[node.id] = [...new Set(items.flatMap((item) => item.execution.decisions![node.id]))];
    }
    const errors = [...new Set(items.flatMap((item) => item.error ? [item.error] : []))];
    return { workflow, executionCount: items.length, stages, status, tally, decisions,
      done: stages.filter((stage) => stage.status === 'completed' || stage.status === 'skipped').length,
      observedAt: items.flatMap((item) => item.observedAt ? [item.observedAt] : []).sort().at(-1),
      ...(errors.length ? { error: `일부 실행 상태 미확인 · ${errors.join(' · ')}` } : {}) };
  }).sort((a, b) => ['blocked', 'failed', 'running', 'unknown', 'pending', 'unbound', 'completed'].indexOf(a.status)
    - ['blocked', 'failed', 'running', 'unknown', 'pending', 'unbound', 'completed'].indexOf(b.status) || a.workflow.name.localeCompare(b.workflow.name, 'ko'));
}

/** Older documents can observe a Run through node bindings without registered executions. */
export function overviewExecutions(graph: Workflow): Execution[] {
  if (graph.executions?.length) return graph.executions;
  const bindings = Object.fromEntries(graph.nodes.filter(isExecutable).flatMap((node) => node.data.taskId ? [[node.id, node.data.taskId]] : []));
  return graph.runId && Object.keys(bindings).length ? [{ id: '', label: '연결된 Run', bindings }] : [];
}

/** Keep Run observations separate: a failed read must never invalidate a different Run's stages. */
export function overviewEntries(graphs: Workflow[], observations: Record<string, RunObservation>): OverviewEntry[] {
  const entries: OverviewEntry[] = [];
  for (const workflow of graphs) for (const execution of overviewExecutions(workflow)) {
    const runId = executionRun(workflow, execution);
    if (!runId) continue;
    const observation = observations[runId];
    const stages = workflow.nodes.filter(isExecutable).map((node) => ({ node,
      status: nodeExecutionStatus(node, execution, observation?.snapshot ?? null, !!observation?.error),
      round: stageRound(execution, node.id) }));
    const statuses = stages.map((stage) => stage.status);
    if (!stages.length || executionFinished(statuses)) continue;
    entries.push({ workflow, execution, runId, stages, status: aggregateStatus(statuses),
      done: statuses.filter((status) => status === 'completed' || status === 'skipped').length,
      observedAt: observation?.snapshot?.observedAt, error: observation?.error });
  }
  const priority: StageStatus[] = ['blocked', 'failed', 'running', 'unknown', 'pending', 'unbound', 'completed', 'skipped'];
  return entries.sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status)
    || a.workflow.name.localeCompare(b.workflow.name, 'ko') || a.execution.label.localeCompare(b.execution.label, 'ko'));
}

/** The overview does not show 상태 미확인: an unreadable Run drops out of the counts instead of being reported. */
export function withoutUnknown(entry: WorkflowOverview): WorkflowOverview {
  const known = (tally: WorkflowOverview['tally']) => tally.filter((item) => item.status !== 'unknown');
  const tally = known(entry.tally);
  const status = entry.status !== 'unknown' ? entry.status
    : (['failed', 'blocked', 'running', 'pending', 'unbound'] as StageStatus[]).find((value) => tally.some((item) => item.status === value)) ?? 'pending';
  const { error: _error, ...rest } = entry;
  return { ...rest, status, tally, stages: entry.stages.map((stage) => ({ ...stage, tally: known(stage.tally) })) };
}
