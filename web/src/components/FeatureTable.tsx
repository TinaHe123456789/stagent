import type { FeatureView } from '../api';
import { relativeTime } from '../format';

export function FeatureTable({ features, onOpen }: { features: FeatureView[]; onOpen: (id: string) => void }) {
  return (
    <section className="card table-card" aria-label="功能表">
      <h2 className="section-title">功能</h2>
      <table className="features">
        <thead>
          <tr>
            <th aria-label="状态" />
            <th>名称</th>
            <th>标签</th>
            <th>例子通过</th>
            <th>覆盖</th>
            <th>最近验证</th>
          </tr>
        </thead>
        <tbody>
          {features.map((f) => (
            <tr key={f.featureId} onClick={() => onOpen(f.featureId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(f.featureId)}>
              <td>
                <span className={`dot dot-${f.state}`} title={f.stateLabel} />
              </td>
              <td>
                <div className="feature-name">{f.name}</div>
                <div className={`feature-state state-${f.state}`}>{f.stateLabel}</div>
              </td>
              <td>
                <span className={`tag tag-${f.tag}`}>{f.tag}</span>
              </td>
              <td className="num">
                {f.lockedCount === 0 ? <span className="muted">尚无例子</span> : `${f.verifiedCount}/${f.lockedCount}`}
              </td>
              <td>
                <div className={`coverage ${f.coverage.weak ? 'weak' : ''}`} title={f.coverage.reason ?? '覆盖正常'}>
                  <div className="coverage-fill" style={{ width: `${Math.min(f.lockedCount, 4) * 25}%` }} />
                </div>
                {f.coverage.weak && <div className="coverage-note">{f.coverage.reason}</div>}
              </td>
              <td className="muted">{f.lastRunAt ? relativeTime(f.lastRunAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
