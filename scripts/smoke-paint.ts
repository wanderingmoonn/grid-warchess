/**
 * 上帝模式的"画图 / 摆兵"两条热路径：启动级回归（jsdom 跑真入口）。
 *
 * 为什么必须有这一条：这两处优化全是"**少画一点**"型的改动——
 *   · 拖动刷地形时只重画被划过的那几格（`renderBoard` 的 `only` 参数）；
 *   · 摆兵时不再整块重写兵种货架，只改「场上」那一行的数字。
 * 这种改动最典型的坏法不是报错，而是"看着对、其实没生效"：
 * 少画的格子再也不更新、货架被换成空壳、数字停在旧值。
 * 所以这里断言的全是**看得见的结果**，不是函数被调过没有。
 *
 * 和 `smoke-marquee.ts` 共用同一套 jsdom 桩：没有布局就没有 `cellAtPoint`，
 * 所以 `.tiles` 的矩形必须桩成"12 格 × 40px"。
 *
 * 运行：npm run test:paint
 */

// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';

const SIZE = 12;
const CELL = 40;
const OUT = '.tmp/paint-bundle.js';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: OUT,
  loader: { '.css': 'empty' },
  define: { __APP_VERSION__: '"paint-test"' },
  logLevel: 'silent',
});
const code = fs.readFileSync(OUT, 'utf8');
const html = fs.readFileSync('index.html', 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<link rel="stylesheet"[\s\S]*?>/g, '');

const st = createMatch({ ...DEFAULT_CONFIG, size: SIZE, startEra: 1, expansionIds: [], godMode: true }, 771);
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

/** 桩：`.tiles` 的矩形。没有它，cellAtPoint 一律返回 null */
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
// 2026-11-19 起开机先出标题页：要从存档进去，得点一下「继续上一局」
window.document.querySelector('[data-title="continue"]')?.dispatchEvent(
  new window.MouseEvent('click', { bubbles: true }),
);

const tick = (ms) => new Promise((r) => window.setTimeout(r, ms));
await tick(400);

const doc = window.document;
const board = doc.querySelector('#board');
assert.ok(board, '没找到棋盘');

const pointAt = (x, y) => ({ clientX: 10 + x * CELL + CELL / 2, clientY: 10 + y * CELL + CELL / 2 });
const ev = (type, p) => new window.MouseEvent(type, { bubbles: true, cancelable: true, ...p, button: 0 });
const tileAt = (x, y) => doc.querySelector(`.tile[data-x="${x}"][data-y="${y}"]`);
const numOf = (t) => Number(String(t).match(/^(\d+)/)?.[1] ?? -1);

/** 找一排连续 5 格「没城 + 没兵」 */
function findRow() {
  for (let y = 1; y < SIZE - 1; y += 1) {
    for (let x = 1; x + 4 < SIZE; x += 1) {
      let ok = true;
      for (let k = 0; k < 5 && ok; k += 1) {
        const t = st.tiles[y * SIZE + (x + k)];
        if (!t || t.cityId) ok = false;
        else if (st.units.some((u) => u.x === x + k && u.y === y)) ok = false;
      }
      if (ok) return { y, x };
    }
  }
  throw new Error('棋盘上找不到一排五格空地');
}
const row = findRow();

/* 1. 拿森林笔刷拖一排：**拖动过程中**就要逐格变色，不能等松手 */
const forestChip = doc.querySelector('[data-act="god-terrain"][data-terrain="forest"]');
assert.ok(forestChip, '工具栏上该有森林笔刷');
forestChip.dispatchEvent(ev('click', {}));
await tick(120);

const before = [0, 1, 2, 3, 4].map((k) => tileAt(row.x + k, row.y).className);
board.dispatchEvent(ev('pointerdown', pointAt(row.x, row.y)));
for (let k = 1; k <= 4; k += 1) {
  board.dispatchEvent(ev('pointermove', pointAt(row.x + k, row.y)));
  await tick(20);
}
const mid = [0, 1, 2, 3, 4].map((k) => tileAt(row.x + k, row.y).className);
assert.equal(
  mid.filter((c, i) => c !== before[i]).length,
  5,
  `拖到一半这五格都该换过 class：${mid.join(' / ')}`,
);
assert.ok(mid.every((c) => c.includes('t-forest')), `笔刷是森林，五格都该是林子：${mid.join(' / ')}`);
// 森林的疏密是按四邻算的：邻格也得跟着刷新（快路径把四邻一起重画）
assert.notEqual(tileAt(row.x + 2, row.y).dataset.v, undefined, '森林的疏密数据该写回格子');

board.dispatchEvent(ev('pointerup', pointAt(row.x + 4, row.y)));
await tick(200);
assert.ok(
  [0, 1, 2, 3, 4].every((k) => tileAt(row.x + k, row.y).className.includes('t-forest')),
  '松手之后仍然是森林',
);
assert.ok(tileAt(2, 2).className.includes('tile'), '别的格子还在（格子节点是复用的，不该被重建掉）');

/* 2. 摆一个兵：货架节点不许被整块换掉，但「场上」的数字要跟着 +1 */
const beforeCount = doc.querySelector('[data-god-count="A"]').textContent;
const pick = doc.querySelector('[data-act="god-pick"][data-unit="militia"]');
assert.ok(pick, '货架上该有民兵');
pick.dispatchEvent(ev('click', {}));
await tick(120);
// 挑笔刷会改货架的高亮，节点可能被换掉——重新取一个参照，之后不该再变
const shelfChip = doc.querySelector('[data-act="god-pick"][data-unit="militia"]');
assert.ok(shelfChip, '挑了笔刷之后货架上还该有民兵');

const unitsBefore = doc.querySelectorAll('.unit[data-id]').length;
const spot = (() => {
  for (let y = 1; y < SIZE - 1; y += 1) {
    for (let x = 1; x < SIZE - 1; x += 1) {
      const t = st.tiles[y * SIZE + x];
      if (!t || t.cityId || t.terrain !== 'plain') continue;
      if (st.units.some((u) => u.x === x && u.y === y)) continue;
      return { x, y };
    }
  }
  throw new Error('找不到能落子的空格');
})();
board.dispatchEvent(ev('pointerdown', pointAt(spot.x, spot.y)));
board.dispatchEvent(ev('pointerup', pointAt(spot.x, spot.y)));
board.dispatchEvent(ev('click', pointAt(spot.x, spot.y)));
await tick(250);

assert.equal(
  doc.querySelectorAll('.unit[data-id]').length,
  unitsBefore + 1,
  '点了棋子该落下一个兵',
);
assert.ok(
  doc.querySelector('[data-act="god-pick"][data-unit="militia"]') === shelfChip,
  '摆一个兵不该把整个货架重写（节点被换掉 = 又走了 innerHTML）',
);
assert.equal(
  numOf(doc.querySelector('[data-god-count="A"]').textContent),
  numOf(beforeCount) + 1,
  '「场上」那一行要跟着 +1',
);

/* 3. 换一种地形再拖一次：换笔刷之后同样要即时生效 */
const hillChip = doc.querySelector('[data-act="god-terrain"][data-terrain="hill"]');
assert.ok(hillChip, '工具栏上该有丘陵笔刷');
hillChip.dispatchEvent(ev('click', {}));
await tick(120);
board.dispatchEvent(ev('pointerdown', pointAt(row.x, row.y)));
board.dispatchEvent(ev('pointermove', pointAt(row.x + 2, row.y)));
await tick(20);
assert.ok(tileAt(row.x + 1, row.y).className.includes('t-hill'), '换笔刷后再拖，同样要即时生效');
board.dispatchEvent(ev('pointerup', pointAt(row.x + 2, row.y)));
await tick(150);
assert.ok(tileAt(row.x + 1, row.y).className.includes('t-hill'), '松手之后仍是丘陵');

assert.equal(errs.length, 0, `不该有运行时报错：${errs.join('; ')}`);
console.log('通过：拖动画图逐格生效、摆兵不重写货架、「场上」数字就地更新');
