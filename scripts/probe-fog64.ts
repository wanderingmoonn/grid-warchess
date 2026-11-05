/*
 * 64×64 + 迷雾 的体检。
 *
 * 起因：玩家反馈"朋友开迷雾跑 64×64 会闪退，关掉迷雾就正常"。
 * 这条脚本把**不涉及 DOM**的那一半先量出来——建局、刷新记忆、生成视图、
 * AI 决策各自的耗时与堆占用。浏览器那一半（4000 个带 filter 的格子）
 * 单独用页面探针量。
 *
 * 用法：node --experimental-strip-types scripts/probe-fog64.ts [size] [steps]
 */
import { DEFAULT_CONFIG } from '../src/core/setup.ts';
import { createMatch } from '../src/core/setup.ts';
import { playerView } from '../src/core/fog.ts';
import { refreshMemory, applyAction } from '../src/core/rules.ts';
import { aiNextAction } from '../src/core/ai.ts';
import type { GameState } from '../src/core/types.ts';

const size = Number(process.argv[2] ?? 64);
const steps = Number(process.argv[3] ?? 120);

const MB = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
const heap = () => process.memoryUsage().heapUsed;

const timed = <T>(label: string, fn: () => T): { v: T; ms: number } => {
  const t0 = performance.now();
  const v = fn();
  const ms = performance.now() - t0;
  void label;
  return { v, ms };
};

const t0 = performance.now();
const state = createMatch({ ...DEFAULT_CONFIG, size, fog: true } as never, 12345, {});
console.log(`建局 ${size}×${size} 迷雾：${(performance.now() - t0).toFixed(0)}ms，格数 ${state.w * state.h}`);

let s: GameState = state;
let worstRefresh = 0;
let worstView = 0;
let worstAi = 0;
let maxHeap = heap();

for (let i = 0; i < steps; i += 1) {
  for (const p of ['A', 'B'] as const) {
    refreshMemory(s);
    const r = timed('refresh', () => refreshMemory(s));
    worstRefresh = Math.max(worstRefresh, r.ms);

    const watched = timed('view', () => playerView(s, p));
    worstView = Math.max(worstView, watched.ms);
    if (watched.v.state.units.length > s.units.length) {
      throw new Error('视图里的单位比全量还多');
    }

    const act = timed('ai', () => aiNextAction(s, 'normal' as never, new Set(), 0));
    worstAi = Math.max(worstAi, act.ms);
    const action = act.v ?? { type: 'END_TURN' as const };
    const applied = applyAction(s, action as never);
    if (applied.ok) s = applied.state;
    else {
      const end = applyAction(s, { type: 'END_TURN' } as never);
      if (end.ok) s = end.state;
    }
    maxHeap = Math.max(maxHeap, heap());
  }
  if (i % 20 === 0) console.log(`  第 ${i} 轮：堆 ${MB(heap())}，回合 ${s.turn}`);
}

console.log(`\n最慢一次：refreshMemory ${worstRefresh.toFixed(1)}ms / playerView ${worstView.toFixed(1)}ms / 决策 ${worstAi.toFixed(0)}ms`);
console.log(`峰值堆：${MB(maxHeap)}；此刻 ${MB(heap())}`);
