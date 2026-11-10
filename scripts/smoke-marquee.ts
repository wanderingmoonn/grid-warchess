/**
 * 上帝模式框选：启动级回归（jsdom 跑真入口）。
 *
 * 为什么这条必须走真入口：框选是**指针交互**——按下去、斜着拖、松手、再点批量按钮。
 * 规则那半（矩形归一、删/刷/放/平移）在 `test:rules` 里用纯函数照着，
 * 但"拖一下真的会选中、工具栏真的会变、按钮真的会生效"只有把 main.ts 跑起来才验得到。
 *
 * jsdom 没有布局，`cellAtPoint` 会一直返回 null。它其实只依赖两样东西：
 *   · `.tiles` 的 getBoundingClientRect；
 *   · 棋盘上的 `--cols` / `--rows`。
 * 所以这里把那个矩形桩成"12 格 × 40px"，指针事件就能落在确定的格子上——
 * 这也是唯一能让这套交互在 CI 里跑起来的口子。
 *
 * 运行：npm run test:marquee
 */

// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';

const SIZE = 12;
const CELL = 40;
const OUT = '.tmp/marquee-bundle.js';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: OUT,
  loader: { '.css': 'empty' },
  define: { __APP_VERSION__: '"marquee-test"' },
  logLevel: 'silent',
});
const code = fs.readFileSync(OUT, 'utf8');
const html = fs.readFileSync('index.html', 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<link rel="stylesheet"[\s\S]*?>/g, '');

/* 摆一局沙盒：三个兵挨在一起，方便"框住它们" */
const st = createMatch({ ...DEFAULT_CONFIG, size: SIZE, startEra: 1, expansionIds: [], godMode: true }, 771);
const freeSpot = st.tiles
  .map((t, i) => ({ t, i }))
  .filter(({ t }) => !t.cityId && t.terrain === 'plain')
  .map(({ i }) => ({ x: i % SIZE, y: Math.floor(i / SIZE) }))
  .filter((p) => !st.units.some((u) => u.x === p.x && u.y === p.y))[0];
assert.ok(freeSpot, '棋盘上得有一块空地');
const mk = (id, x, y) => ({ id, type: 'militia', owner: 'A', x, y, hp: 20, kills: 0, moved: false, acted: false });
st.units.push(mk('mA', freeSpot.x, freeSpot.y), mk('mB', freeSpot.x + 1, freeSpot.y), mk('mC', freeSpot.x, freeSpot.y + 1));
st.current = 'A';

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://t.test/' });
const { window } = dom;
window.structuredClone = (v) => structuredClone(v);
window.matchMedia = (q) => ({
  matches: false, media: q, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
});
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 16);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);
window.HTMLElement.prototype.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
const ctx = new Proxy({}, { get: (_, k) => (k === 'canvas' ? { width: 1, height: 1 } : () => ({ addColorStop() {} })), set: () => true });
window.HTMLCanvasElement.prototype.getContext = () => ctx;

/* 桩：`.tiles` 的矩形。没有它，cellAtPoint 一律返回 null */
const box = {
  left: 10, top: 10, width: SIZE * CELL, height: SIZE * CELL,
  right: 10 + SIZE * CELL, bottom: 10 + SIZE * CELL, x: 10, y: 10, toJSON() {},
};
const originRect = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function () {
  if (this.classList?.contains('tiles')) return box;
  return originRect.call(this);
};

window.localStorage.setItem('warchess:match:v1', JSON.stringify(st));
const errs = [];
window.addEventListener('error', (e) => errs.push(e.error ?? e.message));
window.eval(code);

const tick = (ms) => new Promise((r) => window.setTimeout(r, ms));
await tick(400);

const doc = window.document;
const board = doc.querySelector('#board');
assert.ok(board, '没找到棋盘');

const pointAt = (x, y) => ({ clientX: 10 + x * CELL + CELL / 2, clientY: 10 + y * CELL + CELL / 2 });
const ev = (type, p) => new window.MouseEvent(type, { bubbles: true, cancelable: true, ...p, button: 0 });
const drag = (a, b) => {
  board.dispatchEvent(ev('pointerdown', pointAt(a.x, a.y)));
  // 中间补一个点：真实拖动不会只有起点和终点
  board.dispatchEvent(ev('pointermove', pointAt(Math.floor((a.x + b.x) / 2), Math.floor((a.y + b.y) / 2))));
  board.dispatchEvent(ev('pointermove', pointAt(b.x, b.y)));
  board.dispatchEvent(ev('pointerup', pointAt(b.x, b.y)));
};
const selCount = () => doc.querySelectorAll('.tile.god-sel').length;
const lastToast = () => {
  const all = [...doc.querySelectorAll('.toast')].map((n) => (n.textContent ?? '').trim());
  return all[all.length - 1] ?? '';
};
const toolbar = () => (doc.querySelector('[data-act="god-batch-del"]')?.closest('.god-group')?.textContent ?? '').replace(/\s+/g, ' ');

/* 1. 斜向拖出一个 3×2：选区要亮、工具栏要报数 */
drag({ x: freeSpot.x, y: freeSpot.y }, { x: freeSpot.x + 2, y: freeSpot.y + 1 });
await tick(200);
assert.equal(selCount(), 6, `斜拖 3×2 该选中 6 格，实际 ${selCount()}`);
const bar = toolbar();
assert.ok(bar.includes('3×2'), `工具栏要写选区尺寸：${bar}`);
assert.ok(bar.includes('6 格'), '工具栏要写格数');
assert.ok(/删兵（\d+）/.test(bar), `删兵按钮上要带数量：${bar}`);
assert.match(lastToast(), /已选 3×2/, `拖完要有一句反馈：${lastToast()}`);

/* 2. 点「删兵」：选区里的人真的没了，按钮数字跟着变 0 */
const unitsBefore = doc.querySelectorAll('.unit[data-id]').length;
const btn = doc.querySelector('[data-act="god-batch-del"]');
assert.ok(btn, '工具栏里没有删兵按钮');
assert.equal(btn.disabled, false, '选区里有兵，删兵按钮该是可点的');
btn.dispatchEvent(ev('click', {}));
await tick(250);
const unitsAfter = doc.querySelectorAll('.unit[data-id]').length;
assert.ok(unitsAfter < unitsBefore, `删兵后棋盘上的单位该变少：${unitsBefore} → ${unitsAfter}`);
assert.match(lastToast(), /删除 \d+ 个单位/, `删除要给一句带数量的反馈：${lastToast()}`);
assert.ok(toolbar().includes('删兵（0）'), `删完选区里没兵了，按钮该写 0：${toolbar()}`);
assert.equal(selCount(), 6, '选区留着——玩家可能接着刷地形');

/* 3. 再拖一次会覆盖选区；单击（没拖开）则收起选区 */
drag({ x: freeSpot.x + 3, y: freeSpot.y + 3 }, { x: freeSpot.x + 4, y: freeSpot.y + 4 });
await tick(150);
assert.equal(selCount(), 4, '再框一块 2×2 要换成新的选区');

board.dispatchEvent(ev('pointerdown', pointAt(freeSpot.x, freeSpot.y)));
board.dispatchEvent(ev('pointerup', pointAt(freeSpot.x, freeSpot.y)));
await tick(150);
assert.equal(selCount(), 0, '没拖开 = 单击：选区收起，不该留下一个 1×1 的框');

/* 4. 拿着笔刷时拖动仍然是"画"，不是框选 */
const terrainChip = doc.querySelector('[data-act="god-terrain"][data-terrain="forest"]');
assert.ok(terrainChip, '工具栏上该有森林笔刷');
terrainChip.dispatchEvent(ev('click', {}));
await tick(120);
drag({ x: 1, y: 1 }, { x: 1, y: 5 });
await tick(200);
assert.equal(selCount(), 0, '拿笔刷时拖动是画地形，不该产生选区');

assert.deepEqual(errs, [], `运行期报错：${errs.slice(0, 2).join(' / ')}`);

console.log('  · 斜拖 3×2 → 选中 6 格，工具栏报数 ✓');
console.log('  · 批量删兵 → 单位真的少了，按钮数字归零 ✓');
console.log('  · 单击不产选区 / 有笔刷时拖动仍是画 ✓');
console.log('\n通过：上帝模式的框选与批量操作在真入口上跑得通\n');
window.close();
