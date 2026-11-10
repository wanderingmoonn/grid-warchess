/**
 * 「浓雾蔽野」的启动级回归：黑格点不开、天气不给黑区染色。
 *
 * 守的是 2026-11-09 报上来的两处**信息泄漏**（修完只留了个临时脚本在 `.tmp`）：
 *   1. 点黑格照样弹出地形卡 / 城卡——浓雾把地图遮了，城卡却还在报护甲和耐久；
 *   2. 天气视图把黑区也染了色——天气由地形算出，"这片在下雨"等于告诉玩家
 *      那边不是沙漠，配合「温和不画」连地形轮廓都能反推。
 *
 * 做法：用 `createMatch` 造一局 blackout + seasons、开雾的存档，塞进 jsdom 的
 * localStorage，再跑**真正的** `main.ts`（esbuild 打成 iife）。然后：
 *   · 点黑格空地 → 面板一字不许变；
 *   · 点黑格城市 → 同上（这条最严重：城卡会漏耐久）；
 *   · 点看得见的格子 → 必须照常弹出（反证：别把正常交互一起拦掉）；
 *   · 开天气视图 → 落在黑格上的色块必须是 0。
 * 最后用"只开季节、不开浓雾"跑一遍同样的点击，确认那三格都能点开——
 * 这条守的是"不勾扩展时行为一格都不变"。
 *
 * 运行：npm run test:blackout
 */

// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { visibleTilesOf } from '../src/core/rules.ts';

const OUT = '.tmp/blackout-bundle.js';
const KEY = 'warchess:match:v1';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: OUT,
  loader: { '.css': 'empty' },
  define: { __APP_VERSION__: '"blackout-test"' },
  logLevel: 'silent',
});
const code = fs.readFileSync(OUT, 'utf8');
const html = fs.readFileSync('index.html', 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<link rel="stylesheet"[\s\S]*?>/g, '');

/** 开一局指定扩展的存档，跑真入口，返回可操作的一堆句柄 */
function boot(expansionIds) {
  const st = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 1, fog: true, expansionIds },
    88991,
  );
  st.current = 'A';

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://t.test/' });
  const { window } = dom;
  // jsdom 没有 structuredClone；浏览器 2022 年就有了，不补首屏会走"存档读不动"的兜底
  window.structuredClone = (v) => structuredClone(v);
  window.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'canvas' ? { width: 1, height: 1 }
      : k === 'measureText' ? () => ({ width: 1 })
        : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) })
          : () => ({ addColorStop() {} })),
    set: () => true,
  });
  window.HTMLCanvasElement.prototype.getContext = () => ctx;
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
  window.localStorage.setItem(KEY, JSON.stringify(st));

  const errs = [];
  window.addEventListener('error', (e) => errs.push(e.error ?? e.message));
  window.eval(code);
  return { window, st, errs };
}

const tick = (w, ms) => new Promise((r) => w.setTimeout(r, ms));
const textOf = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

async function probe(expansionIds, label) {
  const { window, st, errs } = boot(expansionIds);
  await tick(window, 350);
  const doc = window.document;
  const panel = doc.querySelector('#panel, .side-panel, #side') ?? doc.body;

  const vis = visibleTilesOf(st, 'A');
  const firstHidden = (pred) => {
    for (let i = 0; i < st.w * st.h; i += 1) {
      if (!vis.has(i) && pred(i)) return { x: i % st.w, y: Math.floor(i / st.w) };
    }
    return null;
  };
  const hiddenPlain = firstHidden((i) => !st.tiles[i].cityId);
  const hiddenCity = firstHidden((i) => Boolean(st.tiles[i].cityId));
  const someSeen = [...vis].map((i) => ({ x: i % st.w, y: Math.floor(i / st.w) }))[0] ?? null;

  /** 点一格，返回面板变没变 */
  async function click(p) {
    if (!p) return null;
    const before = textOf(panel);
    const tile = doc.querySelector(`.tile[data-x="${p.x}"][data-y="${p.y}"]`);
    assert.ok(tile, `找不到 (${p.x},${p.y}) 这一格`);
    tile.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick(window, 200);
    return { changed: textOf(panel) !== before, unknown: tile.className.includes('unknown') };
  }

  const r = {
    hiddenPlain: await click(hiddenPlain),
    hiddenCity: await click(hiddenCity),
    seen: await click(someSeen),
    errs: errs.length,
  };

  // 天气视图：点 chip，数落在黑格上的色块
  const chip = doc.querySelector('[data-act="board-view"][data-id="seasons-weather"]');
  if (chip) {
    chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick(window, 250);
    const painted = [...doc.querySelectorAll('.board-view .fx-qi')];
    const onBlack = painted.filter((n) => {
      const t = doc.querySelector(`.tile[data-x="${n.dataset.x}"][data-y="${n.dataset.y}"]`);
      return t?.className.includes('unknown');
    });
    r.painted = painted.length;
    r.onBlack = onBlack.length;
  }

  // 浓雾关着时"点得开"是**正确**行为，别一律写成"漏"
  const blackout = expansionIds.includes('blackout');
  const cell = (x) => (blackout ? (x ? '漏了（被点开）' : '点不开 ✓') : (x ? '点得开 ✓' : '点不开（拦过头）'));
  console.log(`  · ${label}：视野外空地 ${cell(r.hiddenPlain?.changed)} · ` +
    `视野外城市 ${cell(r.hiddenCity?.changed)} · ` +
    `可见格${r.seen?.changed ? '正常弹出 ✓' : '打不开（拦过头）'} · ` +
    `天气染 ${r.painted ?? '-'} 格，落黑 ${r.onBlack ?? '-'} 格 · 报错 ${r.errs}`);
  window.close();
  return r;
}

/* ------------------------------------------------------------------ */
/* 1. 勾了浓雾：两处泄漏都必须堵住                                      */
/* ------------------------------------------------------------------ */
const on = await probe(['blackout', 'seasons'], '浓雾开');
assert.equal(on.errs, 0, '启动有运行期报错');
assert.equal(on.hiddenPlain?.unknown, true, '视野外的格子该画成黑格（.tile.unknown）');
assert.equal(on.hiddenPlain?.changed, false, '点黑格空地不该弹出地形卡');
assert.equal(on.hiddenCity?.changed, false, '点黑格城市不该弹出城卡（会漏耐久）');
assert.equal(on.seen?.changed, true, '看得见的格子必须照常能点开——别把正常交互一起拦掉');
assert.ok((on.painted ?? 0) > 0, '天气视图本身该有颜色（否则这条断言没意义）');
assert.equal(on.onBlack, 0, '天气不该给黑区染色');

/* ------------------------------------------------------------------ */
/* 2. 只开季节：行为一格都不许变                                        */
/* ------------------------------------------------------------------ */
const off = await probe(['seasons'], '浓雾关');
assert.equal(off.errs, 0, '启动有运行期报错');
assert.equal(off.hiddenPlain?.unknown, false, '没开浓雾就不该有黑格');
assert.equal(off.hiddenPlain?.changed, true, '普通雾下地形一直可见，点它必须能看');
assert.equal(off.hiddenCity?.changed, true, '普通雾下城也能点开');
assert.equal(off.onBlack, 0, '没有黑格，自然不会有色块落在黑区');

console.log('\n通过：浓雾的遮挡在点击与染色两条路上都成立，且不影响未开扩展的交互\n');
