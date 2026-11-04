/**
 * 一次性工具：把"开始界面"截成一张静态 HTML，方便直接看版式。
 *
 * 走的是真实代码路径（jsdom 里点开「新对局」→ 切到「地图」页），
 * CSS 用 src/style.css 原文，所以看到的就是线上那一版。
 */

import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  write: false,
  loader: { '.css': 'text' },
  target: 'es2022',
  logLevel: 'silent',
});
const code = result.outputFiles[0]?.text;
if (!code) throw new Error('打包失败');

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;
if (!window.structuredClone) {
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
}
class FakeResizeObserver {
  constructor(cb: () => void) {
    void cb;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
window.eval(code);

const doc = window.document;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

doc.querySelector<HTMLElement>('[data-act="new-game"]')?.click();
await sleep(30);
// 2026-11-04 起「新对局」只回首页，面板要从首页的「开始对局」进去
doc.querySelector<HTMLElement>('[data-title="new"]')?.click();
await sleep(80);
const battle = doc.querySelector('.modal-mask')?.innerHTML ?? '';

doc.querySelector<HTMLElement>('[data-tab="maps"]')?.click();
await sleep(80);
const maps = doc.querySelector('.modal-mask')?.innerHTML ?? '';

const css = readFileSync('src/style.css', 'utf8');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>开始界面</title>
<style>${css}</style>
<style>
  body { margin:0; background: var(--bg); min-height:100vh; }
  .shot { padding: 0; }
  .case { padding: 18px 22px 0; font: 600 13px/1.6 system-ui, sans-serif; color: var(--text-2); }
  /* 快照里没有遮罩层，直接让面板自己占位 */
  .shot { padding: 0 16px 18px; }
  .shot .modal { margin: 0 auto; }
</style></head>
<body>
  <div class="case">战役页（默认）</div>
  <div class="shot">${battle}</div>
  <div class="case">地图页（点左侧「地图」）</div>
  <div class="shot">${maps}</div>
</body></html>`;

writeFileSync('_publish/start-screen-preview.html', html, 'utf8');
console.log('written', html.length, 'bytes');
