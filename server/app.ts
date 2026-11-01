import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { createOrcaBridge } from './orca.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStorage, validId, validateWorkflow } from './storage.ts';
import { buildBrief, checkBranches, checkGroups, flowOf, linkedWorkflows } from './execute.ts';
import { briefPrompt, generatedWorkflow, generationTimeoutMs, maxPromptLength, workflowPrompt, type Generation } from './generate.ts';
import { coordinatorEventTypes, createRunLog, launchDirName } from './runlog.ts';
import { decisionError, executionResults, executionTasks, loggedExecutions, skippedStages, type RunLogDetail } from '../src/model.ts';
import { defaultCleanup, type AutomationConfig, type AutomationState, type Cleanup, asksAtRun, executionFinished, executionStatuses, isExecutable, worktreeNamePattern, type RunSnapshot, type Workflow } from '../src/model.ts';

/** Minimum gap between two 실행 requests for the same workflow, so a double click cannot start two coordinators. */
const launchCooldownMs = 60_000;

export function createApp(directory: string, bridge = createOrcaBridge(), options: { root?: string; watchMs?: number } = {}) {
  void options; // root is no longer used: every run names its project.
  const launches = new Map<string, number>();
  // Coordinators of parallel executions write the same document; changes to one workflow's executions run one at a time.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(id, run);
    void run.finally(() => { if (queues.get(id) === run) queues.delete(id); }).catch(() => {});
    return run;
  }
  const app = express();
  const storage = createStorage(directory);
  const runlog = createRunLog(join(directory, '.executions'));
  // Background observer: results of open Runs are logged even while no canvas is open.
  if (options.watchMs) runlog.watch((runId) => bridge.snapshot(runId), options.watchMs);
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const host = req.get('host') ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.status(403).json({ error: '로컬 요청만 허용합니다.' }); return; }
    const origin = req.get('origin');
    if ((origin && origin !== `http://${host}`) || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: '같은 출처의 요청만 허용합니다.' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/status', async (_req, res) => { res.json(await bridge.status()); });
  app.get('/api/runs', async (_req, res) => { res.json(await bridge.runs()); });
  app.get('/api/locations', async (_req, res) => { res.json(await bridge.locations()); });
  app.get('/api/runs/:id', async (req, res) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.id)) { res.status(400).json({ error: '올바르지 않은 Run ID입니다.' }); return; }
    const snapshot = await bridge.snapshot(req.params.id);
    // Each poll doubles as the execution log's observer: Task status changes are appended to the launch that registered this Run.
    void runlog.observe(snapshot).catch(() => {});
    res.json(snapshot);
  });
  app.post('/api/runs/:id/tasks/:taskId/open', async (req, res) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.taskId)) {
      res.status(400).json({ error: '올바르지 않은 Run 또는 Task ID입니다.' }); return;
    }
    const result = await bridge.openTask(req.params.id, req.params.taskId);
    res.status(result.opened ? 200 : 409).json(result.opened ? result : { error: result.reason });
  });
  app.get('/api/workflows', async (_req, res) => { res.json(await storage.list()); });
  app.post('/api/validate', (req, res) => {
    try { res.json(validateWorkflow(req.body)); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.get('/api/workflows/:id', async (req, res) => { res.json(await storage.load(req.params.id)); });
  app.put('/api/workflows/:id', async (req, res) => {
    if (req.params.id !== req.body?.id) { res.status(400).json({ error: '워크플로 ID가 일치하지 않습니다.' }); return; }
    let graph;
    try { graph = validateWorkflow(req.body); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    res.json(await storage.save(graph));
  });
  app.delete('/api/workflows/:id', async (req, res) => {
    if (!validId(req.params.id)) { res.status(400).json({ error: '올바르지 않은 워크플로 ID입니다.' }); return; }
    await storage.remove(req.params.id);
    res.json({ deleted: true });
  });
  // Used by the coordinator agent: binds the Run and its executions without rewriting the rest of the document.
  app.put('/api/workflows/:id/executions', async (req, res) => {
    if (!validId(req.params.id)) { res.status(400).json({ error: '올바르지 않은 워크플로 ID입니다.' }); return; }
    const result = await serial(req.params.id, async () => {
      const graph = await storage.load(req.params.id);
      // Re-registering the same Run keeps branch decisions already recorded for an execution.
      const kept = (execution: unknown) => {
        const previous = graph.runId && graph.runId === req.body?.runId && execution && typeof execution === 'object'
          ? graph.executions?.find((item) => item.id === (execution as { id?: unknown }).id) : undefined;
        return previous?.decisions && !(execution as { decisions?: unknown }).decisions
          ? { ...(execution as object), decisions: previous.decisions, skipped: previous.skipped } : execution;
      };
      const executions = Array.isArray(req.body?.executions) ? req.body.executions.map(kept) : req.body?.executions;
      try { return { stored: await storage.save({ ...graph, runId: req.body?.runId, executions }) }; }
      catch (error) { return { error: (error as Error).message }; }
    });
    if ('error' in result) { res.status(400).json({ error: result.error }); return; }
    const { stored } = result;
    if (stored.runId) await runlog.register(stored.id, stored.runId, loggedExecutions(stored.executions ?? [])).catch(() => {});
    res.json(stored);
  });
  // Used by the coordinator agent while it waits: what has been decided (also on the canvas) and which Tasks to close.
  app.get('/api/workflows/:id/executions/:executionId/decisions', async (req, res) => {
    const { id, executionId } = req.params;
    if (!validId(id) || !validId(executionId)) { res.status(400).json({ error: '올바르지 않은 워크플로 또는 실행 ID입니다.' }); return; }
    const execution = (await storage.load(id)).executions?.find((item) => item.id === executionId);
    if (!execution) { res.status(404).json({ error: '이 워크플로에 등록된 실행이 아닙니다.' }); return; }
    res.json({ decisions: execution.decisions ?? {}, skipped: execution.skipped ?? [], skippedTasks: executionTasks(execution, execution.skipped ?? []) });
  });
  // The saved graph as it runs (links expanded): the canvas uses it to find the user decisions that are open now.
  app.get('/api/workflows/:id/flow', async (req, res) => {
    if (!validId(req.params.id)) { res.status(400).json({ error: '올바르지 않은 워크플로 ID입니다.' }); return; }
    const graph = await storage.load(req.params.id);
    try { res.json(flowOf(graph, await linkedWorkflows(graph, (linkId) => storage.load(linkId)))); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  // Used by the coordinator agent (and by the canvas for user decisions): records a decision and returns the Tasks no taken path reaches any more.
  app.post('/api/workflows/:id/executions/:executionId/decisions', async (req, res) => {
    const { id, executionId } = req.params;
    if (!validId(id) || !validId(executionId)) { res.status(400).json({ error: '올바르지 않은 워크플로 또는 실행 ID입니다.' }); return; }
    const node = req.body?.node;
    const outputs = req.body?.outputs;
    // 'user': picked on the canvas's decision card; otherwise reported by the coordinator.
    const byUser = req.body?.by === 'user';
    if (typeof node !== 'string' || !/^[a-zA-Z0-9_.-]{1,400}$/.test(node) || !Array.isArray(outputs) || outputs.some((output) => typeof output !== 'string')) {
      res.status(400).json({ error: '{"node":"<분기 nodeId>","outputs":["<출력 id>"]} 형식이어야 합니다.' }); return;
    }
    const result = await serial(id, async () => {
      const graph = await storage.load(id);
      const execution = graph.executions?.find((item) => item.id === executionId);
      if (!execution) return { status: 404, error: '이 워크플로에 등록된 실행이 아닙니다.' };
      let flow;
      try { flow = flowOf(graph, await linkedWorkflows(graph, (linkId) => storage.load(linkId))); }
      catch (error) { return { status: 400, error: (error as Error).message }; }
      const decisions = execution.decisions ?? {};
      const problem = decisionError(flow, decisions, node, outputs);
      if (problem) return { status: decisions[node] ? 409 : 400, error: problem };
      const updated = { ...execution, decisions: { ...decisions, [node]: outputs }, skipped: skippedStages(flow, { ...decisions, [node]: outputs }) };
      const stored = await storage.save({ ...graph, executions: graph.executions!.map((item) => item.id === executionId ? updated : item) });
      return { status: 200, stored, updated, flow, repeat: !!decisions[node] };
    });
    if (!('stored' in result) || !result.stored) { res.status(result.status).json({ error: result.error }); return; }
    const { stored, updated } = result;
    if (stored.runId) await runlog.register(stored.id, stored.runId, loggedExecutions(stored.executions ?? [])).catch(() => {});
    if (stored.runId && byUser && 'repeat' in result && !result.repeat) {
      const stage = result.flow.find((item) => item.id === node);
      await runlog.appendRun(stored.runId, { type: 'gate', taskId: executionTasks(updated, [node])[0],
        message: `${stage?.label ?? node} ${updated.label}: 캔버스에서 사용자가 ${outputs.map((output: string) => stage?.outputLabels?.[output] ?? output).join(', ')} 선택` }).catch(() => {});
    }
    // Every skipped Task, not only the new ones, so a retried request still tells the coordinator what to close.
    res.json({ decisions: updated.decisions, skipped: updated.skipped, skippedTasks: executionTasks(updated, updated.skipped) });
  });
  type RunSettings = { count: number; project: string; inputs: Record<string, string>; cleanup: Cleanup; automation?: { id: string; name: string } };
  class RunError extends Error { constructor(readonly status: number, message: string) { super(message); } }

  /** Checks a run request against the saved graph and Orca; never trusts a path or name the client sends without checking it. */
  async function settingsFor(graph: Workflow, body: Record<string, unknown>): Promise<RunSettings> {
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new RunError(400, '실행 횟수는 1~20 사이여야 합니다.');
    // The run always names its project; it must be one Orca has open.
    const project = typeof body.project === 'string' ? body.project : '';
    let projects: string[];
    try { projects = (await bridge.locations()).projects.map((item) => item.path); }
    catch { throw new RunError(503, 'Orca 프로젝트 목록을 확인할 수 없습니다.'); }
    if (!projects.includes(project)) throw new RunError(400, '실행할 프로젝트를 Orca에 열린 프로젝트 중에서 고르세요.');
    // Run-time worktree names: only for this workflow's input-mode groups, and only names orca accepts. Empty = ask during the run.
    const rawInputs = body.inputs ?? {};
    const askIds = new Set(graph.nodes.filter(asksAtRun).map((node) => node.id));
    if (typeof rawInputs !== 'object' || Array.isArray(rawInputs)
      || Object.entries(rawInputs).some(([key, value]) => !askIds.has(key) || typeof value !== 'string' || (value !== '' && !worktreeNamePattern.test(value)))) {
      throw new RunError(400, '워크트리 이름은 영문·숫자·. _ - 만 쓸 수 있고 -로 시작할 수 없습니다.');
    }
    const rawCleanup = (body.cleanup ?? graph.cleanup ?? defaultCleanup) as Record<string, unknown>;
    if (!rawCleanup || typeof rawCleanup !== 'object' || (['coordinator', 'worktrees', 'sessions'] as const).some((key) => typeof rawCleanup[key] !== 'boolean')) {
      throw new RunError(400, '완료 시 정리 설정이 올바르지 않습니다.');
    }
    return { count, project, inputs: rawInputs as Record<string, string>,
      cleanup: { coordinator: !!rawCleanup.coordinator, worktrees: !!rawCleanup.worktrees, sessions: !!rawCleanup.sessions } };
  }

  /** Validates the graph, refuses overlapping runs, and writes the coordinator brief. */
  async function prepareRun(id: string, graph: Workflow, settings: RunSettings, apiBase: string): Promise<{ briefPath: string; logId: string }> {
    if (!graph.nodes.some(isExecutable)) throw new RunError(400, '실행할 단계가 없습니다.');
    let linked: Map<string, Workflow>;
    try { linked = await linkedWorkflows(graph, (linkId) => storage.load(linkId)); checkGroups([graph, ...linked.values()]); checkBranches([graph, ...linked.values()]); }
    catch (error) { throw new RunError(400, (error as Error).message); }
    const last = launches.get(id);
    if (last && Date.now() - last < launchCooldownMs) throw new RunError(409, '방금 실행을 요청했습니다. 코디네이터가 실행을 등록할 때까지 잠시 기다리세요.');
    if (graph.runId && graph.executions?.length) {
      let snapshot: RunSnapshot;
      try { snapshot = await bridge.snapshot(graph.runId); }
      catch { throw new RunError(409, '이전 실행 상태를 확인할 수 없습니다. 잠시 뒤 다시 시도하거나 Run 연결을 해제하세요.'); }
      const open = graph.executions.filter((execution) => !executionFinished(executionStatuses(graph.nodes, execution, snapshot, false)));
      if (open.length) throw new RunError(409, `진행 중인 실행 ${open.length}개가 끝난 뒤 다시 실행하세요.`);
    }
    launches.set(id, Date.now());
    try {
      const startedAt = new Date();
      const logId = launchDirName(startedAt, id);
      const artifactDir = join(runlog.root, logId);
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      await runlog.start(logId, { workflowId: id, workflowName: graph.name, startedAt: startedAt.toISOString(), count: settings.count,
        project: settings.project, ...(settings.automation ? { automation: settings.automation } : {}) });
      await runlog.append(logId, { type: 'requested', message: `${settings.automation ? `자동화 「${settings.automation.name}」` : '실행 버튼'} · ${settings.count}회 · ${settings.project}` });
      const briefPath = join(artifactDir, 'brief.md');
      await writeFile(briefPath, buildBrief({ graph, linked, count: settings.count, apiBase, workspace: settings.project, artifactDir,
        logUrl: `${apiBase}/api/workflows/${id}/logs/${logId}/events`,
        inputs: settings.inputs, cleanup: settings.cleanup, automation: settings.automation }), { mode: 0o600 });
      await runlog.append(logId, { type: 'brief', message: '코디네이터 브리프 작성' });
      return { briefPath, logId };
    } catch (error) { launches.delete(id); throw error; }
  }
  function sendRunError(res: express.Response, error: unknown) {
    if (error instanceof RunError) { res.status(error.status).json({ error: error.message }); return true; }
    return false;
  }

  app.post('/api/workflows/:id/execute', async (req, res) => {
    const id = req.params.id;
    if (!validId(id)) { res.status(400).json({ error: '올바르지 않은 워크플로 ID입니다.' }); return; }
    const graph = await storage.load(id);
    try {
      const settings = await settingsFor(graph, req.body ?? {});
      const { briefPath, logId } = await prepareRun(id, graph, settings, `http://${req.get('host')}`);
      try {
        const { terminal } = await bridge.launchCoordinator(settings.project, `${briefPath} 파일의 브리프를 읽고 그대로 수행해줘. 워크플로 "${graph.name}"을(를) ${settings.count}회 실행하는 코디네이터 역할이다.`);
        await runlog.append(logId, { type: 'coordinator', message: `코디네이터 기동${terminal ? ` · ${terminal}` : ''}` }).catch(() => {});
        if (terminal) await bridge.renameTerminal(terminal, `${graph.name} ×${settings.count} · 코디네이터`).catch(() => {});
      } catch (error) {
        launches.delete(id);
        await runlog.append(logId, { type: 'coordinator-failed', message: `코디네이터 기동 실패: ${(error as Error).message}` }).catch(() => {});
        throw error;
      }
      res.json({ launched: true });
    } catch (error) { if (!sendRunError(res, error)) throw error; }
  });

  // Automations: an Orca schedule whose agent asks this server for a fresh brief and then coordinates the run itself.
  app.get('/api/workflows/:id/automations', async (req, res) => {
    if (!validId(req.params.id)) { res.status(400).json({ error: '올바르지 않은 워크플로 ID입니다.' }); return; }
    const graph = await storage.load(req.params.id);
    let states: AutomationState[] = [];
    let reachable = true;
    try { states = await bridge.automations(); } catch { reachable = false; }
    res.json({ reachable, automations: (graph.automations ?? []).map((config) => ({ ...config, state: states.find((item) => item.orcaId === config.orcaId) ?? null })) });
  });
  app.post('/api/workflows/:id/automations', async (req, res) => {
    const id = req.params.id;
    if (!validId(id)) { res.status(400).json({ error: '올바르지 않은 워크플로 ID입니다.' }); return; }
    const graph = await storage.load(id);
    const body = req.body ?? {};
    try {
      const settings = await settingsFor(graph, body);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const config: AutomationConfig = { id: randomUUID(), name, trigger: typeof body.trigger === 'string' ? body.trigger.trim() : '',
        ...(typeof body.time === 'string' && body.time ? { time: body.time } : {}), ...(body.day !== undefined && body.day !== null && body.day !== '' ? { day: Number(body.day) } : {}),
        project: settings.project, count: settings.count, cleanup: settings.cleanup, ...(Object.keys(settings.inputs).length ? { inputs: settings.inputs } : {}) };
      // Validate the whole document with the new entry before anything is created in Orca.
      try { validateWorkflow({ ...graph, automations: [...(graph.automations ?? []), config] }); }
      catch (error) { throw new RunError(400, (error as Error).message); }
      const apiBase = `http://${req.get('host')}`;
      const prompt = `workflow-canvas 자동화 「${name}」 실행이다. 자동화를 설정하거나 조회하지 말고, 다음 명령으로 이번 실행의 브리프를 받아라: `
        + `curl -s -X POST ${apiBase}/api/workflows/${id}/automations/${config.id}/brief `
        + `응답 JSON 의 briefPath 파일을 읽고 그 지시대로 코디네이터로서 끝까지 수행하라. 응답에 error 가 있으면 그 내용을 이 터미널에 보고하고 종료하라.`;
      config.orcaId = await bridge.createAutomation({ name: `${graph.name} · ${name}`.slice(0, 120), trigger: config.trigger, time: config.time, day: config.day, project: config.project, prompt });
      const latest = await storage.load(id);
      res.json(await storage.save({ ...latest, automations: [...(latest.automations ?? []), config] }));
    } catch (error) { if (!sendRunError(res, error)) throw error; }
  });
  app.post('/api/workflows/:id/automations/:aid/run', async (req, res) => {
    if (!validId(req.params.id) || !validId(req.params.aid)) { res.status(400).json({ error: '올바르지 않은 ID입니다.' }); return; }
    const config = (await storage.load(req.params.id)).automations?.find((item) => item.id === req.params.aid);
    if (!config?.orcaId) { res.status(404).json({ error: '자동화를 찾을 수 없습니다.' }); return; }
    await bridge.runAutomation(config.orcaId);
    res.json({ started: true });
  });
  app.delete('/api/workflows/:id/automations/:aid', async (req, res) => {
    if (!validId(req.params.id) || !validId(req.params.aid)) { res.status(400).json({ error: '올바르지 않은 ID입니다.' }); return; }
    const graph = await storage.load(req.params.id);
    const config = graph.automations?.find((item) => item.id === req.params.aid);
    if (!config) { res.status(404).json({ error: '자동화를 찾을 수 없습니다.' }); return; }
    if (config.orcaId) {
      const exists = (await bridge.automations()).some((item) => item.orcaId === config.orcaId);
      if (exists) await bridge.removeAutomation(config.orcaId);
    }
    res.json(await storage.save({ ...graph, automations: graph.automations!.filter((item) => item.id !== config.id) }));
  });
  // Called by the automation's agent when Orca fires it: returns a fresh brief built from the saved settings.
  app.post('/api/workflows/:id/automations/:aid/brief', async (req, res) => {
    if (!validId(req.params.id) || !validId(req.params.aid)) { res.status(400).json({ error: '올바르지 않은 ID입니다.' }); return; }
    const graph = await storage.load(req.params.id);
    const config = graph.automations?.find((item) => item.id === req.params.aid);
    if (!config) { res.status(404).json({ error: '이 워크플로에 등록된 자동화가 아닙니다.' }); return; }
    try {
      const settings = await settingsFor(graph, { count: config.count, project: config.project, inputs: config.inputs ?? {}, cleanup: config.cleanup });
      const { briefPath, logId } = await prepareRun(graph.id, graph, { ...settings, automation: { id: config.id, name: config.name } }, `http://${req.get('host')}`);
      await runlog.append(logId, { type: 'coordinator', message: '자동화 에이전트가 브리프를 받아 코디네이터로 시작' }).catch(() => {});
      res.json({ briefPath });
    } catch (error) { if (!sendRunError(res, error)) throw error; }
  });
  /** Launches from before execution logs existed get the workflow's current Run, so their results show too. */
  async function adoptCurrentRun(id: string) {
    if (!validId(id)) return;
    try {
      const graph = await storage.load(id);
      if (graph.runId && graph.executions?.length) await runlog.adopt(id, graph.name, graph.runId, loggedExecutions(graph.executions));
    } catch { /* a missing workflow still lists its logs */ }
  }
  // Execution logs: one per 실행 request (button or automation), newest first.
  app.get('/api/workflows/:id/logs', async (req, res) => {
    if (!validId(req.params.id)) { res.status(400).json({ error: '올바르지 않은 워크플로 ID입니다.' }); return; }
    await adoptCurrentRun(req.params.id);
    res.json(await runlog.list(req.params.id));
  });
  app.get('/api/workflows/:id/logs/:logId', async (req, res) => {
    await adoptCurrentRun(req.params.id);
    const detail = await runlog.detail(req.params.id, req.params.logId);
    let results: RunLogDetail['results'] = null;
    let resultsError: string | undefined;
    // Final (or current) state of every execution, straight from Orca, so finished executions show their results.
    if (detail.meta.runId && detail.meta.executions?.length) {
      try {
        const snapshot = await bridge.snapshot(detail.meta.runId);
        await runlog.observe(snapshot).catch(() => {});
        results = executionResults(detail.meta.executions, snapshot);
      } catch { resultsError = 'Orca에서 이 Run을 조회하지 못했습니다.'; }
    }
    const fresh = results ? await runlog.detail(req.params.id, req.params.logId) : detail;
    res.json({ ...fresh, results, ...(resultsError ? { resultsError } : {}) } satisfies RunLogDetail);
  });
  app.get('/api/workflows/:id/logs/:logId/files/:name', async (req, res) => { res.json(await runlog.file(req.params.id, req.params.logId, req.params.name)); });
  // Used by the coordinator agent to record gate decisions, worker results and errors.
  app.post('/api/workflows/:id/logs/:logId/events', async (req, res) => {
    const { id, logId } = req.params;
    if (!runlog.validLaunch(id, logId)) { res.status(400).json({ error: '올바르지 않은 실행 로그 ID입니다.' }); return; }
    const body = req.body ?? {};
    const message = typeof body.message === 'string' ? body.message.replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim() : '';
    if (!(coordinatorEventTypes as readonly string[]).includes(body.type) || !message || message.length > 2000
      || (body.taskId !== undefined && (typeof body.taskId !== 'string' || !validId(body.taskId)))) {
      res.status(400).json({ error: `type 은 ${coordinatorEventTypes.join('·')} 중 하나, message 는 1~2000자여야 합니다.` }); return;
    }
    await runlog.detail(id, logId); // the launch must exist
    await runlog.append(logId, { type: body.type, message, ...(body.taskId ? { taskId: body.taskId } : {}) });
    res.json({ logged: true });
  });
  // Natural-language generation (workflow or one stage's instructions), done by an agent Orca launches.
  const generations = new Map<string, Generation>();
  const view = (item: Generation): Generation => item.status === 'pending' && Date.now() - item.createdAt > generationTimeoutMs
    ? { ...item, status: 'failed', error: '생성 에이전트가 시간 안에 결과를 보내지 않았습니다.' } : item;
  app.post('/api/generations', async (req, res) => {
    const body = req.body ?? {};
    const kind = body.kind;
    const request = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (kind !== 'workflow' && kind !== 'brief') { res.status(400).json({ error: 'kind 는 workflow 또는 brief 여야 합니다.' }); return; }
    if (!request || request.length > maxPromptLength) { res.status(400).json({ error: `요청을 1~${maxPromptLength}자로 적으세요.` }); return; }
    if ([...generations.values()].filter((item) => view(item).status === 'pending').length >= 5) {
      res.status(429).json({ error: '생성 중인 요청이 많습니다. 끝난 뒤 다시 시도하세요.' }); return;
    }
    // The agent works in a project Orca has open (it may read it for context); never a path the client made up.
    const project = typeof body.project === 'string' ? body.project : '';
    let projects: string[];
    try { projects = (await bridge.locations()).projects.map((item) => item.path); }
    catch { res.status(503).json({ error: 'Orca 프로젝트 목록을 확인할 수 없습니다.' }); return; }
    if (!projects.includes(project)) { res.status(400).json({ error: '생성 에이전트가 작업할 프로젝트를 Orca에 열린 프로젝트 중에서 고르세요.' }); return; }
    let graph: Workflow | undefined;
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : '';
    if (kind === 'brief') {
      // The canvas's current (possibly unsaved) graph gives the stage its context.
      try { graph = validateWorkflow(body.workflow); } catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
      if (!graph.nodes.some((node) => node.id === nodeId && node.type === 'stage')) { res.status(400).json({ error: '지침을 만들 단계를 찾지 못했습니다.' }); return; }
    }
    const id = randomUUID();
    const dir = join(directory, '.generations', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const apiBase = `http://${req.get('host')}`;
    const resultUrl = `${apiBase}/api/generations/${id}`;
    const resultFile = join(dir, 'result.json');
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, kind === 'workflow'
      ? workflowPrompt({ request, resultUrl, resultFile, saved: await storage.list() })
      : briefPrompt({ request, resultUrl, resultFile, graph: graph!, nodeId }), { mode: 0o600 });
    const item: Generation = { id, kind, status: 'pending', createdAt: Date.now(), project, ...(kind === 'brief' ? { nodeId } : {}) };
    generations.set(id, item);
    try {
      const { terminal } = await bridge.launchGenerator(project, `${promptPath} 파일을 읽고 그대로 수행해줘. ${kind === 'workflow' ? '자연어 요청으로 워크플로를 만드는' : '워크플로 단계의 지침을 쓰는'} 역할이다.`);
      const label = kind === 'brief' ? graph!.nodes.find((node) => node.id === nodeId)?.data.label : '';
      if (terminal) await bridge.renameTerminal(terminal, kind === 'workflow' ? '워크플로 생성' : `지침 생성 · ${label || '단계'}`).catch(() => {});
    } catch (error) {
      generations.delete(id);
      res.status(503).json({ error: `생성 에이전트를 띄우지 못했습니다: ${(error as Error).message}` }); return;
    }
    res.json(item);
  });
  app.get('/api/generations/:id', (req, res) => {
    const item = generations.get(req.params.id);
    if (!item) { res.status(404).json({ error: '생성 요청을 찾을 수 없습니다(서버가 다시 시작되었을 수 있습니다).' }); return; }
    res.json(view(item));
  });
  // Used by the generation agent: its result, validated here; a 400 tells it what to fix.
  app.put('/api/generations/:id', async (req, res) => {
    const item = generations.get(req.params.id);
    if (!item) { res.status(404).json({ error: '생성 요청을 찾을 수 없습니다.' }); return; }
    if (view(item).status !== 'pending') { res.status(409).json({ error: '이미 끝난 생성 요청입니다.' }); return; }
    const body = req.body ?? {};
    if (typeof body.error === 'string' && Object.keys(body).length === 1) {
      generations.set(item.id, { ...item, status: 'failed', error: body.error.slice(0, 2000) || '에이전트가 만들지 못했습니다.' });
      res.json({ recorded: true }); return;
    }
    try {
      if (item.kind === 'brief') {
        if (typeof body.description !== 'string' || !body.description.trim() || body.description.length > 20000) throw new Error('description 은 1~20000자 문자열이어야 합니다.');
        if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 500)) throw new Error('label 은 500자 이하 문자열이어야 합니다.');
        generations.set(item.id, { ...item, status: 'done', description: body.description, ...(body.label?.trim() ? { label: body.label.trim() } : {}) });
      } else {
        const graph = validateWorkflow(generatedWorkflow(body, randomUUID()));
        if (!graph.nodes.some(isExecutable)) throw new Error('실행할 단계(worker·gate·branch·workflow)가 하나 이상 필요합니다.');
        const linked = await linkedWorkflows(graph, (linkId) => storage.load(linkId));
        checkBranches([graph, ...linked.values()]);
        await storage.save(graph);
        generations.set(item.id, { ...item, status: 'done', workflowId: graph.id });
      }
      res.json({ accepted: true });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API를 찾을 수 없습니다.' }); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const code = (error as NodeJS.ErrnoException).code;
    const status = code === 'ENOENT' ? 404 : (error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400
      : typeof error.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 503);
    const message = error instanceof Error && !code ? error.message : '요청을 처리할 수 없습니다.';
    res.status(status).json({ error: message });
  };
  app.use(errors);
  return app;
}
