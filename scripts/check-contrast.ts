/**
 * 对比度体检：把 style.css 里的颜色 token 抓出来，算 WCAG 对比度。
 *
 * 为什么需要它：UI 重构里"深色主题"最容易翻车的地方不是好不好看，是**读不出来**。
 * 而这件事没法靠眼睛在 jsdom 里验（没有布局、不算样式），只能把颜色拿出来算。
 *
 * 判据（WCAG 2.1）：
 *   · 正文（--ink-1/--ink-2）：≥ 4.5:1
 *   · 次要信息（--ink-3）：≥ 4.5:1 —— 它是 11–12px 的正文级文字，不是"大字号"，
 *     所以不适用 3:1 的大字例外。现在 legacy 这一档是不达标的，报告里会标出来。
 *   · 装饰/描边（--stroke-*）：≥ 1.5:1 即可（只要求"分得开"）。
 *
 * 运行：npm run test:contrast
 */

// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync('src/style.css', 'utf8');

/** 从某个选择器块里取变量值 */
function varsOf(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `style.css 里找不到 ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

function hexOf(v: string): string | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(v.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 相对亮度 */
function lum(hex: string): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: string, b: string): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* 两套主题的取色：legacy 在 :root，modern 在 [data-ui='modern'] */
const root = varsOf(':root');
const modern = varsOf("[data-ui='modern']");

/** 语义别名：老变量名（--panel 等）现在就是这套语义层 */
const SURFACES = ['bg', 'panel', 'panel-2'];
const INKS = ['text', 'text-2', 'text-3'];

function palette(vars: Record<string, string>, label: string) {
  const out: Record<string, string> = {};
  for (const k of [...SURFACES, ...INKS, 'line', 'line-strong']) {
    const v = hexOf(vars[k] ?? '');
    if (v) out[k] = v;
  }
  assert.ok(Object.keys(out).length >= 8, `${label} 的 token 没取全：${Object.keys(out)}`);
  return out;
}

const themes = [
  { name: 'legacy', p: palette(root, 'legacy') },
  { name: 'modern', p: palette(modern, 'modern') },
];

/* 正文与次要文字：都要 ≥ 4.5；背景取三档里最接近的那个（panel 是主力面） */
const TEXT_MIN = 4.5;
/* 描边：只要求"分得开"，1.5 是经验值，低于它等于没画 */
const STROKE_MIN = 1.5;

const rows: string[] = [];
const failures: string[] = [];

for (const { name, p } of themes) {
  for (const ink of INKS) {
    for (const surface of SURFACES) {
      const r = ratio(p[ink]!, p[surface]!);
      rows.push(`${name}  ${ink} on ${surface}  ${r.toFixed(2)}:1`);
      if (r < TEXT_MIN) failures.push(`${name}: --${ink} 在 --${surface} 上只有 ${r.toFixed(2)}:1（要 ≥ ${TEXT_MIN}）`);
    }
  }
  for (const stroke of ['line', 'line-strong']) {
    const r = ratio(p[stroke]!, p['panel']!);
    rows.push(`${name}  ${stroke} on panel  ${r.toFixed(2)}:1`);
    if (r < STROKE_MIN) failures.push(`${name}: --${stroke} 在 --panel 上只有 ${r.toFixed(2)}:1（要 ≥ ${STROKE_MIN}）`);
  }
}

/* 只报"现代主题"的硬失败：legacy 是既有观感，改了就是改版，不在这一步动，
   但要把它列出来让人看见（下面单独打印）。 */
const modernFailures = failures.filter((f) => f.startsWith('modern'));
const legacyFailures = failures.filter((f) => f.startsWith('legacy'));

console.log('── 对比度实测 ──');
for (const r of rows) console.log('  ' + r);

if (legacyFailures.length > 0) {
  console.log('\n⚠ legacy 这批不达标（既有观感，本次不动，只记录）：');
  for (const f of legacyFailures) console.log('  · ' + f);
}

assert.deepEqual(
  modernFailures,
  [],
  `modern 主题有对比度不达标：\n${modernFailures.join('\n')}`,
);

console.log('\n通过：modern 主题的文字与描边对比度达标\n');
