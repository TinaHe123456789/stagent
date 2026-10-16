import { useState } from 'react';
import type { CardAction, OverviewResponse } from '../api';

interface Props {
  overview: OverviewResponse;
  /** 各按钮的处理函数（结论卡只负责展示与禁用原因）。 */
  handlers: Partial<Record<CardAction['id'], () => void>>;
  onAcceptLedger: (reason: string) => void;
}

const VERDICT: Record<OverviewResponse['status'], string> = {
  ok: '可以继续：所有已锁定例子都在当前代码上验证通过',
  blocked: '不能继续：下面的问题解决前不能合并',
  needs_you: '需要你确认后才能继续',
  checking: '正在运行检查，结果出来前不能合并',
  ledger_modified: '账本被直接修改过，所有写操作已禁用',
  empty: '先描述第一个功能并锁定它的验收例子',
};

export function ConclusionCard({ overview, handlers: given, onAcceptLedger }: Props) {
  const [reason, setReason] = useState('');
  const handlers: Partial<Record<CardAction['id'], () => void>> = { ...given, accept_ledger: () => onAcceptLedger(reason) };

  return (
    <section className={`card conclusion status-${overview.status}`} aria-label="结论卡">
      <div className="conclusion-head">
        <span className="conclusion-icon" aria-hidden>
          {overview.icon}
        </span>
        <div>
          <h1 className="conclusion-title">{overview.title}</h1>
          <p className="conclusion-verdict">{VERDICT[overview.status]}</p>
        </div>
      </div>

      {overview.run && (
        <div className="progress" aria-label="检查进度">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${overview.run.total ? (overview.run.done / overview.run.total) * 100 : 0}%` }}
            />
          </div>
          <span className="progress-text">
            {overview.run.done}/{overview.run.total}
          </span>
        </div>
      )}

      {overview.reasons.length > 0 && (
        <ol className="reasons">
          {overview.reasons.map((r) => (
            <li key={r.text} className={`reason sev-${Math.min(r.severity, 9)}`}>
              {r.text}
            </li>
          ))}
        </ol>
      )}

      {overview.slowRunHint && (
        <p className="hint">
          上次全量回归用了 {Math.round(overview.slowRunHint.durationMs / 60000)} 分钟，最慢的检查：
          {overview.slowRunHint.slowest.map((s) => `${s.exampleId}（${Math.round(s.durationMs / 1000)} 秒）`).join('、')}
        </p>
      )}

      {overview.status === 'ledger_modified' && (
        <label className="field inline">
          <span>确认原因（至少 4 个字，会记入账本）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：我手动修正了一处笔误" />
        </label>
      )}

      <div className="actions">
        {overview.actions.map((a) => {
          const disabled =
            !a.enabled || (a.id === 'accept_ledger' && [...reason.trim()].length < 4) || !handlers[a.id];
          const why = !a.enabled
            ? a.disabledReason
            : a.id === 'accept_ledger' && disabled
              ? '先填写确认原因'
              : undefined;
          return (
            <span key={a.id} className="action">
              <button className={a.primary ? 'btn btn-primary' : 'btn'} disabled={disabled} onClick={handlers[a.id]}>
                {a.label}
              </button>
              {disabled && why && <span className="disabled-reason">{why}</span>}
            </span>
          );
        })}
      </div>
    </section>
  );
}
