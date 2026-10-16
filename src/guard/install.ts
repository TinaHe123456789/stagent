/**
 * stagent init 安装的守卫钩子（规格 §6）：
 *
 * - .claude/settings.json 的 PreToolUse hook：`npx stagent hook pre-tool-use`。合并进已有文件，不动其他键和别的 hook；
 *   已经装过（任一 hook 命令包含 `stagent hook pre-tool-use`）就不再重复添加。
 * - .git/hooks/pre-merge-commit 提醒脚本：只提醒"请通过 Stagent 合并"，永远 exit 0、不阻止合并。
 *   用 `# stagent` 标记识别自己的脚本；已有别人的同名钩子则跳过并警告；config.guard.preMergeReminder=false 时不装并删除自己的。
 */
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const CLAUDE_SETTINGS_RELATIVE_PATH = join('.claude', 'settings.json');
export const HOOK_COMMAND = 'npx stagent hook pre-tool-use';
export const HOOK_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
export const PRE_MERGE_MARKER = '# stagent pre-merge-commit reminder';

export interface ClaudeHookResult {
  /** 本次新写入了 hook。 */
  installed: boolean;
  /** 本次新建了 settings.json。 */
  createdFile: boolean;
  warning?: string;
}

export async function installClaudeHook(projectRoot: string): Promise<ClaudeHookResult> {
  const path = join(projectRoot, CLAUDE_SETTINGS_RELATIVE_PATH);
  let settings: Record<string, unknown> = {};
  let createdFile = true;
  try {
    const text = await readFile(path, 'utf8');
    createdFile = false;
    const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text);
    if (!isObject(parsed)) throw new Error('顶层不是对象');
    settings = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        installed: false,
        createdFile: false,
        warning: `${CLAUDE_SETTINGS_RELATIVE_PATH} 无法解析（${(err as Error).message}），未写入守卫 hook；请手动添加 PreToolUse hook：${HOOK_COMMAND}`,
      };
    }
  }

  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const pre = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  if (pre.some(hasStagentHook)) return { installed: false, createdFile: false };

  pre.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  settings.hooks = { ...hooks, PreToolUse: pre };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n');
  return { installed: true, createdFile };
}

function hasStagentHook(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => isObject(h) && typeof h.command === 'string' && h.command.includes('stagent hook pre-tool-use'));
}

export type PreMergeReminderStatus = 'installed' | 'unchanged' | 'skipped' | 'removed' | 'disabled' | 'no-git';

export function preMergeScript(): string {
  return `#!/bin/sh
${PRE_MERGE_MARKER}（只提醒，不阻止合并；关闭：.stagent/config.json 设 "guard": { "preMergeReminder": false } 后重新运行 stagent init）
# Stagent 自己合并时会设置 STAGENT_MERGE=1，不再提醒。
[ -n "$STAGENT_MERGE" ] && exit 0
echo "⚠️  Stagent 提醒：这次合并没有经过 Stagent。建议在 Stagent 页面里合并，它会先确认锁定的验收例子都已验证。本提醒不会阻止合并。" >&2
exit 0
`;
}

export async function installPreMergeReminder(
  projectRoot: string,
  enabled: boolean,
): Promise<{ status: PreMergeReminderStatus; warning?: string }> {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  if (!(await exists(hooksDir))) return { status: 'no-git' };
  const path = join(hooksDir, 'pre-merge-commit');
  const current = await readFile(path, 'utf8').catch(() => null);
  const ours = current !== null && current.includes(PRE_MERGE_MARKER);

  if (!enabled) {
    if (ours) {
      await rm(path, { force: true });
      return { status: 'removed' };
    }
    return { status: 'disabled' };
  }
  if (current !== null && !ours) {
    return { status: 'skipped', warning: '.git/hooks/pre-merge-commit 已存在且不是 Stagent 的，未安装合并提醒' };
  }
  const script = preMergeScript();
  if (current === script) return { status: 'unchanged' };
  await writeFile(path, script);
  await chmod(path, 0o755);
  return { status: ours ? 'unchanged' : 'installed' };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
