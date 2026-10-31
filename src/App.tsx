import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  addEdge, useNodesState, useEdgesState, useReactFlow, MarkerType,
  type Connection, type NodeProps, type Edge,
} from '@xyflow/react';
import {
  Activity, ArrowDownToLine, ArrowUpFromLine, Box, Check, ChevronRight, Circle,
  CircleHelp, Clock3, FileJson2, GitBranch, Layers3, LayoutDashboard, Link2,
  LoaderCircle, Menu, Network, Plus, Save, Settings2, ShieldCheck, StickyNote,
  Trash2, Unplug, X, XCircle,
} from 'lucide-react';
import {
  fromSnapshot, newWorkflow, projectNodes, serializableWorkflow, statusLabels,
  type Workflow, type StageNode, type StageKind, type StageStatus, type RunSummary, type RunSnapshot,
} from './model';

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '요청에 실패했습니다.');
  return result;
}

const statusIcons = { unbound: Unplug, pending: Clock3, running: LoaderCircle, completed: Check, failed: XCircle, blocked: CircleHelp, unknown: CircleHelp };
const kindNames = { task: '에이전트 작업', gate: '검토 단계', note: '메모' };
function StageCard({ data, selected }: NodeProps<StageNode>) {
  const status = data.status ?? 'unbound';
  const StatusIcon = statusIcons[status];
  const KindIcon = data.kind === 'gate' ? ShieldCheck : data.kind === 'note' ? StickyNote : Box;
  return <article className={`stage-card ${status} ${selected ? 'selected' : ''}`} aria-label={`${data.label}, ${statusLabels[status]}`}>
    <Handle type="target" position={Position.Left} />
    <div className="stage-kind"><KindIcon size={14} /><span>{kindNames[data.kind]}</span><span className={`status-dot ${status}`} /></div>
    <h3>{data.label || '이름 없는 단계'}</h3>
    <p>{data.description || '단계를 선택해 내용을 작성하세요.'}</p>
    <div className="stage-footer"><span className={`stage-status ${status}`}><StatusIcon size={13} className={status === 'running' ? 'spin' : ''} />{statusLabels[status]}</span>
      <span className="agent-label">{data.agent || (data.taskId ? data.taskId.slice(0, 14) : 'Task 연결 가능')}</span></div>
    <Handle type="source" position={Position.Right} />
  </article>;
}
const nodeTypes = { stage: StageCard };

export function App() { return <ReactFlowProvider><Workspace /></ReactFlowProvider>; }

function Workspace() {
  const [workflow, setWorkflow] = useState<Workflow>(newWorkflow);
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNode>(workflow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(workflow.edges);
  const [selectedId, setSelectedId] = useState<string | null>('design');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [saved, setSaved] = useState<{ id: string; name: string }[]>([]);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [connection, setConnection] = useState<{ connected: boolean; version?: string }>({ connected: false });
  const [snapshotError, setSnapshotError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const { fitView, screenToFlowPosition } = useReactFlow<StageNode>();
  const current = useMemo(() => serializableWorkflow({ ...workflow, nodes, edges }), [workflow, nodes, edges]);
  const fingerprint = JSON.stringify(current);
  const dirty = fingerprint !== savedFingerprint;
  const selected = nodes.find((node) => node.id === selectedId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const stale = !!snapshotError || (!!workflow.runId && !snapshot);
  const displayNodes = useMemo(() => projectNodes(nodes, snapshot, stale).map((node) => ({ ...node, selected: node.id === selectedId })), [nodes, snapshot, stale, selectedId]);
  const displayEdges = useMemo(() => edges.map((edge) => {
    const target = displayNodes.find((node) => node.id === edge.target);
    const source = displayNodes.find((node) => node.id === edge.source);
    const active = target?.data.status === 'running' && source?.data.status === 'completed';
    return { ...edge, selected: edge.id === selectedEdgeId, animated: active, type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color: active ? '#76d8bc' : '#49545c' },
      style: { stroke: active ? '#76d8bc' : '#414b54', strokeWidth: active ? 2 : 1.4 } };
  }), [edges, displayNodes, selectedEdgeId]);
  const counts = displayNodes.reduce((totals, node) => { const key = node.data.status ?? 'unbound'; totals[key] = (totals[key] ?? 0) + 1; return totals; }, {} as Partial<Record<StageStatus, number>>);
  const selectedProjected = displayNodes.find((node) => node.id === selectedId);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      const results = await Promise.allSettled([
        api<{ connected: boolean; version: string }>('/api/status', { signal: controller.signal }),
        api<RunSummary[]>('/api/runs', { signal: controller.signal }),
        api<{ id: string; name: string }[]>('/api/workflows', { signal: controller.signal }),
      ]);
      if (cancelled) return;
      const [health, runList, files] = results;
      if (health.status === 'fulfilled') { setConnection(health.value); setConnectionError(health.value.connected ? '' : 'Orca가 준비되지 않았습니다.'); }
      else { setConnection({ connected: false }); setConnectionError(health.reason.message); }
      if (runList.status === 'fulfilled') setRuns(runList.value);
      else setConnectionError(runList.reason.message);
      if (files.status === 'fulfilled') setSaved(files.value);
      timer = setTimeout(refresh, 15000);
    }
    void refresh();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setSnapshotError('');
    if (!workflow.runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      try {
        const result = await api<RunSnapshot>(`/api/runs/${encodeURIComponent(workflow.runId)}`, { signal: controller.signal });
        if (!cancelled) { setSnapshot(result); setSnapshotError(''); }
      } catch (error) { if (!cancelled) setSnapshotError((error as Error).message); }
      if (!cancelled) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [workflow.runId]);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === connection.target) { setNotice('다른 단계에 연결하세요.'); return; }
    setEdges((items) => addEdge({ ...connection, id: crypto.randomUUID() }, items));
  }, [setEdges]);

  function applyWorkflow(graph: Workflow, persisted: boolean) {
    setWorkflow(graph); setNodes(graph.nodes); setEdges(graph.edges);
    setSelectedId(graph.nodes[0]?.id ?? null); setSelectedEdgeId(null);
    setSavedFingerprint(persisted ? JSON.stringify(serializableWorkflow(graph)) : '');
    setTimeout(() => { void fitView({ padding: 0.25, duration: 300 }); }, 80);
  }
  function confirmReplace() { return !dirty || window.confirm('저장하지 않은 변경 내용이 있습니다. 캔버스를 바꿀까요?'); }
  async function save() {
    setBusy(true);
    try {
      await api(`/api/workflows/${current.id}`, { method: 'PUT', body: JSON.stringify(current) });
      setSavedFingerprint(JSON.stringify(current));
      setSaved(await api('/api/workflows'));
      setNotice('워크플로를 로컬에 저장했습니다.');
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  async function load(id: string) {
    if (!confirmReplace()) return;
    setBusy(true);
    try { applyWorkflow(await api<Workflow>(`/api/workflows/${id}`), true); setSidebarOpen(false); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  function addNode(kind: StageKind) {
    const id = crypto.randomUUID();
    const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
    const position = screenToFlowPosition({ x: pane.x + pane.width * 0.45, y: pane.y + pane.height * 0.4 });
    setNodes((items) => [...items, { id, type: 'stage', position, data: { label: kindNames[kind], description: '', kind } }]);
    setSelectedId(id); setSelectedEdgeId(null);
  }
  function updateNode(data: Partial<StageNode['data']>) {
    setNodes((items) => items.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, ...data } } : node));
  }
  function removeSelected() {
    if (selectedId) {
      setNodes((items) => items.filter((node) => node.id !== selectedId));
      setEdges((items) => items.filter((edge) => edge.source !== selectedId && edge.target !== selectedId));
      setSelectedId(null);
    } else if (selectedEdgeId) {
      setEdges((items) => items.filter((edge) => edge.id !== selectedEdgeId)); setSelectedEdgeId(null);
    }
  }
  function changeRun(runId: string) {
    if (runId === workflow.runId) return;
    if (nodes.some((node) => node.data.taskId) && !window.confirm('Run을 바꾸면 기존 Task 연결이 해제됩니다. 계속할까요?')) return;
    setSnapshot(null);
    setWorkflow((value) => ({ ...value, runId }));
    setNodes((items) => items.map((node) => ({ ...node, data: { ...node.data, taskId: undefined } })));
  }
  function importRun() {
    if (!snapshot || !confirmReplace()) return;
    applyWorkflow({ ...current, ...fromSnapshot(snapshot) }, false);
    setNotice(`${snapshot.tasks.length}개 Task를 그래프로 가져왔습니다.`);
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${current.id}.json`; anchor.click();
    URL.revokeObjectURL(url);
  }
  async function importFile(file?: File) {
    if (!file || !confirmReplace()) return;
    if (file.size > 2 * 1024 * 1024) { setNotice('2MB 이하의 JSON 파일을 선택하세요.'); return; }
    try {
      const graph = await api<Workflow>('/api/validate', { method: 'POST', body: await file.text() });
      // Imported graphs become new local documents, preserving the original saved graph.
      applyWorkflow({ ...graph, id: crypto.randomUUID() }, false);
      setNotice('JSON을 가져왔습니다. 저장 버튼으로 로컬에 보관하세요.');
    } catch (error) { setNotice((error as Error).message); }
  }

  return <div className="workspace">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <a className="brand" href="/" onClick={(event) => event.preventDefault()}><span className="brand-mark"><Network size={23} /></span><span>workflow<span className="brand-sub">canvas</span></span><span className="version">0.1</span></a>
      <div className="workspace-label"><span className="workspace-avatar">W</span><div>로컬 워크스페이스<small>Orca orchestration</small></div><ChevronRight size={14} /></div>
      <div className="sidebar-section-title">워크플로<span>{saved.length}</span></div>
      <button className="sidebar-item active" onClick={() => setSidebarOpen(false)}><GitBranch size={17} /><span title={workflow.name}>{workflow.name}</span><span className="tiny-dot" /></button>
      {saved.filter((item) => item.id !== workflow.id).map((item) => <button className="sidebar-item" key={item.id} onClick={() => void load(item.id)}><FileJson2 size={16} /><span>{item.name}</span></button>)}
      <button className="sidebar-item subtle" onClick={() => { if (confirmReplace()) applyWorkflow({ ...newWorkflow(), name: '새 워크플로', nodes: [], edges: [] }, false); }}><Plus size={16} /><span>새 워크플로</span></button>
      <div className="sidebar-divider" />
      <div className="sidebar-section-title">ORCA 연결 <Activity size={13} /></div>
      <label className="field-label run-label" htmlFor="run-selector">관찰할 Run</label>
      <select id="run-selector" value={workflow.runId} onChange={(event) => changeRun(event.target.value)}>
        <option value="">Run 선택</option>
        {workflow.runId && !runs.some((run) => run.id === workflow.runId) && <option value={workflow.runId}>{workflow.runId}</option>}
        {runs.map((run) => <option key={run.id} value={run.id}>{run.objective}</option>)}
      </select>
      {workflow.runId && <div className="run-card"><div className="eyebrow">선택한 RUN</div><strong>{snapshot?.run.objective || runs.find((run) => run.id === workflow.runId)?.objective || workflow.runId}</strong><span>{snapshot?.tasks.length ?? '—'} tasks · {snapshot?.workers.length ?? '—'} attempts</span>
        <button className="button small" onClick={importRun} disabled={!snapshot || !!snapshotError}><ArrowDownToLine size={14} />Task로 그래프 만들기</button>
      </div>}
      <div className="sidebar-bottom"><div className={`connection ${connection.connected && !connectionError ? 'connected' : ''}`}><span className="status-dot" /><span>{connection.connected && !connectionError ? 'Orca 연결됨' : 'Orca 연결 확인 필요'}</span><span className="version">{connection.version || 'local'}</span></div><p>그래프는 설계하고,<br />실행 상태는 Orca에서 확인합니다.</p></div>
    </aside>

    <main className="main">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="메뉴 열기" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={20} /></button><Layers3 size={16} /><span>워크플로</span><ChevronRight size={14} /><strong>캔버스</strong></div>
        <div className="toolbar-actions"><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
          <button className="button ghost" onClick={() => importRef.current?.click()} title="JSON 가져오기"><ArrowUpFromLine size={15} /><span>가져오기</span></button>
          <button className="button ghost" onClick={download} title="JSON 내보내기"><ArrowDownToLine size={15} /><span>내보내기</span></button>
          <button className="button primary" onClick={() => void save()} disabled={busy}><Save size={15} />{busy ? '저장 중' : '저장'}{dirty && <span className="unsaved-dot" />}</button>
        </div>
      </header>
      <section className="canvas-heading"><div><div className="eyebrow">WORKFLOW EDITOR <span className="local-badge">LOCAL</span></div><input className="workflow-name" aria-label="워크플로 이름" value={workflow.name} maxLength={500} onChange={(event) => setWorkflow((value) => ({ ...value, name: event.target.value }))} /><p>{workflow.description || '단계를 연결해 작업의 흐름을 만드세요.'}</p></div>
        <div className="heading-stats"><span><i className="status-dot running" />실행 {counts.running ?? 0}</span><span><Check size={14} />완료 {counts.completed ?? 0}</span><span className="total">{nodes.length} 단계</span></div>
      </section>
      {(snapshotError || connectionError) && <div className="error-banner" role="alert"><CircleHelp size={15} />{snapshotError || connectionError}</div>}
      <div className="editor-body">
        <section className="canvas" aria-label="워크플로 그래프 캔버스">
          <div className="canvas-tools"><button className="button small" onClick={() => addNode('task')}><Plus size={15} />작업 추가</button><button className="icon-button" title="검토 단계 추가" aria-label="검토 단계 추가" onClick={() => addNode('gate')}><ShieldCheck size={17} /></button><button className="icon-button" title="메모 추가" aria-label="메모 추가" onClick={() => addNode('note')}><StickyNote size={17} /></button><span className="tool-divider" /><button className="icon-button" title="전체 보기" aria-label="전체 보기" onClick={() => void fitView({ padding: 0.25, duration: 300 })}><LayoutDashboard size={17} /></button></div>
          <div className="canvas-mode"><span className={`status-dot ${workflow.runId && snapshot && !stale ? 'running' : ''}`} />{workflow.runId ? 'Orca 실시간 관찰' : '설계 모드'}</div>
          <ReactFlow<StageNode> nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_event, node) => { setSelectedId(node.id); setSelectedEdgeId(null); }} onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedId(null); }}
            onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); }} fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.15} maxZoom={1.6} deleteKeyCode={['Backspace', 'Delete']} colorMode="dark" proOptions={{ hideAttribution: false }}>
            <Background gap={22} size={1} color="#2c353d" />
            <Controls showInteractive={false} />
            <MiniMap nodeColor={(node) => node.data.status === 'running' ? '#76d8bc' : node.data.status === 'completed' ? '#478473' : '#3b454f'} maskColor="rgba(16,20,25,.6)" pannable zoomable />
          </ReactFlow>
          {nodes.length === 0 && <div className="empty-canvas"><Network size={36} /><h2>첫 단계를 만들어 보세요</h2><p>작업을 추가하거나 Orca Run의 Task를 가져올 수 있습니다.</p><button className="button primary" onClick={() => addNode('task')}><Plus size={16} />작업 추가</button></div>}
          <div className="canvas-hint">드래그로 이동 · 포트를 연결해 흐름 만들기 · Delete로 삭제</div>
        </section>

        <aside className="inspector"><div className="inspector-header"><span><Settings2 size={16} />{selectedEdge ? '연결 속성' : '단계 속성'}</span><span className="inspector-counter">{selected ? `${nodes.findIndex((node) => node.id === selected.id) + 1} / ${nodes.length}` : '—'}</span></div>
          {selected ? <div className="inspector-content"><div className="selected-kind"><Box size={21} /><div><span>{kindNames[selected.data.kind]}</span><strong>{selected.data.label || '이름 없는 단계'}</strong></div></div>
            <label className="field-label" htmlFor="stage-name">단계 이름</label><input id="stage-name" value={selected.data.label} maxLength={500} onChange={(event) => updateNode({ label: event.target.value })} />
            <label className="field-label" htmlFor="stage-kind">단계 유형</label><select id="stage-kind" value={selected.data.kind} onChange={(event) => updateNode({ kind: event.target.value as StageKind })}><option value="task">에이전트 작업</option><option value="gate">검토 단계</option><option value="note">메모</option></select>
            <label className="field-label" htmlFor="stage-description">작업 지침</label><textarea id="stage-description" rows={5} value={selected.data.description} maxLength={20000} placeholder="목표, 작업 범위, 완료 조건을 적으세요." onChange={(event) => updateNode({ description: event.target.value })} />
            <div className="inspector-divider" />
            <div className="section-label"><Link2 size={15} />Orca Task 연결</div><p className="field-help">Task를 연결하면 실행 상태가 자동으로 표시됩니다.</p>
            <label className="field-label" htmlFor="task-selector">관찰할 Task</label><select id="task-selector" value={selected.data.taskId ?? ''} disabled={!snapshot || stale} onChange={(event) => updateNode({ taskId: event.target.value || undefined })}><option value="">미연결</option>
              {selected.data.taskId && !snapshot?.tasks.some((task) => task.id === selected.data.taskId) && <option value={selected.data.taskId}>{selected.data.taskId} (조회되지 않음)</option>}
              {snapshot?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select>
            {!workflow.runId && <p className="field-help">왼쪽에서 Run을 먼저 선택하세요.</p>}
            <div className={`task-state ${selectedProjected?.data.status ?? 'unbound'}`}><span className="status-dot" /><span>{statusLabels[selectedProjected?.data.status ?? 'unbound']}</span><small>{selectedProjected?.data.agent || 'Orca Task'}</small></div>
            {selectedProjected?.data.model && <p className="field-help">모델 · {selectedProjected.data.model}</p>}
            <div className="inspector-note"><ShieldCheck size={16} /><p>이 화면은 실행 상태를 관찰합니다. 워커 실행과 승인 처리는 Orca 코디네이터가 담당합니다.</p></div>
            <button className="button danger" onClick={removeSelected}><Trash2 size={14} />단계 삭제</button>
          </div> : selectedEdge ? <div className="inspector-content"><label className="field-label" htmlFor="edge-label">연결 설명</label><input id="edge-label" value={String(selectedEdge.label ?? '')} maxLength={500} placeholder="예: 검증 통과" onChange={(event) => setEdges((items) => items.map((edge) => edge.id === selectedEdgeId ? { ...edge, label: event.target.value } : edge))} /><p className="field-help">연결 설명은 설계용입니다. 실행 조건을 자동으로 강제하지 않습니다.</p><button className="button danger" onClick={removeSelected}><Trash2 size={14} />연결 삭제</button></div>
            : <div className="inspector-empty"><Settings2 size={28} /><p>단계나 연결을 선택해<br />속성을 편집하세요.</p></div>}
        </aside>
      </div>
      <footer className="statusbar"><span><Circle size={10} />{dirty ? '저장하지 않은 변경 사항' : '로컬 저장 완료'}</span><span>{workflow.runId ? `3초 간격 조회 · ${snapshot && !stale ? new Date(snapshot.observedAt).toLocaleTimeString('ko-KR') : '상태 확인 중'}` : 'Orca Run을 연결하면 실제 실행 상태가 표시됩니다.'}</span><span>JSON v1</span></footer>
    </main>
    {notice && <div className="toast" role="status"><span>{notice}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {sidebarOpen && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setSidebarOpen(false)} />}
  </div>;
}
