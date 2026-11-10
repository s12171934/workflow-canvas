import { useEffect, useRef, useState } from 'react';
import { Braces, FileText, Maximize2, X } from 'lucide-react';
import { variableRefs, type WorkflowVariable } from './model';

const maxLength = 20000;

/** Inspector preview of a stage's instructions; clicking it opens the full editor. */
export function InstructionPreview({ label, value, placeholder, readOnly, onOpen }: { label: string; value: string; placeholder: string; readOnly?: boolean; onOpen: () => void }) {
  const lines = value ? value.split('\n').length : 0;
  // View-only mode disables the inspector fieldset (and every button in it), so show the whole text scrollable instead.
  if (readOnly) return <>
    <span className="field-label">{label}</span>
    <div className="instruction-preview readonly" tabIndex={0}>
      {value ? <span className="instruction-text">{value}</span> : <span className="instruction-placeholder">{placeholder}</span>}
    </div>
  </>;
  return <>
    <div className="instruction-head">
      <span className="field-label">{label}</span>
      <button type="button" className="button ghost small" onClick={onOpen} title="큰 편집기로 열기"><Maximize2 size={12} />편집</button>
    </div>
    <button type="button" className={`instruction-preview ${value ? '' : 'empty'}`} onClick={onOpen} aria-label={`${label} 편집`}>
      {value ? <span className="instruction-text">{value}</span> : <span className="instruction-placeholder">{placeholder}</span>}
    </button>
    {value && <p className="field-help instruction-meta">{lines}줄 · {value.length.toLocaleString()}자 · 눌러서 편집</p>}
  </>;
}

/** Large modal editor. Edits a draft; nothing changes until 적용. */
export function InstructionDialog({ title, label, value, placeholder, variables, checkVariables, onApply, onClose }: {
  title: string; label: string; value: string; placeholder: string; variables: WorkflowVariable[]; checkVariables: boolean;
  onApply: (value: string) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== value;

  useEffect(() => { const el = area.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, []);

  function close() {
    if (dirty && !window.confirm('적용하지 않은 변경이 있습니다. 버리고 닫을까요?')) return;
    onClose();
  }
  function apply() { onApply(draft); onClose(); }
  function insert(text: string) {
    const el = area.current;
    if (!el) return;
    const start = el.selectionStart, end = el.selectionEnd;
    const next = draft.slice(0, start) + text + draft.slice(end);
    if (next.length > maxLength) return;
    setDraft(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
  }

  const declared = new Set(variables.map((item) => item.key));
  const unknown = checkVariables ? [...new Set(variableRefs(draft))].filter((key) => !declared.has(key)) : [];
  const lines = draft ? draft.split('\n').length : 0;

  return <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal instruction-modal" role="dialog" aria-modal="true" aria-labelledby="instruction-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); }
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); apply(); }
      }}>
      <header>
        <h2 id="instruction-title"><FileText size={16} />{label}<span className="instruction-target">「{title}」</span></h2>
        <button type="button" className="icon-button" aria-label="닫기" onClick={close}><X size={16} /></button>
      </header>
      {checkVariables && variables.length > 0 && <div className="instruction-vars">
        <span><Braces size={12} />설정값 넣기</span>
        {variables.map((item) => <button key={item.key} type="button" className="variable-chip" title={item.label || item.key}
          onClick={() => insert(`{{${item.key}}}`)}>{`{{${item.key}}}`}</button>)}
      </div>}
      <textarea ref={area} className="instruction-area" value={draft} maxLength={maxLength} placeholder={placeholder} spellCheck={false}
        aria-label={label} onChange={(event) => setDraft(event.target.value)} />
      {unknown.length > 0 && <p className="field-help warning">{unknown.map((key) => `{{${key}}}`).join(', ')} 은(는) 워크플로 설정값에 없습니다. 이대로면 실행 전에 거부됩니다.</p>}
      <footer>
        <span className="instruction-count">{lines}줄 · {draft.length.toLocaleString()} / {maxLength.toLocaleString()}자{dirty ? ' · 변경됨' : ''}</span>
        <span className="instruction-hint">⌘/Ctrl+Enter 적용 · Esc 닫기</span>
        <button type="button" className="button ghost" onClick={close}>취소</button>
        <button type="button" className="button primary" onClick={apply} disabled={!dirty}>적용</button>
      </footer>
    </div>
  </div>;
}
