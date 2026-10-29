/**
 * 性能体检。
 *
 * 为什么需要它：32×32 在自己机器上不卡、在朋友机器上卡——"感觉卡"既没法定位，
 * 也没法证明改完有没有变好。这个脚本把一次完整重绘拆成几段逐段计时，
 * 输出的是可比的数字，不是体感。
 *
 * 测什么（一次"帧" = `main.ts` 里 `render()` 走的那条流水）：
 *
 *   1. 雾视图   `playerView()`    每帧都算，32×32 要过 1 024 格
 *   2. 棋盘     `renderBoard()`   全量重建格子 / 城市 / 棋子
 *   3. 侧栏     `renderPanel()`   整块 innerHTML 重绘
 *   4. 威胁圈   `threatTiles()`   选中单位时每帧重算
 *   5. AI 决策  `aiNextAction()`  AI 回合里那一下"思考"停顿
 *
 * 顺带量化两件和浏览器开销成正比的东西：**每帧新建多少个 DOM 节点**、
 * **每帧往页面里写多少 KB 的 HTML**。jsdom 不做布局和绘制，但这两项能替它说话。
 *
 * 关于"帧率"：脚本给的是 **JS 侧上限** = 1000 / p50。真机还要加上样式重算、
 * 布局、绘制，只会更慢不会更快。所以它是下限判据——
 * 这里就已经超 16.7ms 的档，真机必然掉帧。
 *
 * 用法：
 *   npm run perf                         # 12/16/20/24/32 五档
 *   npm run perf -- --sizes=20,32        # 只测两档
 *   npm run perf -- --frames=80          # 每档多跑几帧，p95 更稳
 *   npm run perf -- --army=60            # 指定场上兵力（默认按面积推）
 *   npm run perf -- --compare            # 32×32 上横向比不同配置
 *   npm run perf -- --json=perf.json     # 结果落盘，便于两次改动前后对比
 *   npm run perf -- --md=docs/PERF.md    # 同时出一份 Markdown 报告
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { JSDOM } from 'jsdom';

import { UNIT_TYPES } from '../src/core/config.ts';
import { playerView } from '../src/core/fog.ts';
import { aiNextAction } from '../src/core/ai.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { threatTiles } from '../src/core/rules.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

// ---------------------------------------------------------------- 命令行参数

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq < 0 ? 'true' : hit.slice(eq + 1);
}

function num(name: string, fallback: number): number {
  const raw = arg(name);
  const v = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

const SIZES = (arg('sizes') ?? '12,16,20,24,32')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((n) => Number.isFinite(n) && n >= 8 && n <= 64)
  .sort((a, b) => a - b);

const FRAMES = num('frames', 50);
const WARMUP = num('warmup', 10);
const AI_TRIES = num('ai', 8);
/**
 * 每档跑几轮。
 *
 * 帧内取最快只解决"帧间干扰"，解决不了"第几档"这个顺序效应：
 * 同一个 32×32，做第 5 档时是 21.6ms、做第 6 个场景时是 20.6ms（差 5%）。
 * 所以整轮也跑两遍，取最快那一轮——机器越忙，这个差别越大。
 */
const REPEAT = Math.max(1, num('repeat', 2));
const JSON_OUT = arg('json');
const MD_OUT = arg('md');
const BASELINE = arg('baseline');
const DO_COMPARE = arg('compare') === 'true';

// ---------------------------------------------------------------- 终端着色

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const esc = (code: string, s: string): string => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = (s: string): string => esc('31', s);
const yellow = (s: string): string => esc('33', s);
const green = (s: string): string => esc('32', s);
const cyan = (s: string): string => esc('36', s);
const dim = (s: string): string => esc('2', s);
const bold = (s: string): string => esc('1', s);

/** 中日韩字符在等宽字体里占两列，`padEnd` 按字符数算会错位 */
function dw(s: string): number {
  let n = 0;
  for (const ch of s) {
    n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
      ? 2
      : 1;
  }
  return n;
}

function pad(s: string, n: number, align: 'l' | 'r' = 'l'): string {
  const gap = Math.max(0, n - dw(s));
  return align === 'r' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

/** 先补齐再上色。顺序反了的话，pad 会把 ANSI 转义当成可见字符，整列错位。 */
function padC(s: string, n: number, paint: (x: string) => string, align: 'l' | 'r' = 'r'): string {
  return paint(pad(s, n, align));
}

// ---------------------------------------------------------------- 环境搭建

/**
 * 装一个 jsdom 当浏览器。
 *
 * 顺序很重要：`board.ts` / `panel.ts` 里直接写 `document.createElement`，
 * 模块加载时就得有全局 `document`。所以这里先铺环境，再**动态** import 渲染层。
 */
function installDom(): JSDOM['window'] {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = w;
  g.document = w.document;
  g.HTMLElement = w.HTMLElement;
  g.Element = w.Element;
  g.Node = w.Node;
  g.Event = w.Event;
  g.MouseEvent = w.MouseEvent;
  g.getComputedStyle = w.getComputedStyle.bind(w);
  if (!w.structuredClone) {
    (w as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  }
  return w;
}

interface HtmlStat {
  calls: number;
  chars: number;
  nodes: number;
  ms: number;
  /** 这一帧调了几次 getBoundingClientRect —— 每次都可能触发一次强制布局 */
  rects: number;
}

/**
 * 给 `innerHTML` 的 setter 打桩。
 *
 * 这是唯一能切开"算得快"和"塞得慢"的一刀：`renderBoard` 的总耗时里，
 * 有多少花在我们拼字符串上、多少花在把字符串变成 DOM 上，光看总时间分不出来。
 * 顺带数出这一帧新建了多少元素（`<div` 出现次数）和写了多少字节。
 */
function instrumentHtml(w: JSDOM['window']): HtmlStat {
  const proto = w.Element.prototype as unknown as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
  if (!desc?.get || !desc.set) throw new Error('jsdom 的 innerHTML 不是存取器，打不了桩');

  const stat: HtmlStat = { calls: 0, chars: 0, nodes: 0, ms: 0, rects: 0 };
  Object.defineProperty(proto, 'innerHTML', {
    configurable: true,
    enumerable: desc.enumerable ?? false,
    get(this: Element): string {
      return (desc.get as (this: Element) => string).call(this);
    },
    set(this: Element, v: string): void {
      const t0 = performance.now();
      const text = String(v);
      stat.calls += 1;
      stat.chars += text.length;
      for (let i = text.indexOf('<div'); i >= 0; i = text.indexOf('<div', i + 4)) stat.nodes += 1;
      (desc.set as (this: Element, v: string) => void).call(this, text);
      stat.ms += performance.now() - t0;
    },
  });
  // 顺带数一下 getBoundingClientRect：FLIP 动画每个棋子读两次（旧位置、新位置）。
  // 真机上"写 class → 读 rect → 再写 transform"这种交替会让浏览器强制同步布局，
  // 是那种"每帧都慢一点、但看不出哪一行"的典型来源。
  const rectProto = w.Element.prototype as unknown as Record<string, unknown>;
  const rectFn = rectProto.getBoundingClientRect as (this: Element) => DOMRect;
  if (typeof rectFn === 'function') {
    Object.defineProperty(rectProto, 'getBoundingClientRect', {
      configurable: true,
      value(this: Element): DOMRect {
        stat.rects += 1;
        return rectFn.call(this);
      },
    });
  }

  return stat;
}

// ---------------------------------------------------------------- 统计

interface Stat {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

function stats(xs: number[]): Stat {
  if (xs.length === 0) return { n: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const a = [...xs].sort((x, y) => x - y);
  const at = (q: number): number => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))]!;
  const sum = a.reduce((x, y) => x + y, 0);
  return { n: a.length, min: a[0]!, p50: at(0.5), p95: at(0.95), max: a[a.length - 1]!, mean: sum / a.length };
}

/** 有多少比例的帧越过了 60fps 的单帧预算 */
function shareOver(xs: number[], budget = 16.7): number {
  if (xs.length === 0) return 0;
  return xs.filter((x) => x > budget).length / xs.length;
}

const fmt = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));

function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function heapUsed(): number {
  return process.memoryUsage().heapUsed;
}

/**
 * 手动 GC。
 *
 * 不 GC 就测堆，测到的是"上一次回收之后攒了多少垃圾"——中间撞一次 GC，
 * 数字直接变负。第一版没开 `--expose-gc`，24×24 报 +20MB、16×16 报 +0.0MB、
 * 32×32 报 +87MB，全是回收时机碰运气。要报"常驻涨了多少"，就得自己按钟。
 */
const gc = (globalThis as unknown as { gc?: () => void }).gc;

// ---------------------------------------------------------------- 场景

interface ScenarioResult {
  label: string;
  size: number;
  army: number;
  genMs: number;
  frame: Stat;
  fog: Stat;
  board: Stat;
  panel: Stat;
  threat: Stat;
  ai: Stat | null;
  htmlChars: number;
  htmlNodes: number;
  rects: number;
  /** 超过 60fps 单帧预算（16.7ms）的帧占比，就是玩家眼里的"掉了多少帧" */
  over: number;
  elems: number;
  heapMb: number;
  /** 每帧合计里，"把 HTML 变成 DOM"占了多少（jsdom 侧） */
  htmlMs: number;
}

type RenderBoard = (el: HTMLElement, view: unknown, ui: unknown) => void;
type RenderPanel = (el: HTMLElement, input: unknown) => void;

/**
 * 摆一批兵。
 *
 * 空棋盘测出来的数字没有意义——32×32 卡不卡，卡在"后期二三十支部队挤在河两岸"。
 * 这里按面积撒兵，位置取可站立格，摆不下就跳过（水里、山里、敌城里都会失败）。
 */
function fillArmy(s: GameState, total: number): number {
  // 只摆陆军：船下水要水域、建筑要平地，掺进来大半会失败，
  // 白白稀释"这批兵到底摆了几个"这个数字。
  const kinds = ['militia', 'archer', 'spearman', 'knight', 'tower'];
  let placed = 0;
  let k = 0;
  // 逐格扫，摆不满就绕着城再扫一圈：棋盘边缘两圈常常全是水或山
  for (let ring = 0; ring < 3 && placed < total; ring += 1) {
    for (let y = 1 + ring; y < s.h - 1 - ring && placed < total; y += 1) {
      for (let x = 1 + ring; x < s.w - 1 - ring && placed < total; x += 1) {
        if (s.units.some((u) => u.x === x && u.y === y)) continue;
        const owner: PlayerId = (x + y) % 2 === 0 ? 'A' : 'B';
        const r = placeUnit(s, owner, kinds[k % kinds.length]!, x, y);
        if (r.ok) {
          placed += 1;
          k += 1;
        }
      }
    }
  }
  return placed;
}

interface RunOpts {
  size: number;
  army?: number;
  frames?: number;
  expansions?: readonly string[];
  fog?: boolean;
  label?: string;
  ai?: boolean;
  /**
   * 这一帧里"画面变了多少"。默认 `select`：每帧换一个选中单位。
   *
   * 为什么默认不是"什么都不变"：增量重绘上线之后，反复画同一幅画面会让所有缓存
   * 全命中（新建元素 0、HTML 0 字节），那一行数字好看但没有意义——真机上玩家
   * 每点一下、AI 每走一步，面板和高亮都会真的换。"每帧换选中"是能重复的最小
   * 真实操作，拿它当主表，改前改后才在同一把尺子上。
   *   · `none` 什么都不变（缓存的乐观下限，只在"缓存省了多少"那一节里用）
   *   · `select` 玩家在几个兵之间点来点去（默认）
   *   · `full` 每帧把三层砍掉重来（等价于增量重绘之前的全量重建）
   */
  churn?: 'none' | 'select' | 'full';
}

async function runScenario(
  opts: RunOpts,
  win: JSDOM['window'],
  html: HtmlStat,
  renderBoard: RenderBoard,
  renderPanel: RenderPanel,
): Promise<ScenarioResult> {
  const size = opts.size;
  const frames = opts.frames ?? FRAMES;
  const army = opts.army ?? Math.max(4, Math.round((size * size) / 24));

  // ---- 开局：地图生成 + 建局 ----
  const t0 = performance.now();
  const state = createMatch(
    {
      ...DEFAULT_CONFIG,
      size,
      startEra: 3,
      expansionIds: [...(opts.expansions ?? DEFAULT_CONFIG.expansionIds)],
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    // 所有档用同一个种子：规模是唯一变量，别让地图长相参与比较
    20261028,
  );
  const genMs = performance.now() - t0;

  const placed = fillArmy(state, army);
  if (opts.fog !== undefined) state.fog = opts.fog;

  // ---- 造容器。board / side 的尺寸 jsdom 里是 0，但节点数与 HTML 字节数不受影响
  const doc = win.document;
  const boardEl = doc.createElement('div');
  boardEl.className = 'board';
  doc.body.appendChild(boardEl);
  const sideEl = doc.createElement('div');
  sideEl.className = 'side';
  doc.body.appendChild(sideEl);

  const me: PlayerId = 'A';
  const picked = state.units.find((u) => u.owner === me && u.type !== 'boat' && u.type !== 'tower');
  /** `select` 档轮流选中的那几个单位：玩家真正会点的自家兵 */
  const own = state.units.filter((u) => u.owner === me && u.type !== 'boat' && u.type !== 'tower');

  // 预热：JIT 和 jsdom 的首次样式表初始化都别算进样本里
  for (let i = 0; i < WARMUP; i += 1) {
    const v = playerView(state, me, false);
    renderBoard(boardEl, v as unknown, {
      selectedId: picked?.id ?? null,
      reach: [],
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat: [],
    });
    renderPanel(sideEl, {
      view: v,
      me,
      selectedUnit: picked ?? null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });
  }
  win.document.body.removeChild(boardEl);
  win.document.body.removeChild(sideEl);

  // ---- 正式采样 ----
  const boardEl2 = doc.createElement('div');
  boardEl2.className = 'board';
  doc.body.appendChild(boardEl2);
  const sideEl2 = doc.createElement('div');
  sideEl2.className = 'side';
  doc.body.appendChild(sideEl2);

  // 先画一帧不进样本：这一帧要把格子的节点建起来（换地图才发生一次）。
  // 把那一次算进"最大帧"，抖动结论就会被它一个人带跑——
  // 玩家抱怨的"一顿一顿"是稳态里的抖动，不是开局第一帧。
  {
    const v0 = playerView(state, me, false);
    const t0 = picked ? Array.from(threatTiles(state, picked)) : [];
    renderBoard(boardEl2, v0 as unknown, {
      selectedId: picked?.id ?? null,
      reach: t0.slice(0, 40),
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat: t0,
      incomeHints: new Map(t0.slice(0, 20).map((g) => [g, 7])),
    });
    renderPanel(sideEl2, {
      view: v0,
      me,
      selectedUnit: picked ?? null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });
  }

  const samples: Record<'frame' | 'fog' | 'board' | 'panel' | 'threat', number[]> = {
    frame: [],
    fog: [],
    board: [],
    panel: [],
    threat: [],
  };
  let htmlChars = 0;
  let htmlNodes = 0;
  let htmlMs = 0;

  gc?.();
  const heapBefore = heapUsed();
  let rects = 0;
  for (let i = 0; i < frames; i += 1) {
    html.calls = 0;
    html.chars = 0;
    html.nodes = 0;
    html.ms = 0;
    html.rects = 0;

    const f0 = performance.now();

    // `full` 档先把三层砍掉：等价于"增量重绘之前"的那种每帧全量重建
    if (opts.churn === 'full') {
      boardEl2.innerHTML = '';
      sideEl2.innerHTML = '';
    }
    // 换一个选中：面板和高亮真的换，缓存跳不过去（`select`，主表的默认档）
    const selectOn = (opts.churn ?? 'select') === 'select';
    const sel = selectOn && own.length > 0 ? own[i % own.length]! : picked;

    let t = performance.now();
    const view = playerView(state, me, false);
    const fogMs = performance.now() - t;

    // 威胁圈：真实 render() 里每帧都算（选中单位且还没行动时）
    t = performance.now();
    const threat = sel ? Array.from(threatTiles(state, sel)) : [];
    const threatMs = performance.now() - t;

    t = performance.now();
    renderBoard(boardEl2, view as unknown, {
      selectedId: sel?.id ?? null,
      reach: threat.slice(0, 40),
      targets: [],
      siegeTargets: [],
      selectedCityId: null,
      placeable: [],
      threat,
      incomeHints: new Map(threat.slice(0, 20).map((g) => [g, 7])),
    });
    const boardMs = performance.now() - t;

    t = performance.now();
    renderPanel(sideEl2, {
      view,
      me,
      selectedUnit: sel ?? null,
      selectedCityId: null,
      selectedCampId: null,
      selectedTile: null,
    });
    const panelMs = performance.now() - t;

    const frameMs = performance.now() - f0;

    samples.frame.push(frameMs);
    samples.fog.push(fogMs);
    samples.board.push(boardMs);
    samples.panel.push(panelMs);
    samples.threat.push(threatMs);
    htmlChars += html.chars;
    htmlNodes += html.nodes;
    htmlMs += html.ms;
    rects += html.rects;
  }
  gc?.();
  const heapAfter = heapUsed();

  // ---- AI 决策：单独测，因为它不在帧循环里，但 AI 回合的停顿主要来自它
  let ai: Stat | null = null;
  if (opts.ai !== false) {
    const times: number[] = [];
    for (let i = 0; i < AI_TRIES; i += 1) {
      const a0 = performance.now();
      aiNextAction(state);
      times.push(performance.now() - a0);
    }
    ai = stats(times);
  }

  const elems = doc.querySelectorAll('*').length;
  doc.body.removeChild(boardEl2);
  doc.body.removeChild(sideEl2);

  return {
    label: opts.label ?? `${size}×${size}`,
    size,
    army: placed,
    genMs,
    frame: stats(samples.frame),
    fog: stats(samples.fog),
    board: stats(samples.board),
    panel: stats(samples.panel),
    threat: stats(samples.threat),
    ai,
    htmlChars: htmlChars / frames,
    htmlNodes: htmlNodes / frames,
    rects: rects / frames,
    over: shareOver(samples.frame),
    elems,
    heapMb: gc ? Math.max(0, (heapAfter - heapBefore) / 1024 / 1024) : Number.NaN,
    htmlMs: htmlMs / frames,
  };
}

interface BaselineRow {
  label: string;
  frame: { min: number; p50: number };
  htmlNodes: number;
  htmlChars: number;
}

/**
 * 读上一次的结果，给"改完到底快了多少"一个说法。
 *
 * 没有这个，优化就只能靠记忆和体感；有了它，每次改完跑一遍就知道方向对不对。
 * 匹配按 `label`（规模/配置名），对不上的档直接跳过，不硬凑。
 */
function loadBaseline(path: string): { when: string; rows: BaselineRow[] } | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      when?: string;
      rows?: BaselineRow[];
    };
    return { when: raw.when ?? '未知时间', rows: raw.rows ?? [] };
  } catch {
    console.log(yellow(`  读不到基线 ${path}，跳过对比`));
    return null;
  }
}

function printDelta(rows: ScenarioResult[], base: { when: string; rows: BaselineRow[] }): string[] {
  const byLabel = new Map(base.rows.map((r) => [r.label, r]));
  const head = [pad('规模', 8), pad('基线最快', 11, 'r'), pad('现在最快', 11, 'r'), pad('变化', 11, 'r'), pad('新元素', 11, 'r'), '  判定'].join('');
  console.log(dim(head));
  console.log(dim('─'.repeat(dw(head) + 2)));

  const lines: string[] = [];
  for (const r of rows) {
    const b = byLabel.get(r.label);
    if (!b) continue;
    // 比"最快帧"：机器上的干扰只会让帧更慢，不会更快，所以它是最干净的对照量
    const before = b.frame.min || b.frame.p50;
    const delta = r.frame.min - before;
    const pct = before > 0 ? (delta / before) * 100 : 0;
    const text = `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;
    // 阈值按比例而不是绝对毫秒：这台机器上同一份代码连跑两次就会漂 ±10%，
    // 拿 1ms 当"变了"的分界，等于把噪声当结论。
    const paint = pct < -8 ? green : pct > 8 ? red : dim;
    const verdict = pct < -8 ? '变快' : pct > 8 ? '变慢' : '噪声内';
    console.log(
      [
        pad(r.label, 8),
        pad(`${fmt(before)}ms`, 11, 'r'),
        pad(`${fmt(r.frame.min)}ms`, 11, 'r'),
        padC(text, 11, paint),
        pad(`${Math.round(b.htmlNodes)}→${Math.round(r.htmlNodes)}`, 11, 'r'),
        '  ',
        paint(verdict),
      ].join(''),
    );
    lines.push(`| ${r.label} | ${fmt(before)}ms | ${fmt(r.frame.min)}ms | ${text} | ${verdict} |`);
  }
  const bigNow = rows[rows.length - 1];
  const bigBase = bigNow ? byLabel.get(bigNow.label) : undefined;
  if (bigNow && bigBase) {
    const b = bigBase.frame.min || bigBase.frame.p50;
    const saved = 1 - bigNow.frame.min / Math.max(0.001, b);
    console.log(
      dim(
        `  最大一档 ${bigNow.label}：${fmt(b)}ms → ${fmt(bigNow.frame.min)}ms（` +
          (saved > 0.08 ? green(`${(saved * 100).toFixed(0)}% 省下来`) : saved < -0.08 ? red(`${(-saved * 100).toFixed(0)}% 更慢`) : dim('在噪声内')) +
          '）',
      ),
    );
    console.log(
      dim(
        '  注意：同一份代码连跑两次，这一列自己就会漂 ±10%（系统负载、GC、CPU 频率）。\n' +
          '  低于 ±8% 的差异别当结论；真要确认，用同样的参数连跑三次看趋势。\n' +
          '  更硬的证据是"新元素"一列——它由代码决定，不受机器影响：建得少了就是少了。',
      ),
    );
  }
  return lines;
}

/** 跑 REPEAT 轮，留最快的那一轮（整轮留，不混着挑，否则数字自相矛盾） */
async function runBest(
  opts: RunOpts,
  win: JSDOM['window'],
  html: HtmlStat,
  renderBoard: RenderBoard,
  renderPanel: RenderPanel,
): Promise<ScenarioResult> {
  let best: ScenarioResult | null = null;
  for (let k = 0; k < REPEAT; k += 1) {
    const r = await runScenario(opts, win, html, renderBoard, renderPanel);
    if (!best || r.frame.min < best.frame.min) best = r;
  }
  return best!;
}

// ---------------------------------------------------------------- 输出

function rate(ms: number): { label: string; paint: (s: string) => string } {
  if (ms <= 8) return { label: '很顺', paint: green };
  if (ms <= 16.7) return { label: '够用', paint: green };
  if (ms <= 33.3) return { label: '掉帧', paint: yellow };
  return { label: '会卡', paint: red };
}

function bar(v: number, max: number, width = 14): string {
  const n = max <= 0 ? 0 : Math.round((v / max) * width);
  return '█'.repeat(Math.max(0, Math.min(width, n))) + '·'.repeat(Math.max(0, width - n));
}

function printOverview(rows: ScenarioResult[]): void {
  const head = [
    pad('规模', 8),
    pad('兵力', 6, 'r'),
    pad('最快', 9, 'r'),
    pad('p50', 9, 'r'),
    pad('p95', 9, 'r'),
    pad('最大', 9, 'r'),
    pad('掉帧率', 9, 'r'),
    pad('p50帧率', 9, 'r'),
    pad('判定', 8),
  ].join('');
  console.log(dim(head));
  console.log(dim('─'.repeat(dw(head))));

  for (const r of rows) {
    const rt = rate(r.frame.p50);
    const fps = r.frame.p50 > 0 ? 1000 / r.frame.p50 : 0;
    const dropText = `${Math.round(r.over * 100)}%`;
    console.log(
      [
        pad(r.label, 8),
        pad(String(r.army), 6, 'r'),
        padC(`${fmt(r.frame.min)}ms`, 9, dim),
        padC(`${fmt(r.frame.p50)}ms`, 9, rt.paint),
        pad(`${fmt(r.frame.p95)}ms`, 9, 'r'),
        pad(`${fmt(r.frame.max)}ms`, 9, 'r'),
        r.over > 0 ? padC(dropText, 9, red) : padC(dropText, 9, green),
        pad(`${Math.round(fps)}fps`, 9, 'r'),
        rt.paint(pad(rt.label, 8)),
      ].join(''),
    );
  }
  console.log(
    dim(
      '  「最快」是这一档跑得最快的一帧——机器上有别的活时只会让帧变慢，不会让它变快，\n' +
        '  所以这个数比 p50 更适合拿来比"改动前后"（p50 会跟着系统抖动漂 ±5~10%）。',
    ),
  );
}

/** 每帧新建多少东西。浏览器不做布局的账，但会按这些数字收钱。 */
function printBudget(rows: ScenarioResult[]): void {
  const head = [
    pad('规模', 8),
    pad('DOM节点', 10, 'r'),
    pad('新建元素', 10, 'r'),
    pad('HTML/帧', 11, 'r'),
    pad('读矩形', 9, 'r'),
    pad('堆增量', 10, 'r'),
  ].join('');
  console.log(dim(head));
  console.log(dim('─'.repeat(dw(head))));
  for (const r of rows) {
    const nodes = String(Math.round(r.htmlNodes));
    const heap = Number.isNaN(r.heapMb) ? dim('n/a') : r.heapMb > 0.05 ? `+${r.heapMb.toFixed(1)}MB` : '≈0';
    console.log(
      [
        pad(r.label, 8),
        pad(String(r.elems), 10, 'r'),
        r.htmlNodes > 1500 ? padC(nodes, 10, yellow) : pad(nodes, 10, 'r'),
        pad(bytes(Math.round(r.htmlChars)), 11, 'r'),
        r.rects > 20 ? padC(String(Math.round(r.rects)), 9, yellow) : pad(String(Math.round(r.rects)), 9, 'r'),
        r.heapMb > 20 ? padC(heap, 10, yellow) : pad(heap, 10, 'r'),
      ].join(''),
    );
  }
  console.log(
    dim(
      '  新建元素 = 每帧被丢弃重建的 DOM 数量，HTML/帧 = 每帧写进 innerHTML 的字节数。\n' +
        '  读矩形 = 每帧调了几次 getBoundingClientRect，每一次都可能让浏览器立刻做一遍布局。\n' +
        '  这三项在真机上还要乘上"重算样式 + 布局 + 绘制"——jsdom 不付这笔账，所以它测不到。',
    ),
  );
}

/**
 * 脚本测不到的那一半：样式重算、布局、绘制。
 *
 * jsdom 里没有这两步，真机上有——而且它和"节点数 × 每节点绘制层数"成正比。
 * 这里只做静态统计，把"要付多少账"的量级摆出来，不假装能测出毫秒数。
 * 这一段存在的理由：同一份代码在你机器上不卡、在朋友机器上卡，
 * 差的就是这一半（显卡、屏幕分辨率、合成层预算）。
 */
function printBrowserSide(rows: ScenarioResult[]): string[] {
  let css = '';
  try {
    css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  } catch {
    console.log(dim('  读不到 style.css，跳过这一段'));
    return [];
  }
  const tileRules = (css.match(/\.tile[^{]*\{/g) ?? []).length;
  const pseudos = (css.match(/\.tile[^{]*::(?:before|after)\s*\{/g) ?? []).length;
  const shadows = (css.match(/box-shadow/g) ?? []).length;
  const gradients = (css.match(/(?:linear|radial)-gradient/g) ?? []).length;

  const big = rows[rows.length - 1]!;
  const cells = big.size * big.size;
  // 保守估计：一格最多自己 + 两个伪元素，实际按地形不同而少
  const drawables = cells * 3;

  console.log(
    dim(
      `  每格最多 3 个绘制对象（自身 + ::before 地形纹理 + ::after 高亮层），` +
        `${big.label} = ${cells} 格 → 最多 ${drawables.toLocaleString('en-US')} 个。`,
    ),
  );
  console.log(
    dim(
      `  style.css 里 .tile 相关规则 ${tileRules} 条、伪元素 ${pseudos} 处、box-shadow ${shadows} 处、渐变 ${gradients} 处。`,
    ),
  );
  console.log(
    dim(
      '  这些在真机上要重算样式 → 布局 → 绘制三层，代价随绘制对象数线性涨，\n' +
        '  而且对显卡和屏幕分辨率很敏感——这就是"同一份代码，你的机器不卡、朋友的卡"的另一半。\n' +
        '  脚本量不到的强制布局还有两处：renderBoard 每帧读一次 el.clientWidth（算格子像素宽），\n' +
        '  fitBoard() 读 offsetWidth 写 style（只在窗口/缩放/工具栏尺寸真变时才跑）。',
    ),
  );
  return [
    `每格最多 3 个绘制对象，${big.label} 最多 ${drawables} 个；.tile 规则 ${tileRules} 条、伪元素 ${pseudos} 处、box-shadow ${shadows} 处。`,
    'renderBoard 每帧读一次 clientWidth；fitBoard 只在尺寸标脏后才读写布局。真机上仍是强制同步布局，只是不再每帧都付。',
  ];
}

/** 最小二乘：t = 固定开销 + 每格成本 × 格数。把"省不掉的"和"按格涨的"分开。 */
function fitLinear(rows: ScenarioResult[]): { a: number; b: number; r2: number } {
  const pts = rows.map((r) => [r.size * r.size, r.frame.p50] as const);
  const n = pts.length;
  if (n < 2) return { a: 0, b: 0, r2: 0 };
  const mx = pts.reduce((x, p) => x + p[0], 0) / n;
  const my = pts.reduce((x, p) => x + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  }
  const b = den === 0 ? 0 : num / den;
  const a = my - b * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (const [x, y] of pts) {
    const pred = a + b * x;
    ssRes += (y - pred) * (y - pred);
    ssTot += (y - my) * (y - my);
  }
  return { a, b, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

function printStages(rows: ScenarioResult[]): void {
  const maxFrame = Math.max(...rows.map((r) => r.frame.p50), 0.001);
  console.log(
    dim([pad('规模', 8), pad('雾视图', 9, 'r'), pad('棋盘', 9, 'r'), pad('侧栏', 9, 'r'), pad('威胁圈', 9, 'r'), pad('合计', 9, 'r'), '  占用'].join('')),
  );
  console.log(dim('─'.repeat(80)));
  for (const r of rows) {
    const total = r.fog.p50 + r.board.p50 + r.panel.p50 + r.threat.p50;
    const top = Math.max(
      ...[
        ['雾', r.fog.p50],
        ['棋盘', r.board.p50],
        ['侧栏', r.panel.p50],
        ['威胁', r.threat.p50],
      ].map((x) => x[1] as number),
    );
    const who = r.board.p50 === top ? '棋盘' : r.panel.p50 === top ? '侧栏' : r.fog.p50 === top ? '雾' : '威胁';
    console.log(
      [
        pad(r.label, 8),
        pad(fmt(r.fog.p50), 9, 'r'),
        pad(fmt(r.board.p50), 9, 'r'),
        pad(fmt(r.panel.p50), 9, 'r'),
        pad(fmt(r.threat.p50), 9, 'r'),
        pad(fmt(total), 9, 'r'),
        '  ',
        dim(bar(total, maxFrame, 12)),
        ` ${Math.round((total / maxFrame) * 100)}%`,
        who === '棋盘' ? yellow(' ←') : '',
      ].join(''),
    );
  }
  console.log(
    dim(
      `\n  （棋盘一列里含"把 HTML 变成 DOM"的时间，jsdom 侧平均 ${fmt(
        rows.reduce((a, r) => a + r.htmlMs, 0) / Math.max(1, rows.length),
      )}ms；真机这段是浏览器的解析器，快得多，但节点数一样要付布局和绘制的账）`,
    ),
  );
}

function printAi(rows: ScenarioResult[]): void {
  const withAi = rows.filter((r) => r.ai);
  if (withAi.length === 0) return;
  console.log(
    dim([pad('规模', 8), pad('最快', 9, 'r'), pad('p50', 9, 'r'), pad('p95', 9, 'r'), pad('最大', 9, 'r'), '  读法'].join('')),
  );
  console.log(dim('─'.repeat(76)));
  for (const r of withAi) {
    const a = r.ai!;
    const note =
      a.p50 > 100 ? red('一次想一秒，AI 回合会明显一顿') : a.p50 > 50 ? yellow('偏慢，快进时会累积') : dim('可接受');
    console.log(
      [
        pad(r.label, 8),
        pad(`${fmt(a.min)}ms`, 9, 'r'),
        pad(`${fmt(a.p50)}ms`, 9, 'r'),
        pad(`${fmt(a.p95)}ms`, 9, 'r'),
        pad(`${fmt(a.max)}ms`, 9, 'r'),
        '  ',
        note,
      ].join(''),
    );
  }
  console.log(dim('  最快一列更接近"纯计算成本"；p50 里还混着当回合局面本身的复杂度。'));
}

interface Finding {
  level: 0 | 1 | 2;
  text: string;
}

/**
 * 从数字里推结论，不写死结论。
 *
 * 每条都带"依据"：数字是多少、占多少、增长几倍。没有依据的判断等于没判断。
 */
function analyze(rows: ScenarioResult[]): Finding[] {
  const out: Finding[] = [];
  const big = rows[rows.length - 1]!;
  const small = rows[0]!;

  // 1) 是否越过 60fps 预算
  if (big.frame.p50 > 16.7) {
    out.push({
      level: big.frame.p50 > 33.3 ? 2 : 1,
      text: `${big.label} 单帧 p50 ${fmt(big.frame.p50)}ms，已经越过 60fps 的 16.7ms 预算（JS 侧上限 ${Math.round(
        1000 / big.frame.p50,
      )}fps）。真机加上布局与绘制只会更慢——这就是"明显卡顿"的来源。`,
    });
  } else {
    out.push({
      level: 0,
      text: `${big.label} 单帧 p50 ${fmt(big.frame.p50)}ms，JS 侧还在 60fps 预算内；如果真机仍卡，瓶颈更可能在布局/绘制而非脚本。`,
    });
  }

  // 2) 主阶段占比
  const parts: Array<[string, number]> = [
    ['棋盘重绘', big.board.p50],
    ['侧栏重绘', big.panel.p50],
    ['雾视图', big.fog.p50],
    ['威胁圈', big.threat.p50],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  const sum = parts.reduce((a, b) => a + b[1], 0) || 1;
  const [topName, topMs] = parts[0]!;
  out.push({
    level: topMs / sum > 0.5 ? 1 : 0,
    text: `${big.label} 上最大的一块是「${topName}」：${fmt(topMs)}ms，占全部脚本耗时的 ${Math.round(
      (topMs / sum) * 100,
    )}%（其余：${parts
      .slice(1)
      .map(([n, v]) => `${n} ${Math.round((v / sum) * 100)}%`)
      .join('、')}）。`,
  });

  // 3) 把单帧拆成"固定开销 + 每格成本"：省不掉的和按格涨的分开算
  if (rows.length >= 2) {
    const f = fitLinear(rows);
    const cells = big.size * big.size;
    const total = f.a + f.b * cells;
    const fixedShare = total > 0 ? f.a / total : 0;
    const cellRatio = cells / (small.size * small.size);
    const timeRatio = big.frame.p50 / Math.max(0.001, small.frame.p50);
    // 拟合贴不贴，决定"每格成本"这个模型还算不算数。
    // 增量重绘之后它就不贴了：单帧不再按格数涨，而是按"有多少单位、面板内容多少"涨。
    // 这时再拿"每格多少微秒"往下推，会推出一个不存在的优化方向。
    const flat = timeRatio < 1.5 && cellRatio > 3;
    out.push({
      level: fixedShare > 0.35 ? 1 : 0,
      text:
        `按格数做线性拟合：**固定开销 ${fmt(f.a)}ms + 每格 ${(f.b * 1000).toFixed(2)}µs**（R²=${f.r2.toFixed(2)}）。` +
        `${big.label} 的 ${fmt(big.frame.p50)}ms 里，${Math.round(fixedShare * 100)}% 与格数无关。` +
        (flat
          ? '每格成本已经压到很小，大头换成了"与格数无关"的那部分——见下一条，别再往格子上使劲了。'
          : f.r2 > 0.85
            ? '拟合很贴，说明模型对得上——要压帧时间就压"每格成本"这一项。'
            : '拟合有偏，说明还有别的变量在动（多半是各档兵力不同，或小图上固定开销占比太高）。'),
    });
    out.push({
      level: 0,
      text: flat
        ? `从 ${small.label} 到 ${big.label}：格数 ×${cellRatio.toFixed(1)}，单帧只 ×${timeRatio.toFixed(
            1,
          )}。格子已经不是主要变量了——大头挪到了每帧固定的那部分：棋子层重写、侧栏、雾视图。` +
          `这些只跟"有多少单位、面板里写了多少字"走，跟地图多大几乎无关。`
        : `从 ${small.label} 到 ${big.label}：格数 ×${cellRatio.toFixed(
            1,
          )}、单帧 ×${timeRatio.toFixed(1)}。单帧涨得比格数慢，是因为固定开销在两端都占着——` +
          `这也说明"只在 12×12 上试"永远发现不了 32×32 的问题。`,
    });
  }

  // 4) 每帧重建的 DOM 规模
  if (big.htmlNodes > 0) {
    // 换成比例来说：22 个节点不该被写成"绝大部分每帧换一批"
    const share = big.elems > 0 ? big.htmlNodes / big.elems : 0;
    out.push({
      level: big.htmlNodes > 1500 ? 1 : 0,
      text: `每帧新建 ${Math.round(big.htmlNodes)} 个元素、写入 ${bytes(
        Math.round(big.htmlChars),
      )} HTML，约占常驻元素（${big.elems} 个）的 ${(share * 100).toFixed(0)}%。` +
        (share < 0.1
          ? '节点已经按需复用了，剩下的这一点是"真的变了"的那部分。'
          : '这些节点是被丢弃重建的，浏览器每次都要重算样式、重排、重绘。'),
    });
  }

  // 5) 侧栏：整块重绘是不是常态
  if (big.panel.p50 > 1) {
    out.push({
      level: big.panel.p50 > 4 ? 1 : 0,
      text: `侧栏每帧 ${fmt(big.panel.p50)}ms。按内容跳过已经做了，这个数代表"内容真变了"的帧——` +
        `而它是一整块重写：换一个选中，顶卡、战报卡这些没变的也跟着重建。`,
    });
  }

  // 6) AI 决策
  // 拿最大那一档：AI 的成本跟着棋盘和兵力涨，用最小档说过头了
  const aiRow = [...rows].reverse().find((r) => r.ai && r.ai.p50 > 0);
  if (aiRow?.ai) {
    const a = aiRow.ai;
    out.push({
      level: a.p50 > 50 ? 2 : a.p50 > 20 ? 1 : 0,
      text: `AI 单次决策 ${fmt(a.p50)}ms（${aiRow.label}，p95 ${fmt(a.p95)}ms）。${
        a.p50 > 50
          ? 'AI 每走一步都要想这么久，快进/观战时就是一阵一阵的顿。'
          : '单步可接受，但一回合十几步会累加成肉眼可见的停顿。'
      }`,
    });
  }

  // 7) 抖动：同一份活，最快和最慢差多少
  const jitter = big.frame.max / Math.max(0.001, big.frame.min);
  if (jitter > 2) {
    out.push({
      level: jitter > 3 ? 2 : 1,
      text: `同一份活，最快 ${fmt(big.frame.min)}ms、最慢 ${fmt(big.frame.max)}ms，差 ${jitter.toFixed(
        1,
      )} 倍。这种抖动比"一直慢"更难受——它是"一顿一顿"。来源通常是 GC（每帧丢弃 ${Math.round(
        big.htmlNodes,
      )} 个节点）和强制布局，而不是算力不够。`,
    });
  }

  // 8) 内存
  if (Number.isFinite(big.heapMb) && big.heapMb > 1) {
    out.push({
      level: big.heapMb > 30 ? 1 : 0,
      text: `${big.label} 跑 ${big.frame.n} 帧涨了 +${big.heapMb.toFixed(
        1,
      )} MB 堆。量本身不大，但它多是短命的 DOM 节点——真机上这些节点会进 GC 的年轻代，频繁回收就是那种"隔几秒一顿"的节奏。`,
    });
  }

  return out;
}

function advise(rows: ScenarioResult[]): string[] {
  const big = rows[rows.length - 1]!;
  const sum = big.board.p50 + big.panel.p50 + big.fog.p50 + big.threat.p50 || 1;
  const out: string[] = [];

  if (big.board.p50 / sum > 0.4) {
    out.push(
      `**棋盘这一列还剩下的钱**：${fmt(big.board.p50)}ms/帧，占脚本 ${Math.round((big.board.p50 / sum) * 100)}%。` +
        `格子的节点已经复用（增量重绘），这一列里现在混着三件事：逐格算 class（${big.size * big.size} 格过一遍）、` +
        `改动的格子写 className、以及棋子层的整块重写。要看究竟是哪一件，得在这三处各插一次计时。`,
    );
  }
  if (big.htmlNodes > 800) {
    out.push(
      `**别用 innerHTML 重建**：每帧 ${Math.round(big.htmlNodes)} 个元素走一遍"解析字符串→建节点→丢旧节点"。` +
        `缓存节点数组、按需 patch，或者把静态地形层画到一张 canvas 上，只在底层数据变化时重画。`,
    );
  }
  if (big.panel.p50 / sum > 0.15) {
    out.push(
      `**侧栏的内容拆分**：${fmt(big.panel.p50)}ms/帧。按内容跳过已经做了（一样的 HTML 不再写），` +
        `所以这个数全是"内容真的变了"的那部分。要再省，就把侧栏拆成几块各自缓存：` +
        `顶卡（金币/城市/回合）、详情卡（选中单位）、战报卡——现在换一个选中会把整块 30KB 一起重写。`,
    );
  }
  if (big.threat.p50 / sum > 0.12) {
    out.push(
      `**威胁圈缓存**：${fmt(big.threat.p50)}ms/帧。它只依赖"单位位置 + 视野 + 敌方位置"，` +
        `单位没动、视野没变就可以整块复用；现在是无条件重算。`,
    );
  }
  if (big.fog.p50 / sum > 0.15) {
    out.push(
      `**雾视图缓存**：${fmt(big.fog.p50)}ms/帧，且和棋盘各算一遍可见格。` +
        `可以只在"有单位移动/回合切换"时重算，或者让 render 直接用上一次的结果。`,
    );
  }
  if (big.ai && big.ai.p50 > 40) {
    out.push(
      `**AI 决策挪出主线程**：单次 ${fmt(big.ai.p50)}ms 的同步计算会卡住整个界面（连按钮都点不动）。` +
        '短期可以在决策前后各让一帧（await 一个 setTimeout 0），长期挪到 Worker。',
    );
  }
  if (big.rects > 20) {
    out.push(
      `**治一下强制同步布局**：每帧 ${Math.round(big.rects)} 次 \`getBoundingClientRect\`。` +
        '写下样式之后再读矩形，浏览器为了回答那一刻的尺寸会立刻把布局算一遍；' +
        '位置本来就按百分比算得出来，位移量自己乘一下格子宽就行，不必问浏览器。',
    );
  }
  if (big.frame.p95 > big.frame.p50 * 2) {
    out.push(
      `**首帧/异常帧**：p95 ${fmt(big.frame.p95)}ms 是 p50 的 ${(big.frame.p95 / big.frame.p50).toFixed(
        1,
      )} 倍，说明有明显的不稳定帧（GC、首次布局、动画启动）。这类卡顿体感最刺眼，值得单独抓一次。`,
    );
  }
  if (out.length === 0) out.push('各阶段都在预算内，先按真机 Performance 面板确认瓶颈层级（脚本、布局、绘制、合成）。');
  return out;
}

/**
 * 缓存到底省了多少、什么情况下省不到。
 *
 * 主表每帧画的是同一幅画面，缓存全命中——那是**最乐观**的一种情形。
 * 真机对局里点一下别的兵、扣一次血、金币变一下，都会让某几层真的重写。
 * 所以同一档再跑三遍：同一画面 / 每帧换选中 / 每帧全量重画。
 *
 * 最后一档是"增量重绘之前"的等价物，拿它当"没优化时会多贵"的参照。
 */
function printChurn(rows: ScenarioResult[]): string[] {
  if (rows.length === 0) return [];
  const head = [
    pad('画面情形', 18),
    pad('最快', 10, 'r'),
    pad('p50', 10, 'r'),
    pad('新建元素', 11, 'r'),
    pad('HTML/帧', 11, 'r'),
  ].join('');
  console.log(dim(head));
  console.log(dim('─'.repeat(dw(head))));
  const out: string[] = [];
  for (const r of rows) {
    console.log(
      [
        pad(r.label, 18),
        pad(`${fmt(r.frame.min)}ms`, 10, 'r'),
        pad(`${fmt(r.frame.p50)}ms`, 10, 'r'),
        pad(String(Math.round(r.htmlNodes)), 11, 'r'),
        pad(bytes(Math.round(r.htmlChars)), 11, 'r'),
      ].join(''),
    );
    out.push(`| ${r.label} | ${fmt(r.frame.min)}ms | ${fmt(r.frame.p50)}ms | ${Math.round(r.htmlNodes)} | ${bytes(Math.round(r.htmlChars))} |`);
  }
  const steady = rows.find((r) => r.label === '同一画面');
  const full = rows.find((r) => r.label === '每帧全量重画');
  const sel = rows.find((r) => r.label === '每帧换选中');
  console.log(
    dim(
      '  「同一画面」是缓存全命中的下限，「每帧全量重画」是增量重绘之前的等价物；\n' +
        '  真机上的多数帧落在两者之间——玩家点一下别的兵、金币变了，只有变化的那几层重写。',
    ),
  );
  if (steady && full) {
    const saved = 1 - steady.frame.min / Math.max(0.001, full.frame.min);
    console.log(
      dim(
        `  省下的：${fmt(full.frame.min)}ms → ${fmt(steady.frame.min)}ms（${(saved * 100).toFixed(0)}%）` +
          (sel ? `；换选中那一档是 ${fmt(sel.frame.min)}ms` : ''),
      ),
    );
  }
  return out;
}

function mdTable(rows: ScenarioResult[]): string[] {
  const L: string[] = [];
  L.push('| 规模 | 兵力 | 最快 | 单帧 p50 | p95 | 最大 | 掉帧率 | p50 帧率 | DOM 节点 | HTML/帧 | 新建元素 | 堆增量 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    L.push(
      `| ${r.label} | ${r.army} | ${fmt(r.frame.min)}ms | ${fmt(r.frame.p50)}ms | ${fmt(r.frame.p95)}ms | ${fmt(
        r.frame.max,
      )}ms | ${Math.round(r.over * 100)}% | ${Math.round(1000 / Math.max(0.001, r.frame.p50))}fps | ${r.elems} | ${bytes(
        Math.round(r.htmlChars),
      )} | ${Math.round(r.htmlNodes)} | ${Number.isNaN(r.heapMb) ? 'n/a' : `+${r.heapMb.toFixed(1)}MB`} |`,
    );
  }
  return L;
}

function renderMarkdown(
  rows: ScenarioResult[],
  findings: Finding[],
  advice: string[],
  delta: string[] = [],
  browser: string[] = [],
  compare: ScenarioResult[] = [],
  churn: string[] = [],
): string {
  const L: string[] = [];
  L.push('# 性能体检报告', '');
  L.push(`> 由 \`npm run perf\` 生成 · ${new Date().toLocaleString('zh-CN')} · 每档 ${FRAMES} 帧`);
  L.push('', '> 环境：Node + jsdom。**不含浏览器布局与绘制**，帧率一列是 JS 侧上限（下限判据）。', '');
  L.push('## 总览', '');
  L.push(...mdTable(rows.filter((r) => !compare.includes(r))));
  L.push('', '## 阶段拆解（p50，ms）', '');
  L.push('| 规模 | 雾视图 | 棋盘 | 侧栏 | 威胁圈 | 合计 |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    L.push(
      `| ${r.label} | ${fmt(r.fog.p50)} | ${fmt(r.board.p50)} | ${fmt(r.panel.p50)} | ${fmt(r.threat.p50)} | ${fmt(
        r.fog.p50 + r.board.p50 + r.panel.p50 + r.threat.p50,
      )} |`,
    );
  }
  if (compare.length > 0) {
    L.push('', '## 配置横比', '');
    L.push(...mdTable(compare));
  }
  if (churn.length > 0) {
    L.push('', '## 缓存省了多少', '');
    L.push('| 画面情形 | 最快 | p50 | 新建元素 | HTML/帧 |');
    L.push('|---|---:|---:|---:|---:|');
    L.push(...churn);
    L.push('');
    L.push('「同一画面」是缓存全命中的下限，「每帧全量重画」是增量重绘之前的等价物，真机多数帧落在两者之间。');
  }
  if (browser.length > 0) {
    L.push('', '## 浏览器那边（脚本测不到的一半）', '');
    for (const b of browser) L.push(`- ${b}`);
  }
  if (delta.length > 0) {
    L.push('', '## 与基线对比', '');
    L.push('| 规模 | 基线 p50 | 现在 p50 | 变化 | 判定 |');
    L.push('|---|---:|---:|---:|---|');
    L.push(...delta);
  }
  L.push('', '## 结论', '');
  for (const f of findings) L.push(`- ${f.level === 2 ? '**[卡]** ' : f.level === 1 ? '**[注意]** ' : ''}${f.text}`);
  L.push('', '## 建议（按收益排序）', '');
  advice.forEach((a, i) => L.push(`${i + 1}. ${a}`));
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const win = installDom();
  const html = instrumentHtml(win);

  // 必须在 document 就位之后再加载渲染层
  const { renderBoard } = await import('../src/ui/board.ts');
  const { renderPanel } = await import('../src/ui/panel.ts');

  console.log('');
  console.log(
    bold('  棋盘性能体检') +
      dim(`  ·  node ${process.version}  ·  每档 ${FRAMES} 帧 × ${REPEAT} 轮（预热 ${WARMUP}）`),
  );
  console.log(dim('─'.repeat(96)));
  console.log(
    dim(
      '  一"帧" = render() 走的一整条流水：playerView → threatTiles → renderBoard → renderPanel\n' +
        '  主表每帧切一个选中单位（玩家在几个兵之间点的最小真实操作），缓存跳不过去。\n' +
        '  jsdom 不做布局/绘制，所以这里的帧时间是**下限**：它都没过 16.7ms 的档，真机必然掉。',
    ),
  );
  console.log('');

  // 第一档总会偏慢：jsdom 第一次建样式表、V8 第一次编译这几条热路径。
  // 拿它当基准会把所有结论带偏（第一版 12×12 报 9.4ms，比 16×16 的 8.0ms 还慢，
  // 而格子只有人家一半），所以先空跑一遍同样的流水再丢掉。
  process.stdout.write(dim('  预热 …'));
  await runScenario(
    { size: SIZES[SIZES.length - 1] ?? 16, frames: 12, ai: false },
    win,
    html,
    renderBoard as unknown as RenderBoard,
    renderPanel as unknown as RenderPanel,
  );
  process.stdout.write(`\r${' '.repeat(30)}\r`);

  const rows: ScenarioResult[] = [];
  for (const size of SIZES) {
    process.stdout.write(dim(`  跑 ${size}×${size} …`));
    const r = await runBest({ size }, win, html, renderBoard as unknown as RenderBoard, renderPanel as unknown as RenderPanel);
    rows.push(r);
    process.stdout.write(`\r${' '.repeat(30)}\r`);
  }

  console.log(bold('■ 总览') + dim('（单帧 = 一次完整 render 流水）'));
  printOverview(rows);
  console.log('');
  console.log(bold('■ 每帧资源') + dim('（这些数字决定浏览器那边要付多少布局与绘制的账）'));
  printBudget(rows);
  console.log('');
  console.log(bold('■ 浏览器那边') + dim('（脚本测不到的一半，只能估量级）'));
  const browserNotes = printBrowserSide(rows);
  console.log('');
  console.log(bold('■ 阶段拆解') + dim('（p50，ms；右侧是各阶段占最大一档总耗时的比例）'));
  printStages(rows);
  console.log('');
  console.log(bold('■ AI 决策') + dim('（不在帧循环里，但 AI 回合的停顿主要来自这里）'));
  printAi(rows);
  console.log('');

  console.log(bold('■ 缓存省了多少') + dim('（同一档换三种"画面变了多少"，别只看主表那一行）'));
  const churnSize = rows[rows.length - 1]!.size;
  const churnRows: ScenarioResult[] = [];
  for (const c of [
    { churn: 'none', label: '同一画面' },
    { churn: 'select', label: '每帧换选中' },
    { churn: 'full', label: '每帧全量重画' },
  ] as const) {
    process.stdout.write(dim(`  跑 ${c.label} …`));
    churnRows.push(
      await runBest(
        { size: churnSize, churn: c.churn, label: c.label },
        win,
        html,
        renderBoard as unknown as RenderBoard,
        renderPanel as unknown as RenderPanel,
      ),
    );
    process.stdout.write(`\r${' '.repeat(30)}\r`);
  }
  const churnLines = printChurn(churnRows);
  console.log('');

  const findings = analyze(rows);
  console.log(bold('■ 瓶颈结论'));
  for (const f of findings) {
    const mark = f.level === 2 ? red('●') : f.level === 1 ? yellow('●') : green('○');
    console.log(`  ${mark} ${f.text}`);
  }
  console.log('');

  const advice = advise(rows);
  console.log(bold('■ 建议（按收益排序）'));
  advice.forEach((a, i) => console.log(`  ${cyan(String(i + 1) + '.')} ${a}`));
  console.log('');

  // ---- 配置横比 ----
  let compare: ScenarioResult[] = [];
  if (DO_COMPARE) {
    const size = SIZES[SIZES.length - 1]!;
    const ALL = ['bloodbath', 'turn-order-comp', 'veterans'];
    console.log(bold(`■ 配置横比（${size}×${size}）`) + dim('　基准直接取上面那一行，不再重跑——重跑一次会差 50%，那是机器状态不是配置差异'));
    // 基准必须和主表里同一档对上，否则"32×32 到底是 21ms 还是 31ms"就说不清了。
    // 这里直接借主表那一行的结果当基准，只额外跑"改动量"的几种配置。
    const baseRow = rows[rows.length - 1]!;
    compare.push({ ...baseRow, label: '基准' });
    const cases: RunOpts[] = [
      { size, label: '开基础扩展', expansions: ALL },
      { size, label: '雾战', expansions: [], fog: true },
      { size, label: '兵力×2', expansions: [], army: Math.round((size * size) / 12) },
    ];
    for (const c of cases) {
      process.stdout.write(dim(`  跑 ${c.label} …`));
      compare.push(await runBest(c, win, html, renderBoard as unknown as RenderBoard, renderPanel as unknown as RenderPanel));
      process.stdout.write(`\r${' '.repeat(30)}\r`);
    }
    printOverview(compare);
    const byLabel = new Map(compare.map((c) => [c.label, c]));
    const base = byLabel.get('基准');
    if (base) {
      const bits: string[] = [];
      for (const k of ['开基础扩展', '雾战', '兵力×2']) {
        const c = byLabel.get(k);
        if (!c) continue;
        const d = c.frame.min - base.frame.min;
        const pct = (d / Math.max(0.001, base.frame.min)) * 100;
        bits.push(`${k} ${d >= 0 ? '+' : ''}${fmt(d)}ms（${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%）`);
      }
      console.log(dim(`  相对基准：${bits.join(' · ')}`));
      const doubled = byLabel.get('兵力×2');
      if (doubled) {
        const bite = (doubled.frame.min - base.frame.min) / Math.max(0.001, base.frame.min);
        console.log(
          dim(
            bite < 0.2
              ? '  兵力翻倍只贵这么一点，而格数从 144 涨到 1024 让单帧翻了三倍——卡顿的主因是格子，不是兵。'
              : '  兵力翻倍明显更贵，说明棋子本身也是大头，优化时别只盯着格子。',
          ),
        );
      }
    }
    console.log('');
  }

  // ---- 与基线对比 ----
  let deltaLines: string[] = [];
  if (BASELINE) {
    const base = loadBaseline(BASELINE);
    if (base) {
      console.log(bold('■ 与基线对比') + dim(`（${BASELINE} · ${new Date(base.when).toLocaleString('zh-CN')} 那次）`));
      deltaLines = printDelta(rows, base);
      console.log('');
    }
  }

  // ---- 落盘 ----
  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          when: new Date().toISOString(),
          node: process.version,
          frames: FRAMES,
          rows,
          compare,
          findings: findings.map((f) => ({ level: f.level, text: f.text })),
          advice,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(dim(`  结果已写入 ${JSON_OUT}`));
  }
  if (MD_OUT) {
    writeFileSync(MD_OUT, renderMarkdown(rows, findings, advice, deltaLines, browserNotes, compare, churnLines), 'utf8');
    console.log(dim(`  报告已写入 ${MD_OUT}`));
  }
  console.log('');
}

await main();
