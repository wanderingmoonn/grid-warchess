/**
 * 启动冒烟：把**真正的** `src/main.ts` 放进 jsdom 里跑一遍，再点几个按钮。
 *
 * 守的是一类线上事故：**页面能打开，但点什么都没反应**。
 *
 * 2026-11-09 出过一次：合并 `style.css` 时少了一个 `}`，`.status-chip.st-exposed`
 * 之后的所有样式被当成它的嵌套内容，首页布局整体失效。当时 `test:ui` 的
 * 219 条断言全绿——因为它 import 的是各个渲染函数，**从来不 import `main.ts`**，
 * "启动 + 事件接线"这条链路没有任何测试覆盖。
 *
 * 所以这里只做三件事，都是"整个页面"级别的：
 *   1. 启动不抛错、不产生运行期报错、首屏占位被替换；
 *   2. 顶栏那几个按钮点了真的改状态（迷雾开关、暂停 AI、结束回合）；
 *   3. 点完之后没有新报错。
 *
 * 它**不能**验证样式表长什么样（jsdom 不排版）——那件事由 `npm run test:css` 管。
 *
 * 运行：npm run test:boot
 */

// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const OUT = '.tmp/boot-bundle.js';
const log = (...a) => console.log('  ok  ', ...a);

/* ------------------------------------------------------------------ *
 * 1. 打包：node 不能直接 import .ts/.css，先让 esbuild 出一个 iife
 * ------------------------------------------------------------------ */
fs.mkdirSync('.tmp', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: OUT,
  // 样式在 jsdom 里没有意义，直接丢掉；它的结构由 check-css 管
  loader: { '.css': 'empty' },
  define: { __APP_VERSION__: '"boot-test"' },
  logLevel: 'silent',
});
assert.ok(fs.statSync(OUT).size > 200_000, '打包结果太小，可能入口没链上');

/* ------------------------------------------------------------------ *
 * 2. jsdom：补上浏览器有、jsdom 没有的那几样
 * ------------------------------------------------------------------ */
const html = fs.readFileSync('index.html', 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<link rel="stylesheet"[\s\S]*?>/g, '');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://boot.test/' });
const { window } = dom;

/**
 * `structuredClone` 是 jsdom 的缺口，不是产品的：`playerView` 用了它，
 * 不补的话首屏会走一遍"存档读不动，改开新局"的兜底。
 */
window.structuredClone = (v) => structuredClone(v);
window.matchMedia = (q) => ({
  matches: false, media: q, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 16);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};

const fakeCtx = new Proxy({}, {
  get: (_, k) => {
    if (k === 'canvas') return { width: 100, height: 100 };
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
    return () => {};
  },
  set: () => true,
});
window.HTMLCanvasElement.prototype.getContext = () => fakeCtx;
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

const errors = [];
window.addEventListener('error', (e) => errors.push(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(e.reason));

/* ------------------------------------------------------------------ *
 * 3. 跑入口
 * ------------------------------------------------------------------ */
let threw = null;
try {
  window.eval(fs.readFileSync(OUT, 'utf8'));
} catch (e) {
  threw = e;
}
const tick = (ms) => new Promise((r) => window.setTimeout(r, ms));
await tick(300);

assert.equal(threw, null, `启动就抛错：${threw?.message ?? threw}`);
assert.deepEqual(errors.map((e) => String(e?.message ?? e)), [], '启动过程中有运行期报错');

const app = window.document.querySelector('#app');
assert.ok(app, '找不到 #app');
const text = () => (app.textContent ?? '').replace(/\s+/g, ' ');
assert.ok(!/正在布置战场/.test(text()), '首屏占位还在——入口没渲染出来');
log('启动：无抛错、无报错、首屏已渲染');

/* ------------------------------------------------------------------ *
 * 4. 点按钮：挑"点了会改文字"的，innerHTML 不作判据
 *    （zoom-in / 反馈 这类改的是 CSS 类或弹层，innerHTML 不变）
 * ------------------------------------------------------------------ */
async function untilText(pred, what) {
  for (let i = 0; i < 40; i++) {
    if (pred(text())) return text();
    await tick(50);
  }
  assert.fail(`点了 ${what} 之后界面没变（2 秒内）`);
}

{
  const fog = window.document.querySelector('[data-act="toggle-fog"]');
  assert.ok(fog, '顶栏缺少迷雾开关');
  const before = /迷雾：(开|关)/.exec(text())?.[1];
  assert.ok(before, '顶栏没写迷雾状态');
  fog.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await untilText((t) => new RegExp(`迷雾：${before === '开' ? '关' : '开'}`).test(t), '迷雾开关');
  log(`交互：迷雾 ${before} → ${before === '开' ? '关' : '开'}`);
}

{
  const pause = window.document.querySelector('[data-act="ai-pause"]');
  assert.ok(pause, '顶栏缺少暂停 AI');
  const before = /暂停 AI/.test(text()) ? '暂停 AI' : '继续';
  pause.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await untilText((t) => (before === '暂停 AI' ? /继续/.test(t) : /暂停 AI/.test(t)), '暂停 AI');
  log('交互：暂停 AI 有反应');
}

{
  const end = window.document.querySelector('[data-act="end-turn"]');
  assert.ok(end, '顶栏缺少结束回合');
  const turnOf = (t) => Number(/第 (\d+) 回合/.exec(t)?.[1] ?? 0);
  const before = turnOf(text());
  assert.ok(before > 0, '顶栏没写回合数');
  end.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await untilText((t) => turnOf(t) > before, '结束回合');
  log(`交互：第 ${before} 回合 → 第 ${turnOf(text())} 回合`);
}

assert.deepEqual(errors.map((e) => String(e?.message ?? e)), [], '点击过程中有新报错');

console.log('\n通过：启动与事件接线正常\n');
