import type { CheckResult, Event, LedgerLine } from '../../src/ledger/types.js';

/** 投影测试用：直接构造账本行（投影不校验哈希）。 */
export class LineBuilder {
  readonly lines: LedgerLine[] = [];
  private t = Date.parse('2026-10-16T08:00:00Z');

  add(event: Event): this {
    this.t += 1000;
    this.lines.push({ seq: this.lines.length, at: new Date(this.t).toISOString(), event, prevHash: '0'.repeat(64), hash: '0'.repeat(64) });
    return this;
  }

  feature(featureId: string, name = featureId): this {
    return this.add({ type: 'feature.created', featureId, name, origin: 'new' });
  }

  example(featureId: string, exampleId: string, checkHash = `h-${exampleId}`, kind: 'behavior' | 'visual' = 'behavior'): this {
    this.add({ type: 'example.drafted', exampleId, featureId, given: 'g', when: 'w', then: `期望 ${exampleId}`, kind });
    return this.add({ type: 'example.locked', exampleId, checkPath: `.stagent/checks/${exampleId}.mjs`, checkHash, by: 'user' });
  }

  run(
    results: Array<[exampleId: string, status: CheckResult['status'], checkHash?: string]>,
    opts: { workTreeHash?: string; spec?: string; valid?: boolean; purpose?: 'regression' | 'red_check' | 'baseline' } = {},
  ): this {
    const wt = opts.workTreeHash ?? 'wt1';
    return this.add({
      type: 'run.completed',
      runId: `r${this.lines.length}`,
      purpose: opts.purpose ?? 'regression',
      startCommit: 'c1',
      endCommit: 'c1',
      startWorkTreeHash: wt,
      endWorkTreeHash: wt,
      workTreeHashSpec: opts.spec ?? 'spec1',
      valid: opts.valid ?? true,
      snapshots: Object.fromEntries(results.map(([id, , h]) => [id, h ?? `h-${id}`])),
      results: results.map(([exampleId, status]) => ({ exampleId, status, durationMs: 10, logPath: `log/${exampleId}` })),
      commit: 'c1',
      workTreeHash: wt,
    });
  }
}

export const CURRENT = { workTreeHash: 'wt1', workTreeHashSpec: 'spec1' };
