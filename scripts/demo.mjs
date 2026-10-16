#!/usr/bin/env node
/**
 * 演示：在临时目录生成一个示例项目，锁定几个例子并跑一次全量回归，然后启动 Stagent 服务。
 *
 *   npm run demo                 # 构建后在 0.0.0.0:4310 启动
 *   PORT=4400 node scripts/demo.mjs
 *
 * 示例状态：一个进行中的新功能档改动被阻止——购物车结算已验证、登录被破坏、支付结果不稳定。
 * 需要先 npm run build（npm run demo 会自动构建）。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../dist/index.js', import.meta.url);
const { initProject, startService } = await import(dist.href);

const root = join(tmpdir(), 'stagent-demo');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'src'), { recursive: true });

const files = {
  'package.json': JSON.stringify({ name: 'shop-demo', private: true, type: 'module' }, null, 2),
  'README.md': '# shop demo\n',
  '.gitignore': 'node_modules/\n',
  'src/shop.mjs': `export function total(items) { return items.reduce((s, i) => s + i.price * i.qty, 0); }
export function login(user, pass) { return user === 'alice' && pass === 'secret'; }
export function pay(amount) { return amount > 0; }
`,
  '.stagent/checks/cart/total.mjs': `const { total } = await import(process.env.STAGENT_PROJECT_ROOT + '/src/shop.mjs');
process.exit(total([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]) === 25 ? 0 : 1);
`,
  '.stagent/checks/cart/empty.mjs': `const { total } = await import(process.env.STAGENT_PROJECT_ROOT + '/src/shop.mjs');
process.exit(total([]) === 0 ? 0 : 1);
`,
  '.stagent/checks/login/ok.mjs': `const { login } = await import(process.env.STAGENT_PROJECT_ROOT + '/src/shop.mjs');
process.exit(login('alice', 'secret') ? 0 : 1);
`,
  '.stagent/checks/login/wrong.mjs': `const { login } = await import(process.env.STAGENT_PROJECT_ROOT + '/src/shop.mjs');
process.exit(login('alice', 'nope') ? 1 : 0);
`,
  // 第一次失败、第二次通过：演示"结果不稳定"。
  '.stagent/checks/pay/ok.mjs': `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const m = process.env.STAGENT_PROJECT_ROOT + '/node_modules/.pay-warm';
if (existsSync(m)) process.exit(0);
mkdirSync(process.env.STAGENT_PROJECT_ROOT + '/node_modules', { recursive: true });
writeFileSync(m, '');
process.exit(1);
`,
};
for (const [path, content] of Object.entries(files)) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}
const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@stagent.local', ...args], { cwd: root });
git('init', '-q', '-b', 'main');
await initProject(root);
await writeFile(join(root, '.stagent/config.json'), JSON.stringify({ checkCommand: 'node {path}', checkTimeoutMs: 10000, releaseCommand: 'echo 已发布 > released.txt' }, null, 2));
git('add', '-A');
git('commit', '-q', '-m', 'demo');

const port = Number(process.env.PORT ?? 4310);
const running = await startService({ root, port, host: process.env.HOST ?? '0.0.0.0', open: false });
const call = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};
// 用新功能档的改动登记功能与例子（M3 起由 Claude Code 起草，这里直接用写好的检查文件）。
const change = await call('POST', '/api/changes', { description: '接入购物车、登录与支付', track: 'feature' });
const draft = async (feature, given, when, then, checkPath) =>
  call('POST', `/api/changes/${change.changeId}/examples`, { ...feature, given, when, then, checkPath });

const cart = await draft({ featureName: '购物车结算' }, '购物车里有 2 件 10 元和 1 件 5 元的商品', '查看合计', '合计显示 25 元', '.stagent/checks/cart/total.mjs');
await draft({ featureId: cart.featureId }, '购物车为空', '查看合计', '合计显示 0 元', '.stagent/checks/cart/empty.mjs');
const login = await draft({ featureName: '登录' }, '用户 alice 已注册', '输入正确密码登录', '登录成功', '.stagent/checks/login/ok.mjs');
await draft({ featureId: login.featureId }, '用户 alice 已注册', '输入错误密码登录', '提示密码错误，不能登录', '.stagent/checks/login/wrong.mjs');
await draft({ featureName: '支付' }, '订单金额 25 元', '点击支付', '支付成功', '.stagent/checks/pay/ok.mjs');
await call('POST', `/api/changes/${change.changeId}/examples/lock`, {});

// 改坏登录：错误密码也能登录。
await writeFile(
  join(root, 'src/shop.mjs'),
  files['src/shop.mjs'].replace("user === 'alice' && pass === 'secret'", "user === 'alice'"),
);
await call('POST', `/api/changes/${change.changeId}/check`);
await running.service.waitForRun();

console.log(`Stagent 演示已启动：${running.url}（示例项目 ${root}）`);
const stop = () => void running.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
