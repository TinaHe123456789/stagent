import { useState, type FormEvent } from 'react';

interface Props {
  disabled: boolean;
  defaultTrack?: 'small' | 'feature';
  onCreate: (description: string, track: 'small' | 'feature') => Promise<void>;
}

/** 描述一个改动。只要会新增或改变用户可见行为，就选新功能档（D19）。 */
export function NewChange({ disabled, defaultTrack = 'small', onCreate }: Props) {
  const [description, setDescription] = useState('');
  const [track, setTrack] = useState<'small' | 'feature'>(defaultTrack);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onCreate(description, track);
    setDescription('');
  };
  return (
    <section className="card" aria-label="描述一个改动" id="new-change">
      <h2 className="section-title">描述一个改动</h2>
      <form className="new-change" onSubmit={submit}>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="例如：登录加验证码 / 把按钮改成蓝色"
          disabled={disabled}
        />
        <div className="track-choice" role="radiogroup" aria-label="档位">
          <label className={track === 'small' ? 'chosen' : ''}>
            <input type="radio" checked={track === 'small'} onChange={() => setTrack('small')} disabled={disabled} />
            小改动 <span className="muted">只跑全量回归</span>
          </label>
          <label className={track === 'feature' ? 'chosen' : ''}>
            <input type="radio" checked={track === 'feature'} onChange={() => setTrack('feature')} disabled={disabled} />
            新功能 <span className="muted">先确认例子再实现</span>
          </label>
        </div>
        <button className="btn btn-primary" disabled={disabled || !description.trim()}>
          开始改动
        </button>
      </form>
      <p className="muted small">会新增或改变用户可见行为的，请选新功能。Claude Code 自动判断档位在 M3 提供。</p>
    </section>
  );
}
