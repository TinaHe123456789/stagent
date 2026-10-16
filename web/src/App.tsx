import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribe, type FeatureView, type OverviewResponse } from './api';
import { ConclusionCard } from './components/ConclusionCard';
import { DevPanel } from './components/DevPanel';
import { FeatureDrawer } from './components/FeatureDrawer';
import { FeatureTable } from './components/FeatureTable';
import { GuardNotice } from './components/GuardNotice';
import { Stats } from './components/Stats';
import { TopBar } from './components/TopBar';

/** 工作区的变化（证据过期）在 M2-2 接入文件监听前靠轮询发现。 */
const POLL_MS = 5000;

export function App() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [features, setFeatures] = useState<FeatureView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [devOpen, setDevOpen] = useState(false);
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
              onAddFeature={() => setDevOpen(true)}
            />
            {overview.runError && <div className="banner banner-error">上次运行被拒绝：{overview.runError}</div>}
            <GuardNotice block={overview.lastGuardBlock} />
            {overview.stats.features > 0 && <Stats stats={overview.stats} />}
            {features.length > 0 && <FeatureTable features={features} onOpen={setOpenId} />}
            <DevPanel
              open={devOpen || features.length > 0}
              features={features}
              disabled={overview.ledger.state === 'locked'}
              onAddFeature={(name) => act(() => api.devAddFeature(name))}
              onLockExample={(id, body) => act(() => api.devLockExample(id, body))}
            />
          </>
        )}
      </main>
      {openFeature && <FeatureDrawer feature={openFeature} onClose={() => setOpenId(null)} />}
    </div>
  );
}
