/**
 * Bash 危险命令规则（规格 §6 守卫；对应 spec v2.2 附录 B）。
 *
 * 附录 B 原文缺失，下面的规则按 §6 的"删除 / 强推 / 删库"三类推断，并补上"shell 写入 .stagent/"一类
 * （否则 Write/Edit 被拦后换成 `echo > .stagent/...` 就能绕过）。每条规则都有正反例测试（test/guard/rules.test.ts）。
 *
 * 结构类规则（rm、find、git、.stagent 写入）在拆分后的简单命令上判断；
 * 数据库类规则用正则匹配每个简单命令的文本，引号里的 SQL（psql -c "DROP TABLE x"）也能命中，
 * 但跳过 grep / rg / git 等只读搜索与提交命令，避免 `grep -r "DROP TABLE"` 误拦。
 *
 * 规则可经 config.guard.bashRules 扩展：每项是正则源码（或 `/源码/flags`），匹配整条命令；非法正则忽略并给出警告。
 */
import { commandWord, gitSubcommand, hasFlag, positionals, redirectTargets, splitCommands, type SimpleCommand } from './shell.js';

export interface BashRuleContext {
  /** 当前会话是否是「确认例子」阶段的起草会话：允许写 .stagent/checks/draft/**。 */
  draftAllowed: boolean;
}

export interface BashRule {
  id: string;
  /** 给人看的规则说明（docs/guard.md 的规则表）。 */
  description: string;
  /** 拦截时告诉 AI 的原因与替代做法。 */
  reason: string;
  match(cmds: SimpleCommand[], raw: string, ctx: BashRuleContext): boolean;
}

/**
 * 可以放心递归删除的依赖与构建产物目录。`rm -rf node_modules`、`rm -rf packages/a/dist` 放行；
 * 目标里有 `..`、绝对路径、`~`、变量、通配符（在这些目录之前）时一律不算。
 */
export const DISPOSABLE_DIRS = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '__pycache__',
  '.pytest_cache',
  'target',
];

export function isDisposableTarget(target: string): boolean {
  if (!target || target.startsWith('/') || target.startsWith('~') || /[$`]/.test(target)) return false;
  const segments = target.replace(/^(\.\/)+/, '').split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..' || s.toLowerCase() === '.stagent' || s === '.git')) return false;
  for (const s of segments) {
    if (DISPOSABLE_DIRS.includes(s)) return true;
    if (/[*?[\]{}]/.test(s)) return false;
  }
  return false;
}

/** 词里是否引用了 .stagent/ 目录（含绝对路径、`--file=.stagent/x`）。 */
export function refersToStagent(word: string): boolean {
  return /(^|[/=])\.stagent(\/|$)/i.test(word);
}

function isDraftWord(word: string): boolean {
  return /(^|[/=])\.stagent\/checks\/draft\/./i.test(word) && !word.split('/').includes('..');
}

const RM_WORDS = new Set(['rm', 'unlink', 'shred']);
/** 修改所有参数的命令：任一参数在 .stagent/ 里就算写入。 */
const WRITE_ALL_ARGS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'touch', 'mkdir', 'chmod', 'chown', 'truncate', 'tee', 'mv']);
/** 只写最后一个参数（目标）的命令。 */
const WRITE_LAST_ARG = new Set(['cp', 'install', 'rsync', 'ln']);
/** 只读搜索 / 提交说明里出现 SQL 关键字不算危险。 */
const TEXT_ONLY_WORDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'git']);

const WHOLE_TREE = new Set(['.', './', ':/', '*', ':(top)', ':/*']);

function each(cmds: SimpleCommand[], word: string, fn: (args: string[], viaXargs: boolean) => boolean): boolean {
  return cmds.some((c) => {
    const w = commandWord(c);
    return w.word === word && fn(w.args, w.viaXargs);
  });
}

function eachGit(cmds: SimpleCommand[], sub: string, fn: (rest: string[]) => boolean): boolean {
  return each(cmds, 'git', (args) => {
    const g = gitSubcommand(args);
    return g.sub === sub && fn(g.rest);
  });
}

function textMatch(cmds: SimpleCommand[], re: RegExp): boolean {
  return cmds.some((c) => {
    const w = commandWord(c).word;
    if (w && TEXT_ONLY_WORDS.has(w)) return false;
    return re.test(c.join(' '));
  });
}

export const DEFAULT_BASH_RULES: readonly BashRule[] = [
  {
    id: 'rm-recursive',
    description: '递归删除（rm -r / -rf / -fr / -r -f / --recursive），依赖与构建产物目录除外',
    reason: '递归删除可能抹掉用户的工作，已拦截。只允许删除 node_modules、dist、build、.next、coverage 等依赖或构建产物目录；确实需要删除其他目录，请在回报里说明，由用户自己执行',
    match: (cmds) =>
      each(cmds, 'rm', (args, viaXargs) => {
        if (!hasFlag(args, 'r', '--recursive') && !hasFlag(args, 'R')) return false;
        const targets = positionals(args);
        if (viaXargs) return true; // 目标来自标准输入，看不到
        return targets.some((t) => !isDisposableTarget(t));
      }),
  },
  {
    id: 'find-delete',
    description: 'find … -delete，或 find … -exec rm（起点全是依赖/构建产物目录时除外）',
    reason: 'find 批量删除可能抹掉用户的工作，已拦截。请改为列出要删的文件，在回报里说明，由用户确认后执行',
    match: (cmds) =>
      each(cmds, 'find', (args) => {
        const execRm = args.some(
          (a, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a) && RM_WORDS.has((args[i + 1] ?? '').split('/').pop()!),
        );
        if (!args.includes('-delete') && !execRm) return false;
        const starts: string[] = [];
        for (const a of args) {
          if (a.startsWith('-') || a === '(' || a === '!') break;
          starts.push(a);
        }
        return starts.length === 0 || starts.some((s) => !isDisposableTarget(s));
      }),
  },
  {
    id: 'git-push-force',
    description: '强制推送：git push --force / -f / --force-with-lease / --force-if-includes / +refspec',
    reason: '强制推送会覆盖远端历史，已拦截（包括 --force-with-lease）。请用普通 git push；如需改写远端历史，请在回报里说明，由用户自己执行',
    match: (cmds) =>
      eachGit(
        cmds,
        'push',
        (rest) =>
          hasFlag(rest, 'f', '--force', '--force-with-lease', '--force-if-includes') ||
          positionals(rest).some((p) => p.startsWith('+')),
      ),
  },
  {
    id: 'git-push-delete',
    description: '删除远端分支或引用：git push --delete / -d / origin :branch / --mirror / --prune',
    reason: '删除远端分支或引用无法从本地撤销，已拦截。请在回报里说明，由用户自己执行',
    match: (cmds) =>
      eachGit(
        cmds,
        'push',
        (rest) => hasFlag(rest, 'd', '--delete', '--mirror', '--prune') || positionals(rest).slice(1).some((p) => p.startsWith(':')),
      ),
  },
  {
    id: 'git-reset-hard',
    description: 'git reset --hard（丢弃未提交的改动）',
    reason: 'git reset --hard 会丢弃未提交的改动，已拦截。要撤销自己的改动，请逐个文件修改回去，或在回报里说明由用户处理',
    match: (cmds) => eachGit(cmds, 'reset', (rest) => rest.includes('--hard')),
  },
  {
    id: 'git-clean-force',
    description: 'git clean -f（含 -fd、-fdx、--force；带 -n / --dry-run 的预演除外）',
    reason: 'git clean -f 会永久删除未跟踪的文件，已拦截。可以先用 git clean -n 列出，再在回报里说明由用户执行',
    match: (cmds) => eachGit(cmds, 'clean', (rest) => hasFlag(rest, 'f', '--force') && !hasFlag(rest, 'n', '--dry-run')),
  },
  {
    id: 'git-discard-changes',
    description: '整体丢弃工作区改动：git checkout . / -- . / -f、git restore .（只取消暂存的 --staged 除外）、git stash drop / clear',
    reason: '这条命令会整体丢弃工作区里未提交的改动（可能包含用户的工作），已拦截。只撤销你改过的具体文件，或在回报里说明由用户处理',
    match: (cmds) =>
      eachGit(cmds, 'checkout', (rest) => hasFlag(rest, 'f', '--force') || positionals(rest).some((p) => WHOLE_TREE.has(p))) ||
      eachGit(cmds, 'restore', (rest) => {
        const stagedOnly = hasFlag(rest, 'S', '--staged') && !hasFlag(rest, 'W', '--worktree');
        return !stagedOnly && positionals(rest).some((p) => WHOLE_TREE.has(p));
      }) ||
      eachGit(cmds, 'stash', (rest) => rest[0] === 'drop' || rest[0] === 'clear'),
  },
  {
    id: 'git-branch-force-delete',
    description: '强制删除本地分支：git branch -D / --delete --force',
    reason: '强制删除分支可能丢掉未合并的提交，已拦截。可以用 git branch -d（只删已合并的分支），或在回报里说明由用户执行',
    match: (cmds) =>
      eachGit(cmds, 'branch', (rest) => hasFlag(rest, 'D') || (hasFlag(rest, 'd', '--delete') && hasFlag(rest, 'f', '--force'))),
  },
  {
    id: 'sql-drop',
    description: '删库删表：DROP DATABASE / TABLE / SCHEMA（含 psql -c、mysql -e 引号里的 SQL），MongoDB dropDatabase()',
    reason: '删除数据库、表或 schema 无法撤销，已拦截。如果确实需要，请在回报里说明，由用户自己执行',
    match: (cmds) => textMatch(cmds, /\bdrop\s+(database|table|schema)\b|\bdropDatabase\s*\(/i),
  },
  {
    id: 'sql-truncate',
    description: '清空表：TRUNCATE TABLE name（大小写不限），或大写的 TRUNCATE name（Unix 的 truncate -s 与普通英文里的 truncate 除外）',
    reason: '清空表数据无法撤销，已拦截。如果确实需要，请在回报里说明，由用户自己执行',
    match: (cmds) => textMatch(cmds, /\btruncate\s+table\b/i) || textMatch(cmds, /\bTRUNCATE\s+(?!-)["`\w]/),
  },
  {
    id: 'dropdb',
    description: '删库命令行工具：dropdb、mysqladmin drop',
    reason: '删除数据库无法撤销，已拦截。如果确实需要，请在回报里说明，由用户自己执行',
    match: (cmds) => each(cmds, 'dropdb', () => true) || each(cmds, 'mysqladmin', (args) => positionals(args).includes('drop')),
  },
  {
    id: 'prisma-reset',
    description: 'Prisma 重置数据库：prisma migrate reset、prisma db push --force-reset',
    reason: '这条命令会清空并重建数据库，已拦截。请用 prisma migrate dev；如需重置，请在回报里说明由用户执行',
    match: (cmds) => textMatch(cmds, /\bprisma\s+migrate\s+reset\b|\bprisma\s+db\s+push\b.*--force-reset/),
  },
  {
    id: 'framework-db-drop',
    description: '框架删库：rails / rake db:drop / db:reset / db:purge，Django manage.py flush',
    reason: '这条命令会删除或清空数据库，已拦截。如果确实需要，请在回报里说明，由用户自己执行',
    match: (cmds) => textMatch(cmds, /\b(rails|rake)\s+db:(drop|reset|purge)\b|\b(manage\.py|django-admin)\s+flush\b/),
  },
  {
    id: 'redis-flush',
    description: 'Redis 清库：FLUSHALL / FLUSHDB',
    reason: '清空 Redis 数据无法撤销，已拦截。如果确实需要，请在回报里说明，由用户自己执行',
    match: (cmds) => textMatch(cmds, /\bflush(all|db)\b/i),
  },
  {
    id: 'stagent-write',
    description: 'shell 写入 .stagent/：重定向（> / >>）、tee、sed -i / perl -i、cp / mv / rm / touch / ln / dd of= 等，git checkout / restore / rm / mv 作用于 .stagent/',
    reason: '.stagent/ 是 Stagent 的账本、快照与锁定检查，只能由 Stagent 自己写入，已拦截。如果你认为例子需要改，请在回报里说明，由用户授权修改',
    match: (cmds, _raw, ctx) => {
      const hit = (w: string) => refersToStagent(w) && !(ctx.draftAllowed && isDraftWord(w));
      return cmds.some((c) => {
        if (redirectTargets(c).some(hit)) return true;
        const { word, args } = commandWord(c);
        if (!word) return false;
        const pos = positionals(args);
        if (WRITE_ALL_ARGS.has(word)) return pos.some(hit);
        if (WRITE_LAST_ARG.has(word)) return pos.length > 0 && hit(pos[pos.length - 1]!);
        if (word === 'dd') return args.some((a) => a.startsWith('of=') && hit(a));
        if (word === 'sed' || word === 'perl') {
          const inPlace = args.some((a) => a.startsWith('-i') || a === '--in-place' || a.startsWith('--in-place=') || /^-[a-hj-zA-Z]*i/.test(a));
          return inPlace && pos.some(hit);
        }
        if (word === 'git') {
          const g = gitSubcommand(args);
          return ['checkout', 'restore', 'rm', 'mv', 'clean', 'apply'].includes(g.sub ?? '') && positionals(g.rest).some(hit);
        }
        return false;
      });
    },
  },
];

export interface CompiledRules {
  rules: BashRule[];
  /** 被忽略的配置规则（非法正则）。 */
  warnings: string[];
}

/** 默认规则 + config.guard.bashRules（正则源码，或 `/源码/flags`），匹配整条命令。 */
export function compileBashRules(extra: readonly string[] = []): CompiledRules {
  const rules: BashRule[] = [...DEFAULT_BASH_RULES];
  const warnings: string[] = [];
  extra.forEach((source, i) => {
    let re: RegExp;
    try {
      const m = /^\/(.+)\/([a-z]*)$/s.exec(source);
      re = m ? new RegExp(m[1]!, m[2]!.replace(/[gy]/g, '')) : new RegExp(source);
    } catch (err) {
      warnings.push(`config.guard.bashRules[${i}] 不是合法正则，已忽略：${(err as Error).message}`);
      return;
    }
    rules.push({
      id: `config:${i}`,
      description: `项目配置规则 ${source}`,
      reason: `命令命中项目配置的守卫规则 ${source}，已拦截。如果确实需要，请在回报里说明，由用户自己执行`,
      match: (_cmds, raw) => re.test(raw),
    });
  });
  return { rules, warnings };
}

/** 第一条命中的规则；没有命中返回 null。 */
export function matchBashRules(command: string, rules: readonly BashRule[], ctx: BashRuleContext): BashRule | null {
  const cmds = splitCommands(command);
  return rules.find((r) => r.match(cmds, command, ctx)) ?? null;
}
