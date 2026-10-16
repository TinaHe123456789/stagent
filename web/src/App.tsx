import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribe, type FeatureView, type OverviewResponse } from './api';
import { AuthDialog, type AuthDialogSpec } from './components/AuthDialog';
import { DanglingNotice } from './components/DanglingNotice';
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
  const [dialog, setDialog] = useState<AuthDialogSpec | null>(null);
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

  /** 授权：成功后刷新；失败时把服务端原因显示在页首，并让对话框保持打开。 */
  const authorize = async (body: { action: string; reason: string } & Record<string, unknown>) => {
    try {
      const r = await api.authorize(body);
      setError(r.ok ? null : `已执行，但没有成功：${r.detail ?? ''}`);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      await refresh();
    }
  };
  const openNewChange = (track: 'small' | 'feature') => {
    setNewOpen(track);
    setTimeout(() => document.getElementById('new-change')?.scrollIntoView({ behavior: 'smooth' }), 0);
  };
  const openMerge = (changeId: string) =>
    setDialog({
      title: '合并这个改动？',
      background: '服务端会重算所有锁定检查的哈希并校验账本，通过后提交到 git（git add -A + commit）。合并免填原因。',
      confirmLabel: '合并',
      reasonOptional: true,
      onConfirm: () => act(() => api.merge(changeId)),
    });
  const openOverride = (changeId: string) =>
    setDialog({
      title: '授权强行合并？',
      background: '还有失败或未验证的例子。强行合并会照常提交，但原因会写进账本、决策记录和交付报告；锁定检查被修改时仍然不能合并。',
      confirmLabel: '授权并合并',
      danger: true,
      onConfirm: (reason) => authorize({ action: 'merge_override', changeId, reason }),
    });
  const openAbandon = async (changeId: string) => {
    let extra: AuthDialogSpec['extra'];
    try {
      const p = await api.abandonPreview(changeId);
      extra = (
        <div className="dialog-files">
          <div className="meta">
            还原到 <code>{p.restoreTo.slice(0, 7)}</code>，{p.note}：
          </div>
          {p.files.length === 0 ? (
            <div className="muted">没有需要还原的文件</div>
          ) : (
            <ul>
              {p.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code> <span className="muted">{f.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setDialog({
      title: '放弃这个改动？',
      background: '工作区会还原到改动开始时的提交，下面这些文件的修改会丢失；本改动锁定的例子会解锁，本改动新建的功能会退役。',
      extra,
      confirmLabel: '授权放弃',
      danger: true,
      onConfirm: (reason) => authorize({ action: 'abandon', changeId, reason }),
    });
  };
  const openModifyLocked = (exampleId: string, label: string) =>
    setDialog({
      title: '授权修改锁定例子？',
      background: `${label} 会被解锁。改好检查后在功能详情里点「重新锁定」，系统会写新快照并自动跑全量回归；旧的运行结果不再作证。`,
      confirmLabel: '授权解锁',
      onConfirm: (reason) => authorize({ action: 'modify_locked', exampleId, reason }),
    });
  const openRetire = (f: FeatureView) =>
    setDialog({
      title: `退役功能「${f.name}」？`,
      background: `它的 ${f.lockedCount} 个锁定例子会解锁，功能从账本首页移除（历史记录仍在账本里）。`,
      confirmLabel: '授权退役',
      danger: true,
      onConfirm: async (reason) => {
        await authorize({ action: 'delete', featureId: f.featureId, reason });
        setOpenId(null);
      },
    });
  const openRelease = () =>
    setDialog({
      title: '发布上线？',
      background: '会运行 config.json 里配置的发布命令。授权一次只执行一次；如果中途崩溃，重启后不会自动重跑。',
      confirmLabel: '授权发布',
      danger: true,
      onConfirm: (reason) => authorize({ action: 'release', reason }),
    });

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
              onAcceptLedger={(reason) => act(() => api.acceptLedger(reason))}
              handlers={{
                run_regression: () => act(api.startRun),
                cancel_run: () => act(api.cancelRun),
                add_feature: () => openNewChange('feature'),
                new_change: () => openNewChange('small'),
                lock_examples: () => change && act(() => api.lockExamples(change.changeId)),
                start_check: () => change && act(() => api.startCheck(change.changeId)),
                merge: () => change && openMerge(change.changeId),
                merge_override: () => change && openOverride(change.changeId),
                abandon: () => change && openAbandon(change.changeId),
                restore_locked: () => act(async () => {
                  for (const t of overview.auth.tamperedChecks) await api.restoreExample(t.exampleId);
                }),
                modify_locked: () => {
                  const t = overview.auth.tamperedChecks[0];
                  if (t) openModifyLocked(t.exampleId, `「${t.featureName}」${t.checkPath}`);
                },
                release: () => openRelease(),
              }}
            />
            <DanglingNotice dangling={overview.auth.dangling} onDismiss={(id) => act(() => api.dismissDangling(id))} />
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
                onMerge={() => openMerge(change.changeId)}
                onOverride={() => openOverride(change.changeId)}
                onAbandon={() => openAbandon(change.changeId)}
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
      {openFeature && (
        <FeatureDrawer
          feature={openFeature}
          change={change}
          tampered={overview?.auth.tamperedChecks ?? []}
          onClose={() => setOpenId(null)}
          onModify={(exampleId, label) => openModifyLocked(exampleId, label)}
          onRestore={(exampleId) => act(() => api.restoreExample(exampleId))}
          onRelock={(exampleId) => act(() => api.relockExample(exampleId))}
          onRetire={() => openRetire(openFeature)}
        />
      )}
      {dialog && <AuthDialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
