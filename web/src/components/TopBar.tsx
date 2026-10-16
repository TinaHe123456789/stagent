import type { OverviewResponse } from '../api';

const NAV = [
  { label: '功能账本', active: true },
  { label: '改动记录', hint: 'M2 提供' },
  { label: '决策与规则', hint: 'M5 提供' },
  { label: '交付报告', hint: 'M5 提供' },
];

export function TopBar({ overview }: { overview: OverviewResponse | null }) {
  const running = overview?.run != null;
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">Stagent</span>
          {overview && (
            <>
              <span className="divider">/</span>
              <span className="project">{overview.project.name}</span>
              {overview.project.branch && <span className="branch">⎇ {overview.project.branch}</span>}
            </>
          )}
        </div>
        <div className="topbar-meta">
          <span className={`pill ${running ? 'pill-busy' : ''}`}>执行器：{running ? '检查中' : '空闲'}</span>
          <span className="pill pill-muted" title="Claude Code 驱动在 M3 提供">
            今日费用 —
          </span>
        </div>
      </div>
      <nav className="nav">
        {NAV.map((n) => (
          <span key={n.label} className={`nav-item ${n.active ? 'active' : 'disabled'}`} title={n.hint}>
            {n.label}
          </span>
        ))}
      </nav>
    </header>
  );
}
