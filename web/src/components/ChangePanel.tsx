import { useState, type FormEvent } from 'react';
import type { ChangeView, FeatureView } from '../api';
import { relativeTime } from '../format';
import { ProgressSteps } from './ProgressSteps';

interface Props {
  change: ChangeView;
  features: FeatureView[];
  disabled: boolean;
  onSetTrack: (track: 'small' | 'feature') => Promise<void>;
  onDraft: (body: Record<string, string>) => Promise<void>;
  onLock: () => Promise<void>;
  onCheck: () => Promise<void>;
  onMerge: () => void;
  onOverride: () => void;
  onAbandon: () => void;
}

const SOURCE_LABEL: Record<ChangeView['source'], string> = { 'claude-code': 'Stagent 发起', external: '外部改动（Cursor / 手写）' };
const NEW_FEATURE = '__new__';

/** 进行中的改动：档位、流程进度、原因，以及当前阶段需要你做的事。 */
export function ChangePanel({ change, features, disabled, onSetTrack, onDraft, onLock, onCheck, onMerge, onOverride, onAbandon }: Props) {
  const [form, setForm] = useState({ featureId: NEW_FEATURE, featureName: '', given: '', when: '', then: '', kind: 'behavior', checkPath: '.stagent/checks/' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const isFeature = change.track === 'feature';
  const canDowngrade = change.lockedExampleIds.length === 0;
  const featureName = (id: string) => features.find((f) => f.featureId === id)?.name ?? id;

  const draft = async (e: FormEvent) => {
    e.preventDefault();
    const { featureId, featureName: name, ...rest } = form;
    await onDraft({ ...rest, ...(featureId === NEW_FEATURE ? { featureName: name } : { featureId }) });
    setForm({ ...form, given: '', when: '', then: '' });
  };

  return (
    <section className="card change-panel" aria-label="进行中的改动">
      <header className="change-head">
        <div>
          <div className="change-title">{change.description || '未命名改动'}</div>
          <div className="change-meta">
            <span className={`tag ${isFeature ? 'tag-新功能' : ''}`}>{isFeature ? '新功能档' : '小改动档'}</span>
            <span className="tag">{SOURCE_LABEL[change.source]}</span>
            <span className="muted">
              基准 <code>{change.baseCommit.slice(0, 7) || '—'}</code> · 开始于 {relativeTime(change.startedAt)}
            </span>
          </div>
        </div>
        <span className="action">
          {isFeature ? (
            <>
              <button className="btn btn-ghost" disabled={disabled || !canDowngrade} onClick={() => onSetTrack('small')}>
                降为小改动档
              </button>
              {!canDowngrade && <span className="disabled-reason">已锁定例子，不能降档</span>}
            </>
          ) : (
            <button className="btn btn-ghost" disabled={disabled} onClick={() => onSetTrack('feature')}>
              升为新功能档
            </button>
          )}
        </span>
      </header>

      <ProgressSteps change={change} />
      <div className={`phase phase-${change.phase}`}>
        当前：{change.phaseLabel}
        {change.lastRun && (
          <span className="muted">
            {' '}
            · 上次检查 {relativeTime(change.lastRun.at)}
            {change.lastRun.fresh ? '' : '（之后代码有改动）'}
          </span>
        )}
      </div>
      {change.blockers.length > 0 && (
        <ul className="blockers">
          {change.blockers.slice(0, 5).map((b) => (
            <li key={b}>{b}</li>
          ))}
          {change.blockers.length > 5 && <li className="muted">还有 {change.blockers.length - 5} 条</li>}
        </ul>
      )}

      {change.phase === 'implementing' && (
        <div className="row hint-row">
          <span className="muted">
            {change.source === 'external'
              ? '外部改动静止 2 秒后会自动检查。Cursor 的改动不能在写入时拦截，只在合并前校验。'
              : 'Claude Code 驱动在 M3 提供；现在可以自己或用 Cursor 修改，改完点「开始检查」。'}
          </span>
          <button className="btn btn-primary" disabled={disabled} onClick={onCheck}>
            开始检查
          </button>
        </div>
      )}

      {change.unmanagedCommits.length > 0 && (
        <p className="hint">
          ⚠️ 检测到 {change.unmanagedCommits.length} 个未经 Stagent 合并的提交（最近：<code>{change.unmanagedCommits.at(-1)!.toCommit.slice(0, 7)}</code>），已补跑全量回归。
        </p>
      )}

      <AuthBlock change={change} disabled={disabled} onMerge={onMerge} onOverride={onOverride} onAbandon={onAbandon} />

      {isFeature && (
        <div className="drafts">
          <h3 className="section-title">验收例子草稿</h3>
          {change.pendingDrafts.length === 0 ? (
            <p className="muted">没有待确认的草稿。{change.lockedExampleIds.length ? `本改动已锁定 ${change.lockedExampleIds.length} 个例子。` : ''}</p>
          ) : (
            <>
              <ul className="draft-list">
                {change.pendingDrafts.map((d) => (
                  <li key={d.exampleId}>
                    <span className="tag">{featureName(d.featureId)}</span> 情况：{d.given} → 操作：{d.when} → 期望：<b>{d.then}</b>
                    {d.kind === 'visual' && <span className="tag">外观</span>} <code>{d.checkPath}</code>
                  </li>
                ))}
              </ul>
              <span className="action">
                <button className="btn btn-primary" disabled={disabled} onClick={onLock}>
                  确认并锁定 {change.pendingDrafts.length} 个例子
                </button>
                <span className="disabled-reason">锁定后保存检查快照，之后只运行快照里的内容；改锁定例子需要授权。</span>
              </span>
            </>
          )}

          <form className="grid" onSubmit={draft}>
            <label className="field">
              <span>功能</span>
              <select value={form.featureId} onChange={set('featureId')} disabled={disabled}>
                <option value={NEW_FEATURE}>＋ 新功能</option>
                {features.map((f) => (
                  <option key={f.featureId} value={f.featureId}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>类型</span>
              <select value={form.kind} onChange={set('kind')} disabled={disabled}>
                <option value="behavior">行为</option>
                <option value="visual">外观</option>
              </select>
            </label>
            {form.featureId === NEW_FEATURE && (
              <label className="field span-2">
                <span>新功能名称</span>
                <input value={form.featureName} onChange={set('featureName')} placeholder="例如：登录验证码" disabled={disabled} />
              </label>
            )}
            <label className="field">
              <span>情况</span>
              <input value={form.given} onChange={set('given')} placeholder="用户已注册" disabled={disabled} />
            </label>
            <label className="field">
              <span>操作</span>
              <input value={form.when} onChange={set('when')} placeholder="输错 3 次密码后再登录" disabled={disabled} />
            </label>
            <label className="field">
              <span>期望</span>
              <input value={form.then} onChange={set('then')} placeholder="要求输入验证码" disabled={disabled} />
            </label>
            <label className="field">
              <span>检查文件（已写好，在 .stagent/checks/ 下）</span>
              <input value={form.checkPath} onChange={set('checkPath')} disabled={disabled} />
            </label>
            <div className="grid-actions">
              <button
                className="btn"
                disabled={disabled || !form.given || !form.when || !form.then || (form.featureId === NEW_FEATURE && !form.featureName)}
              >
                起草例子
              </button>
              <span className="muted">M3-2 起由 Claude Code 起草例子和检查；现在先手写检查文件再登记。</span>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

/** 授权区块：合并、强行合并、放弃——每项写明现在能不能做、为什么、怎么解除。 */
function AuthBlock({
  change,
  disabled,
  onMerge,
  onOverride,
  onAbandon,
}: {
  change: ChangeView;
  disabled: boolean;
  onMerge: () => void;
  onOverride: () => void;
  onAbandon: () => void;
}) {
  const inExamples = change.phase === 'confirm_examples' || change.phase === 'red_check';
  const checking = change.phase === 'checking';
  const rows: { label: string; enabled: boolean; why: string; onClick: () => void; danger?: boolean }[] = [
    {
      label: '合并',
      enabled: change.phase === 'mergeable',
      why:
        change.phase === 'mergeable'
          ? '全部检查通过。合并前服务端会再校验锁定检查与账本'
          : `需要全部检查通过；现在是「${change.phaseLabel}」${change.blockers[0] ? `：${change.blockers[0]}` : ''}`,
      onClick: onMerge,
    },
    {
      label: '授权强行合并',
      enabled: !inExamples && !checking && change.phase !== 'mergeable',
      why: inExamples
        ? '还在确认例子阶段'
        : checking
          ? '检查进行中'
          : change.phase === 'mergeable'
            ? '已经可以正常合并'
            : '有失败或未验证的例子时可用；需要填写原因，会进入交付报告',
      onClick: onOverride,
      danger: true,
    },
    {
      label: '放弃改动',
      enabled: !checking,
      why: checking ? '检查进行中' : '还原到改动开始时的提交，需要填写原因；先列出受影响的文件',
      onClick: onAbandon,
      danger: true,
    },
  ];
  return (
    <div className="auth-block">
      <h3 className="section-title">授权</h3>
      <ul>
        {rows.map((r) => (
          <li key={r.label}>
            <button
              className={r.label === '合并' && r.enabled ? 'btn btn-primary' : r.danger ? 'btn btn-ghost-danger' : 'btn'}
              disabled={disabled || !r.enabled}
              onClick={r.onClick}
            >
              {r.label}
            </button>
            <span className="disabled-reason">{r.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
