import { useState } from 'react';
import type { OverviewResponse } from '../api';

/** 拦截提醒：显示最近一条 guard.blocked，可关闭。守卫本身在 M2-1 实现。 */
export function GuardNotice({ block }: { block: OverviewResponse['lastGuardBlock'] }) {
  const [dismissed, setDismissed] = useState<number | null>(null);
  if (!block || dismissed === block.seq) return null;
  return (
    <div className="banner banner-warn" role="status">
      <span>
        🛡 已拦截 {block.tool} 写入 <code>{block.path}</code>：{block.detail}
      </span>
      <button className="btn btn-ghost" onClick={() => setDismissed(block.seq)}>
        知道了
      </button>
    </div>
  );
}
