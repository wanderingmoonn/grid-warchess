/**
 * **兵种标定台**（S0b，2026-11-27；只读，不参与任何判断）。
 *
 *   node --experimental-strip-types scripts/probe-duel-table.ts [--era 3] [--n 6]
 *
 * 用户定的办法（2026-11-27 00:24）：**同代每一对兵在引擎里打一场，赢一次得 1 分**，
 * 分高的是"最普适的强"（赢得多，未必不被某个兵克，但一定最好用）。
 *
 * 为什么不用闭式公式算：S0 已经证过，公式会系统性低估射程——
 * 弓手×6 打斥候×6、火枪×6 打戟兵×6，引擎里的结果和"每发伤害×能挨几发"相反。
 * 原因是**排队 + 逐个到达**（近战要走过去、只有贴上去的几个能打，远程全程全队输出），
 * 那是场面的属性，不是单兵对的属性。所以这里**直接问引擎**。
 *
 * ── 打法（两边完全相同，只比兵种）────────────────────────────
 *
 *   贴身就打（挑血最少的）→ 否则朝最近的敌人走一格 → 走不动就原地结束。
 *   双方同一套，所以胜负只来自兵种差异；城市在角落、双方 0 金、谁也不造兵。
 *
 * ── 输出 ──────────────────────────────────────────────────
 *
 *   ① 对局表：每对的胜负 + 双方剩余（正反各跑一次，顺便看有没有"边"偏差）
 *   ② 胜分排名：赢 1 分；分数相同看**互相克制**（谁赢谁）
 *   ③ 环检测：在"胜分相同"的那一撮里找 a>b>c>a（用户说的未定问题，先数出来）
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';
import { duel, flushDuelCache } from './lib/duel-cache.ts';

const argOf = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : dflt;
};
const ERA = Number(argOf('era', '3'));
const N = Number(argOf('n', '6'));

const fight = (a: string, b: string) => duel(a, b, N);

const ids = Object.values(s0().unitTypes)
  .filter((d) => d.category === 'combat' && (d.domain ?? 'land') !== 'water' && (d.era ?? 1) === ERA)
  .map((d) => d.id);
function s0(): GameState {
  return createMatch({ ...DEFAULT_CONFIG, size: 14, startEra: 1 }, 7);
}
const name = (t: string): string => s0().unitTypes[t]?.name ?? t;

console.log(`\n=== ${ERA} 代 · 每对 ${N} 个对 ${N} 个 · 同一套打法（结果走缓存）===\n`);

const score = new Map<string, number>(ids.map((t) => [t, 0]));
const head: Array<{ a: string; b: string; win: 'A' | 'B' | '平'; aLeft: number; bLeft: number; rev: boolean }> = [];
const rows: string[] = [];

for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i]!;
    const b = ids[j]!;
    const r1 = fight(a, b);
    const r2 = fight(b, a); /* 反着再打一次：**两边的"先手优势"要相抵** */
    /*
     * **按两次的净胜人数计分，不按单场胜负**（2026-11-27 00:30 修正）。
     *
     * 第一版按"这一场的赢家"计分，结果 火枪 vs 臼炮 两向都是"先动的那边 5:0"——
     * 两个射程一样、身价相近的兵，胜负完全由先手决定，单场胜负量不出兵种差异。
     * 现在用两次的净胜人数相加：正负相抵之后，先手优势自己消掉。
     */
    const margin = (r1.aLeft - r1.bLeft) + (r2.bLeft - r2.aLeft);
    const win: 'A' | 'B' | '平' = margin > 0 ? 'A' : margin < 0 ? 'B' : '平';
    const agree = Math.sign(margin) !== 0;
    const winner = win === 'A' ? a : win === 'B' ? b : null;
    if (winner) score.set(winner, (score.get(winner) ?? 0) + 1);
    head.push({ a, b, win, aLeft: r1.aLeft, bLeft: r1.bLeft, rev: !agree });
    rows.push(
      `${name(a).padEnd(6)} vs ${name(b).padEnd(6)} → ${(winner ? name(winner) : '平').padEnd(6)}` +
        ` ${String(r1.aLeft).padStart(2)}:${String(r1.bLeft).padStart(2)}` +
        ` / 反向 ${r2.aLeft}:${r2.bLeft} → 净 ${margin > 0 ? '+' : ''}${margin}`,
    );
  }
}
for (const r of rows) console.log('  ' + r);

const rank = [...score.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
console.log(`\n胜分排名：`);
for (const [t, sc] of rank) console.log(`  ${name(t).padEnd(6)} ${sc} 分`);

/* 同分之间的克制关系 + 环 */
const groups = new Map<number, string[]>();
for (const [t, sc] of rank) groups.set(sc, [...(groups.get(sc) ?? []), t]);
for (const [sc, g] of groups) {
  if (g.length < 2) continue;
  const lines: string[] = [];
  for (const a of g) for (const b of g) {
    if (a === b) continue;
    const h = head.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!h) continue;
    const w = h.a === a ? h.win : h.win === 'A' ? 'B' : h.win === 'B' ? 'A' : '平';
    if (w === 'A') lines.push(`${name(a)}>${name(b)}`);
  }
  console.log(`\n${sc} 分组内克制：${lines.length > 0 ? lines.join('  ') : '互相打平/无一边倒'}`);
  /* 三元环 */
  const cyc: string[] = [];
  for (const a of g) for (const b of g) for (const c of g) {
    if (new Set([a, b, c]).size < 3) continue;
    const wins = (x: string, y: string): boolean => {
      const h = head.find((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x));
      if (!h) return false;
      return h.a === x ? h.win === 'A' : h.win === 'B';
    };
    if (wins(a, b) && wins(b, c) && wins(c, a)) {
      const k = [a, b, c].sort().join('+');
      if (!cyc.includes(k)) cyc.push(k);
    }
  }
  console.log(`  三元环：${cyc.length === 0 ? '无' : cyc.join(' , ')}`);
}

flushDuelCache();
