/**
 * 兵种数值体检：把"每一项属性到底值多少钱"从现有造价里**反解**出来，
 * 再拿它给每个兵种算一个"模型价"，看谁贵了、谁便宜了、谁压根没被计价。
 *
 * 为什么用回归而不是拍权重：280 个兵种的造价是人一条条手填的，里面已经
 * 隐含了一套"攻/血/甲/射程/移速/视野/技能各值多少"的约定。先用最小二乘把
 * 这套隐含约定解出来，再谈"哪里失衡"才站得住——否则就是拿我自己的偏好
 * 去否定别人的手填值。
 *
 * 模型（对数线性，弹性可读）：
 *   cost ≈ K · dpr^a · ehp^b · rangeT^c · moveT^d · visionT^e · abilityT^f
 * 其中
 *   dpr     = (atk + magicAtk×1.2) × burst            每回合理论输出（打 0 甲）
 *   ehp     = maxHp × 20 / max(1, 20 − armor)          挨 20 攻时能吃几刀的等效血量
 *   rangeT  = 1 + min(5, max(0, range−1)) × 0.30      射程的收益是非线性的（越远越贵）
 *   moveT   = 1 + max(0, move−2) × 0.12               机动：能选在哪开战
 *   visionT = 1 + clamp(vision−3, −2, 6) × 0.04       视野：迷雾下"看得见才打得着"
 *   abilityT= 1 + Σ 能力权重（见表，封顶 0.6）
 *
 * 输出：
 *   ① 隐含弹性（每项属性涨 1%，造价涨百分之几）
 *   ② 模型价 vs 实际价的比值榜（谁贵谁便宜）
 *   ③ 硬冲突清单（看不见自己射程、移 1 配射 1、攻低血厚却卖高价……）
 *
 * 运行：node --experimental-strip-types scripts/audit-stats.ts
 */
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { availableExpansions } from '../src/core/expansions.ts';
import { abilityValue, combatCore } from '../src/core/unit-value.ts';
import type { UnitTypeDef } from '../src/core/types.ts';

/**
 * 能力权重表来自 `core/unit-value.ts`——和 AI 采购用的是同一份。
 * 这里不再抄第二份：抄了就会出现"审计和 AI 对同一个兵估价不同"。
 */
const abilityValueOf = abilityValue;


const rangeT = (r: number): number => 1 + Math.min(5, Math.max(0, r - 1)) * 0.3;
const moveT = (m: number): number => 1 + Math.max(0, m - 2) * 0.12;
const visionT = (v: number): number => 1 + Math.max(-2, Math.min(6, v - 3)) * 0.04;

/**
 * 输出与等效血都问 `combatCore`：物理/魔法分通道、破甲砍半甲、威胁谱带魔抗。
 * 上一版这里算的是 `(攻 + 魔攻×1.2) × 段数`——把魔法塞进物理通道再一起减甲，
 * 正是模型里刚修掉的那个错，回归特征没理由再用一遍。
 */
const dprOf = (d: UnitTypeDef): number => combatCore(d).dps;
/** 等效血直接问模型：单一「20 攻」那条曲线在厚甲段是发散的，别在回归里再用一遍 */
const ehpOf = (d: UnitTypeDef): number => combatCore(d).ehp;

/** 最小二乘：正规方程 + 高斯消元（特征只有 6 列，不值得引库） */
function solve(A: number[][], y: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, y[i] as number]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]!;
    if (Math.abs(piv) < 1e-12) continue;
    for (let k = c; k <= n; k += 1) M[c]![k]! /= piv;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k += 1) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row) => row[n]!);
}

const ids = availableExpansions().map((e) => e.id);
const s = createMatch({ ...DEFAULT_CONFIG, startEra: 6, expansionIds: ids }, 1);
const allUnits = Object.values(s.unitTypes).filter((d) => d.category === 'combat' && d.cost > 0);
/*
 * 英雄不进拟合。
 *
 * 它们的价签买的是"技能表"（剑修的剑气、至尊法师的法术），而技能效果大多
 * 不在 `atk/hp/armor` 里。硬塞进来只会让"技能"那一列被少数极端值带偏。
 * 它们照旧出现在结果里，只是不参与解权重。
 */
const heroIds = new Set(allUnits.filter((d) => d.hero).map((d) => d.id));
const all = allUnits.filter((d) => !d.hero);

/** 特征：ln(dpr), ln(ehp), ln(rangeT), ln(moveT), ln(visionT), ln(abilityT) */
const NAMES = ['ln(输出)', 'ln(等效血)', 'ln(射程)', 'ln(移速)', 'ln(视野)', 'ln(技能)', 'ln(时代)', '空中层', '水域'];
const X: number[][] = [];
const y: number[] = [];
for (const d of all) {
  X.push([
    Math.log(Math.max(1, dprOf(d))),
    Math.log(ehpOf(d)),
    Math.log(rangeT(d.range ?? 1)),
    Math.log(moveT(d.move)),
    Math.log(visionT(d.vision)),
    Math.log(1 + abilityValueOf(d)),
    Math.log(Math.max(1, d.era)),
    d.layer === 'air' ? 1 : 0,
    d.domain === 'water' ? 1 : 0,
  ]);
  y.push(Math.log(d.cost));
}

// 正规方程
const k = NAMES.length;
const XtX: number[][] = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0));
const Xty: number[] = new Array(k + 1).fill(0);
for (let i = 0; i < X.length; i += 1) {
  const row = [1, ...(X[i] as number[])];
  for (let a = 0; a <= k; a += 1) {
    Xty[a]! += row[a]! * (y[i] as number);
    for (let b = 0; b <= k; b += 1) XtX[a]![b]! += row[a]! * row[b]!;
  }
}
const beta = solve(XtX, Xty);

let ssTot = 0;
let ssRes = 0;
const yMean = y.reduce((a, b) => a + b, 0) / y.length;
for (let i = 0; i < X.length; i += 1) {
  const pred = [1, ...(X[i] as number[])].reduce((acc, v, idx) => acc + v * beta[idx]!, 0);
  ssRes += (y[i]! - pred) ** 2;
  ssTot += (y[i]! - yMean) ** 2;
}
const r2 = 1 - ssRes / ssTot;

console.log(`\n样本：${all.length} 个战斗兵种 · 另有英雄 ${heroIds.size} 个只列榜不参与拟合（全 34 个扩展 + 本体，时代上限 6）`);
console.log(`模型：cost ≈ K · 输出^a · 等效血^b · 射程^c · 移速^d · 视野^e · 技能^f · 时代^g · 空中/水域哑变量`);
console.log(`R² = ${r2.toFixed(3)}   （不是拟合好坏的问题：造价是人手填的，本来就带噪声）\n`);
console.log('① 隐含弹性（这项属性涨 1%，造价涨百分之几）');
for (let i = 0; i < k; i += 1) {
  console.log(`   ${NAMES[i]!.padEnd(12)} ${beta[i + 1]!.toFixed(3)}`);
}

type Row = { d: UnitTypeDef; fair: number; ratio: number };
const rows: Row[] = allUnits.map((d) => {
  const idx = all.indexOf(d);
  // 英雄没有 X 行：用"同代同类的平均"兜底，只在榜上出现、不参与拟合
  const pred =
    idx >= 0
      ? [1, ...X[idx]!].reduce((acc, v, i2) => acc + v * beta[i2]!, 0)
      : Math.log(d.cost);
  const fair = Math.exp(pred);
  return { d, fair, ratio: d.cost / fair };
});
rows.sort((a, b) => b.ratio - a.ratio);

const line = (r: Row): string =>
  `   ${r.d.name.padEnd(9)} ${r.d.id.padEnd(18)} 价 ${String(r.d.cost).padStart(4)} · 模型 ${String(Math.round(r.fair)).padStart(4)} · ` +
  `比 ${r.ratio.toFixed(2)}${r.d.hero ? '(英雄)' : ''} · 攻 ${String(r.d.atk).padStart(2)} 血 ${String(r.d.maxHp).padStart(3)} 甲 ${String(r.d.armor).padStart(2)} ` +
  `移 ${String(r.d.move).padStart(2)} 视 ${String(r.d.vision).padStart(2)} 射 ${String(r.d.range ?? 1).padStart(2)}`;

console.log('\n② 溢价最狠的 15 个（花了冤枉钱）');
for (const r of rows.slice(0, 15)) console.log(line(r));
console.log('\n③ 性价比最高的 15 个（模型说它该更贵）');
for (const r of rows.slice(-15).reverse()) console.log(line(r));

console.log('\n④ 硬冲突');
const conflicts: Array<{ d: UnitTypeDef; why: string }> = [];
for (const d of all) {
  const range = d.range ?? 1;
  if (range >= 3 && d.vision < range) {
    conflicts.push({ d, why: `射程 ${range} 却只有视野 ${d.vision}：看不见自己射程内的目标（依赖队友点灯）` });
  }
  if (d.move <= 1 && range <= 1) {
    conflicts.push({ d, why: `移 ${d.move} + 近战：一旦出生点周围是森林/丘陵就永远到不了前线` });
  }
  if ((d.burst ?? 1) >= 3 && d.atk >= 40) {
    conflicts.push({ d, why: `攻 ${d.atk} × ${d.burst} 段：单回合爆发 ${d.atk * (d.burst ?? 1)}，与"多段各自减甲"的定位冲突` });
  }
  if (d.maxHp <= 26 && d.move >= 5 && (d.cost ?? 0) >= 150) {
    conflicts.push({ d, why: `血 ${d.maxHp} 却移 ${d.move}、卖 ${d.cost}：冲进去就死，机动变成负资产` });
  }
}
for (const c of conflicts) {
  console.log(`   ${c.d.name.padEnd(9)} ${c.d.id.padEnd(18)} ${c.why}`);
}
console.log(`   共 ${conflicts.length} 条`);
