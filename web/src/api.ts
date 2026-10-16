import type { Overview } from '../../src/projection/overview';
import type { FeatureView } from '../../src/projection/projection';

export type { CardAction, CardStatus, Overview } from '../../src/projection/overview';
export type { ExampleView, FeatureView, UnverifiedReason } from '../../src/projection/projection';

export type OverviewResponse = Overview & {
  runError: string | null;
  project: { name: string; branch: string | null };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

export const api = {
  overview: () => request<OverviewResponse>('GET', '/api/overview'),
  features: () => request<FeatureView[]>('GET', '/api/features'),
  feature: (id: string) => request<FeatureView>('GET', `/api/features/${encodeURIComponent(id)}`),
  startRun: () => request<{ total: number }>('POST', '/api/runs'),
  cancelRun: () => request<{ ok: true }>('POST', '/api/runs/current/cancel'),
  acceptLedger: (reason: string) => request<{ ok: true }>('POST', '/api/ledger/accept', { reason }),
  devAddFeature: (name: string) => request<{ featureId: string }>('POST', '/api/dev/features', { name }),
  devLockExample: (featureId: string, body: Record<string, string>) =>
    request<{ exampleId: string }>('POST', `/api/dev/features/${encodeURIComponent(featureId)}/examples`, body),
};

/** 订阅服务端事件；任何事件都触发 onChange。EventSource 自带 Last-Event-ID 续传。 */
export function subscribe(onChange: (type: string) => void): () => void {
  const es = new EventSource('/api/events/stream');
  const types = ['run.started', 'run.progress', 'run.finished', 'run.failed', 'ledger.appended', 'ledger.locked', 'resync'];
  for (const t of types) es.addEventListener(t, () => onChange(t));
  return () => es.close();
}
