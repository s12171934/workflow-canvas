import { useEffect, useMemo, useState } from 'react';
import { FileText, History, RefreshCw, X, Zap } from 'lucide-react';
import { runEventNames, statusLabels, type RunEvent, type RunLogDetail, type RunLogFile, type RunLogOutcome, type RunLogSummary } from './model';

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '요청에 실패했습니다.');
  return result;
}
const time = (value: string) => new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTime = (value: string) => new Date(value).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortPath = (path?: string) => path ? path.split('/').filter(Boolean).slice(-2).join('/') : '';
/** Events that are judgements or failures, as opposed to routine status changes. */
const tone = (event: RunEvent) => ['task', 'execution', 'finished'].includes(event.type) ? event.status ?? 'unknown'
  : ['error', 'coordinator-failed'].includes(event.type) ? 'failed' : event.type === 'gate' ? 'blocked' : event.type === 'report' ? 'completed' : 'info';

const outcomeNames: Record<RunLogOutcome, string> = { pending: '등록 대기', running: '진행 중', completed: '완료', failed: '실패', blocked: '확인 필요', unknown: 'Run 미확인' };

/** Execution history of one workflow: one entry per 실행 request, its event timeline and the files it left. */
export function RunLogDialog({ workflowId, workflowName, onClose }: { workflowId: string; workflowName: string; onClose: () => void }) {
  const [list, setList] = useState<RunLogSummary[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [detail, setDetail] = useState<RunLogDetail | null>(null);
  const [file, setFile] = useState<RunLogFile | null>(null);
  const [hideTasks, setHideTasks] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const base = `/api/workflows/${encodeURIComponent(workflowId)}/logs`;

  // List and the open entry refresh together every few seconds, so a running execution's log fills in live.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const items = await get<RunLogSummary[]>(base, controller.signal);
        setList(items);
        const id = selected || items[0]?.id || '';
        if (!selected && id) setSelected(id);
        const fresh = id ? await get<RunLogDetail>(`${base}/${id}`, controller.signal) : null;
        setDetail(fresh);
        // Reading the detail can log a just-observed result; reflect it in the list without another request.
        if (fresh) setList(items.map((item) => item.id === fresh.id ? { ...item, ...fresh.meta, id: item.id, outcome: fresh.outcome, events: fresh.events.length,
          ...(fresh.events.length ? { last: fresh.events[fresh.events.length - 1] } : {}) } : item));
        setError('');
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 4000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, selected, tick]);
  useEffect(() => { setFile(null); }, [selected]);

  async function openFile(name: string) {
    try { setFile(await get<RunLogFile>(`${base}/${selected}/files/${encodeURIComponent(name)}`)); }
    catch (failure) { setError((failure as Error).message); }
  }
  const events = useMemo(() => (detail?.events ?? []).filter((event) => !hideTasks || event.type !== 'task'), [detail, hideTasks]);
  const meta = detail?.meta;

  return <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal log-modal" role="dialog" aria-modal="true" aria-labelledby="log-title" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      <header><h2 id="log-title"><History size={16} />「{workflowName}」 실행 로그</h2>
        <div className="log-actions"><button type="button" className="icon-button" aria-label="새로 고침" title="새로 고침" onClick={() => setTick((value) => value + 1)}><RefreshCw size={15} /></button>
          <button type="button" className="icon-button" aria-label="닫기" autoFocus onClick={onClose}><X size={16} /></button></div></header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="log-body">
        <nav className="log-list" aria-label="실행 목록">
          {list === null ? <p className="field-help">불러오는 중…</p> : !list.length ? <p className="field-help">아직 실행 기록이 없습니다. 실행 버튼이나 자동화로 실행하면 여기에 남습니다.</p>
            : list.map((item) => <button key={item.id} type="button" className={`log-entry ${item.id === selected ? 'active' : ''}`} onClick={() => setSelected(item.id)}>
              <strong>{dateTime(item.startedAt)}<span className={`outcome ${item.outcome}`}>{outcomeNames[item.outcome]}</span>{item.automation && <span className="automation-tag"><Zap size={10} />{item.automation.name}</span>}</strong>
              <small>{item.count ? `×${item.count}` : '설정 미기록'}{item.project ? ` · ${shortPath(item.project)}` : ''}</small>
              <small className={`log-last ${item.last ? tone(item.last) : ''}`}>{item.last ? `${runEventNames[item.last.type] ?? item.last.type} · ${item.last.type === 'task' ? `${item.last.message} ${statusLabels[item.last.status ?? 'unknown']}` : item.last.message}` : '이벤트 없음'}</small>
            </button>)}
        </nav>
        <section className="log-detail" aria-label="실행 상세">
          {!meta ? <p className="field-help">왼쪽에서 실행을 고르세요.</p> : <>
            <dl className="log-meta">
              <div><dt>시작</dt><dd>{new Date(meta.startedAt).toLocaleString('ko-KR')}</dd></div>
              <div><dt>프로젝트</dt><dd title={meta.project}>{meta.project ?? '—'}</dd></div>
              <div><dt>횟수</dt><dd>{meta.count ?? '—'}</dd></div>
              <div><dt>Run</dt><dd>{meta.runId ?? '등록 전'}</dd></div>
              {meta.inputs && Object.keys(meta.inputs).length > 0 && <div><dt>입력</dt><dd>{Object.values(meta.inputs).join(' · ')}</dd></div>}
              {meta.values && Object.keys(meta.values).length > 0 && <div><dt>설정값</dt><dd>{Object.entries(meta.values).map(([key, value]) => `${key} = ${value}`).join(' · ')}</dd></div>}
            </dl>
            <div className="log-section-label">실행 결과 <span className={`outcome ${detail.outcome}`}>{outcomeNames[detail.outcome]}</span></div>
            {detail.results ? <table className="log-results"><tbody>{detail.results.map((result) => <tr key={result.id}>
                <th scope="row"><span className={`status-dot ${result.finished ? 'completed' : result.status}`} />{result.label}<small>{result.finished ? '완료' : statusLabels[result.status]}</small></th>
                <td><div className="log-stages">{result.stages.map((stage) => <span key={stage.taskId} className={`log-stage ${stage.skipped ? 'skipped' : stage.status}`} title={stage.taskId}><span className="status-dot" />{stage.title}<em>{stage.skipped ? '진행 안 함' : statusLabels[stage.status]}</em></span>)}</div></td>
              </tr>)}</tbody></table>
              : <p className="field-help">{detail.resultsError ?? (meta.runId ? '이 실행의 Task 연결 정보가 없습니다.' : '코디네이터가 실행을 등록하면 실행별 결과가 표시됩니다. 실행 로그 도입 전 실행은 워크플로가 지금 가리키는 Run이 아니면 결과를 알 수 없습니다.')}</p>}
            {meta.adopted && <p className="field-help">실행 로그 도입 전 실행이라 아래 이벤트 시각은 실제 시각이 아니라 관찰한 시각입니다.</p>}
            {detail.files.length > 0 && <div className="log-files">{detail.files.map((name) => <button key={name} type="button" className={`button small ${file?.name === name ? 'primary' : 'ghost'}`} onClick={() => void (file?.name === name ? setFile(null) : openFile(name))}><FileText size={13} />{name}</button>)}</div>}
            {file && <pre className="log-file" aria-label={file.name}>{file.text}{file.truncated && `\n… (${Math.round(file.size / 1024)}KB 중 앞 1MB만 표시)`}</pre>}
            <div className="log-timeline-head"><span>이벤트 {events.length}</span>
              <label className="check-row inline"><input type="checkbox" checked={hideTasks} onChange={(event) => setHideTasks(event.target.checked)} />Task 상태 변화 숨기기</label></div>
            <ol className="log-timeline">
              {events.map((event, index) => <li key={index} className={`log-event ${tone(event)}`}>
                <time dateTime={event.at}>{time(event.at)}</time><span className="status-dot" />
                <span className="log-type">{runEventNames[event.type] ?? event.type}</span>
                <span className="log-message">{event.type === 'task' ? <>{event.message} <em>{event.from ? `${statusLabels[event.from]} → ` : ''}{statusLabels[event.status ?? 'unknown']}</em></> : event.message}</span>
              </li>)}
              {!events.length && <li className="field-help">기록된 이벤트가 없습니다. Task 상태 변화는 캔버스가 이 Run을 관찰하는 동안 기록됩니다.</li>}
            </ol></>}
        </section>
      </div>
    </div>
  </div>;
}
