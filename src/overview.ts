import { calculate } from './core.ts';
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

const priority = ['blocked', 'failed', 'running', 'unknown', 'pending', 'unbound', 'completed', 'skipped'];
export function overviewWorkflows(entries: OverviewEntry[]): WorkflowOverview[] {
  return calculate<WorkflowOverview[]>('overviewWorkflows', [entries]).sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status) || a.workflow.name.localeCompare(b.workflow.name, 'ko'));
}
export function overviewExecutions(graph: Workflow): Execution[] { return calculate('overviewExecutions', [graph]); }
export function overviewEntries(graphs: Workflow[], observations: Record<string, RunObservation>): OverviewEntry[] {
  return calculate<OverviewEntry[]>('overviewEntries', [graphs, observations]).sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status) || a.workflow.name.localeCompare(b.workflow.name, 'ko') || a.execution.label.localeCompare(b.execution.label, 'ko'));
}
export function withoutUnknown(entry: WorkflowOverview): WorkflowOverview { return calculate('withoutUnknown', [entry]); }
