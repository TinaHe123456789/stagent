import type { OverviewResponse } from '../api';
import { relativeTime } from '../format';

const LABEL: Record<string, string> = {
  merge: '合并',
  merge_override: '强行合并',
  abandon: '放弃改动',
  modify_locked: '修改锁定例子',
  delete: '退役功能',
  release: '发布上线',
  budget_raise: '提高费用上限',
};

/** 已消费但没有结算的授权：上次做到一半（可能崩溃），系统不会自动重试。 */
export function DanglingNotice({ dangling, onDismiss }: { dangling: OverviewResponse['auth']['dangling']; onDismiss: (authId: string) => void }) {
  if (dangling.length === 0) return null;
  return (
    <div className="banner banner-error dangling" role="alert">
      <div>
        <b>有授权做到一半：</b>下面的动作已经消费了授权，但没有完成记录，可能是中途崩溃。系统不会自动重试，请先确认实际情况（例如发布到底有没有执行）。
        <ul>
          {dangling.map((d) => (
            <li key={d.authId}>
              {LABEL[d.action] ?? d.action} · {relativeTime(d.at)}
              {d.reason ? ` · 原因：${d.reason}` : ''}{' '}
              <button className="btn btn-ghost" onClick={() => onDismiss(d.authId)}>
                我已确认处理
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
