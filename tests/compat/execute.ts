import { calculate } from '../../src/core.ts';
import { compute } from './native.ts';
import type { Workflow, FlowStage, Cleanup } from '../../src/model.ts';
export type BriefInput = {
  graph: Workflow;
  /** The coordinator was started inside this group's worktree, prepared by the server (absent: it starts in the project). */
  preparedGroup?: string;
  /** Saved workflows reachable through workflow-link nodes, by id. */
  linked?: Map<string, Workflow>;
  count: number;
  /** The request's name (실행 이름): executions are labelled with it (`executionLabel`). Absent: plain `#<n>`. */
  title?: string;
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
export const maxLinkDepth = 3;
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
export type InstructionFile = { path: string; content: string };
export function checkGroups(workflows: Workflow[]) { calculate("checkGroups", [workflows]); }
export function checkSpawns(workflows: Workflow[], linked: Map<string, Workflow>) { calculate("checkSpawns", [workflows, Object.fromEntries(linked)]); }
export function checkLoops(workflows: Workflow[], linked: Map<string, Workflow>) { calculate("checkLoops", [workflows, Object.fromEntries(linked)]); }
export function checkVariables(workflows: Workflow[]) { calculate("checkVariables", [workflows]); }
export function checkCoordinatorGroup(workflow: Workflow) { calculate("checkCoordinatorGroup", [workflow]); }
export function checkBranches(workflows: Workflow[]) { calculate("checkBranches", [workflows]); }
export function checkScripts(workflows: Workflow[]) { calculate("checkScripts", [workflows]); }
export function checkSessions(workflows: Workflow[]) { calculate("checkSessions", [workflows]); }
export function flowOf(graph: Workflow, linked: Map<string, Workflow>): FlowStage[] { return calculate('flowOf', [graph, Object.fromEntries(linked)]); }
export function composeBrief(input: BriefInput): { brief: string; files: InstructionFile[] } { return compute('composeBrief', [{ ...input, linked: Object.fromEntries(input.linked ?? []) }]); }
export function buildBrief(input: BriefInput): string { return composeBrief(input).brief; }
export async function preflight(graph: Workflow, load: (id: string) => Promise<Workflow>): Promise<PreflightReport> {
  let linked = new Map<string, Workflow>(), error: string | undefined;
  try { linked = await linkedWorkflows(graph, load); } catch (e) { error = (e as Error).message; }
  return compute('preflight', [graph, Object.fromEntries(linked), error]);
}
