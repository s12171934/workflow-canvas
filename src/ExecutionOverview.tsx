import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowUpRight, Bot, Check, ChevronRight, CircleHelp, LayoutDashboard, LoaderCircle, RefreshCw, Search, Split, SquareTerminal, Workflow as WorkflowIcon } from 'lucide-react';
import { layered, layoutGap } from './layout';
import { roundedPath, routeEdge, routeGap } from './routing';
import { executionRun, kindNames, statusLabels, type RunSnapshot, type Workflow } from './model';
import { overviewEntries, overviewExecutions, overviewWorkflows, withoutUnknown, type OverviewData, type OverviewEntry, type RunObservation, type WorkflowOverview } from './overview';

async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '실행 정보를 불러오지 못했습니다.');
  return result;
}
/** Bound concurrent Orca reads even with many workflows; every snapshot request can start CLI processes. */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    for (let at = cursor++; at < items.length; at = cursor++) results[at] = await fn(items[at]);
  }));
  return results;
}
const openKey = 'workflow-canvas.overview.open';
type OpenExecution = (workflowId: string, executionId: string, nodeId?: string) => Promise<void>;

/** Overview nodes are narrower and sit closer than on the canvas, so the graph fits a card without scrolling. */
const width = 132, height = 48, padding = 10;
/** Wide enough for an edge's stubs and padding (routeGap) to turn between two columns. */
const columnSqueeze = (width + 2 * (routeGap.stub + routeGap.pad) + 8) / (width + layoutGap.column);
/** Below this the labels stop being readable; the graph scrolls instead of shrinking further. */
const minScale = 0.66;

function ExecutionGraph({ entry, onOpen, full, onToggle }: { entry: WorkflowOverview; onOpen: OpenExecution; full: boolean; onToggle: () => void }) {
  const marker = useId().replace(/:/g, '');
  const viewport = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth));
    observer.observe(element);
    setAvailable(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const active = entry.stages.filter((stage) => stage.tally.some((item) => ['running', 'blocked', 'failed'].includes(item.status)));
  const unknown = entry.stages.filter((stage) => stage.status === 'unknown');
  const focus = active.length ? active : unknown.length ? unknown : entry.stages.filter((stage) => stage.status === 'pending' && !entry.workflow.edges.some((edge) => !edge.loop && edge.target === stage.node.id
    && entry.stages.some((before) => before.node.id === edge.source && !['completed', 'skipped'].includes(before.status))));
  const focusKey = focus.map((stage) => stage.node.id).join(',');
  const layout = useMemo(() => {
    const context = new Set(focus.map((stage) => stage.node.id));
    for (const edge of entry.workflow.edges) if (!edge.loop && focus.some((stage) => stage.node.id === edge.source || stage.node.id === edge.target)) {
      context.add(edge.source); context.add(edge.target);
    }
    const stages = full || !context.size ? entry.stages : entry.stages.filter((stage) => context.has(stage.node.id));
    const ids = new Set(stages.map((stage) => stage.node.id));
    const edges = entry.workflow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    const placed = layered(stages.map((stage) => ({ id: stage.node.id, width, height })), edges.filter((edge) => !edge.loop));
    const squeezed = new Map([...placed.positions].map(([id, point]) => [id, { x: Math.round(point.x * columnSqueeze), y: point.y }]));
    // Edges go around the nodes they do not join (the canvas's own router): horizontal and vertical runs with square
    // corners only (radius 0). A detour may leave the nodes' box, so the box grows to hold it.
    const rects = [...squeezed].map(([id, point]) => ({ id, x: point.x, y: point.y, width, height }));
    const routed = edges.map((edge) => {
      const from = squeezed.get(edge.source)!, to = squeezed.get(edge.target)!;
      // Its own two nodes count too: a loop edge must come round the target to enter it from the left, not through it.
      return routeEdge({ x: from.x + width, y: from.y + height / 2 }, { x: to.x, y: to.y + height / 2 }, rects);
    });
    const xs = [...rects.flatMap((rect) => [rect.x, rect.x + width]), ...routed.flat().map((point) => point.x)];
    const ys = [...rects.flatMap((rect) => [rect.y, rect.y + height]), ...routed.flat().map((point) => point.y)];
    const left = xs.length ? Math.min(...xs) : 0, top = ys.length ? Math.min(...ys) : 0;
    const positions = new Map([...squeezed].map(([id, point]) => [id, { x: point.x - left, y: point.y - top }]));
    const routes = new Map(edges.map((edge, at) => [edge.id, roundedPath(routed[at].map((point) => ({ x: point.x - left + padding, y: point.y - top + padding })), 0)]));
    return { edges, stages, positions, routes, size: { width: xs.length ? Math.max(...xs) - left : 0, height: ys.length ? Math.max(...ys) - top : 0 } };
  }, [entry.workflow, entry.stages, full, focusKey]);
  const natural = { width: layout.size.width + padding * 2, height: layout.size.height + padding * 2 };
  const scale = available ? Math.min(1, Math.max(minScale, available / natural.width)) : 1;
  useLayoutEffect(() => {
    const point = layout.positions.get(focus[0]?.node.id);
    if (point && viewport.current) {
      viewport.current.scrollLeft = (point.x + width / 2 + padding) * scale - viewport.current.clientWidth / 2;
      viewport.current.scrollTop = (point.y + height / 2 + padding) * scale - viewport.current.clientHeight / 2;
    }
  }, [focusKey, full, scale]);
  return <><div className="overview-graph-label"><span>{full ? '전체 단계' : '현재 단계 주변'} · {layout.stages.length} / {entry.stages.length}</span><button onClick={onToggle} aria-pressed={full}>{full ? '주변만 보기' : '전체 단계 보기'}</button></div>
  <div ref={viewport} className="overview-graph" role="region" aria-label={`${entry.workflow.name} 단계 그래프`} tabIndex={0}>
    <div className="overview-graph-fit" style={{ width: Math.floor(natural.width * scale), height: Math.floor(natural.height * scale) }}>
    <div className="overview-graph-inner" style={{ width: natural.width, height: natural.height, transform: scale < 1 ? `scale(${scale})` : undefined }}>
      <svg className="overview-connections" width="100%" height="100%" aria-hidden="true">
        <defs><marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L8 4L0 8" fill="currentColor" /></marker></defs>
        {layout.edges.map((edge) => {
          const source = entry.stages.find((stage) => stage.node.id === edge.source)!;
          const skipped = entry.stages.find((stage) => stage.node.id === edge.target)?.status === 'skipped'
            || (!!edge.sourceHandle && !!entry.decisions[edge.source] && !entry.decisions[edge.source].includes(edge.sourceHandle));
          const label = source.node.data.outputs?.find((output) => output.id === edge.sourceHandle)?.label;
          return <path key={edge.id} className={`${edge.loop ? 'loop' : ''} ${skipped ? 'skipped' : ''}`} d={layout.routes.get(edge.id)} markerEnd={`url(#${marker})`}><title>{edge.loop ? '되돌아가기 · ' : ''}{label || String(edge.label ?? '')}</title></path>;
        })}
      </svg>
      {layout.stages.map(({ node, status, tally }) => {
        const point = layout.positions.get(node.id)!;
        const visibleStatus = (['failed', 'blocked', 'running'] as const).find((value) => tally.some((item) => item.status === value)) ?? (status === 'unknown' ? 'pending' : status);
        const counts = tally.map((item) => `${statusLabels[item.status]} ${item.count}`).join(' · ');
        const Icon = node.data.kind === 'gate' ? CircleHelp : node.data.kind === 'branch' ? Split : node.data.kind === 'workflow' ? WorkflowIcon : node.data.kind === 'script' ? SquareTerminal : Bot;
        return <button key={node.id} className={`overview-node ${visibleStatus}`} style={{ left: point.x + padding, top: point.y + padding, width, height }}
          title={`${node.data.label} · ${kindNames[node.data.kind]} · ${counts} · 캔버스에서 열기`}
          onClick={() => void onOpen(entry.workflow.id, 'all', node.id)}>
          <span className="overview-node-name"><Icon size={13} /><strong>{node.data.label || '이름 없는 단계'}</strong></span>
          <span className="overview-node-status" title={counts}><i className={`status-dot ${visibleStatus}`} />{tally.slice(0, 2).map((item) => `${statusLabels[item.status]} ${item.count}`).join(' · ')}{tally.length > 2 && ` +${tally.length - 2}`}</span>
        </button>;
      })}
    </div>
    </div>
  </div></>;
}

/** A separate view over saved workflows; opening it leaves the editor and its unsaved changes mounted. */
export function ExecutionOverview({ onClose, onOpen }: { onClose: () => void; onOpen: OpenExecution }) {
  const [entries, setEntries] = useState<OverviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState('');
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  /** Cards start folded to one line; the ones a viewer opened stay open in this browser. */
  const [open, setOpen] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(openKey) ?? '[]')); } catch { return new Set(); } });
  const [full, setFull] = useState<Set<string>>(new Set());
  const flip = (set: Set<string>, id: string) => { const next = new Set(set); if (!next.delete(id)) next.add(id); return next; };
  useEffect(() => { try { localStorage.setItem(openKey, JSON.stringify([...open])); } catch { /* storage unavailable */ } }, [open]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let graphs: Workflow[] = [];
    const observations: Record<string, RunObservation> = {};
    const settled = new Map<string, string>();
    let loggedSettled = new Set<string>();
    async function refresh() {
      if (document.hidden) { timer = setTimeout(refresh, 10000); return; }
      setLoading(true);
      try {
        const data = await get<OverviewData>('/api/executions/overview', controller.signal);
        if (controller.signal.aborted) return;
        graphs = data.graphs;
        Object.assign(observations, data.observations);
        setEntries(overviewEntries(graphs, observations));
        loggedSettled = new Set(data.settled);
        const signatures = new Map<string, string[]>();
        for (const graph of graphs) for (const execution of overviewExecutions(graph)) {
          const id = executionRun(graph, execution);
          if (id) signatures.set(id, [...(signatures.get(id) ?? []), JSON.stringify([graph.id, graph.nodes.map((node) => [node.id, node.data.kind]), execution])]);
        }
        await mapLimited([...signatures], async ([id, parts]) => {
          const signature = JSON.stringify(parts);
          if (loggedSettled.has(id) || settled.get(id) === signature) return;
          try {
            const snapshot = await get<RunSnapshot>(`/api/runs/${encodeURIComponent(id)}`, controller.signal);
            observations[id] = { snapshot };
            if (!overviewEntries(graphs, { [id]: observations[id] }).some((entry) => entry.runId === id)) settled.set(id, signature);
          } catch (failure) { observations[id] = { snapshot: observations[id]?.snapshot ?? null, error: (failure as Error).message }; }
          if (!controller.signal.aborted) setEntries(overviewEntries(graphs, observations));
        });
        if (controller.signal.aborted) return;
        setEntries(overviewEntries(graphs, observations));
        setUpdated(new Date().toLocaleTimeString('ko-KR', { hour12: false }));
        setError('');
      } catch (failure) {
        if (!controller.signal.aborted) {
          const message = (failure as Error).message;
          for (const [id, observation] of Object.entries(observations)) if (!loggedSettled.has(id) && !settled.has(id)) observation.error = message;
          setEntries(overviewEntries(graphs, observations));
          setError(message);
        }
      }
      if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(refresh, 10000); }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tick]);

  const workflows = useMemo(() => overviewWorkflows(entries).map(withoutUnknown), [entries]);
  const has = (entry: WorkflowOverview, statuses: string[]) => entry.tally.some((item) => statuses.includes(item.status));
  const counts = {
    all: workflows.length,
    running: workflows.filter((entry) => has(entry, ['running'])).length,
    attention: workflows.filter((entry) => has(entry, ['blocked', 'failed'])).length,
  };
  const shown = workflows.filter((entry) => {
    const match = [entry.workflow.name, ...(entry.workflow.tags ?? []), ...entry.stages.map((stage) => stage.node.data.label)].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    return match && (filter === 'all' || filter === 'running' && has(entry, ['running'])
      || filter === 'attention' && has(entry, ['blocked', 'failed']));
  });
  return <section className="execution-overview" aria-label="전체 워크플로 실행 현황" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <header className="overview-header">
      <button className="button ghost" onClick={onClose}><ArrowLeft size={16} /><span>캔버스로 돌아가기</span></button>
      <div className="overview-title"><LayoutDashboard size={18} /><h1 ref={heading} tabIndex={-1} title="워크플로마다 하나의 그래프에 진행 중인 실행을 합쳐 보여 줍니다.">워크플로 실행 현황</h1><span className="overview-workflow-count">{workflows.length}개 워크플로 · 진행 실행 {entries.length}개</span></div>
      <div className="overview-filters" role="group" aria-label="실행 상태 필터">
        {([['all', '전체'], ['running', '실행 중'], ['attention', '확인·실패']] as const).map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{counts[key]}</span></button>)}
      </div>
      <label className="overview-search"><Search size={15} /><input aria-label="워크플로 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="워크플로, 단계, 태그 검색" /></label>
      <span className="overview-refresh-state" role="status">{loading ? <><LoaderCircle size={13} className="spin" />조회 중</> : <><i className="status-dot running" />10초마다 갱신{updated && ` · ${updated}`}</>}</span>
      <button className="icon-button" aria-label="전체 실행 새로 고침" title="새로 고침" disabled={loading} onClick={() => setTick((value) => value + 1)}><RefreshCw size={16} /></button>
    </header>
    <div className="overview-scroll">
      {error && <div className="error-banner" role="alert">{error} 마지막 조회 결과를 표시합니다.</div>}
      <div className="overview-grid">
        {shown.map((entry) => {
          const id = entry.workflow.id, isOpen = open.has(id);
          const current = entry.stages.flatMap(({ node, tally }) => tally.filter((item) => ['running', 'blocked', 'failed'].includes(item.status)).map((item) => ({ node, ...item })));
          return <article key={id} className={`overview-card ${entry.status} ${isOpen ? 'open' : ''}`} aria-label={entry.workflow.name}>
          <header className="overview-card-heading">
            <button className="overview-card-toggle" aria-expanded={isOpen} onClick={() => setOpen((set) => flip(set, id))} title={isOpen ? '접기' : '진행 단계와 그래프 보기'}>
              <ChevronRight size={15} className="overview-chevron" /><h2>{entry.workflow.name}</h2>
              <span className="overview-running">{current.map(({ node, status, count }) => <span key={`${node.id}:${status}`} className={status}><i className={`status-dot ${status}`} />{node.data.label}{count > 1 && ` ${count}`}</span>)}</span>
            </button>
            <span className={`outcome ${entry.status}`}>{statusLabels[entry.status]}</span>
            <button className="icon-button" aria-label={`${entry.workflow.name} 캔버스 열기`} title="캔버스 열기" onClick={() => void onOpen(id, 'all')}><ArrowUpRight size={17} /></button>
          </header>
          {isOpen && <>
          <div className="overview-workflow-name"><WorkflowIcon size={12} />진행 실행 {entry.executionCount}개{entry.workflow.tags?.map((tag) => <span key={tag}>#{tag}</span>)}</div>
          <div className="overview-progress" title="진행 중인 모든 실행에서 완료되었거나 건너뛴 단계"><progress max={entry.stages.length} value={entry.done} aria-label={`${entry.workflow.name} 완료 단계`} /><span><Check size={12} />{entry.done} / {entry.stages.length} 단계</span></div>
          <div className="overview-current">{current.map(({ node, status, count }) => <button key={`${node.id}:${status}`} className={status} onClick={() => void onOpen(id, 'all', node.id)}><i className={`status-dot ${status}`} /><span>{node.data.label} · {statusLabels[status]} {count}</span><ArrowUpRight size={11} /></button>)}</div>
          <ExecutionGraph entry={entry} onOpen={onOpen} full={full.has(id)} onToggle={() => setFull((set) => flip(set, id))} />
          <footer className="overview-card-footer"><div>{entry.tally.map(({ status, count }) => <span key={status} className={`overview-tally ${status}`}><i className={`status-dot ${status}`} />{statusLabels[status]} {count}</span>)}</div><small>{entry.observedAt ? `${new Date(entry.observedAt).toLocaleTimeString('ko-KR', { hour12: false })} 마지막 관찰` : '관찰 대기'}</small></footer>
          </>}
        </article>;
        })}
      </div>
      {!shown.length && <div className="overview-empty">{loading ? <LoaderCircle size={30} className="spin" /> : <Activity size={32} />}<h2>{loading ? '실행 정보를 불러오는 중입니다' : entries.length ? '조건에 맞는 실행이 없습니다' : error ? '실행 정보를 확인할 수 없습니다' : '진행 중인 실행이 없습니다'}</h2><p>{entries.length ? '검색어나 상태 필터를 바꿔 보세요.' : '저장된 워크플로에서 실행을 시작하면 이곳에 표시됩니다. 완료된 실행은 각 캔버스의 실행 로그에서 확인할 수 있습니다.'}</p></div>}
    </div>
  </section>;
}
