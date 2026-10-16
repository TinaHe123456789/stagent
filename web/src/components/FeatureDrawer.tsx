import { useEffect } from 'react';
import type { ExampleView, FeatureView } from '../api';
import { relativeTime } from '../format';

const STATE_TEXT: Record<ExampleView['state'], string> = { verified: '已验证', failed: '失败', unverified: '未验证' };
const REASON_TEXT: Record<NonNullable<ExampleView['reason']>, string> = {
  ai_claim_only: '仅 AI 声称',
  errored: '执行异常',
  flaky: '结果不稳定',
  invalid: '证据无效',
  stale: '证据过期',
  not_run: '未执行',
};

/** 详情抽屉（M1-3 只有证据区；档位、进度条与改动部分在 M2-2）。 */
export function FeatureDrawer({ feature, onClose }: { feature: FeatureView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label={`${feature.name} 详情`}>
        <header className="drawer-head">
          <div>
            <h2>{feature.name}</h2>
            <div className={`feature-state state-${feature.state}`}>{feature.stateLabel}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="drawer-body">
          <h3 className="section-title">证据 · 本功能的例子</h3>
          {feature.examples.length === 0 && (
            <p className="muted">尚无锁定例子。{feature.draftCount > 0 ? `有 ${feature.draftCount} 个草稿待锁定。` : ''}</p>
          )}
          {feature.examples.map((x) => (
            <details key={x.exampleId} className={`example ex-${x.state}`} open={x.state !== 'verified'}>
              <summary>
                <span className={`chip chip-${x.state}`}>
                  {STATE_TEXT[x.state]}
                  {x.reason ? ` · ${REASON_TEXT[x.reason]}` : ''}
                </span>
                <span className="example-then">{x.then}</span>
                {x.kind === 'visual' && <span className="tag">外观</span>}
              </summary>
              <dl className="gwt">
                <dt>情况</dt>
                <dd>{x.given}</dd>
                <dt>操作</dt>
                <dd>{x.when}</dd>
                <dt>期望</dt>
                <dd>{x.then}</dd>
              </dl>
              <p className="explanation">{x.explanation}</p>
              {x.lastResult && (
                <p className="meta">
                  最近运行 {relativeTime(x.lastResult.at)} · 结果 {x.lastResult.status}
                  {x.lastResult.attempts > 1 ? ` · 共 ${x.lastResult.attempts} 次尝试` : ''}
                  {x.lastResult.logPath && (
                    <>
                      {' '}
                      · 日志 <code>{x.lastResult.logPath}</code>
                    </>
                  )}
                </p>
              )}
              {x.claims.length > 0 && (
                <div className="claims">
                  <div className="meta">AI 回报（仅声称，不作证）：</div>
                  {x.claims.map((c) => (
                    <blockquote key={c.at}>{c.text}</blockquote>
                  ))}
                </div>
              )}
              <p className="meta">
                检查 <code>{x.checkPath}</code> · 锁定于 {relativeTime(x.lockedAt)}
              </p>
            </details>
          ))}
        </div>
      </aside>
    </>
  );
}
