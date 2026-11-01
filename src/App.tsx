import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, NodeResizer,
  addEdge, useNodesState, useEdgesState, useReactFlow, useStore, MarkerType,
  type Connection, type NodeChange, type MiniMapNodeProps, type NodeProps, type Edge,
} from '@xyflow/react';
import {
  Activity, ArrowDownToLine, History, ArrowUpFromLine, Bot, Check, ChevronRight, Circle,
  CircleHelp, Clock3, ExternalLink, FileJson2, FolderGit2, GitBranch, Group, Hand, Layers3, LayoutDashboard, Link2,
  Eye, LoaderCircle, Lock, Menu, Move, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, MousePointer2, Network, Play, Plus, Save, Settings2, SkipForward, Sparkles, Split, SquareDashed, StickyNote,
  Trash2, Unplug, Workflow as WorkflowIcon, X, XCircle, Zap,
} from 'lucide-react';
import {
  aggregateStatus, executionFinished, executionRun, executionStatuses as computeExecutionStatuses, mergeSnapshots, workflowRuns, openableStatuses, fromSnapshot, newWorkflow, projectNodes, serializableWorkflow, statusLabels,
  asksAtRun, defaultWorkerModel, effortLevels, frameContents, isFrame, launchesWorker, workerModels, type Effort, type Rect, joinNames, pendingDecisions, gateAskerNames, type GateAsker, linkModeNames, maxSpawnItems, type LinkMode, variableKeyPattern, variableRefs, maxVariables, maxVariableValue, type WorkflowVariable, loopBody, maxLoopRounds, type WorkflowEdge, type FlowStage, type PendingDecision, branchJudgeNames, branchModeNames, isBranch, maxBranchOutputs, type BranchJudge, type BranchMode, type BranchOutput, defaultCleanup, triggerNames, worktreeNamePattern, type AutomationConfig, type AutomationState, type Cleanup, canNest, maxGroupDepth, nameSourceNames, safeWorktreeName, type NameSource, createsWorktree, groupOf, membershipOf, orderNodes, worktreeRepo, isExecutable, isGroup, kindNames, normalizeNodes, scopeNames,
  type Workflow, type Execution, type StageNode, type StageKind, type NodeKind, type GroupScope, type StageStatus, type RunSummary, type RunSnapshot, type Locations,
} from './model';
import { RunLogDialog } from './RunLog';

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '요청에 실패했습니다.');
  return result;
}

const statusIcons = { unbound: Unplug, pending: Clock3, running: LoaderCircle, completed: Check, failed: XCircle, blocked: CircleHelp, unknown: CircleHelp, skipped: SkipForward };
// Lets node cards open a worker's terminal and name linked workflows without threading callbacks through node data.
const CanvasContext = createContext<{ openTask: (taskId: string) => void; workflowName: (id?: string) => string | undefined; viewOnly: boolean }>({
  openTask: () => {}, workflowName: () => undefined, viewOnly: false });
const kindIcons: Record<NodeKind, typeof Bot> = { worker: Bot, gate: Hand, branch: Split, note: StickyNote, workflow: WorkflowIcon, group: SquareDashed, frame: Group };
/** Minimap marks a node by kind with the card's accent colour and icon; a corner dot carries run status. */
const accentColors: Record<StageKind, string> = { worker: '#7fb0f5', gate: '#e3b45f', branch: '#e3b45f', workflow: '#62d0c0', note: '#b4b67e' };
const scopeColors: Record<GroupScope, string> = { project: '#8cc97a', worktree: '#b996f2' };
const statusDotColors: Partial<Record<StageStatus, string>> = { running: '#76d8bc', completed: '#478473', blocked: '#f5c46b', failed: '#ef6b6b' };
function MiniMapNode({ id, x, y, width, height, borderRadius, selected, onClick }: MiniMapNodeProps) {
  const data = useStore((state) => (state.nodeLookup.get(id) as StageNode | undefined)?.data);
  if (!data) return null;
  // Groups and memo groups are drawn as large boxes with the icon in the corner.
  const group = data.kind === 'group' || data.kind === 'frame';
  const color = data.kind === 'group' ? scopeColors[data.scope ?? 'project'] : data.kind === 'frame' ? accentColors.note : accentColors[data.kind as StageKind] ?? '#8b98a5';
  const Icon = data.kind === 'group' ? (data.scope === 'worktree' ? GitBranch : FolderGit2) : kindIcons[data.kind] ?? Bot;
  const size = group ? Math.min(90, width * 0.3, height * 0.3) : Math.min(width, height) * 0.6;
  const dot = !group && data.status ? statusDotColors[data.status] : undefined;
  return <g className={`minimap-node ${data.kind}`} onClick={(event) => onClick?.(event, id)}>
    <rect x={x} y={y} width={width} height={height} rx={borderRadius} ry={borderRadius} fill={color} fillOpacity={group ? 0.08 : 0.2}
      stroke={color} strokeWidth={selected ? 14 : 6} strokeDasharray={data.kind === 'note' || group ? '18 10' : undefined} />
    <Icon x={group ? x + 20 : x + (width - size) / 2} y={group ? y + 20 : y + (height - size) / 2} size={size} color={color} strokeWidth={2.4} />
    {dot && <circle cx={x + width - height * 0.18} cy={y + height * 0.18} r={height * 0.12} fill={dot} />}
  </g>;
}
function StageCard({ data, selected }: NodeProps<StageNode>) {
  const status = data.status ?? 'unbound';
  const StatusIcon = statusIcons[status];
  const { openTask, workflowName } = useContext(CanvasContext);
  const openable = !!data.activeTaskId && openableStatuses.includes(status);
  const KindIcon = kindIcons[data.kind] ?? Bot;
  if (data.kind === 'note') return <article className={`stage-card note ${selected ? 'selected' : ''}`} aria-label={`메모, ${data.label}`}>
    <Handle type="target" position={Position.Left} />
    <div className="stage-kind"><KindIcon size={14} /><span>{kindNames.note}</span><span className="note-badge">실행 안 함</span></div>
    <h3>{data.label || '메모'}</h3>
    <p className="note-body">{data.description || '실행과 관계없는 설명을 적으세요.'}</p>
    <Handle type="source" position={Position.Right} />
  </article>;
  const linked = data.kind === 'workflow' ? workflowName(data.workflowId) : undefined;
  return <article className={`stage-card ${data.kind} ${status} ${selected ? 'selected' : ''}`} aria-label={`${data.label}, ${statusLabels[status]}`}>
    <Handle type="target" position={Position.Left} />
    <div className="stage-kind"><KindIcon size={14} /><span>{kindNames[data.kind]}</span>
      {data.join === 'any' && <span className="branch-meta join-meta" title="분기에서 갈라진 경로가 다시 모이는 곳">합류: 하나라도</span>}
      {data.kind === 'gate' && data.asker === 'previous' && <span className="branch-meta">{gateAskerNames.previous}이 물음</span>}
      {data.kind === 'branch' && <span className="branch-meta">{branchModeNames[data.mode ?? 'exclusive']} · {branchJudgeNames[data.judge ?? 'previous']}</span>}
      {data.round && <span className="round-badge" title="되돌아가기로 다시 도는 회차">{data.round}회차</span>}
      <span className={`status-dot ${status}`} /></div>
    <h3>{data.label || '이름 없는 단계'}</h3>
    {launchesWorker({ data }) && (data.workerModel || data.effort) && <div className="launch-chip" title="이 단계 워커의 모델·추론 수준(effort)">
      <Bot size={11} />{(data.workerModel || defaultWorkerModel).replace(/^claude-/, '')}{data.effort ? ` · ${data.effort}` : ''}</div>}
    {data.membership && <div className="membership-chips" aria-label="소속">
      {data.membership.project && <span className="member-chip project"><FolderGit2 size={11} />{data.membership.project}</span>}
      {data.membership.worktrees.map((name, index) => <span key={index} className="member-link">
        {(index > 0 || data.membership!.project) && <ChevronRight size={11} className="member-sep" />}<span className="member-chip worktree"><GitBranch size={11} />{name}</span></span>)}</div>}
    {data.kind === 'workflow' && <div className={`link-target ${linked ? '' : 'missing'}`}><Link2 size={12} />{linked ?? (data.workflowId ? '찾을 수 없는 워크플로' : '연결할 워크플로를 고르세요')}
      {data.linkMode && data.linkMode !== 'wait' && <span className="link-mode">{linkModeNames[data.linkMode]}</span>}</div>}
    {data.spawned && <div className="spawn-chips" aria-label="따로 실행한 항목">{data.spawned.map((result, index) =>
      <span key={index} className={`spawn-chip ${result.error ? 'failed' : ''}`} title={result.error ?? `${result.at} 요청`}>{result.item}</span>)}</div>}
    <p>{data.description || (data.kind === 'branch' ? '무엇을 근거로 어느 출력을 고를지 적으세요.' : '단계를 선택해 내용을 작성하세요.')}</p>
    {data.kind === 'branch' && <ul className="branch-outputs" aria-label="분기 출력">
      {(data.outputs ?? []).map((output) => <li key={output.id} className={`branch-output ${data.decision ? (data.decision.includes(output.id) ? 'taken' : 'untaken') : ''}`}>
        <span className="branch-output-id">{output.id}</span><span className="branch-output-label">{output.label || '조건을 적으세요'}</span>
        {data.decision?.includes(output.id) && <Check size={11} />}
        <Handle type="source" position={Position.Right} id={output.id} className="branch-handle" /></li>)}
      {!data.outputs?.length && <li className="branch-output empty">출력을 추가하세요</li>}</ul>}
    {data.runs && data.runs.length > 0 && <div className="run-chips" aria-label="실행별 상태">
      <span className="run-summary">실행 {data.runs.length} · {statusLabels.completed} {data.runs.filter((run) => run.status === 'completed').length}</span>
      {data.runs.map((run) => run.taskId && openableStatuses.includes(run.status)
        ? <button key={run.id} className={`run-chip nodrag ${run.status}`} title={`${run.label} · ${statusLabels[run.status]} · 클릭해 실행 화면 열기`}
          onClick={(event) => { event.stopPropagation(); openTask(run.taskId!); }}><span className="status-dot" />{run.label}</button>
        : <span key={run.id} className={`run-chip ${run.status}`} title={`${run.label} · ${statusLabels[run.status]}`}><span className="status-dot" />{run.label}</span>)}
    </div>}
    <div className="stage-footer"><span className={`stage-status ${status}`}><StatusIcon size={13} className={status === 'running' ? 'spin' : ''} />{statusLabels[status]}</span>
      <span className="agent-label">{openable ? '클릭해 실행 화면 열기' : data.agent || (data.activeTaskId ? data.activeTaskId.slice(0, 14) : data.runs ? '' : 'Task 연결 가능')}</span></div>
    {data.kind !== 'branch' && <Handle type="source" position={Position.Right} />}
  </article>;
}
function GroupCard({ data, selected }: NodeProps<StageNode>) {
  const scope = data.scope ?? 'project';
  const ScopeIcon = scope === 'worktree' ? GitBranch : FolderGit2;
  const create = scope === 'worktree' && data.worktreeMode === 'create';
  const naming = data.nameSource === 'agent' ? '에이전트가 이름 결정' : data.nameSource === 'input' ? '실행 시 입력' : data.worktreeName || '새로 생성';
  const repo = data.repoPath || data.inheritedRepo;
  const target = create ? `${naming}${data.perExecution ? ' · 실행마다' : ''}${repo ? ` · ${shortPath(repo)}` : ''}` : data.path ? shortPath(data.path) : '';
  const { viewOnly } = useContext(CanvasContext);
  return <section className={`group-card ${scope} ${create ? 'create' : ''} ${selected ? 'selected' : ''} ${data.ancestor ? 'ancestor' : ''}`} aria-label={`${scopeNames[scope]} 그룹, ${data.label}`}>
    <NodeResizer isVisible={selected && !viewOnly} minWidth={300} minHeight={200} color={scope === 'worktree' ? '#b996f2' : '#8cc97a'} handleClassName="group-resize-handle" />
    <header className="group-header"><ScopeIcon size={14} /><span className="group-scope">{scopeNames[scope]}</span>
      <strong>{data.label || '이름 없는 그룹'}</strong><span className={`group-path ${target ? '' : 'missing'}`} title={create ? data.repoPath : data.path}>{target || '대상을 고르세요'}</span></header>
  </section>;
}
/** Memo group: only gathers nodes visually. Moving it moves what lies inside; it never sets where anything runs. */
function FrameCard({ data, selected }: NodeProps<StageNode>) {
  const { viewOnly } = useContext(CanvasContext);
  return <section className={`frame-card ${selected ? 'selected' : ''}`} aria-label={`메모 그룹, ${data.label}`}>
    <NodeResizer isVisible={selected && !viewOnly} minWidth={200} minHeight={120} color="#b4b67e" handleClassName="group-resize-handle" />
    <header className="frame-header"><Group size={13} /><strong>{data.label || '메모 그룹'}</strong><span className="note-badge">실행 안 함</span></header>
    {data.description && <p className="frame-body">{data.description}</p>}
  </section>;
}
const nodeTypes = { stage: StageCard, group: GroupCard, frame: FrameCard };
/** Last two path segments, enough to tell sibling projects and worktrees apart. */
function shortPath(path: string) { const parts = path.split('/').filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path; }

const lastWorkflowKey = 'workflow-canvas:last-workflow';
function rememberWorkflow(id: string) { try { localStorage.setItem(lastWorkflowKey, id); } catch { /* storage may be blocked */ } }
function lastWorkflow(): string | null { try { return localStorage.getItem(lastWorkflowKey); } catch { return null; } }
const lastProjectKey = 'workflow-canvas:last-project';
function rememberProject(path: string) { try { localStorage.setItem(lastProjectKey, path); } catch { /* storage may be blocked */ } }
/** 조작 모드: 'select' = 빈 곳 드래그로 여러 개 선택, 'pan' = 드래그로 화면 이동. Remembered per browser. */
type PointerMode = 'select' | 'pan';
const pointerModeKey = 'workflow-canvas:pointer-mode';
function storedPointerMode(): PointerMode { try { return localStorage.getItem(pointerModeKey) === 'pan' ? 'pan' : 'select'; } catch { return 'select'; } }
/** 떠 있는 패널(왼쪽 사이드바·오른쪽 속성)의 펼침 상태와 보기 전용 여부. Remembered per browser. */
type Panels = { left: boolean; right: boolean };
const panelsKey = 'workflow-canvas:panels';
const narrow = (width: number) => typeof window !== 'undefined' && window.matchMedia(`(max-width:${width}px)`).matches;
function storedPanels(): Panels {
  const fallback = { left: !narrow(900), right: !narrow(620) };
  try { const value = JSON.parse(localStorage.getItem(panelsKey) ?? 'null'); return narrow(900) ? { ...fallback, right: value?.right ?? fallback.right }
    : { left: typeof value?.left === 'boolean' ? value.left : fallback.left, right: typeof value?.right === 'boolean' ? value.right : fallback.right }; } catch { return fallback; }
}
const viewOnlyKey = 'workflow-canvas:view-only';
function storedViewOnly(): boolean { try { return localStorage.getItem(viewOnlyKey) === '1'; } catch { return false; } }
function lastProject(): string | null { try { return localStorage.getItem(lastProjectKey); } catch { return null; } }
/** The workflow's settings (like environment variables): asked in the run dialog, fixed per automation, used as {{key}}. */
function VariablesEditor({ variables, nodes, onChange }: { variables: WorkflowVariable[]; nodes: StageNode[]; onChange: (variables: WorkflowVariable[]) => void }) {
  const used = new Set(nodes.filter(isExecutable).flatMap((node) => variableRefs(node.data.description)));
  const update = (index: number, patch: Partial<WorkflowVariable>) => onChange(variables.map((item, at) => at === index ? { ...item, ...patch } : item));
  const nextKey = () => { let n = variables.length + 1; while (variables.some((item) => item.key === `value_${n}`)) n += 1; return `value_${n}`; };
  return <section className="variables-editor" aria-label="워크플로 설정값">
    <div className="field-label">워크플로 설정값</div>
    <p className="field-help">실행 창과 자동화에서 입력받는 값입니다(예: 에픽 티켓 링크, 스프레드시트 주소). 단계 지침에 {'{{키}}'} 로 쓰면 그 값으로 바뀌고, 링크한 워크플로에도 같은 키로 전달됩니다. 비밀값은 넣지 마세요.</p>
    {variables.map((item, index) => {
      const keyError = !variableKeyPattern.test(item.key) ? '영문 소문자로 시작하는 소문자·숫자·_' : variables.some((other, at) => at !== index && other.key === item.key) ? '겹치는 키' : '';
      return <div key={index} className="variable-row">
        <div className="variable-line"><input aria-label="키" className={`variable-key-input ${keyError ? 'invalid' : ''}`} value={item.key} maxLength={40} title={keyError || '지침에 {{키}} 로 씁니다'}
          onChange={(event) => update(index, { key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
          <input aria-label="이름" value={item.label} maxLength={100} placeholder="이름 (예: 에픽 티켓 링크)" onChange={(event) => update(index, { label: event.target.value })} />
          <button className="icon-button" aria-label={`${item.label || item.key} 삭제`} title="삭제" onClick={() => onChange(variables.filter((_, at) => at !== index))}><Trash2 size={13} /></button></div>
        <input aria-label="기본값" value={item.default ?? ''} maxLength={maxVariableValue} placeholder="기본값 (선택)" onChange={(event) => update(index, { default: event.target.value || undefined })} />
        <input aria-label="설명" value={item.description ?? ''} maxLength={500} placeholder="실행 창에 보일 설명 (선택)" onChange={(event) => update(index, { description: event.target.value || undefined })} />
        <label className="check-row"><input type="checkbox" checked={!!item.required} onChange={(event) => update(index, { required: event.target.checked || undefined })} />필수 — 값도 기본값도 없으면 실행하지 않음</label>
        {keyError ? <p className="field-help warning">키: {keyError}</p> : !used.has(item.key) && <p className="field-help">아직 어느 단계 지침에도 {`{{${item.key}}}`} 가 없습니다.</p>}
      </div>; })}
    <button className="button small" disabled={variables.length >= maxVariables} onClick={() => onChange([...variables, { key: nextKey(), label: '' }])}><Plus size={13} />설정값 추가</button>
  </section>;
}
type RunForm = { mode: 'now' | 'schedule'; project: string; count: number; inputs: Record<string, string>; cleanup: Cleanup; values: Record<string, string>;
  name: string; trigger: string; cron: string; time: string; day: number };
/** "매일 09:00", "매주 월 09:00", or the cron text. */
function scheduleText(config: Pick<AutomationConfig, 'trigger' | 'time' | 'day'>) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  if (!triggerNames[config.trigger]) return `cron ${config.trigger}`;
  return [triggerNames[config.trigger], config.trigger === 'weekly' && config.day !== undefined ? days[config.day] : '', config.trigger !== 'hourly' ? config.time ?? '' : ''].filter(Boolean).join(' ');
}
function branchDefaults(): Pick<StageNode['data'], 'mode' | 'judge' | 'outputs'> {
  return { mode: 'exclusive', judge: 'previous', outputs: [{ id: 'pass', label: '조건 충족' }, { id: 'fail', label: '그 외' }] };
}
/** A readable output id that is not taken yet in this branch (coordinators report decisions by it). */
function nextOutputId(outputs: BranchOutput[]) { let n = outputs.length + 1; while (outputs.some((item) => item.id === `out-${n}`)) n += 1; return `out-${n}`; }
/** A natural-language generation running in Orca, as the canvas tracks it. */
type GenerationState = { id: string; kind: 'workflow' | 'brief'; status: 'pending' | 'done' | 'failed'; nodeId?: string; workflowId?: string;
  description?: string; label?: string; error?: string;
  /** brief: the stage's instructions when asked, to tell whether the user edited them in the meantime. */
  before?: string };
function blankWorkflow(): Workflow { return { ...newWorkflow(), name: '새 워크플로', nodes: [], edges: [] }; }

export function App() { return <ReactFlowProvider><Workspace /></ReactFlowProvider>; }

function Workspace() {
  const [workflow, setWorkflow] = useState<Workflow>(blankWorkflow);
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNode>(workflow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WorkflowEdge>(workflow.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // 여러 노드 선택(드래그 박스·Shift/⌘ 클릭). Two or more ids; a single pick always goes to selectedId so the inspector shows it.
  const [multiIds, setMultiIds] = useState<string[]>([]);
  const [pointerMode, setPointerMode] = useState<PointerMode>(storedPointerMode);
  const [panels, setPanels] = useState<Panels>(storedPanels);
  // On narrow screens the sidebar opens as a drawer each time, so only the inspector's state is kept there.
  useEffect(() => { try { localStorage.setItem(panelsKey, JSON.stringify(narrow(900) ? { ...JSON.parse(localStorage.getItem(panelsKey) ?? '{}'), right: panels.right } : panels)); } catch { /* per-browser convenience only */ } }, [panels]);
  // 보기 전용: 노드 이동·연결·삭제·추가와 속성 편집을 막고 화면 이동·선택·관찰만 허용한다.
  const [viewOnly, setViewOnly] = useState(storedViewOnly);
  useEffect(() => { try { localStorage.setItem(viewOnlyKey, viewOnly ? '1' : '0'); } catch { /* per-browser convenience only */ } }, [viewOnly]);
  // Picking something from the sidebar closes it only where it covers the canvas as a drawer.
  const closeDrawer = useCallback(() => { if (narrow(900)) setPanels((value) => ({ ...value, left: false })); }, []);
  useEffect(() => { try { localStorage.setItem(pointerModeKey, pointerMode); } catch { /* per-browser convenience only */ } }, [pointerMode]);
  // V / H switch the mode, as in drawing tools; ignored while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'v' || event.key === 'V') setPointerMode('select');
      else if (event.key === 'h' || event.key === 'H') setPointerMode('pan');
      else if (event.key === 'l' || event.key === 'L') setViewOnly((value) => !value);
      else if (event.key === '[') setPanels((value) => ({ ...value, left: !value.left }));
      else if (event.key === ']') setPanels((value) => ({ ...value, right: !value.right }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Latest selection, so several React Flow select batches in one tick build on each other.
  const selection = useRef<string[]>([]);
  selection.current = multiIds.length ? multiIds : selectedId ? [selectedId] : [];
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [saved, setSaved] = useState<{ id: string; name: string }[]>([]);
  const [locations, setLocations] = useState<Locations>({ projects: [], worktrees: [] });
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  // Runs of executions started by other 실행 requests (one per ticket, say); the selected Run is `snapshot`.
  const [otherSnapshots, setOtherSnapshots] = useState<Record<string, RunSnapshot>>({});
  const [connection, setConnection] = useState<{ connected: boolean; version?: string }>({ connected: false });
  const [snapshotError, setSnapshotError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedFingerprint, setSavedFingerprint] = useState('');
  // 'all' = 모아 보기(실행별 칩), otherwise the selected execution id (실행 선택).
  const [view, setView] = useState<string>('all');
  const [runDialog, setRunDialog] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [runForm, setRunForm] = useState<RunForm>({ mode: 'now', project: '', count: 1, inputs: {}, cleanup: defaultCleanup, values: {},
    name: '', trigger: 'daily', cron: '0 9 * * 1-5', time: '09:00', day: 1 });
  const [watchUntil, setWatchUntil] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  const { fitView, screenToFlowPosition, getInternalNode } = useReactFlow<StageNode>();
  const current = useMemo(() => serializableWorkflow({ ...workflow, nodes, edges }), [workflow, nodes, edges]);
  const fingerprint = JSON.stringify(current);
  const dirty = fingerprint !== savedFingerprint;
  const selected = nodes.find((node) => node.id === selectedId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const multiSet = useMemo(() => new Set(multiIds.filter((id) => nodes.some((node) => node.id === id))), [multiIds, nodes]);
  const stale = !!snapshotError || (!!workflow.runId && !snapshot);
  const executions = useMemo(() => workflow.executions ?? [], [workflow.executions]);
  // Statuses read every observed Run at once: Task ids never repeat across Runs.
  const observed = useMemo(() => mergeSnapshots([snapshot, ...Object.values(otherSnapshots)].filter((item): item is RunSnapshot => !!item)),
    [snapshot, otherSnapshots]);
  const executionStatuses = useMemo(() => executions.map((execution) => {
    const statuses = computeExecutionStatuses(nodes, execution, observed, stale);
    return { ...execution, status: aggregateStatus(statuses), finished: executionFinished(statuses) };
  }), [executions, nodes, observed, stale]);
  // Finished executions are always hidden; the canvas focuses on work still in progress.
  const visibleExecutions = useMemo(() => executionStatuses.filter((execution) => !execution.finished), [executionStatuses]);
  // Automations whose executions are still open: shown so it is clear the canvas is watching a scheduled run.
  const activeAutomations = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const execution of visibleExecutions) if (execution.automation) seen.set(execution.automation.id, execution.automation);
    return [...seen.values()];
  }, [visibleExecutions]);
  const finishedCount = executionStatuses.filter((execution) => execution.finished).length;
  // User decisions (gates, user-judged branches) open now: answered here so the coordinator never has to stop and ask.
  const [flow, setFlow] = useState<FlowStage[]>([]);
  const isSaved = saved.some((item) => item.id === workflow.id);
  useEffect(() => {
    if (!isSaved || !executions.length) { setFlow([]); return; }
    let cancelled = false;
    api<FlowStage[]>(`/api/workflows/${workflow.id}/flow`).then((value) => { if (!cancelled) setFlow(value); }).catch(() => { if (!cancelled) setFlow([]); });
    return () => { cancelled = true; };
  }, [workflow.id, isSaved, savedFingerprint, executions.length]);
  const pending = useMemo(() => stale ? [] : visibleExecutions.flatMap((execution) => pendingDecisions(flow, execution, observed)),
    [flow, visibleExecutions, observed, stale]);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [sent, setSent] = useState<Set<string>>(new Set());
  async function decide(item: PendingDecision, outputs: string[]) {
    const key = `${item.executionId}:${item.node}`;
    setSent((value) => new Set(value).add(key));
    try {
      await api(`/api/workflows/${workflow.id}/executions/${item.executionId}/decisions`, { method: 'POST', body: JSON.stringify({ node: item.node, outputs, by: 'user' }) });
      setNotice(`${item.label} ${item.executionLabel}: ${outputs.map((id) => item.outputs.find((output) => output.id === id)?.label ?? id).join(', ')} 선택. 코디네이터가 30초 안에 반영합니다.`);
      setWatchUntil(Date.now() + 60000);
    } catch (error) {
      setSent((value) => { const next = new Set(value); next.delete(key); return next; });
      setNotice((error as Error).message);
    }
  }
  const visibleIds = useMemo(() => new Set(visibleExecutions.map((execution) => execution.id)), [visibleExecutions]);
  const activeExecution = visibleExecutions.find((execution) => execution.id === view);
  const executionView = executions.length ? (activeExecution ? activeExecution.id : 'all') : null;
  const groupDepth = (node: StageNode) => { let depth = 0; for (let parent = groupOf({ nodes }, node); parent && depth <= maxGroupDepth; parent = groupOf({ nodes }, parent)) depth += 1; return depth; };
  const selectedMembership = useMemo(() => {
    const node = nodes.find((item) => item.id === selectedId);
    return node ? membershipOf({ nodes }, node) : { worktrees: [] as StageNode[] };
  }, [nodes, selectedId]);
  const displayNodes = useMemo(() => orderNodes(projectNodes(nodes, observed, stale, executions, executionView, visibleIds).map((node) => ({ ...node, selected: node.id === selectedId || multiSet.has(node.id),
    data: { ...node.data,
      ...(createsWorktree(node) && !node.data.repoPath ? { inheritedRepo: worktreeRepo({ nodes }, node) } : {}),
      // The selected node shows where it belongs, and the groups it belongs to light up.
      ...(node.id === selectedId && !isGroup(node) && (selectedMembership.project || selectedMembership.worktrees.length)
        ? { membership: { project: selectedMembership.project ? selectedMembership.project.data.label || '이름 없는 프로젝트' : undefined,
          worktrees: selectedMembership.worktrees.map((group) => group.data.label || '이름 없는 워크트리') } } : {}),
      ...(node.id === selectedMembership.project?.id || selectedMembership.worktrees.some((group) => group.id === node.id) ? { ancestor: true } : {}) },
    // Groups sit under every stage (deeper groups above shallower ones), including stages that only overlap them.
    // Memo groups sit under everything, groups included.
    ...(isGroup(node) ? { zIndex: groupDepth(node) - maxGroupDepth - 2 } : isFrame(node) ? { zIndex: -maxGroupDepth - 4 } : {}) }))), [nodes, observed, stale, executions, executionView, visibleIds, selectedId, multiSet, selectedMembership]);
  const displayEdges = useMemo(() => edges.map((edge) => {
    const target = displayNodes.find((node) => node.id === edge.target);
    const source = displayNodes.find((node) => node.id === edge.source);
    const active = target?.data.status === 'running' && source?.data.status === 'completed';
    // A branch edge is conditional (dashed amber); once the shown execution decided it, taken stays bright and untaken fades.
    const output = source && isBranch(source) ? source.data.outputs?.find((item) => item.id === edge.sourceHandle) : undefined;
    const taken = !!output && !!source?.data.decision?.includes(output.id);
    const dead = (!!output && !!source?.data.decision && !taken) || target?.data.status === 'skipped' || source?.data.status === 'skipped';
    if (edge.loop) {
      // A loop goes back: violet, dashed, labelled with its output and limit.
      const loopStroke = dead ? '#4a4258' : '#b996f2';
      return { ...edge, selected: edge.id === selectedEdgeId, type: 'smoothstep', label: `↺ ${edge.label || output?.label || edge.sourceHandle} · 최대 ${edge.loop.max}회`,
        labelStyle: { fill: dead ? '#6b7680' : '#d9c7fb', fontSize: 10 }, labelBgStyle: { fill: '#1b2128' },
        markerEnd: { type: MarkerType.ArrowClosed, color: loopStroke }, style: { stroke: loopStroke, strokeWidth: taken ? 2 : 1.4, strokeDasharray: '4 3', ...(dead ? { opacity: 0.5 } : {}) } };
    }
    const stroke = dead ? '#3a434b' : active ? '#76d8bc' : output ? '#e3b45f' : '#414b54';
    return { ...edge, selected: edge.id === selectedEdgeId, animated: active, type: 'smoothstep',
      label: edge.label || output?.label, ...(output ? { labelStyle: { fill: dead ? '#6b7680' : '#f0d49b', fontSize: 10 }, labelBgStyle: { fill: '#1b2128' } } : {}),
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke === '#414b54' ? '#49545c' : stroke },
      style: { stroke, strokeWidth: active || taken ? 2 : 1.4, ...(output && !taken ? { strokeDasharray: '6 4' } : {}), ...(dead ? { opacity: 0.5, strokeDasharray: '3 5' } : {}) } };
  }), [edges, displayNodes, selectedEdgeId]);
  const counts = displayNodes.filter(isExecutable).reduce((totals, node) => { const key = node.data.status ?? 'unbound'; totals[key] = (totals[key] ?? 0) + 1; return totals; }, {} as Partial<Record<StageStatus, number>>);
  const stageCount = nodes.filter(isExecutable).length;
  const workflowName = useCallback((id?: string) => id ? (id === workflow.id ? workflow.name : saved.find((item) => item.id === id)?.name) : undefined, [saved, workflow.id, workflow.name]);
  const selectedGroup = selected && isGroup(selected) ? selected : undefined;
  const selectedFrame = selected && isFrame(selected) ? selected : undefined;
  const parentGroup = selectedGroup ? groupOf({ nodes }, selectedGroup) : undefined;
  const ownerProject = selectedGroup ? membershipOf({ nodes }, selectedGroup).project : undefined;
  // A worktree group inside a project group only offers that project's worktrees.
  const locationOptions = selectedGroup ? (selectedGroup.data.scope === 'worktree'
    ? locations.worktrees.filter((item) => !ownerProject?.data.ref || item.repoId === ownerProject.data.ref) : locations.projects) : [];
  /** Project a create-mode group would use if it names none itself. */
  const inheritedRepoOf = (group: StageNode) => { const parent = groupOf({ nodes }, group); return parent ? worktreeRepo({ nodes }, parent) : ''; };
  const selectedProjected = displayNodes.find((node) => node.id === selectedId);
  const selectedTaskId = selected ? (activeExecution ? activeExecution.bindings[selected.id] : selected.data.taskId) : undefined;

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
        api<Locations>('/api/locations', { signal: controller.signal }),
      ]);
      if (cancelled) return;
      const [health, runList, files, places] = results;
      if (places.status === 'fulfilled') setLocations(places.value);
      if (health.status === 'fulfilled') { setConnection(health.value); setConnectionError(health.value.connected ? '' : 'Orca가 준비되지 않았습니다.'); }
      else { setConnection({ connected: false }); setConnectionError(health.reason.message); }
      if (runList.status === 'fulfilled') setRuns(runList.value);
      else setConnectionError(runList.reason.message);
      if (files.status === 'fulfilled') {
        setSaved(files.value);
        // Open the last-used saved document once at startup instead of the sample graph.
        if (!restored.current) {
          restored.current = true;
          const last = lastWorkflow();
          const target = files.value.find((item) => item.id === last) ?? files.value[0];
          if (target) api<Workflow>(`/api/workflows/${target.id}`, { signal: controller.signal })
            .then((graph) => { if (!cancelled) applyWorkflow(graph, true); }).catch(() => {});
        }
      }
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

  // The other Runs: polled like the selected one until every execution in them has finished, then left as last seen.
  const executionsRef = useRef(executions);
  executionsRef.current = executions;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const otherRuns = workflowRuns(workflow).filter((runId) => runId !== workflow.runId).join(',');
  useEffect(() => {
    const runIds = otherRuns ? otherRuns.split(',') : [];
    setOtherSnapshots((value) => Object.fromEntries(Object.entries(value).filter(([runId]) => runIds.includes(runId))));
    if (!runIds.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const settled = new Set<string>();
    async function refresh() {
      await Promise.all(runIds.filter((runId) => !settled.has(runId)).map(async (runId) => {
        try {
          const result = await api<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}`, { signal: controller.signal });
          if (cancelled) return;
          setOtherSnapshots((value) => ({ ...value, [runId]: result }));
          const mine = executionsRef.current.filter((execution) => execution.runId === runId);
          if (mine.every((execution) => executionFinished(computeExecutionStatuses(nodesRef.current, execution, result, false)))) settled.add(runId);
        } catch { /* keep the last snapshot; Tasks never seen read as 상태 미확인 */ }
      }));
      if (!cancelled && settled.size < runIds.length) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [otherRuns]);

  // Pick up what the coordinator (or an automation's coordinator) registers — Run, executions — and automation changes,
  // without touching local graph edits. Fast right after 실행, slower otherwise.
  const currentRef = useRef(current);
  currentRef.current = current;
  const savedRef = useRef(savedFingerprint);
  savedRef.current = savedFingerprint;
  useEffect(() => {
    if (!saved.some((item) => item.id === workflow.id)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = workflow.id;
    async function poll() {
      try {
        const doc = await api<Workflow>(`/api/workflows/${id}`);
        if (cancelled) return;
        const latest = currentRef.current;
        const runtime = (graph: Workflow) => JSON.stringify([graph.runId, graph.executions ?? [], graph.automations ?? []]);
        if (latest.id === id && runtime(doc) !== runtime(latest)) {
          const wasClean = JSON.stringify(latest) === savedRef.current;
          const merged = { runId: doc.runId, executions: doc.executions, automations: doc.automations };
          setWorkflow((value) => ({ ...value, ...merged }));
          if (wasClean) setSavedFingerprint(JSON.stringify(serializableWorkflow({ ...latest, ...merged })));
          if (doc.runId !== latest.runId || JSON.stringify(doc.executions ?? []) !== JSON.stringify(latest.executions ?? [])) { setView('all'); setWatchUntil(0); }
        }
      } catch { /* try again on the next tick */ }
      if (!cancelled) timer = setTimeout(poll, Date.now() < watchUntil ? 3000 : 10000);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [watchUntil, workflow.id, saved]);
  useEffect(() => {
    if (!watchUntil) return;
    const timer = setTimeout(() => setWatchUntil(0), Math.max(0, watchUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [watchUntil]);
  // Orca's view of this workflow's automations (enabled, next/last run).
  const [automationStates, setAutomationStates] = useState<Record<string, AutomationState | null>>({});
  const automationKey = JSON.stringify((workflow.automations ?? []).map((item) => item.orcaId));
  useEffect(() => {
    if (!workflow.automations?.length) { setAutomationStates({}); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<{ automations: (AutomationConfig & { state: AutomationState | null })[] }>(`/api/workflows/${workflow.id}/automations`);
        if (!cancelled) setAutomationStates(Object.fromEntries(result.automations.map((item) => [item.id, item.state])));
      } catch { /* keep the last view */ }
      if (!cancelled) timer = setTimeout(refresh, 30000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workflow.id, automationKey]);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === connection.target) { setNotice('다른 단계에 연결하세요.'); return; }
    const source = nodesRef.current.find((node) => node.id === connection.source);
    if (source && isBranch(source) && !connection.sourceHandle) { setNotice('분기의 출력에서 연결을 시작하세요.'); return; }
    setEdges((items) => {
      // A connection back to a stage that already leads here would close a cycle: it can only be a loop from a branch output.
      const closes = loopBody(items, { source: connection.source, target: connection.target }).includes(connection.source);
      if (!closes) return addEdge({ ...connection, id: crypto.randomUUID() }, items);
      if (!source || !isBranch(source) || (source.data.mode ?? 'exclusive') !== 'exclusive') {
        setNotice('연결이 순환합니다. 되돌아가려면 「하나만」 고르는 분기의 출력에서 앞 단계로 연결하세요.'); return items;
      }
      if (items.some((edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle)) {
        setNotice('되돌아가기 연결은 다른 연결이 없는 분기 출력에서만 만들 수 있습니다. 반복용 출력을 하나 더 만드세요.'); return items;
      }
      const exit = (source.data.outputs ?? []).find((output) => output.id !== connection.sourceHandle);
      if (!exit) { setNotice('되돌아가기에는 반복을 다 썼을 때 갈 출력이 하나 더 필요합니다.'); return items; }
      setNotice(`되돌아가기 연결을 만들었습니다(최대 3회, 초과 시 「${exit.label || exit.id}」). 연결을 선택해 바꿀 수 있습니다.`);
      return addEdge({ ...connection, id: crypto.randomUUID(), loop: { max: 3, exit: exit.id } } as WorkflowEdge, items);
    });
  }, [setEdges]);

  // Natural-language generation: Orca launches an agent that sends its result back to the server; the canvas polls and applies it.
  const [generations, setGenerations] = useState<GenerationState[]>([]);
  const [generateDialog, setGenerateDialog] = useState(false);
  const [generateForm, setGenerateForm] = useState({ prompt: '', project: '' });
  const [briefForm, setBriefForm] = useState<{ nodeId: string; prompt: string; project: string } | null>(null);
  /** Where the agent starts: the stage's project group, the workflow's default, the last used project, else the first one Orca has open. */
  function defaultProject(node?: StageNode) {
    const paths = locations.projects.map((item) => item.path);
    const group = node ? membershipOf({ nodes }, node).project : undefined;
    return [group?.data.path, workflow.workspace, lastProject()].find((path) => path && paths.includes(path)) ?? paths[0] ?? '';
  }
  async function startGeneration(kind: 'workflow' | 'brief', prompt: string, project: string, node?: StageNode): Promise<boolean> {
    try {
      const item = await api<GenerationState>('/api/generations', { method: 'POST',
        body: JSON.stringify({ kind, prompt, project, ...(node ? { nodeId: node.id, workflow: current } : {}) }) });
      setGenerations((list) => [...list, { ...item, ...(node ? { before: node.data.description } : {}) }]);
      rememberProject(project);
      setNotice(kind === 'workflow' ? 'Orca에서 워크플로 생성 에이전트를 띄웠습니다. 끝나면 캔버스에 엽니다.' : 'Orca에서 지침 생성 에이전트를 띄웠습니다. 끝나면 이 단계에 반영합니다.');
      return true;
    } catch (error) { setNotice((error as Error).message); return false; }
  }
  const pendingGenerations = generations.filter((item) => item.status === 'pending').map((item) => item.id).join(',');
  useEffect(() => {
    if (!pendingGenerations) return;
    let cancelled = false;
    const timer = setInterval(() => {
      for (const id of pendingGenerations.split(',')) {
        api<GenerationState>(`/api/generations/${id}`)
          .catch((error: Error) => ({ status: 'failed' as const, error: error.message }))
          .then((result) => { if (!cancelled && result.status !== 'pending') setGenerations((list) => list.map((item) => item.id === id ? { ...item, ...result, before: item.before } : item)); });
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pendingGenerations]);
  // Apply each finished generation once.
  const appliedGenerations = useRef(new Set<string>());
  useEffect(() => {
    for (const item of generations) {
      if (item.status === 'pending' || appliedGenerations.current.has(item.id)) continue;
      appliedGenerations.current.add(item.id);
      if (item.status === 'failed') { setNotice(`생성 실패: ${item.error ?? '알 수 없는 오류'}`); continue; }
      if (item.kind === 'workflow' && item.workflowId) {
        void api<{ id: string; name: string }[]>('/api/workflows').then(setSaved).catch(() => {});
        if (!dirty) void load(item.workflowId);
        else setNotice('워크플로를 만들어 저장했습니다. 지금 캔버스에 저장하지 않은 변경이 있어 열지 않았습니다. 사이드바에서 여세요.');
        continue;
      }
      const node = nodes.find((candidate) => candidate.id === item.nodeId);
      if (!node || item.description === undefined) { setNotice('지침을 만들었지만 그 단계가 캔버스에 없어 반영하지 못했습니다.'); continue; }
      if (node.data.description !== (item.before ?? '') && node.data.description.trim()
        && !window.confirm(`「${node.data.label}」 지침을 그사이 직접 고쳤습니다. 생성한 지침으로 바꿀까요?`)) continue;
      // A suggested name replaces only a default or empty one.
      const rename = item.label && (!node.data.label.trim() || node.data.label === kindNames[node.data.kind]);
      setNodes((list) => list.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, description: item.description!, ...(rename ? { label: item.label! } : {}) } } : candidate));
      setNotice(`「${rename ? item.label : node.data.label}」 지침을 생성했습니다. 저장하면 반영됩니다.`);
    }
  }, [generations]);
  function applyWorkflow(graph: Workflow, persisted: boolean) {
    graph = { ...graph, nodes: normalizeNodes(graph.nodes) };
    setWorkflow(graph); setNodes(graph.nodes); setEdges(graph.edges); setView('all');
    setSelectedId(graph.nodes[0]?.id ?? null); setSelectedEdgeId(null); setMultiIds([]);
    setSavedFingerprint(persisted ? JSON.stringify(serializableWorkflow(graph)) : '');
    setTimeout(() => { void fitView({ padding: 0.25, duration: 300 }); }, 80);
  }
  function confirmReplace() { return !dirty || window.confirm('저장하지 않은 변경 내용이 있습니다. 캔버스를 바꿀까요?'); }
  async function save(doc: Workflow = current): Promise<boolean> {
    setBusy(true);
    try {
      await api(`/api/workflows/${doc.id}`, { method: 'PUT', body: JSON.stringify(doc) });
      setSavedFingerprint(JSON.stringify(doc));
      rememberWorkflow(doc.id);
      setSaved(await api('/api/workflows'));
      setNotice('워크플로를 로컬에 저장했습니다.');
      return true;
    } catch (error) { setNotice((error as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function load(id: string) {
    if (!confirmReplace()) return;
    setBusy(true);
    try { applyWorkflow(await api<Workflow>(`/api/workflows/${id}`), true); rememberWorkflow(id); closeDrawer(); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  function addNode(kind: StageKind) {
    const id = crypto.randomUUID();
    const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
    const position = screenToFlowPosition({ x: pane.x + pane.width * 0.45, y: pane.y + pane.height * 0.4 });
    setNodes((items) => [...items, { id, type: 'stage', position, data: { label: kindNames[kind], description: '', kind, ...(kind === 'branch' ? branchDefaults() : {}) } }]);
    setSelectedId(id); setSelectedEdgeId(null);
  }
  function addGroup(scope: GroupScope) {
    const id = crypto.randomUUID();
    const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
    const position = screenToFlowPosition({ x: pane.x + pane.width * 0.3, y: pane.y + pane.height * 0.25 });
    // Groups go first: React Flow renders parents before their children.
    setNodes((items) => [{ id, type: 'group', position, width: 640, height: 360, data: { label: scopeNames[scope], description: '', kind: 'group', scope, path: '' } }, ...items]);
    setSelectedId(id); setSelectedEdgeId(null);
  }
  function addFrame() {
    const id = crypto.randomUUID();
    const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
    const position = screenToFlowPosition({ x: pane.x + pane.width * 0.3, y: pane.y + pane.height * 0.25 });
    setNodes((items) => [{ id, type: 'frame', position, width: 560, height: 320, data: { label: kindNames.frame, description: '', kind: 'frame' } }, ...items]);
    setSelectedId(id); setSelectedEdgeId(null);
  }
  // Dragging memo groups carries what lay inside them when the drag started (except nodes already moving with the selection).
  const frameDrag = useRef<{ id: string; start: { x: number; y: number }; items: Map<string, { x: number; y: number }> } | null>(null);
  function startDrag(grabbed: StageNode, dragged: StageNode[]) {
    frameDrag.current = null;
    const frames = dragged.filter(isFrame);
    if (!frames.length) return;
    const rects = new Map<string, Rect>();
    for (const node of nodes) {
      const internal = getInternalNode(node.id);
      if (internal) rects.set(node.id, { ...internal.internals.positionAbsolute, width: internal.measured.width ?? node.width ?? 0, height: internal.measured.height ?? node.height ?? 0 });
    }
    const moving = new Set(dragged.map((node) => node.id));
    const carried = new Set(frames.flatMap((frame) => frameContents(frame.id, nodes, rects)).filter((id) => !moving.has(id)));
    frameDrag.current = { id: grabbed.id, start: { ...grabbed.position },
      items: new Map(nodes.filter((node) => carried.has(node.id)).map((node) => [node.id, { ...node.position }])) };
  }
  function dragFrame(dragged: StageNode[]) {
    const drag = frameDrag.current;
    const grabbed = drag && dragged.find((node) => node.id === drag.id);
    if (!drag || !grabbed || !drag.items.size) return;
    const dx = grabbed.position.x - drag.start.x, dy = grabbed.position.y - drag.start.y;
    setNodes((items) => items.map((node) => { const origin = drag.items.get(node.id); return origin ? { ...node, position: { x: origin.x + dx, y: origin.y + dy } } : node; }));
  }
  function stopDrag(dragged: StageNode[]) {
    const drag = frameDrag.current;
    frameDrag.current = null;
    for (const node of dragged) if (!isFrame(node)) regroup(node.id);
    // Carried stages may have left (or entered) a project/worktree group; settle that once the moved positions are measured.
    if (drag?.items.size) requestAnimationFrame(() => { for (const id of drag.items.keys()) regroup(id); });
  }
  /** Dropping a stage inside a group puts it in that group; dropping it outside takes it out. */
  function regroup(id: string) {
    const dragged = getInternalNode(id);
    if (!dragged || isFrame(dragged)) return;
    // A project group never goes inside anything; a worktree group goes in a project or another worktree.
    if (isGroup(dragged) && dragged.data.scope !== 'worktree') return;
    const absolute = dragged.internals.positionAbsolute;
    const center = { x: absolute.x + (dragged.measured.width ?? 254) / 2, y: absolute.y + (dragged.measured.height ?? 150) / 2 };
    const inside = (node: StageNode) => { for (let p = groupOf({ nodes }, node), d = 0; p && d <= maxGroupDepth; p = groupOf({ nodes }, p), d += 1) if (p.id === id) return true; return false; };
    const candidates = nodes.filter((node) => isGroup(node) && node.id !== id && canNest(dragged, node) && !inside(node)
      // Never exceed the nesting limit (a dragged group brings its own depth along).
      && groupDepth(node) + 1 <= maxGroupDepth)
      // Innermost first: the deepest group under the pointer wins.
      .sort((a, b) => groupDepth(b) - groupDepth(a));
    const target = candidates.map((group) => getInternalNode(group.id)).find((group) => {
      if (!group) return false;
      const { x, y } = group.internals.positionAbsolute;
      return center.x >= x && center.x <= x + (group.measured.width ?? 0) && center.y >= y && center.y <= y + (group.measured.height ?? 0);
    });
    if ((target?.id ?? undefined) === (dragged.parentId ?? undefined)) return;
    const origin = target?.internals.positionAbsolute ?? { x: 0, y: 0 };
    setNodes((items) => items.map((node) => node.id === id
      ? { ...node, parentId: target?.id, position: { x: absolute.x - origin.x, y: absolute.y - origin.y } } : node));
  }
  const openTask = useCallback(async (taskId: string) => {
    // A Task belongs to the Run of the execution that bound it; node.data.taskId bindings use the selected Run.
    const owner = executions.find((execution) => Object.values(execution.bindings).includes(taskId)
      || Object.values(execution.links ?? {}).some((tasks) => Object.values(tasks).includes(taskId)));
    const runId = owner ? executionRun(workflow, owner) : workflow.runId;
    if (!runId) return;
    try {
      await api(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/open`, { method: 'POST' });
      setNotice('Orca에서 실행 화면을 열었습니다.');
    } catch (error) { setNotice((error as Error).message); }
  }, [workflow, executions]);
  function clickNode(id: string, additive: boolean) {
    // ⌘/Ctrl 클릭 toggles the node in the selection (already applied through handleNodesChange); it never opens a task.
    if (additive) return;
    setSelectedId(id); setSelectedEdgeId(null); setMultiIds([]);
    const node = displayNodes.find((item) => item.id === id);
    if (!node || !isExecutable(node)) return;
    if (node.data.activeTaskId && openableStatuses.includes(node.data.status ?? 'unbound')) { void openTask(node.data.activeTaskId); return; }
    const running = (node.data.runs ?? []).filter((run) => run.taskId && openableStatuses.includes(run.status));
    if (running.length === 1) void openTask(running[0].taskId!);
    else if (running.length > 1) setNotice('실행 중인 실행이 여러 개입니다. 노드의 칩을 눌러 열 실행을 고르세요.');
  }
  /** 실행 always asks where to run (and, if needed, worktree names and clean-up) before anything starts. */
  function openRunDialog() {
    if (!nodes.some(isExecutable)) { setNotice('실행할 단계가 없습니다.'); return; }
    const unlinked = nodes.find((node) => node.data.kind === 'workflow' && !node.data.workflowId);
    if (unlinked) { setNotice(`'${unlinked.data.label}' 링크 노드에 연결할 워크플로를 고르세요.`); return; }
    if (missingLinkTarget()) return;
    const remembered = lastProject();
    const preferred = [workflow.workspace, remembered].find((path) => path && locations.projects.some((item) => item.path === path)) ?? '';
    setRunForm((form) => ({ ...form, project: preferred, cleanup: workflow.cleanup ?? defaultCleanup,
      inputs: Object.fromEntries(nodes.filter(asksAtRun).map((node) => [node.id, form.inputs[node.id] ?? ''])),
      values: Object.fromEntries((workflow.variables ?? []).map((item) => [item.key, form.values[item.key] ?? ''])),
      name: form.name || '정기 실행' }));
    setRunDialog(true);
  }
  async function submitRun() {
    const form = runForm;
    if (!form.project) { setNotice('실행할 프로젝트를 고르세요.'); return; }
    const badInput = Object.entries(form.inputs).find(([, value]) => value && !worktreeNamePattern.test(value));
    if (badInput) { setNotice('워크트리 이름은 영문·숫자·. _ - 만 쓸 수 있고 -로 시작할 수 없습니다.'); return; }
    const missingValue = (workflow.variables ?? []).find((item) => item.required && !form.values[item.key]?.trim() && !item.default?.trim());
    if (missingValue) { setNotice(`필수 설정값 「${missingValue.label}」을(를) 입력하세요.`); return; }
    const values = Object.fromEntries(Object.entries(form.values).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
    // The chosen clean-up becomes this workflow's default; save first so the server runs exactly what is on screen.
    const doc = serializableWorkflow({ ...current, cleanup: form.cleanup });
    if (JSON.stringify(doc) !== savedFingerprint) { setWorkflow((value) => ({ ...value, cleanup: form.cleanup })); if (!(await save(doc))) return; }
    rememberProject(form.project);
    const inputs = Object.fromEntries(Object.entries(form.inputs).filter(([, value]) => value));
    setBusy(true);
    try {
      if (form.mode === 'now') {
        await api(`/api/workflows/${doc.id}/execute`, { method: 'POST', body: JSON.stringify({ count: form.count, project: form.project, inputs, values, cleanup: form.cleanup }) });
        setWatchUntil(Date.now() + 5 * 60_000);
        setNotice(`코디네이터를 띄웠습니다. ${form.count}회 실행이 등록되면 그래프에 표시됩니다.`);
      } else {
        const trigger = form.trigger === 'cron' ? form.cron.trim() : form.trigger;
        const result = await api<Workflow>(`/api/workflows/${doc.id}/automations`, { method: 'POST', body: JSON.stringify({
          name: form.name, trigger, ...(['daily', 'weekdays', 'weekly'].includes(form.trigger) ? { time: form.time } : {}),
          ...(form.trigger === 'weekly' ? { day: form.day } : {}), count: form.count, project: form.project, inputs, values, cleanup: form.cleanup }) });
        setWorkflow((value) => ({ ...value, automations: result.automations }));
        setSavedFingerprint(JSON.stringify(serializableWorkflow({ ...doc, automations: result.automations })));
        setNotice(`자동화 「${form.name}」을(를) Orca에 등록했습니다.`);
      }
      setRunDialog(false);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  async function automationAction(config: AutomationConfig, action: 'run' | 'remove') {
    if (action === 'remove' && !window.confirm(`자동화 「${config.name}」을(를) 삭제할까요? Orca의 예약과 실행 기록도 지워집니다.`)) return;
    try {
      if (action === 'run') { await api(`/api/workflows/${workflow.id}/automations/${config.id}/run`, { method: 'POST' }); setWatchUntil(Date.now() + 5 * 60_000); setNotice(`자동화 「${config.name}」을(를) 지금 실행했습니다.`); }
      else {
        const result = await api<Workflow>(`/api/workflows/${workflow.id}/automations/${config.id}`, { method: 'DELETE' });
        const wasClean = JSON.stringify(current) === savedFingerprint;
        setWorkflow((value) => ({ ...value, automations: result.automations }));
        if (wasClean) setSavedFingerprint(JSON.stringify(serializableWorkflow({ ...current, automations: result.automations })));
        setNotice(`자동화 「${config.name}」을(를) 삭제했습니다.`);
      }
    } catch (error) { setNotice((error as Error).message); }
  }
  async function removeWorkflow(id: string, name: string) {
    if (!window.confirm(`'${name}' 워크플로를 삭제할까요? 저장 파일이 지워지며 되돌릴 수 없습니다. Orca의 Run과 Task는 그대로 남습니다.`)) return;
    setBusy(true);
    try {
      await api(`/api/workflows/${id}`, { method: 'DELETE' });
      const files = await api<{ id: string; name: string }[]>('/api/workflows');
      setSaved(files);
      if (id === workflow.id) {
        const next = files[0];
        if (next) { applyWorkflow(await api<Workflow>(`/api/workflows/${next.id}`), true); rememberWorkflow(next.id); }
        else applyWorkflow(blankWorkflow(), false);
      }
      setNotice(`'${name}' 워크플로를 삭제했습니다.`);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  function bindTask(taskId: string | undefined) {
    if (!activeExecution) { updateNode({ taskId }); return; }
    setWorkflow((value) => ({ ...value, executions: (value.executions ?? []).map((execution: Execution) => {
      if (execution.id !== activeExecution.id || !selectedId) return execution;
      const bindings = { ...execution.bindings };
      if (taskId) bindings[selectedId] = taskId; else delete bindings[selectedId];
      return { ...execution, bindings };
    }) }));
  }
  function changeKind(kind: StageKind) {
    if (!selected) return;
    if (kind === 'branch' && !selected.data.outputs?.length) { updateNode({ kind, ...branchDefaults() }); return; }
    updateNode({ kind });
    // Leaving branch: its edges go back to the single source port.
    if (isBranch(selected) && kind !== 'branch') setEdges((items) => items.map((edge) => edge.source === selected.id ? { ...edge, sourceHandle: null } : edge));
  }
  function removeOutput(outputId: string) {
    if (!selected) return;
    updateNode({ outputs: (selected.data.outputs ?? []).filter((item) => item.id !== outputId) });
    // Its edges go with it; a loop that fell back to it falls back to another remaining output (or stops being possible).
    const others = (selected.data.outputs ?? []).filter((item) => item.id !== outputId);
    setEdges((items) => items.filter((edge) => !(edge.source === selected.id && edge.sourceHandle === outputId))
      .flatMap((edge) => edge.source !== selected.id || edge.loop?.exit !== outputId ? [edge]
        : others.some((item) => item.id !== edge.sourceHandle) ? [{ ...edge, loop: { ...edge.loop, exit: others.find((item) => item.id !== edge.sourceHandle)!.id } }] : []));
  }
  function updateNode(data: Partial<StageNode['data']>) {
    setNodes((items) => items.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, ...data } } : node));
  }
  function missingLinkTarget(): boolean {
    const missing = nodes.find((node) => node.data.kind === 'workflow' && node.data.workflowId && !workflowName(node.data.workflowId));
    if (missing) setNotice(`'${missing.data.label}' 링크가 가리키는 워크플로가 저장되어 있지 않습니다.`);
    return !!missing;
  }
  function removeSelected() {
    const ids = new Set(multiSet.size ? multiSet : selectedId ? [selectedId] : []);
    if (ids.size) {
      const byId = new Map(nodes.map((node) => [node.id, node]));
      // Deleting a group keeps what was inside: it moves up to the nearest surviving parent (or the canvas) at the same place.
      setNodes((items) => items.filter((node) => !ids.has(node.id)).map((node) => {
        let { parentId, position } = node;
        for (let parent = parentId ? byId.get(parentId) : undefined; parent && ids.has(parent.id); parent = parentId ? byId.get(parentId) : undefined) {
          position = { x: position.x + parent.position.x, y: position.y + parent.position.y };
          parentId = parent.parentId;
        }
        return parentId === node.parentId ? node : { ...node, parentId, position };
      }));
      setEdges((items) => items.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)));
      setSelectedId(null); setMultiIds([]);
      if (ids.size > 1) setNotice(`노드 ${ids.size}개를 삭제했습니다.`);
    } else if (selectedEdgeId) {
      setEdges((items) => items.filter((edge) => edge.id !== selectedEdgeId)); setSelectedEdgeId(null);
    }
  }
  /** React Flow reports clicks, ⌘/Ctrl 클릭 and the drag box as select changes; they become our selection (one → inspector, more → multiIds). */
  function handleNodesChange(changes: NodeChange<StageNode>[]) {
    const picks = changes.filter((change) => change.type === 'select');
    if (picks.length) {
      const next = new Set(selection.current);
      for (const change of picks) if (change.selected) next.add(change.id); else next.delete(change.id);
      const ids = [...next];
      if (ids.length !== selection.current.length || ids.some((id) => !selection.current.includes(id))) {
        selection.current = ids;
        if (ids.length > 1) { setSelectedId(null); setMultiIds(ids); } else { setSelectedId(ids[0] ?? null); setMultiIds([]); }
        if (ids.length) setSelectedEdgeId(null);
      }
    }
    onNodesChange(changes);
  }
  function changeRun(runId: string) {
    if (runId === workflow.runId) return;
    if ((nodes.some((node) => node.data.taskId) || executions.length) && !window.confirm('Run을 바꾸면 기존 Task 연결이 해제됩니다. 계속할까요?')) return;
    setSnapshot(null);
    setWorkflow((value) => ({ ...value, runId, executions: undefined }));
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

  const canvasContext = useMemo(() => ({ openTask, workflowName, viewOnly }), [openTask, workflowName, viewOnly]);
  /** 소속: the project and worktree groups of the selected node; clicking one selects that group. */
  function membership() {
    const { project, worktrees } = selectedMembership;
    const describe = (group: StageNode) => createsWorktree(group)
      ? `${group.data.nameSource === 'agent' ? '에이전트가 이름 결정' : group.data.nameSource === 'input' ? '실행 시 입력' : `새로 생성 「${group.data.worktreeName || `wf-${group.id.slice(0, 8)}`}」`}${group.data.perExecution ? ' · 실행마다' : ''}`
      : group.data.path ? shortPath(group.data.path) : '대상 미지정';
    const row = (group: StageNode | undefined, scope: GroupScope) => {
      const Icon = scope === 'worktree' ? GitBranch : FolderGit2;
      return group
        ? <button className={`member-row ${scope}`} title={`${group.data.path || group.data.repoPath || ''}`} onClick={() => { setSelectedId(group.id); setSelectedEdgeId(null); setMultiIds([]); }}>
            <Icon size={14} /><span className="member-kind">{scope === 'worktree' ? '워크트리' : '프로젝트'}</span><strong>{group.data.label || '이름 없는 그룹'}</strong><small>{describe(group)}</small></button>
        : <div className={`member-row empty ${scope}`}><Icon size={14} /><span className="member-kind">{scope === 'worktree' ? '워크트리' : '프로젝트'}</span><small>없음</small></div>;
    };
    return <div className="membership" aria-label="소속"><span className="field-label">소속</span>
      {row(project, 'project')}
      {worktrees.length ? worktrees.map((group, index) => <div key={group.id} className="member-nest" style={{ paddingLeft: index * 12 }}>{row(group, 'worktree')}</div>)
        : selectedGroup?.data.scope !== 'worktree' && row(undefined, 'worktree')}
      {selectedGroup && worktrees.length > 0 && <p className="field-help">워크트리 「{worktrees[worktrees.length - 1].data.label}」의 하위 워크트리로 Orca에서 만들어집니다.</p>}
      {!project && !worktrees.length && selected && !isGroup(selected) && <p className="field-help">어느 그룹에도 속하지 않아 실행할 때 고른 프로젝트에서 작업합니다.</p>}</div>;
  }
  return <CanvasContext.Provider value={canvasContext}><div className="workspace">
    <main className="main">
      <header className="topbar"><div className="topbar-title"><button className="icon-button mobile-menu" aria-label="메뉴 열기" aria-expanded={panels.left} onClick={() => setPanels((value) => ({ ...value, left: !value.left }))}><Menu size={20} /></button>
          <div className="title-block"><input className="workflow-name" aria-label="워크플로 이름" value={workflow.name} maxLength={500} disabled={viewOnly} onChange={(event) => setWorkflow((value) => ({ ...value, name: event.target.value }))} />
            <p title={workflow.description}>{workflow.description || '단계를 연결해 작업의 흐름을 만드세요.'}</p></div>
          <div className="heading-stats"><span><i className="status-dot running" />실행 {counts.running ?? 0}</span><span><Check size={14} />완료 {counts.completed ?? 0}</span><span className="total">{stageCount} 단계</span></div></div>
        <div className="toolbar-actions"><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
          <button className="button ghost file-action" onClick={() => importRef.current?.click()} title="JSON 가져오기"><ArrowUpFromLine size={15} /><span>가져오기</span></button>
          <button className="button ghost file-action" onClick={download} title="JSON 내보내기"><ArrowDownToLine size={15} /><span>내보내기</span></button>
          {saved.some((item) => item.id === workflow.id) && <button className="button ghost" onClick={() => setLogOpen(true)} title="실행 요청별 이벤트·산출물·보고"><History size={15} /><span>실행 로그</span></button>}
          <button className="button run" onClick={openRunDialog} disabled={busy || watchUntil > 0} title="프로젝트를 고르고 지금 실행하거나 자동화로 예약합니다"><Play size={15} />{watchUntil > 0 ? '등록 대기' : '실행'}</button>
          {saved.some((item) => item.id === workflow.id) && <button className="icon-button" title="이 워크플로 삭제" aria-label="이 워크플로 삭제" onClick={() => void removeWorkflow(workflow.id, workflow.name)} disabled={busy}><Trash2 size={16} /></button>}
          <button className="button primary" onClick={() => void save()} disabled={busy}><Save size={15} />{busy ? '저장 중' : '저장'}{dirty && <span className="unsaved-dot" />}</button>
        </div>
      </header>
      {(snapshotError || connectionError) && <div className="error-banner" role="alert"><CircleHelp size={15} />{snapshotError || connectionError}</div>}
      <div className={`editor-body ${panels.left ? 'left-open' : 'left-closed'} ${panels.right ? 'right-open' : 'right-closed'} ${viewOnly ? 'view-only' : ''}`}>
        <section className="canvas" aria-label="워크플로 그래프 캔버스">
          <div className="canvas-tools" role="toolbar" aria-label="추가">
            <span className="tool-group-label">조작</span>
            {([['select', MousePointer2, '선택 (V)', '빈 곳을 드래그해 여러 노드를 선택. 화면 이동은 스크롤·가운데 버튼·Space+드래그'],
              ['pan', Move, '화면 이동 (H)', '드래그로 화면 이동. Shift+드래그로 여러 노드 선택']] as const).map(([mode, Icon, name, tip]) =>
              <button key={mode} className={`tool-button mode-button ${pointerMode === mode ? 'active' : ''}`} aria-label={name} aria-pressed={pointerMode === mode} onClick={() => setPointerMode(mode)}>
                <Icon size={17} /><span className="tool-tip" role="tooltip"><strong>{name}</strong>{tip}</span></button>)}
            <button className={`tool-button mode-button ${viewOnly ? 'active locked' : ''}`} aria-label="보기 전용 (L)" aria-pressed={viewOnly} onClick={() => setViewOnly((value) => !value)}>
              {viewOnly ? <Lock size={17} /> : <Eye size={17} />}<span className="tool-tip" role="tooltip"><strong>보기 전용 (L)</strong>{viewOnly ? '켜짐: 이동·연결·삭제·편집이 막혀 있습니다. 눌러서 편집으로 돌아가기' : '노드 이동·연결·삭제·추가와 속성 편집을 막고 보기만 합니다'}</span></button>
            {!viewOnly && <><span className="tool-divider" /><span className="tool-group-label">노드</span>
            {([['worker', Bot, '워커', '에이전트 하나가 지침을 수행'], ['gate', Hand, '사용자 개입 게이트', '사용자가 통과·거절을 결정'],
              ['branch', Split, '분기', '판정 결과에 따라 출력 하나(또는 여럿)로만 진행. 일반 연결은 모두 병렬'],
              ['workflow', WorkflowIcon, '워크플로 링크', '저장된 다른 워크플로를 펼쳐 실행'], ['note', StickyNote, '메모', '실행과 무관한 설명']] as const).map(([kind, Icon, name, tip]) =>
              <button key={kind} className={`tool-button kind-${kind}`} aria-label={`${name} 추가`} onClick={() => addNode(kind)}>
                <Icon size={17} /><span className="tool-tip" role="tooltip"><strong>{name}</strong>{tip}</span></button>)}
            <span className="tool-divider" /><span className="tool-group-label">그룹</span>
            {([['project', FolderGit2, '프로젝트 그룹', 'Orca에 열린 프로젝트에서 작업. 다른 프로젝트 그룹은 넣을 수 없음'],
              ['worktree', GitBranch, '워크트리 그룹', '기존 워크트리 선택 또는 실행마다 새로 생성. 프로젝트 그룹 안에 넣을 수 있음']] as const).map(([scope, Icon, name, tip]) =>
              <button key={scope} className={`tool-button kind-${scope}`} aria-label={`${name} 추가`} onClick={() => addGroup(scope)}>
                <Icon size={17} /><span className="tool-tip" role="tooltip"><strong>{name}</strong>{tip}</span></button>)}
            <button className="tool-button kind-frame" aria-label="메모 그룹 추가" onClick={addFrame}>
              <Group size={17} /><span className="tool-tip" role="tooltip"><strong>메모 그룹</strong>노드를 묶어 보여 주기만 함. 옮기면 안의 노드가 함께 움직이고, 실행·작업 위치와는 무관</span></button></>}
            <span className="tool-divider" />
            <button className="tool-button" aria-label="전체 보기" onClick={() => void fitView({ padding: 0.25, duration: 300 })}><LayoutDashboard size={17} /><span className="tool-tip" role="tooltip"><strong>전체 보기</strong>모든 노드가 보이게 맞춤</span></button></div>
          {executions.length > 0 && <div className="execution-bar" role="toolbar" aria-label="실행 보기">
            <div className="segmented"><button className={executionView === 'all' ? 'active' : ''} onClick={() => setView('all')}>모아 보기</button>
              <button className={executionView !== 'all' ? 'active' : ''} disabled={!visibleExecutions.length} onClick={() => setView(activeExecution?.id ?? visibleExecutions[0]?.id ?? 'all')}>실행 선택</button></div>
            {finishedCount > 0 && <span className="hide-finished">끝난 실행 {finishedCount}개 숨김</span>}
            {!visibleExecutions.length && <span className="execution-empty">진행 중인 실행이 없습니다</span>}
            {executionView !== 'all' && <div className="execution-chips">{visibleExecutions.map((execution) => <button key={execution.id}
              className={`run-chip ${execution.status} ${execution.id === executionView ? 'active' : ''}`} title={`${statusLabels[execution.status]}${execution.automation ? ` · 자동화 「${execution.automation.name}」` : ''}`}
              onClick={() => setView(execution.id)}><span className="status-dot" />{execution.automation && <Zap size={10} />}{execution.label}</button>)}</div>}
          </div>}
          {pending.length > 0 && <section className="decision-panel" aria-label="결정 대기">
            <header><Hand size={14} />결정 대기 {pending.length}<small>코디네이터는 기다리지 않고 진행하다가 고른 값을 가져갑니다</small></header>
            {pending.map((item) => {
              const key = `${item.executionId}:${item.node}`;
              const picked = picks[key] ?? [];
              const sending = sent.has(key);
              return <article key={key} className="decision-card">
                <div className="decision-title"><span className="run-chip blocked"><span className="status-dot" />{item.executionLabel}</span><strong>{item.label}</strong></div>
                {item.question && <p>{item.question}</p>}
                {item.askedBy && <div className="decision-asker"><Bot size={12} /><span>「{item.askedBy.label}」 워커 터미널에서 묻고 있습니다. 그곳에서 답하거나 여기서 고르세요.</span>
                  {item.askedBy.taskId && <button className="button small" onClick={() => void openTask(item.askedBy!.taskId!)}><ExternalLink size={12} />워커 열기</button>}</div>}
                {item.mode === 'exclusive'
                  ? <div className="decision-options">{item.outputs.map((output) => <button key={output.id} className="button" disabled={sending} onClick={() => void decide(item, [output.id])}>{output.label}</button>)}</div>
                  : <><div className="decision-options">{item.outputs.map((output) => <label key={output.id} className="decision-check"><input type="checkbox" checked={picked.includes(output.id)} disabled={sending}
                      onChange={(event) => setPicks((value) => ({ ...value, [key]: event.target.checked ? [...picked, output.id] : picked.filter((id) => id !== output.id) }))} />{output.label}</label>)}</div>
                    <button className="button primary" disabled={!picked.length || sending} onClick={() => void decide(item, picked)}>선택 확정</button></>}
                {sending && <small className="decision-sent">전달함 · 코디네이터가 반영하면 사라집니다</small>}
              </article>;
            })}
          </section>}
          <div className="canvas-mode"><span className={`status-dot ${workflow.runId && snapshot && !stale ? 'running' : ''}`} />{workflow.runId ? 'Orca 실시간 관찰' : '설계 모드'}
            {activeAutomations.length > 0 && <span className="automation-badge" title="이 자동화가 시작한 실행이 진행 중입니다"><Zap size={11} />자동화 {activeAutomations.map((item) => `「${item.name}」`).join(' ')} 진행 중</span>}</div>
          <ReactFlow<StageNode> nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes} onNodesChange={handleNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeDragStart={(_event, node, dragged) => startDrag(node, dragged)} onNodeDrag={(_event, _node, dragged) => dragFrame(dragged)} onNodeDragStop={(_event, _node, dragged) => stopDrag(dragged)}
            onSelectionDragStart={(_event, dragged) => dragged[0] && startDrag(dragged[0], dragged)} onSelectionDrag={(_event, dragged) => dragFrame(dragged)} onSelectionDragStop={(_event, dragged) => stopDrag(dragged)}
            nodesDraggable={!viewOnly} nodesConnectable={!viewOnly} edgesReconnectable={!viewOnly}
            selectionOnDrag={pointerMode === 'select' && !viewOnly} panOnDrag={pointerMode === 'select' && !viewOnly ? [1, 2] : true} panOnScroll multiSelectionKeyCode={['Meta', 'Control']}
            onBeforeDelete={async () => { if (!viewOnly) removeSelected(); return false; }}
            onNodeClick={(event, node) => clickNode(node.id, event.metaKey || event.ctrlKey)} onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedId(null); setMultiIds([]); }}
            onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); setMultiIds([]); }} elevateNodesOnSelect={false} fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.15} maxZoom={1.6} deleteKeyCode={viewOnly ? null : ['Backspace', 'Delete']} colorMode="dark" proOptions={{ hideAttribution: false }}>
            <Background gap={22} size={1} color="#2c353d" />
            <Controls showInteractive={false} />
            <MiniMap<StageNode> nodeComponent={MiniMapNode} maskColor="rgba(16,20,25,.6)" pannable zoomable />
          </ReactFlow>
          {nodes.length === 0 && !viewOnly && <div className="empty-canvas"><Network size={36} /><h2>첫 단계를 만들어 보세요</h2><p>워커를 추가하고, 프로젝트·워크트리 그룹으로 작업 위치를 묶을 수 있습니다.</p><div className="empty-actions"><button className="button primary" onClick={() => addNode('worker')}><Plus size={16} />워커 추가</button>
            <button className="button" onClick={() => { setGenerateForm((form) => ({ ...form, project: form.project || defaultProject() })); setGenerateDialog(true); }}><Sparkles size={16} />자연어로 만들기</button></div></div>}
          <div className="canvas-hint">{viewOnly ? '보기 전용: 드래그·스크롤로 화면 이동, 클릭으로 선택만 됩니다 · L로 편집 모드 · [ / ]로 패널 접기' : pointerMode === 'select' ? '선택 모드: 빈 곳 드래그로 여러 개 선택 · 스크롤/가운데 버튼·Space+드래그로 화면 이동' : '이동 모드: 드래그로 화면 이동 · Shift+드래그로 여러 개 선택'} · V/H로 모드 전환 · 노드 드래그로 이동 · 단계를 그룹 안에 놓아 작업 위치 지정 · 포트를 연결해 흐름 만들기 · Delete로 삭제 · L 보기 전용 · [ / ]로 패널 접기</div>
        </section>
        <aside className="sidebar floating-panel" hidden={!panels.left} aria-label="워크플로 목록">
          <div className="sidebar-head"><a className="brand" href="/" onClick={(event) => event.preventDefault()}><span className="brand-mark"><Network size={23} /></span><span>workflow<span className="brand-sub">canvas</span></span><span className="version">0.1</span></a><button className="icon-button panel-collapse" title="사이드바 접기 ([)" aria-label="사이드바 접기" onClick={() => setPanels((value) => ({ ...value, left: false }))}><PanelLeftClose size={16} /></button></div>
          <div className="workspace-label"><span className="workspace-avatar">W</span><div>로컬 워크스페이스<small>Orca orchestration</small></div><ChevronRight size={14} /></div>
          <div className="sidebar-section-title">워크플로<span>{saved.length}</span></div>
          <button className="sidebar-item active" onClick={closeDrawer}><GitBranch size={17} /><span title={workflow.name}>{workflow.name}</span><span className="tiny-dot" /></button>
          {saved.filter((item) => item.id !== workflow.id).map((item) => <div className="sidebar-row" key={item.id}><button className="sidebar-item" onClick={() => void load(item.id)}><FileJson2 size={16} /><span>{item.name}</span></button>
            <button className="icon-button row-delete" title="워크플로 삭제" aria-label={`${item.name} 삭제`} onClick={() => void removeWorkflow(item.id, item.name)}><Trash2 size={14} /></button></div>)}
          <button className="sidebar-item subtle" onClick={() => { if (confirmReplace()) applyWorkflow(blankWorkflow(), false); }}><Plus size={16} /><span>새 워크플로</span></button>
          <button className="sidebar-item subtle" onClick={() => { setGenerateForm((form) => ({ ...form, project: form.project || defaultProject() })); setGenerateDialog(true); closeDrawer(); }}>
            <Sparkles size={16} /><span>자연어로 만들기</span>{generations.some((item) => item.kind === 'workflow' && item.status === 'pending') && <LoaderCircle size={13} className="spin" />}</button>
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
          {saved.some((item) => item.id === workflow.id) && <><div className="sidebar-section-title">자동화<span>{workflow.automations?.length ?? 0}</span></div>
            {(workflow.automations ?? []).map((config) => { const state = automationStates[config.id];
              return <div key={config.id} className={`automation-item ${state?.enabled ? 'on' : state === null ? 'missing' : ''}`}>
                <div className="automation-head"><Zap size={13} /><strong title={config.name}>{config.name}</strong>
                  <button className="icon-button" title="지금 실행" aria-label={`${config.name} 지금 실행`} disabled={!config.orcaId || state === null} onClick={() => void automationAction(config, 'run')}><Play size={13} /></button>
                  <button className="icon-button" title="자동화 삭제" aria-label={`${config.name} 삭제`} onClick={() => void automationAction(config, 'remove')}><Trash2 size={13} /></button></div>
                <small>{scheduleText(config)} · ×{config.count} · {shortPath(config.project)}</small>
                {config.values && Object.keys(config.values).length > 0 && <small className="automation-values" title={Object.entries(config.values).map(([key, value]) => `${key} = ${value}`).join('\n')}>
                  {Object.entries(config.values).map(([key, value]) => `${(workflow.variables ?? []).find((item) => item.key === key)?.label ?? key}: ${value}`).join(' · ')}</small>}
                <small>{state === null ? 'Orca에서 찾을 수 없음' : state === undefined ? '상태 확인 중' : !state.enabled ? '꺼짐'
                  : `다음 ${state.nextRunAt ? new Date(state.nextRunAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}${state.lastRunAt ? ` · 마지막 ${new Date(state.lastRunAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}`}</small>
              </div>; })}
            {!workflow.automations?.length && <p className="sidebar-empty">실행 버튼에서 「자동화로 예약」을 고르면 여기에 표시됩니다.</p>}</>}
          <div className="sidebar-bottom"><div className={`connection ${connection.connected && !connectionError ? 'connected' : ''}`}><span className="status-dot" /><span>{connection.connected && !connectionError ? 'Orca 연결됨' : 'Orca 연결 확인 필요'}</span><span className="version">{connection.version || 'local'}</span></div><p>그래프는 설계하고,<br />실행 상태는 Orca에서 확인합니다.</p></div>
        </aside>
        {!panels.left && <button className="panel-toggle left" title="사이드바 펼치기 ([)" aria-label="사이드바 펼치기" onClick={() => setPanels((value) => ({ ...value, left: true }))}><PanelLeftOpen size={16} /></button>}

        {!panels.right && <button className="panel-toggle right" title="속성 패널 펼치기 (])" aria-label="속성 패널 펼치기" onClick={() => setPanels((value) => ({ ...value, right: true }))}>
          <Settings2 size={15} /><span>속성</span>{(selected || selectedEdge || multiSet.size > 1) && <i className="selection-dot" />}<PanelRightOpen size={16} /></button>}
        <aside className="inspector floating-panel" hidden={!panels.right} aria-label="속성"><div className="inspector-header"><span><Settings2 size={16} />{multiSet.size > 1 ? '여러 노드 선택' : selectedEdge ? '연결 속성' : selectedGroup ? '그룹 속성' : selectedFrame ? '메모 그룹 속성' : '단계 속성'}</span><span className="inspector-counter">{viewOnly && <span className="view-only-badge"><Lock size={10} />보기 전용</span>}{selected ? `${nodes.findIndex((node) => node.id === selected.id) + 1} / ${nodes.length}` : '—'}
            <button className="icon-button panel-collapse" title="속성 패널 접기 (])" aria-label="속성 패널 접기" onClick={() => setPanels((value) => ({ ...value, right: false }))}><PanelRightClose size={15} /></button></span></div>
          <fieldset className="inspector-fields" disabled={viewOnly}>
          {multiSet.size > 1 ? <div className="inspector-content"><div className="selected-kind"><Layers3 size={21} /><div><span>여러 노드</span><strong>{multiSet.size}개 선택됨</strong></div></div>
            <ul className="multi-list">{nodes.filter((node) => multiSet.has(node.id)).map((node) => <li key={node.id}><span>{isGroup(node) ? `${scopeNames[node.data.scope ?? 'project']} 그룹` : kindNames[node.data.kind]}</span>{node.data.label || '이름 없음'}</li>)}</ul>
            <div className="inspector-note"><Layers3 size={16} /><p>선택한 노드 하나를 끌면 함께 이동합니다. ⌘/Ctrl 클릭으로 하나씩 더하거나 빼고, Delete로 한 번에 지웁니다. 지운 그룹 안의 노드는 남습니다.</p></div>
            <button className="button danger" onClick={removeSelected}><Trash2 size={14} />{multiSet.size}개 삭제</button>
          </div> : selectedGroup ? <div className="inspector-content"><div className="selected-kind">{selectedGroup.data.scope === 'worktree' ? <GitBranch size={21} /> : <FolderGit2 size={21} />}<div><span>{scopeNames[selectedGroup.data.scope ?? 'project']} 그룹</span><strong>{selectedGroup.data.label || '이름 없는 그룹'}</strong></div></div>
            {selectedGroup.data.scope === 'worktree' && membership()}
            <label className="field-label" htmlFor="group-name">그룹 이름</label><input id="group-name" value={selectedGroup.data.label} maxLength={500} onChange={(event) => updateNode({ label: event.target.value })} />
            <label className="field-label" htmlFor="group-scope">대상 종류</label><select id="group-scope" value={selectedGroup.data.scope ?? 'project'} onChange={(event) => updateNode({ scope: event.target.value as GroupScope, path: '', ref: undefined, worktreeMode: undefined })}><option value="project" disabled={!!parentGroup}>Orca에 열린 프로젝트</option><option value="worktree">워크트리</option></select>
            {selectedGroup.data.scope === 'worktree' && <><span className="field-label">워크트리 방식</span>
              <div className="segmented mode-toggle" role="radiogroup" aria-label="워크트리 방식">
                <button role="radio" aria-checked={selectedGroup.data.worktreeMode !== 'create'} className={selectedGroup.data.worktreeMode !== 'create' ? 'active' : ''} onClick={() => updateNode({ worktreeMode: undefined })}>기존 선택</button>
                <button role="radio" aria-checked={selectedGroup.data.worktreeMode === 'create'} className={selectedGroup.data.worktreeMode === 'create' ? 'active' : ''} onClick={() => updateNode({ worktreeMode: 'create', path: '', ref: undefined })}>새로 생성</button></div></>}
            {parentGroup?.data.scope === 'worktree' && <p className="field-help nest-help"><GitBranch size={12} />「{parentGroup.data.label}」의 하위 워크트리로 Orca에서 만들어집니다.</p>}
            {createsWorktree(selectedGroup) ? <>
            <label className="field-label" htmlFor="group-repo">워크트리를 만들 프로젝트</label>
            <select id="group-repo" value={selectedGroup.data.repoPath ?? ''} onChange={(event) => updateNode({ repoPath: event.target.value })}>
              <option value="">{inheritedRepoOf(selectedGroup) ? `상위 그룹을 따름 (${shortPath(inheritedRepoOf(selectedGroup))})` : '실행할 때 고른 프로젝트'}</option>
              {selectedGroup.data.repoPath && !locations.projects.some((item) => item.path === selectedGroup.data.repoPath) && <option value={selectedGroup.data.repoPath}>{selectedGroup.data.repoPath} (Orca에서 조회되지 않음)</option>}
              {locations.projects.map((item) => <option key={item.id} value={item.path}>{item.name}</option>)}
            </select>
            <label className="field-label" htmlFor="group-name-source">이름 정하는 방법</label>
            <select id="group-name-source" value={selectedGroup.data.nameSource ?? 'fixed'} onChange={(event) => updateNode({ nameSource: event.target.value as NameSource })}>
              {(Object.keys(nameSourceNames) as NameSource[]).map((key) => <option key={key} value={key}>{nameSourceNames[key]}</option>)}
            </select>
            {(selectedGroup.data.nameSource ?? 'fixed') === 'fixed' && <><label className="field-label" htmlFor="group-wt-name">워크트리 이름</label>
              <input id="group-wt-name" value={selectedGroup.data.worktreeName ?? ''} maxLength={80} placeholder={`wf-${selectedGroup.id.slice(0, 8)}`}
                onChange={(event) => updateNode({ worktreeName: safeWorktreeName(event.target.value) || undefined })} /></>}
            {selectedGroup.data.nameSource === 'agent' && <><label className="field-label" htmlFor="group-name-from">이름을 정할 단계</label>
              <select id="group-name-from" value={selectedGroup.data.nameFrom ?? ''} onChange={(event) => updateNode({ nameFrom: event.target.value || undefined })}>
                <option value="">선택</option>
                {nodes.filter((node) => isExecutable(node) && !membershipOf({ nodes }, node).worktrees.some((item) => item.id === selectedGroup.id))
                  .map((node) => <option key={node.id} value={node.id}>{node.data.label || '이름 없는 단계'}</option>)}
              </select>
              <p className="field-help">그 단계의 에이전트가 작업을 마치며 워크트리 이름을 정하거나 직접 만들어 보고합니다. 이 그룹 안의 단계는 그 뒤에 시작합니다.</p></>}
            {selectedGroup.data.nameSource === 'input' && <><label className="field-label" htmlFor="group-input-prompt">입력 안내 문구</label>
              <input id="group-input-prompt" value={selectedGroup.data.inputPrompt ?? ''} maxLength={500} placeholder="예: 작업할 이슈 키로 워크트리 이름을 정하세요"
                onChange={(event) => updateNode({ inputPrompt: event.target.value || undefined })} />
              <div className="input-guide"><CircleHelp size={14} /><p><strong>실행 시 입력</strong> — 실행 버튼을 누르면 뜨는 창에서 이름을 적습니다. 비워 두면 실행 중에 코디네이터가 터미널에서 묻습니다. 자동화로 실행하면 예약할 때 적은 값을 쓰고, 없으면 실행 중에 묻습니다.</p></div></>}
            <label className="field-label" htmlFor="group-base">기준 브랜치</label>
            <input id="group-base" value={selectedGroup.data.baseBranch ?? ''} maxLength={200} placeholder="비우면 프로젝트 기본 브랜치"
              onChange={(event) => updateNode({ baseBranch: event.target.value.replace(/[^A-Za-z0-9._/-]/g, '').replace(/^-+/, '').replace(/\.\.+/g, '.') || undefined })} />
            <label className="check-row"><input type="checkbox" checked={!!selectedGroup.data.perExecution} onChange={(event) => updateNode({ perExecution: event.target.checked || undefined })} />
              <span>실행마다 따로 만들기<small>이름 뒤에 -1, -2 …를 붙입니다. 끄면 병렬·반복 실행이 같은 워크트리를 재사용합니다.</small></span></label>
            </> : <>
            <label className="field-label" htmlFor="group-target">{selectedGroup.data.scope === 'worktree' ? '워크트리' : '프로젝트'}</label>
            <select id="group-target" value={selectedGroup.data.path ?? ''} onChange={(event) => { const option = locationOptions.find((item) => item.path === event.target.value);
              const capture = selectedGroup.data.scope === 'worktree' && option ? { worktreeName: safeWorktreeName(option.name) || undefined, branch: option.branch || undefined,
                repoPath: locations.projects.find((item) => item.id === option.repoId)?.path } : {};
              updateNode({ path: event.target.value, ref: option?.id, ...capture, ...(option && (!selectedGroup.data.label || Object.values(scopeNames).includes(selectedGroup.data.label)) ? { label: option.name } : {}) }); }}>
              <option value="">선택</option>
              {selectedGroup.data.path && !locationOptions.some((item) => item.path === selectedGroup.data.path) && <option value={selectedGroup.data.path}>{selectedGroup.data.path} (Orca에서 조회되지 않음)</option>}
              {locationOptions.map((item) => <option key={item.id} value={item.path}>{item.name}{item.branch ? ` · ${item.branch}` : ''}</option>)}
            </select>
            {selectedGroup.data.path && <p className="field-help path-help" title={selectedGroup.data.path}>{selectedGroup.data.path}</p>}
            {selectedGroup.data.scope === 'worktree' && selectedGroup.data.path && <p className="field-help">실행할 때 이 워크트리가 없으면 같은 이름{selectedGroup.data.worktreeName ? `「${selectedGroup.data.worktreeName}」` : ''}{selectedGroup.data.branch ? `·브랜치 ${selectedGroup.data.branch}` : ''}로 다시 만듭니다.</p>}
            </>}
            {selectedGroup.data.scope === 'worktree' && <div className="rule-box"><strong>워크트리 규칙</strong><ul>
              <li>같은 이름이나 브랜치의 워크트리가 이미 있으면 새로 만들지 않고 재사용합니다.</li>
              <li>병렬 실행 중에도 같은 이름은 한 번만 만듭니다.</li>
              <li>워크트리 그룹 안의 워크트리 그룹은 하위 워크트리로 만듭니다.</li>
              <li>정리 여부는 실행할 때 「완료 시 정리」에서 고릅니다.</li></ul></div>}
            <p className="field-help">안에 놓인 단계의 워커는 이 {createsWorktree(selectedGroup) ? '워크트리' : '경로'}에서 작업합니다. 단계를 그룹 밖으로 끌어내면 실행할 때 고른 프로젝트에서 작업합니다.</p>
            <label className="field-label" htmlFor="group-description">메모</label><textarea id="group-description" rows={3} value={selectedGroup.data.description} maxLength={20000} placeholder="이 그룹의 작업 범위" onChange={(event) => updateNode({ description: event.target.value })} />
            <div className="inspector-note"><SquareDashed size={16} /><p>안의 단계 {nodes.filter((node) => node.parentId === selectedGroup.id).length}개. 그룹을 지워도 단계는 남습니다.</p></div>
            <button className="button danger" onClick={removeSelected}><Trash2 size={14} />그룹 삭제</button>
          </div> : selectedFrame ? <div className="inspector-content"><div className="selected-kind"><Group size={21} /><div><span>{kindNames.frame}</span><strong>{selectedFrame.data.label || '메모 그룹'}</strong></div></div>
            <label className="field-label" htmlFor="frame-name">제목</label><input id="frame-name" value={selectedFrame.data.label} maxLength={500} onChange={(event) => updateNode({ label: event.target.value })} />
            <label className="field-label" htmlFor="frame-description">메모</label><textarea id="frame-description" rows={4} value={selectedFrame.data.description} maxLength={20000} placeholder="이 묶음에 대한 설명" onChange={(event) => updateNode({ description: event.target.value })} />
            <div className="inspector-note"><Group size={16} /><p>노드를 묶어 보여 주기만 합니다. 옮기면 안에 있는 노드가 함께 움직이고, 실행·작업 위치에는 영향이 없습니다. 지워도 노드는 남습니다.</p></div>
            <button className="button danger" onClick={removeSelected}><Trash2 size={14} />메모 그룹 삭제</button>
          </div> : selected ? <div className="inspector-content"><div className="selected-kind">{(() => { const Icon = kindIcons[selected.data.kind] ?? Bot; return <Icon size={21} />; })()}<div><span>{kindNames[selected.data.kind]}</span><strong>{selected.data.label || '이름 없는 단계'}</strong></div></div>
            {membership()}
            <label className="field-label" htmlFor="stage-name">단계 이름</label><input id="stage-name" value={selected.data.label} maxLength={500} onChange={(event) => updateNode({ label: event.target.value })} />
            <label className="field-label" htmlFor="stage-kind">단계 유형</label><select id="stage-kind" value={selected.data.kind} onChange={(event) => changeKind(event.target.value as StageKind)}><option value="worker">워커</option><option value="gate">사용자 개입 게이트</option><option value="branch">분기</option><option value="workflow">워크플로 링크</option><option value="note">메모 (실행 안 함)</option></select>
            {selected.data.kind === 'workflow' && <><label className="field-label" htmlFor="stage-link">연결할 워크플로</label>
              <div className="link-row"><select id="stage-link" value={selected.data.workflowId ?? ''} onChange={(event) => updateNode({ workflowId: event.target.value || undefined, ...(event.target.value && (!selected.data.label || selected.data.label === kindNames.workflow) ? { label: workflowName(event.target.value) ?? selected.data.label } : {}) })}>
                <option value="">선택</option>
                {selected.data.workflowId && !workflowName(selected.data.workflowId) && <option value={selected.data.workflowId}>찾을 수 없는 워크플로</option>}
                {saved.filter((item) => item.id !== workflow.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <button className="icon-button" title="연결한 워크플로 열기" aria-label="연결한 워크플로 열기" disabled={!selected.data.workflowId || !saved.some((item) => item.id === selected.data.workflowId)} onClick={() => void load(selected.data.workflowId!)}><ExternalLink size={15} /></button></div>
              <p className="field-help">{selected.data.linkMode === 'spawn'
                ? '실행하면 연결한 워크플로를 펼치지 않고, 항목마다 따로 실행을 요청합니다. 노드 상태는 요청 단계의 상태입니다.'
                : '실행하면 연결한 워크플로의 단계가 이 자리에 펼쳐집니다. 노드 상태는 펼친 단계들의 상태를 모은 것입니다.'}</p>
              <label className="field-label" htmlFor="link-mode">실행 방식</label>
              <select id="link-mode" value={selected.data.linkMode ?? 'wait'} onChange={(event) => updateNode({ linkMode: event.target.value === 'wait' ? undefined : event.target.value as LinkMode })}>
                <option value="wait">{linkModeNames.wait} — 펼친 단계가 모두 끝나야 진행</option><option value="start">{linkModeNames.start} — 시작시키고 바로 진행</option>
                <option value="spawn">{linkModeNames.spawn} — 앞 워커가 보고한 항목마다 별도 실행</option></select>
              <p className="field-help">{selected.data.linkMode === 'start'
                ? '링크 뒤 단계는 링크 앞 단계가 끝나면 펼친 단계와 동시에 시작합니다. 펼친 단계는 따로 끝까지 돌고, 이 실행은 그것까지 끝나야 끝납니다.'
                : selected.data.linkMode === 'spawn'
                  ? `앞에 연결한 워커 하나가 worker_done 에 "items: 항목, 항목" 으로 목록을 보고하면, 항목마다 연결한 워크플로를 따로 실행합니다(한 번에 ${maxSpawnItems}개까지). 항목은 그 워크플로의 「실행 시 입력」 워크트리 이름이 되므로, 대상에는 그런 그룹이 하나 있어야 합니다. 요청이 끝나면 이 링크는 완료이고, 따로 띄운 실행은 기다리지 않습니다 — 진행 상황은 대상 워크플로에서 봅니다.`
                  : '링크 뒤 단계는 펼친 워크플로의 마지막 단계들이 끝난 뒤 시작합니다.'}</p>
              {selected.data.linkMode === 'spawn' && <><label className="field-label">요청한 실행</label>
                {selectedProjected?.data.spawned?.length ? <ul className="run-list">{selectedProjected.data.spawned.map((result, index) => <li key={index}>
                  <button className={`run-chip ${result.error ? 'failed' : 'completed'}`} onClick={() => void load(result.workflowId)} title="대상 워크플로 열기"><span className="status-dot" />{result.item}</button>
                  <span>{result.error ?? '실행 요청됨'}</span></li>)}</ul>
                  : <p className="field-help">실행이 항목을 요청하면 항목별 결과가 여기에 보입니다. 항목을 누르면 대상 워크플로를 엽니다.</p>}</>}</>}
            {selected.data.kind === 'gate' && <>
              <label className="field-label" htmlFor="gate-asker">묻는 곳</label>
              <select id="gate-asker" value={selected.data.asker ?? 'coordinator'} onChange={(event) => updateNode({ asker: event.target.value === 'previous' ? 'previous' as GateAsker : undefined })}>
                <option value="coordinator">코디네이터 (캔버스 결정 대기 카드)</option><option value="previous">직전 단계 워커의 터미널</option></select>
              <p className="field-help">{selected.data.asker === 'previous'
                ? '앞에 연결된 워커 하나가 작업을 마친 뒤 자기 터미널에서 묻고, 답을 받아 decision: approve|reject 로 보고합니다. 작업 맥락을 가진 워커에게 되묻거나 수정을 요청할 수 있습니다. 캔버스 카드에서 골라도 됩니다.'
                : '앞 단계가 끝나면 캔버스 오른쪽 위 결정 대기 카드에 뜹니다. 코디네이터 터미널에 답해도 됩니다.'}</p></>}
            {isBranch(selected) && <>
              <label className="field-label" htmlFor="branch-mode">고르는 출력 수</label>
              <select id="branch-mode" value={selected.data.mode ?? 'exclusive'} onChange={(event) => updateNode({ mode: event.target.value as BranchMode })}>
                <option value="exclusive">하나만 (조건이 서로 배타적)</option><option value="inclusive">해당하는 것 모두 (하나 이상)</option></select>
              <label className="field-label" htmlFor="branch-judge">판정 주체</label>
              <select id="branch-judge" value={selected.data.judge ?? 'previous'} onChange={(event) => updateNode({ judge: event.target.value as BranchJudge })}>
                <option value="previous">직전 단계 워커가 작업을 마치며 판정</option><option value="worker">판정 전용 워커를 따로 띄움</option><option value="user">사용자가 결정 게이트에서 선택</option></select>
              <p className="field-help">{selected.data.judge === 'user' ? '코디네이터가 결정 게이트를 걸고 사용자에게 출력 중 하나를 고르게 합니다. 자동으로 고르지 않습니다.'
                : selected.data.judge === 'worker' ? '이 분기의 지침과 출력 목록을 받은 워커가 앞 단계 산출물을 읽고 판정합니다.'
                : '앞에 연결된 워커 하나가 작업을 마치며 worker_done 첫 줄에 decision: <출력 id> 로 보고합니다.'}</p>
              <span className="field-label">출력</span>
              <ul className="branch-editor">{(selected.data.outputs ?? []).map((output, index) => <li key={output.id}>
                <code title="코디네이터가 판정을 보고할 때 쓰는 id">{output.id}</code>
                <input aria-label={`출력 ${output.id} 조건`} value={output.label} maxLength={200} placeholder="예: 테스트 통과"
                  onChange={(event) => updateNode({ outputs: (selected.data.outputs ?? []).map((item, i) => i === index ? { ...item, label: event.target.value } : item) })} />
                <button className="icon-button" title="출력 삭제(이 출력에서 나간 연결도 지워집니다)" aria-label={`출력 ${output.id} 삭제`} onClick={() => removeOutput(output.id)}><X size={14} /></button></li>)}</ul>
              <button className="button" disabled={(selected.data.outputs?.length ?? 0) >= maxBranchOutputs} onClick={() => updateNode({ outputs: [...(selected.data.outputs ?? []), { id: nextOutputId(selected.data.outputs ?? []), label: '' }] })}><Plus size={14} />출력 추가</button>
              {selectedProjected?.data.decision && <p className="field-help">이 실행의 판정 · {selectedProjected.data.decision.map((id) => selected.data.outputs?.find((item) => item.id === id)?.label || id).join(', ')}</p>}
            </>}
            {isExecutable(selected) && edges.filter((edge) => edge.target === selected.id).length > 1 && <>
              <label className="field-label" htmlFor="stage-join">합류 방식</label>
              <select id="stage-join" value={selected.data.join ?? 'all'} onChange={(event) => updateNode({ join: event.target.value === 'any' ? 'any' : undefined })}>
                <option value="all">{joinNames.all} — 앞 경로가 하나라도 건너뛰어지면 이 단계도 건너뜀</option>
                <option value="any">{joinNames.any} — 분기에서 갈라진 경로가 다시 모이는 곳</option></select>
              <p className="field-help">어느 쪽이든 실제로 진행 중인 앞 단계가 모두 끝난 뒤에 시작합니다.</p></>}
            <label className="field-label" htmlFor="stage-description">{selected.data.kind === 'note' ? '메모 내용' : selected.data.kind === 'gate' ? '사용자에게 물을 내용' : selected.data.kind === 'branch' ? '판정 지침' : selected.data.kind === 'workflow' ? '추가 지침' : '작업 지침'}</label><textarea id="stage-description" rows={5} value={selected.data.description} maxLength={20000} placeholder={selected.data.kind === 'note' ? '실행에 쓰이지 않는 설명입니다.' : selected.data.kind === 'branch' ? '무엇을 근거로 어느 출력을 고를지 적으세요.' : selected.data.kind === 'gate' ? '무엇을 확인하고 통과·거절을 정할지 적으세요.' : '목표, 작업 범위, 완료 조건을 적으세요.'} onChange={(event) => updateNode({ description: event.target.value })} />
            {selected.data.kind !== 'note' && (() => {
              const declared = new Set((workflow.variables ?? []).map((item) => item.key));
              const unknown = variableRefs(selected.data.description).filter((key) => !declared.has(key));
              if (unknown.length) return <p className="field-help warning">{unknown.map((key) => `{{${key}}}`).join(', ')} 은(는) 워크플로 설정값에 없습니다. 빈 곳을 눌러 설정값을 추가하세요 — 이대로면 실행 전에 거부됩니다.</p>;
              if (declared.size) return <p className="field-help">설정값 {[...declared].map((key) => `{{${key}}}`).join(' ')} 를 지침에 쓰면 실행할 때 값으로 바뀝니다.</p>;
              return null;
            })()}
            {selected.data.kind !== 'note' && (() => {
              if (generations.some((item) => item.kind === 'brief' && item.nodeId === selected.id && item.status === 'pending')) {
                return <p className="field-help generating"><LoaderCircle size={12} className="spin" />Orca에서 지침을 생성하는 중입니다. 에이전트 탭에서 진행을 볼 수 있습니다.</p>;
              }
              if (briefForm?.nodeId !== selected.id) return <button className="button small generate-open" onClick={() => setBriefForm({ nodeId: selected.id, prompt: '', project: defaultProject(selected) })}><Sparkles size={13} />자연어로 지침 생성</button>;
              return <div className="generate-form">
                <textarea aria-label="지침 생성 요청" rows={3} autoFocus maxLength={10000} value={briefForm.prompt} placeholder="이 단계가 할 일을 자연어로 적으세요. 예: 로그인 API에 토큰 갱신을 넣고 테스트까지"
                  onChange={(event) => setBriefForm({ ...briefForm, prompt: event.target.value })} />
                <select aria-label="에이전트가 읽을 프로젝트" value={briefForm.project} onChange={(event) => setBriefForm({ ...briefForm, project: event.target.value })}>
                  <option value="">Orca에 열린 프로젝트 선택</option>
                  {locations.projects.map((item) => <option key={item.id} value={item.path}>{item.name} · {shortPath(item.path)}</option>)}</select>
                <p className="field-help">Orca가 이 프로젝트에서 에이전트를 띄워 앞뒤 단계와 코드를 읽고 지침을 씁니다. 지금 지침은 결과로 바뀝니다.</p>
                <div className="generate-actions"><button className="button ghost small" onClick={() => setBriefForm(null)}>취소</button>
                  <button className="button primary small" disabled={!briefForm.prompt.trim() || !briefForm.project}
                    onClick={async () => { if (await startGeneration('brief', briefForm.prompt, briefForm.project, selected)) setBriefForm(null); }}><Sparkles size={13} />생성</button></div></div>;
            })()}
            {launchesWorker(selected) && <>
              <label className="field-label" htmlFor="stage-model">모델</label>
              <select id="stage-model" value={selected.data.workerModel ?? ''} onChange={(event) => updateNode({ workerModel: event.target.value || undefined })}>
                <option value="">기본값 ({defaultWorkerModel})</option>
                {selected.data.workerModel && !(workerModels as readonly string[]).includes(selected.data.workerModel) && <option value={selected.data.workerModel}>{selected.data.workerModel}</option>}
                {workerModels.map((model) => <option key={model} value={model}>{model}</option>)}</select>
              <label className="field-label" htmlFor="stage-effort">추론 수준 (effort)</label>
              <select id="stage-effort" value={selected.data.effort ?? ''} onChange={(event) => updateNode({ effort: (event.target.value || undefined) as Effort | undefined })}>
                <option value="">기본값 (모델 기본)</option>
                {effortLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select>
              <p className="field-help">{selected.data.kind === 'branch' ? '판정 전용 워커를 이 설정으로 띄웁니다. ' : ''}비워 두면 기본값을 씁니다. 직전 단계와 위치·모델·effort 가 모두 같을 때만 터미널을 이어 씁니다.</p></>}
            {isExecutable(selected) && <p className="field-help">작업 위치 · {(() => {
              const { project, worktrees } = membershipOf({ nodes }, selected);
              const group = worktrees[worktrees.length - 1] ?? project;
              if (!group) return '실행할 때 고른 프로젝트';
              if (!createsWorktree(group) && !group.data.path) return `「${group.data.label || '그룹'}」 대상 미지정 — 고르기 전에는 실행할 수 없습니다`;
              if (!createsWorktree(group)) return group.data.path!;
              const repo = worktreeRepo({ nodes }, group);
              return `「${group.data.label}」 워크트리 (실행 때 준비${worktrees.length > 1 ? ', 하위 워크트리' : ''} · ${repo ? shortPath(repo) : '실행할 때 고른 프로젝트'})`; })()}</p>}
            {isExecutable(selected) && <>
            <div className="inspector-divider" />
            <div className="section-label"><Link2 size={15} />Orca Task 연결{activeExecution && <span className="section-badge">{activeExecution.label}</span>}</div>
            {executionView === 'all' ? <><p className="field-help">실행별 상태입니다. Task 연결을 바꾸려면 상단에서 실행 선택으로 전환하세요.</p>
              <ul className="run-list">{selectedProjected?.data.runs?.map((run) => <li key={run.id}><button className={`run-chip ${run.status}`} onClick={() => setView(run.id)}><span className="status-dot" />{run.label}</button><span>{statusLabels[run.status]}</span>
                {executions.find((item) => item.id === run.id)?.automation && <span className="automation-tag"><Zap size={10} />{executions.find((item) => item.id === run.id)!.automation!.name}</span>}</li>)}</ul></>
            : selected.data.kind === 'workflow' ? <p className="field-help">링크 노드는 실행이 등록되면 펼친 단계들의 상태를 보여줍니다.</p>
            : <><p className="field-help">Task를 연결하면 실행 상태가 자동으로 표시됩니다.</p>
            <label className="field-label" htmlFor="task-selector">관찰할 Task</label><select id="task-selector" value={selectedTaskId ?? ''} disabled={!snapshot || stale} onChange={(event) => bindTask(event.target.value || undefined)}><option value="">미연결</option>
              {selectedTaskId && !snapshot?.tasks.some((task) => task.id === selectedTaskId) && <option value={selectedTaskId}>{selectedTaskId} (조회되지 않음)</option>}
              {snapshot?.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select></>}
            {!workflow.runId && <p className="field-help">왼쪽에서 Run을 먼저 선택하세요.</p>}
            <div className={`task-state ${selectedProjected?.data.status ?? 'unbound'}`}><span className="status-dot" /><span>{statusLabels[selectedProjected?.data.status ?? 'unbound']}</span><small>{selectedProjected?.data.agent || 'Orca Task'}</small></div>
            {selectedProjected?.data.model && <p className="field-help">모델 · {selectedProjected.data.model}</p>}
            <div className="inspector-note"><Bot size={16} /><p>이 화면은 실행 상태를 관찰합니다. 워커 실행과 승인 처리는 Orca 코디네이터가 담당합니다.</p></div>
            </>}
            <button className="button danger" onClick={removeSelected}><Trash2 size={14} />단계 삭제</button>
          </div> : selectedEdge ? <div className="inspector-content"><label className="field-label" htmlFor="edge-label">연결 설명</label><input id="edge-label" value={String(selectedEdge.label ?? '')} maxLength={500} placeholder="예: 검증 통과" onChange={(event) => setEdges((items) => items.map((edge) => edge.id === selectedEdgeId ? { ...edge, label: event.target.value } : edge))} />{(() => {
              const source = nodes.find((node) => node.id === selectedEdge.source);
              const output = source && isBranch(source) ? source.data.outputs?.find((item) => item.id === selectedEdge.sourceHandle) : undefined;
              const loop = selectedEdge.loop;
              if (loop && source) {
                const setLoop = (patch: Partial<NonNullable<WorkflowEdge['loop']>>) => setEdges((items) => items.map((edge) => edge.id === selectedEdgeId && edge.loop ? { ...edge, loop: { ...edge.loop, ...patch } } : edge));
                const target = nodes.find((node) => node.id === selectedEdge.target);
                const body = loopBody(edges, selectedEdge).map((id) => nodes.find((node) => node.id === id)?.data.label || id);
                return <><p className="field-help">되돌아가기 연결 — 분기 「{source.data.label}」가 출력 <code>{output?.id}</code>({output?.label || '조건 없음'})을 고르면 「{target?.data.label}」로 돌아가 <strong>{body.join(' → ')}</strong> 를 다시 돕니다(새 회차, 새 Task).</p>
                  <label className="field-label" htmlFor="loop-max">최대 반복 횟수</label>
                  <input id="loop-max" type="number" min={1} max={maxLoopRounds} value={loop.max} onChange={(event) => setLoop({ max: Math.min(maxLoopRounds, Math.max(1, Number(event.target.value) || 1)) })} />
                  <label className="field-label" htmlFor="loop-exit">반복을 다 쓰면</label>
                  <select id="loop-exit" value={loop.exit} onChange={(event) => setLoop({ exit: event.target.value })}>
                    {(source.data.outputs ?? []).filter((item) => item.id !== selectedEdge.sourceHandle).map((item) => <option key={item.id} value={item.id}>{item.label || item.id} 출력으로 진행</option>)}</select>
                  <p className="field-help">{loop.max}번 돌아간 뒤에도 이 출력을 고르면 위 출력으로 바뀌어 진행합니다. 다시 도는 단계의 워커는 앞 회차 산출물과 분기 판정 근거를 먼저 읽습니다.</p></>;
              }
              return output ? <p className="field-help">분기 「{source!.data.label}」의 출력 <code>{output.id}</code>({output.label || '조건 없음'})에서 나온 연결입니다. 분기가 이 출력을 고를 때만 이어지고, 고르지 않으면 뒤 단계는 건너뜁니다.</p>
                : <p className="field-help">일반 연결은 병렬입니다. 앞 단계가 끝나면 바로 이어지고, 한 단계에 여러 연결이 들어오면 건너뛰지 않은 앞 단계가 모두 끝날 때까지 기다립니다. 연결 설명은 참고용이며 진행 여부를 바꾸지 않습니다. 골라서 진행하려면 분기 노드를 쓰세요.</p>;
            })()}<button className="button danger" onClick={removeSelected}><Trash2 size={14} />연결 삭제</button></div>
            : <div className="inspector-content"><div className="inspector-empty compact"><Settings2 size={22} /><p>단계나 연결을 선택해 속성을 편집하세요.</p></div>
              <VariablesEditor variables={workflow.variables ?? []} nodes={nodes} onChange={(variables) => setWorkflow((value) => ({ ...value, variables: variables.length ? variables : undefined }))} /></div>}
          </fieldset>
        </aside>
      </div>
      <footer className="statusbar"><span><Circle size={10} />{dirty ? '저장하지 않은 변경 사항' : '로컬 저장 완료'}</span><span>{workflow.runId ? `3초 간격 조회 · ${snapshot && !stale ? new Date(snapshot.observedAt).toLocaleTimeString('ko-KR') : '상태 확인 중'}` : 'Orca Run을 연결하면 실제 실행 상태가 표시됩니다.'}</span><span>JSON v1</span></footer>
    </main>
    {logOpen && <RunLogDialog workflowId={workflow.id} workflowName={workflow.name} onClose={() => setLogOpen(false)} />}
    {runDialog && <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRunDialog(false); }}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="run-title" onSubmit={(event) => { event.preventDefault(); void submitRun(); }}
        onKeyDown={(event) => { if (event.key === 'Escape') setRunDialog(false); }}>
        <header><h2 id="run-title"><Play size={16} />「{workflow.name}」 실행</h2><button type="button" className="icon-button" aria-label="닫기" onClick={() => setRunDialog(false)}><X size={16} /></button></header>
        <div className="segmented mode-toggle" role="radiogroup" aria-label="실행 방식">
          <button type="button" role="radio" aria-checked={runForm.mode === 'now'} className={runForm.mode === 'now' ? 'active' : ''} onClick={() => setRunForm((form) => ({ ...form, mode: 'now' }))}><Play size={12} />지금 실행</button>
          <button type="button" role="radio" aria-checked={runForm.mode === 'schedule'} className={runForm.mode === 'schedule' ? 'active' : ''} onClick={() => setRunForm((form) => ({ ...form, mode: 'schedule' }))}><Zap size={12} />자동화로 예약</button></div>
        <label className="field-label" htmlFor="run-project">실행할 프로젝트</label>
        <select id="run-project" autoFocus required value={runForm.project} onChange={(event) => setRunForm((form) => ({ ...form, project: event.target.value }))}>
          <option value="">Orca에 열린 프로젝트 선택</option>
          {locations.projects.map((item) => <option key={item.id} value={item.path}>{item.name} · {shortPath(item.path)}</option>)}
        </select>
        <p className="field-help">그룹 밖 단계는 이 프로젝트에서 작업하고, 프로젝트를 정하지 않은 새 워크트리도 여기서 만듭니다. 코디네이터도 여기서 시작합니다.</p>
        <label className="field-label" htmlFor="run-count">병렬 실행 횟수</label>
        <input id="run-count" type="number" min={1} max={20} value={runForm.count} onChange={(event) => setRunForm((form) => ({ ...form, count: Math.min(20, Math.max(1, Math.round(Number(event.target.value) || 1))) }))} />
        {Object.keys(runForm.inputs).length > 0 && <fieldset className="modal-section"><legend>실행 시 입력 · 워크트리 이름</legend>
          {nodes.filter(asksAtRun).map((group) => <div key={group.id}><label className="field-label" htmlFor={`run-input-${group.id}`}>{group.data.label || '워크트리'}</label>
            <input id={`run-input-${group.id}`} value={runForm.inputs[group.id] ?? ''} maxLength={80} placeholder={group.data.inputPrompt || '비우면 실행 중에 코디네이터가 묻습니다'}
              onChange={(event) => setRunForm((form) => ({ ...form, inputs: { ...form.inputs, [group.id]: safeWorktreeName(event.target.value) } }))} />
</div>)}
          <p className="field-help">비워 둔 칸은 실행 중에 코디네이터가 터미널에서 묻습니다. 같은 이름의 워크트리가 이미 있으면 재사용합니다.</p></fieldset>}
        {(workflow.variables ?? []).length > 0 && <fieldset className="modal-section"><legend>설정값</legend>
          {workflow.variables!.map((item) => <div key={item.key}><label className="field-label" htmlFor={`run-value-${item.key}`}>{item.label}{item.required && !item.default ? ' *' : ''} <code className="variable-key">{`{{${item.key}}}`}</code></label>
            <input id={`run-value-${item.key}`} value={runForm.values[item.key] ?? ''} maxLength={maxVariableValue} placeholder={item.default ? `비우면 기본값: ${item.default}` : item.required ? '필수' : '비우면 주지 않음'}
              onChange={(event) => setRunForm((form) => ({ ...form, values: { ...form.values, [item.key]: event.target.value } }))} />
            {item.description && <p className="field-help">{item.description}</p>}</div>)}
          <p className="field-help">{runForm.mode === 'schedule' ? '자동화는 입력한 값을 고정해 매번 씁니다. ' : ''}단계 지침의 {'{{키}}'} 가 이 값으로 바뀌고, 링크한 워크플로에도 같은 키로 전달됩니다. 토큰·비밀번호 같은 비밀값은 넣지 마세요(워크플로 파일과 브리프에 그대로 남습니다).</p></fieldset>}
        {runForm.mode === 'schedule' && <fieldset className="modal-section"><legend>자동화 일정</legend>
          <label className="field-label" htmlFor="run-auto-name">자동화 이름</label>
          <input id="run-auto-name" required value={runForm.name} maxLength={100} onChange={(event) => setRunForm((form) => ({ ...form, name: event.target.value }))} />
          <label className="field-label" htmlFor="run-trigger">반복</label>
          <select id="run-trigger" value={runForm.trigger} onChange={(event) => setRunForm((form) => ({ ...form, trigger: event.target.value }))}>
            {Object.entries(triggerNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}<option value="cron">cron 직접 입력</option></select>
          {runForm.trigger === 'cron' ? <><label className="field-label" htmlFor="run-cron">cron (분 시 일 월 요일)</label>
            <input id="run-cron" value={runForm.cron} maxLength={100} onChange={(event) => setRunForm((form) => ({ ...form, cron: event.target.value }))} /></>
            : runForm.trigger !== 'hourly' && <div className="inline-fields">
              {runForm.trigger === 'weekly' && <label>요일<select value={runForm.day} onChange={(event) => setRunForm((form) => ({ ...form, day: Number(event.target.value) }))}>
                {['일', '월', '화', '수', '목', '금', '토'].map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label>}
              <label>시각<input type="time" value={runForm.time} onChange={(event) => setRunForm((form) => ({ ...form, time: event.target.value }))} /></label></div>}
          <p className="field-help">Orca 자동화로 등록됩니다. 예약 시각이 되면 Orca가 에이전트를 띄우고, 그 에이전트가 이 캔버스에서 브리프를 받아 실행합니다. 그때 캔버스 서버가 켜져 있어야 합니다. 이 화면의 설정(프로젝트·횟수·입력값·정리)이 그대로 고정됩니다.</p></fieldset>}
        <fieldset className="modal-section"><legend>완료 시 정리</legend>
          {([['sessions', '워커 세션 정리', '끝난 워커 터미널을 닫습니다. 끄면 결과를 볼 수 있게 남겨 둡니다.'],
            ['worktrees', '만든 워크트리 삭제', '이번 실행이 새로 만든 워크트리만 지웁니다. 재사용·기존 선택 워크트리와 변경이 남은 워크트리는 지우지 않습니다.'],
            ['coordinator', '코디네이터 종료', '마무리 보고를 파일로 남기고 터미널을 닫습니다. 해결되지 않은 일이 있으면 닫지 않습니다.']] as const).map(([key, name, help]) =>
            <label key={key} className="check-row"><input type="checkbox" checked={runForm.cleanup[key]} onChange={(event) => setRunForm((form) => ({ ...form, cleanup: { ...form.cleanup, [key]: event.target.checked } }))} />
              <span>{name}<small>{help}</small></span></label>)}
          <p className="field-help">고른 정리 설정은 이 워크플로의 기본값으로 저장됩니다.</p></fieldset>
        <footer><button type="button" className="button ghost" onClick={() => setRunDialog(false)}>취소</button>
          <button type="submit" className="button primary" disabled={busy || !runForm.project}>{runForm.mode === 'now' ? <><Play size={14} />{runForm.count}회 실행</> : <><Zap size={14} />자동화 등록</>}</button></footer>
      </form></div>}
    {generateDialog && <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setGenerateDialog(false); }}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="generate-title" onKeyDown={(event) => { if (event.key === 'Escape') setGenerateDialog(false); }}
        onSubmit={async (event) => { event.preventDefault(); if (await startGeneration('workflow', generateForm.prompt, generateForm.project)) { setGenerateDialog(false); setGenerateForm((form) => ({ ...form, prompt: '' })); } }}>
        <header><h2 id="generate-title"><Sparkles size={16} />자연어로 워크플로 만들기</h2><button type="button" className="icon-button" aria-label="닫기" onClick={() => setGenerateDialog(false)}><X size={16} /></button></header>
        <label className="field-label" htmlFor="generate-prompt">무엇을 하는 워크플로인가요</label>
        <textarea id="generate-prompt" rows={7} autoFocus required maxLength={10000} value={generateForm.prompt} onChange={(event) => setGenerateForm((form) => ({ ...form, prompt: event.target.value }))}
          placeholder="예: 이슈를 받아 설계 → 백엔드·프론트 병렬 구현 → 테스트가 통과하면 사용자 검토, 실패하면 수정 후 다시 검증" />
        <label className="field-label" htmlFor="generate-project">에이전트가 읽을 프로젝트</label>
        <select id="generate-project" required value={generateForm.project} onChange={(event) => setGenerateForm((form) => ({ ...form, project: event.target.value }))}>
          <option value="">Orca에 열린 프로젝트 선택</option>
          {locations.projects.map((item) => <option key={item.id} value={item.path}>{item.name} · {shortPath(item.path)}</option>)}</select>
        <p className="field-help">Orca가 이 프로젝트에서 에이전트를 띄워 요청과 코드를 읽고 단계·연결·지침을 만듭니다. 만든 워크플로는 새 문서로 저장되어 캔버스에 열립니다. 프로젝트·워크트리 그룹은 만들지 않으니 열린 뒤 묶으세요.</p>
        <footer><button type="button" className="button ghost" onClick={() => setGenerateDialog(false)}>취소</button>
          <button type="submit" className="button primary" disabled={!generateForm.prompt.trim() || !generateForm.project}><Sparkles size={14} />생성</button></footer>
      </form></div>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {panels.left && <button className="sidebar-scrim" aria-label="메뉴 닫기" onClick={() => setPanels((value) => ({ ...value, left: false }))} />}
  </div></CanvasContext.Provider>;
}
