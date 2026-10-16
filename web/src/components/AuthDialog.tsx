import { useEffect, useState, type ReactNode } from 'react';

export interface AuthDialogSpec {
  /** 问题，例如「授权强行合并？」 */
  title: string;
  /** 背景：为什么要授权、会发生什么。 */
  background: string;
  /** 额外内容（如放弃前受影响的文件清单）。 */
  extra?: ReactNode;
  confirmLabel: string;
  /** 合并免填原因；其余授权原因必填且至少 4 个字。 */
  reasonOptional?: boolean;
  danger?: boolean;
  onConfirm: (reason: string) => Promise<void>;
}

/** 授权确认：写清后果，填原因（会写进账本、决策记录和交付报告）。 */
export function AuthDialog({ spec, onClose }: { spec: AuthDialogSpec; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const short = !spec.reasonOptional && [...reason.trim()].length < 4;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const confirm = async () => {
    setBusy(true);
    try {
      await spec.onConfirm(reason.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <div className="dialog" role="dialog" aria-modal="true" aria-label={spec.title}>
        <h2 className="dialog-title">{spec.title}</h2>
        <p className="dialog-background">{spec.background}</p>
        {spec.extra}
        {!spec.reasonOptional && (
          <label className="field">
            <span>原因（至少 4 个字，会写进账本、决策记录和交付报告）</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
          </label>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <span className="action">
            {short && <span className="disabled-reason">先填写原因</span>}
            <button className={spec.danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy || short} onClick={confirm}>
              {busy ? '处理中…' : spec.confirmLabel}
            </button>
          </span>
        </div>
      </div>
    </>
  );
}
