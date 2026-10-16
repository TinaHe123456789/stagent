import { useState, type FormEvent } from 'react';
import type { FeatureView } from '../api';

interface Props {
  open: boolean;
  disabled: boolean;
  features: FeatureView[];
  onAddFeature: (name: string) => Promise<void>;
  onLockExample: (featureId: string, body: Record<string, string>) => Promise<void>;
}

/**
 * M1 临时演示入口：手动添加功能、锁定一个已写好的检查文件。
 * M2-2 由正式的改动流程（新功能档：起草 → 确认 → 锁定）替换。
 */
export function DevPanel({ open, disabled, features, onAddFeature, onLockExample }: Props) {
  const [name, setName] = useState('');
  const [form, setForm] = useState({ featureId: '', given: '', when: '', then: '', kind: 'behavior', checkPath: '.stagent/checks/' });
  if (!open) return null;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const featureId = form.featureId || features[0]?.featureId || '';

  const addFeature = async (e: FormEvent) => {
    e.preventDefault();
    await onAddFeature(name);
    setName('');
  };
  const lock = async (e: FormEvent) => {
    e.preventDefault();
    await onLockExample(featureId, { ...form, featureId });
    setForm({ ...form, given: '', when: '', then: '' });
  };

  return (
    <section className="card dev-panel" aria-label="手动添加（M1 演示用）">
      <h2 className="section-title">
        手动添加 <span className="tag">M1 演示用 · M2 将由正式流程替换</span>
      </h2>
      <form className="row" onSubmit={addFeature}>
        <input placeholder="功能名称，例如：登录" value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} />
        <button className="btn" disabled={disabled || !name.trim()}>
          添加功能
        </button>
      </form>
      {features.length > 0 && (
        <form className="grid" onSubmit={lock}>
          <label className="field">
            <span>功能</span>
            <select value={featureId} onChange={set('featureId')} disabled={disabled}>
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
          <label className="field">
            <span>情况</span>
            <input value={form.given} onChange={set('given')} placeholder="用户已注册" disabled={disabled} />
          </label>
          <label className="field">
            <span>操作</span>
            <input value={form.when} onChange={set('when')} placeholder="输入正确密码并提交" disabled={disabled} />
          </label>
          <label className="field">
            <span>期望</span>
            <input value={form.then} onChange={set('then')} placeholder="进入首页" disabled={disabled} />
          </label>
          <label className="field">
            <span>检查文件（已写好，在 .stagent/checks/ 下）</span>
            <input value={form.checkPath} onChange={set('checkPath')} disabled={disabled} />
          </label>
          <div className="grid-actions">
            <button className="btn" disabled={disabled || !form.given || !form.when || !form.then}>
              锁定例子
            </button>
            <span className="muted">锁定时保存检查快照；之后系统只运行快照里的内容。</span>
          </div>
        </form>
      )}
    </section>
  );
}
