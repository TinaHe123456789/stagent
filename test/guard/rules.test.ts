import { describe, expect, it } from 'vitest';
import { compileBashRules, DEFAULT_BASH_RULES, isDisposableTarget, matchBashRules } from '../../src/guard/rules.js';
import { splitCommands } from '../../src/guard/shell.js';

const ctx = { draftAllowed: false };

/** 每条默认规则的正例（必须被这条规则拦下）与反例（这条规则不能命中）。 */
const CASES: Record<string, { deny: string[]; allow: string[] }> = {
  'rm-recursive': {
    deny: [
      'rm -rf /',
      'rm -rf src',
      'rm -fr src',
      'rm -r -f src',
      'rm -R lib',
      'rm --recursive --force docs',
      'sudo rm -rf ~/project',
      'rm -rf ./node_modules/../src',
      'rm -rf $HOME',
      'rm -rf *',
      'cd app && rm -rf .',
      'find . -name x | xargs rm -rf',
      'bash -c "rm -rf src"',
      '/bin/rm -rf build-scripts',
    ],
    allow: [
      'rm -rf node_modules',
      'rm -rf ./dist',
      'rm -rf node_modules dist .next coverage',
      'rm -rf packages/web/node_modules',
      'rm -rf dist/*',
      'rm -rf dist 2>/dev/null',
      'rm file.txt',
      'rm -f src/old.ts',
      'echo "rm -rf src"',
      'npm run rm-rf',
    ],
  },
  'find-delete': {
    deny: ['find . -name "*.log" -delete', 'find src -type f -exec rm {} \\;', 'find / -delete', 'find -delete'],
    allow: ['find . -name "*.ts"', 'find node_modules -name "*.map" -delete', 'find dist -type f -exec rm {} +', 'find . -exec cat {} \\;'],
  },
  'git-push-force': {
    deny: [
      'git push --force',
      'git push -f origin main',
      'git push origin main --force-with-lease',
      'git push --force-with-lease=main:abc origin main',
      'git push --force-if-includes',
      'git push -uf origin feat',
      'git push origin +main',
      'git -C repo push --force',
    ],
    allow: ['git push', 'git push -u origin feat', 'git push origin HEAD:main', 'git fetch --force', 'git commit -m "push --force"'],
  },
  'git-push-delete': {
    deny: ['git push origin --delete feat', 'git push -d origin feat', 'git push origin :feat', 'git push --mirror backup', 'git push --prune origin'],
    allow: ['git push origin feat', 'git push origin HEAD:refs/heads/feat', 'git push --tags'],
  },
  'git-reset-hard': {
    deny: ['git reset --hard', 'git reset --hard HEAD~1', 'git stash && git reset --hard origin/main'],
    allow: ['git reset', 'git reset --soft HEAD~1', 'git reset HEAD file.ts', 'git reset --keep HEAD~1'],
  },
  'git-clean-force': {
    deny: ['git clean -f', 'git clean -fd', 'git clean -xdf', 'git clean --force -d'],
    allow: ['git clean -n', 'git clean -fn', 'git clean --dry-run -d', 'git status'],
  },
  'git-discard-changes': {
    deny: [
      'git checkout .',
      'git checkout -- .',
      'git checkout -f main',
      'git restore .',
      'git restore --source=HEAD :/',
      'git restore --staged --worktree .',
      'git stash drop',
      'git stash clear',
    ],
    allow: [
      'git checkout main',
      'git checkout -b feat',
      'git checkout -- src/app.ts',
      'git restore src/app.ts',
      'git restore --staged .',
      'git stash',
      'git stash pop',
    ],
  },
  'git-branch-force-delete': {
    deny: ['git branch -D feat', 'git branch --delete --force feat', 'git branch -d -f feat', 'git branch -df feat'],
    allow: ['git branch -d feat', 'git branch feat', 'git branch --list', 'git branch -m old new'],
  },
  'sql-drop': {
    deny: [
      'psql -c "DROP TABLE users"',
      'mysql -e "drop database app"',
      'sqlite3 app.db "DROP SCHEMA x"',
      'echo "DROP TABLE users;" | psql',
      'psql <<EOF\nDROP TABLE users;\nEOF',
      'mongosh --eval "db.dropDatabase()"',
    ],
    allow: ['psql -c "SELECT * FROM users"', 'grep -r "DROP TABLE" migrations', 'git commit -m "remove drop table usage"', 'npm run dropdown'],
  },
  'sql-truncate': {
    deny: ['psql -c "TRUNCATE TABLE users"', 'mysql -e "truncate table logs"', 'psql -c "TRUNCATE users;"'],
    allow: ['truncate -s 0 app.log', 'truncate --size=0 app.log', 'echo "we truncate long names"', 'rg "TRUNCATE TABLE"'],
  },
  dropdb: {
    deny: ['dropdb app_dev', 'PGPASSWORD=x dropdb -h localhost app', 'mysqladmin -u root drop app'],
    allow: ['createdb app_dev', 'mysqladmin status', 'echo dropdb'],
  },
  'prisma-reset': {
    deny: ['npx prisma migrate reset', 'npx prisma migrate reset --force', 'prisma db push --force-reset'],
    allow: ['npx prisma migrate dev', 'npx prisma db push', 'npx prisma generate'],
  },
  'framework-db-drop': {
    deny: ['bin/rails db:drop', 'rake db:reset', 'rails db:purge', 'python manage.py flush --noinput'],
    allow: ['bin/rails db:migrate', 'rake db:seed', 'python manage.py migrate'],
  },
  'redis-flush': {
    deny: ['redis-cli FLUSHALL', 'redis-cli -n 2 flushdb', 'redis-cli -h host FLUSHALL ASYNC'],
    allow: ['redis-cli GET key', 'redis-cli KEYS "*"', 'echo flushing buffers'],
  },
  'stagent-write': {
    deny: [
      'echo x > .stagent/ledger/events.jsonl',
      'echo x >> .stagent/checks/a.mjs',
      'cat new.mjs | tee .stagent/checks/a.mjs',
      "sed -i 's/1/2/' .stagent/checks/a.mjs",
      "perl -pi -e 's/1/2/' .stagent/checks/a.mjs",
      'cp /tmp/a.mjs .stagent/checks/a.mjs',
      'mv .stagent/checks/a.mjs /tmp/',
      'rm .stagent/ledger/events.jsonl',
      'touch .stagent/checks/new.mjs',
      'ln -s /tmp/evil .stagent/checks/a.mjs',
      'dd if=/dev/zero of=.stagent/ledger/events.jsonl',
      'git checkout -- .stagent/checks/a.mjs',
      'printf x > /abs/project/.stagent/config.json',
      'echo x > .stagent/checks/draft/a.mjs',
    ],
    allow: [
      'cat .stagent/checks/a.mjs',
      'ls -la .stagent',
      'cp .stagent/checks/a.mjs /tmp/a.mjs',
      'grep -r foo .stagent',
      'git add .stagent/checks',
      'git diff .stagent',
      'echo x > src/.stagentrc',
      "sed -n '1,5p' .stagent/checks/a.mjs",
    ],
  },
};

describe('默认 Bash 规则：每条都有正反例', () => {
  it('规则清单与测试用例一一对应', () => {
    expect(Object.keys(CASES).sort()).toEqual(DEFAULT_BASH_RULES.map((r) => r.id).sort());
  });

  for (const rule of DEFAULT_BASH_RULES) {
    describe(rule.id, () => {
      const c = CASES[rule.id]!;
      it.each(c.deny)('拦截：%s', (cmd) => {
        expect(rule.match(splitCommands(cmd), cmd, ctx)).toBe(true);
        expect(matchBashRules(cmd, DEFAULT_BASH_RULES, ctx)).not.toBeNull();
      });
      it.each(c.allow)('不命中：%s', (cmd) => {
        expect(rule.match(splitCommands(cmd), cmd, ctx)).toBe(false);
      });
    });
  }
});

describe('Bash 规则：整体不误拦常见开发命令', () => {
  it.each([
    'npm test',
    'npm install',
    'npx vitest run',
    'git status && git diff',
    'git commit -m "fix: drop unused import"',
    'git push -u origin feat',
    'rm -rf node_modules && npm ci',
    'mkdir -p src/components',
    'cat .stagent/config.json',
    'ls 2>&1 | head',
  ])('%s', (cmd) => {
    expect(matchBashRules(cmd, DEFAULT_BASH_RULES, ctx)).toBeNull();
  });
});

describe('stagent-write 与草稿', () => {
  const rule = DEFAULT_BASH_RULES.find((r) => r.id === 'stagent-write')!;
  it('起草会话可以写 .stagent/checks/draft/，但不能借 .. 跳出草稿目录', () => {
    const draft = { draftAllowed: true };
    const ok = 'echo x > .stagent/checks/draft/a.mjs';
    expect(rule.match(splitCommands(ok), ok, draft)).toBe(false);
    const escape = 'echo x > .stagent/checks/draft/../a.mjs';
    expect(rule.match(splitCommands(escape), escape, draft)).toBe(true);
    const other = 'echo x > .stagent/checks/a.mjs';
    expect(rule.match(splitCommands(other), other, draft)).toBe(true);
  });
});

describe('config.guard.bashRules', () => {
  it('额外规则按正则匹配整条命令，支持 /源码/flags', () => {
    const { rules, warnings } = compileBashRules(['^npm publish', '/deploy\\s+--prod/i']);
    expect(warnings).toEqual([]);
    expect(matchBashRules('npm publish --access public', rules, ctx)?.id).toBe('config:0');
    expect(matchBashRules('vercel DEPLOY --PROD', rules, ctx)?.id).toBe('config:1');
    expect(matchBashRules('npm run build', rules, ctx)).toBeNull();
  });

  it('非法正则被忽略并给出警告', () => {
    const { rules, warnings } = compileBashRules(['(unclosed', 'ok']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bashRules[0]');
    expect(rules.map((r) => r.id)).toContain('config:1');
    expect(rules.map((r) => r.id)).not.toContain('config:0');
  });
});

describe('isDisposableTarget', () => {
  it.each([
    ['node_modules', true],
    ['./dist', true],
    ['apps/web/.next', true],
    ['dist/../src', false],
    ['/tmp/dist', false],
    ['$DIR/dist', false],
    ['*/node_modules', false],
    ['.stagent/dist', false],
    ['src', false],
  ])('%s → %s', (t, expected) => {
    expect(isDisposableTarget(t)).toBe(expected);
  });
});
