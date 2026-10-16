import type { OverviewResponse } from '../api';

export function Stats({ stats }: { stats: OverviewResponse['stats'] }) {
  const items = [
    { label: '已验证功能', value: stats.verified, tone: 'ok' },
    { label: '被破坏功能', value: stats.broken, tone: 'bad' },
    { label: '未验证功能', value: stats.unverified, tone: 'warn' },
    { label: '锁定例子', value: stats.lockedExamples, tone: 'neutral' },
  ];
  return (
    <section className="stats" aria-label="统计">
      {items.map((i) => (
        <div key={i.label} className={`stat tone-${i.tone}`}>
          <div className="stat-value">{i.value}</div>
          <div className="stat-label">{i.label}</div>
        </div>
      ))}
    </section>
  );
}
