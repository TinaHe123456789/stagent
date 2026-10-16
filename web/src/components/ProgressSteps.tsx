import type { ChangeView } from '../api';

const STEPS = ['确认例子', '实现', '检查', '确认并合并'];

/** 流程进度条：①确认例子 → ②实现 → ③检查 → ④确认并合并。小改动档跳过第 ① 步。 */
export function ProgressSteps({ change }: { change: Pick<ChangeView, 'step' | 'track' | 'phase'> }) {
  return (
    <ol className="steps" aria-label="流程进度">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const skipped = n === 1 && change.track === 'small';
        const state = skipped ? 'skipped' : n < change.step ? 'done' : n === change.step ? 'current' : 'todo';
        const blocked = n === change.step && change.phase === 'blocked';
        return (
          <li key={label} className={`step step-${state} ${blocked ? 'step-blocked' : ''}`} title={skipped ? '小改动档不需要确认例子' : undefined}>
            <span className="step-num">{'①②③④'[i]}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}
