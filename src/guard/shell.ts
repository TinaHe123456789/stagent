/**
 * 极简 shell 命令拆分：只为守卫规则服务，不追求完整的 POSIX 语法。
 *
 * - 按 `;` `&&` `||` `|` `&` 换行 `(` `)` 反引号 `$(` 拆成若干"简单命令"，每个简单命令是一组词。
 * - 单双引号内的内容合成一个词（去掉引号），反斜杠转义下一个字符。
 * - 重定向符 `>` `>>` `>|` `&>` `<` 单独成词，便于规则判断写入目标。
 * - `bash -c "..."` / `sh -c` / `eval ...` 的内容会递归拆开，避免用引号包一层就绕过规则。
 *
 * 这是尽力而为的静态检查：变量展开、别名、脚本文件里的命令都看不到（见 docs/guard.md 的局限）。
 */

export type SimpleCommand = string[];

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

export function splitCommands(command: string, depth = 0): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\') {
      if (i + 1 < command.length && command[i + 1] !== '\n') word += command[i + 1];
      inWord = true;
      i++;
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          word += command[j + 1];
          j += 2;
          continue;
        }
        word += command[j];
        j++;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (c === '$' && command[i + 1] === '(') {
      endCommand();
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')' || c === '`') {
      // `&>` 是重定向而不是后台运行
      if (c === '&' && command[i + 1] === '>') {
        endWord();
        words.push('>');
        i += command[i + 2] === '>' ? 2 : 1;
        continue;
      }
      endCommand();
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
      continue;
    }
    if (c === '>' || c === '<') {
      // `2>` 里的 2 是文件描述符，不是参数
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      words.push(c);
      if (command[i + 1] === c || (c === '>' && command[i + 1] === '|')) i++;
      // `>&1` / `>&-`：复制描述符，目标不是文件
      if (command[i + 1] === '&') {
        const m = /^&(\d+|-)/.exec(command.slice(i + 1));
        if (m) {
          words.push(`&${m[1]}`);
          i += m[0].length;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endCommand();

  if (depth >= 3) return out;
  // 递归展开 bash -c / eval 的参数
  const expanded: SimpleCommand[] = [];
  for (const cmd of out) {
    expanded.push(cmd);
    const { word: w, args } = commandWord(cmd);
    if (w === 'eval' && args.length) expanded.push(...splitCommands(args.join(' '), depth + 1));
    if (w && SHELLS.has(w)) {
      const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      const script = ci === -1 ? undefined : args[ci + 1];
      if (script !== undefined) expanded.push(...splitCommands(script, depth + 1));
    }
  }
  return expanded;
}

/** 前缀命令：跳过它们找真正被执行的命令。 */
const PREFIXES = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'xargs', 'builtin']);

export interface CommandWord {
  /** 被执行的命令名（去掉路径，如 /bin/rm → rm）；没有则为 null。 */
  word: string | null;
  args: string[];
  /** 经 xargs 调用：参数来自标准输入，规则看不到。 */
  viaXargs: boolean;
}

export function commandWord(cmd: SimpleCommand): CommandWord {
  let i = 0;
  let viaXargs = false;
  while (i < cmd.length) {
    const w = cmd[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    const base = basenameOf(w);
    if (PREFIXES.has(base)) {
      if (base === 'xargs') viaXargs = true;
      i++;
      // 跳过前缀命令自己的选项（如 sudo -u root、xargs -0）
      while (i < cmd.length && cmd[i]!.startsWith('-')) {
        const opt = cmd[i]!;
        i++;
        if (/^-(u|g|n|I|L|P|d|E|s)$/.test(opt) && i < cmd.length) i++;
      }
      continue;
    }
    return { word: base, args: cmd.slice(i + 1), viaXargs };
  }
  return { word: null, args: [], viaXargs };
}

function basenameOf(w: string): string {
  const i = w.lastIndexOf('/');
  return i === -1 ? w : w.slice(i + 1);
}

/** git 的全局选项（-C dir、-c k=v、--git-dir=…）之后的子命令与参数。 */
export function gitSubcommand(args: string[]): { sub: string | null; rest: string[] } {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    return { sub: a, rest: args.slice(i + 1) };
  }
  return { sub: null, rest: [] };
}

/** 是否带某个短选项（支持合写，如 -fd 含 f）或长选项。 */
export function hasFlag(args: string[], short: string | null, ...long: string[]): boolean {
  for (const a of args) {
    if (a === '--') break;
    if (long.some((l) => a === l || a.startsWith(`${l}=`))) return true;
    if (short && /^-[A-Za-z]+$/.test(a) && a.includes(short)) return true;
  }
  return false;
}

/** 位置参数：去掉选项与重定向（`--` 之后全算位置参数）。 */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '>' || a === '<') {
      i++;
      continue;
    }
    if (opts && a === '--') {
      opts = false;
      continue;
    }
    if (opts && a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}

/** 输出重定向的目标（`> file`、`>> file`、`&> file`）。 */
export function redirectTargets(cmd: SimpleCommand): string[] {
  const out: string[] = [];
  for (let i = 0; i < cmd.length - 1; i++) if (cmd[i] === '>') out.push(cmd[i + 1]!);
  return out;
}
