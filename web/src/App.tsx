import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribe, type FeatureView, type OverviewResponse } from './api';
import { ConclusionCard } from './components/ConclusionCard';
import { ChangePanel } from './components/ChangePanel';
import { NewChange } from './components/NewChange';
import { FeatureDrawer } from './components/FeatureDrawer';
import { FeatureTable } from './components/FeatureTable';
import { GuardNotice } from './components/GuardNotice';
import { Stats } from './components/Stats';
import { TopBar } from './components/TopBar';

/** 兜底轮询：服务端监听到的工作区变化会经 SSE 推送，这里再定时刷新一次以防漏事件。 */
const POLL_MS = 5000;

export function App() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [features, setFeatures] = useState<FeatureView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState<null | 'small' | 'feature'>(null);
  const pending = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [o, f] = await Promise.all([api.overview(), api.features()]);
      setOverview(o);
      setFeatures(f);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribe(() => {
      if (pending.current !== null) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        void refresh();
      }, 150);
    });
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const openFeature = features.find((f) => f.featureId === openId) ?? null;
  const change = overview?.change ?? null;
  const locked = overview?.ledger.state === 'locked';

  return (
    <div className="app">
      <TopBar overview={overview} />
      <main className="page">
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
        {!overview ? (
          <div className="loading">正在读取账本…</div>
        ) : (
          <>
            <ConclusionCard
              overview={overview}
              onRun={() => act(api.startRun)}
              onCancel={() => act(api.cancelRun)}
              onAcceptLedger={(reason) => act(() => api.acceptLedger(reason))}
              onNewChange={(track) => {
                setNewOpen(track);
                setTimeout(() => document.getElementById('new-change')?.scrollIntoView({ behavior: 'smooth' }), 0);
              }}
              onLockExamples={() => change && act(() => api.lockExamples(change.changeId))}
              onStartCheck={() => change && act(() => api.startCheck(change.changeId))}
            />
            {overview.runError && <div className="banner banner-error">上次运行被拒绝：{overview.runError}</div>}
            <GuardNotice block={overview.lastGuardBlock} />
            {change && (
              <ChangePanel
                change={change}
                features={features}
                disabled={locked}
                onSetTrack={(track) => act(() => api.setTrack(change.changeId, track))}
                onDraft={(body) => act(() => api.draftExample(change.changeId, body))}
                onLock={() => act(() => api.lockExamples(change.changeId))}
                onCheck={() => act(() => api.startCheck(change.changeId))}
              />
            )}
            {!change && (newOpen || features.length > 0) && (
              <NewChange
                key={newOpen ?? 'default'}
                disabled={locked}
                defaultTrack={newOpen ?? 'small'}
                onCreate={async (description, track) => {
                  await act(() => api.createChange(description, track));
                  setNewOpen(null);
                }}
              />
            )}
            {overview.stats.features > 0 && <Stats stats={overview.stats} />}
            {features.length > 0 && <FeatureTable features={features} onOpen={setOpenId} />}
          </>
        )}
      </main>
      {openFeature && <FeatureDrawer feature={openFeature} change={change} onClose={() => setOpenId(null)} />}
    </div>
  );
}
