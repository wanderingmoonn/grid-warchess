/**
 * 给估值模型标定 `POWER_K`。
 *
 * 为什么需要：`POWER_K` 只是个量级常数，用来把战力换算到"和旧版 p50 效率 ≈ 5~6
 * 同一个区间"——因为采购分里性价比那一段被 `Math.min(26, eff × EFF_SCALE)` 夹住了，
 * 量级一变，夹的边界等于换了，采购行为的差异就不是"口径变准了"而是"常数换了"。
 *
 * 所以**每次改动压缩指数 / 价格指数，都得重新解一次 K**，否则对照实验里
 * 两个变量的效果会混在一起。
 *
 * 用法：
 *   npm run calibrate:k                 # 打印当前默认口径
 *   npm run calibrate:k -- 0.55 0.7     # 给指定的压缩指数各解一个 K
 *   npm run calibrate:k -- 0.55:0.95    # 也可以指定"压缩指数:价格指数"
 */
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { availableExpansions } from '../src/core/expansions.ts';
import {
  LANCHESTER_EXP,
  PRICE_EXP,
  POWER_K,
  rangeFactor,
  moveFactor,
  visionFactor,
  abilityValue as abilityValueOf,
  NEUTRAL_CONTEXT,
} from '../src/core/unit-value.ts';
import type { UnitTypeDef } from '../src/core/types.ts';

const BASE_ARMOR = 5;
const BASE_ATK = 20;

const ids = availableExpansions().map((e) => e.id);
const s = createMatch({ ...DEFAULT_CONFIG, startEra: 6, expansionIds: ids }, 1);
const units = Object.values(s.unitTypes).filter(
  (d) => d.category === 'combat' && d.cost > 0,
);

const burstOf = (d: UnitTypeDef): number => Math.max(1, d.burst ?? 1);
const dprOf = (d: UnitTypeDef): number =>
  Math.max(1, d.atk + (d.magicAtk ?? 0) * 1.2 - BASE_ARMOR) * burstOf(d);
const ehpOf = (d: UnitTypeDef): number =>
  Math.max(1, d.maxHp) * (BASE_ATK / Math.max(1, BASE_ATK - d.armor));

/** 与 unitPower 一致的"除 K 与压缩指数之外"那一坨 */
const shapeOf = (d: UnitTypeDef): number =>
  rangeFactor(d.range ?? 1) *
  moveFactor(d.move, NEUTRAL_CONTEXT) *
  visionFactor(d.vision, NEUTRAL_CONTEXT) *
  (1 + abilityValueOf(d));

/**
 * 能力权重直接问 AI 那把尺子：`abilityValue` 是导出的，
 * 不在这里抄第二份表——抄了就会和采购口径分叉。
 */

/** 某个 (exp, priceExp) 下，K = 1 时的效率分布 */
function effsAt(exp: number, priceExp: number): number[] {
  return units
    .map((d) => {
      const core = (dprOf(d) * ehpOf(d)) ** exp;
      return (core * shapeOf(d)) / Math.max(20, d.cost) ** priceExp;
    })
    .sort((x, y) => x - y);
}

const q = (a: number[], p: number): number => a[Math.min(a.length - 1, Math.floor(p * a.length))] as number;

const args = process.argv.slice(2);
const TARGET = 5.5;
/** 采购分里性价比那一段的上限：`min(26, eff × EFF_SCALE)`，EFF_SCALE = 3 */
const CAP_EFF = 26 / 3;

const combos: Array<[number, number, number | undefined]> = args.length
  ? args.map((a) => {
      const [e, p, k] = a.split(':');
      return [Number(e), p ? Number(p) : PRICE_EXP, k ? Number(k) : undefined] as [
        number,
        number,
        number | undefined,
      ];
    })
  : [[LANCHESTER_EXP, PRICE_EXP, undefined]];

console.log(`兵种样本 ${units.length} 个（含全部扩展）· 目标效率中位 ${TARGET} · 封顶线 eff ${CAP_EFF.toFixed(2)}\n`);
console.log('| 压缩指数 | 价格指数 | K | 建议 K | p10 | p50 | p90 | 撞封顶 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [e, p, kFixed] of combos) {
  const effs = effsAt(e, p);
  const k = kFixed ?? TARGET / (q(effs, 0.5) || 1);
  const scaled = effs.map((x) => x * k);
  const capped = scaled.filter((x) => x >= CAP_EFF).length;
  console.log(
    `| ${e} | ${p} | ${k.toFixed(2)} | ${(TARGET / (q(effs, 0.5) || 1)).toFixed(2)} | ${q(scaled, 0.1).toFixed(1)} | ` +
      `${q(scaled, 0.5).toFixed(1)} | ${q(scaled, 0.9).toFixed(1)} | ${((capped / scaled.length) * 100).toFixed(0)}% |`,
  );
}

if (!args.length) {
  const effs = effsAt(LANCHESTER_EXP, PRICE_EXP).map((x) => x * POWER_K);
  console.log(
    `\n当前默认：exp ${LANCHESTER_EXP} · 价 ${PRICE_EXP} · K ${POWER_K}` +
      `｜p50 ${q(effs, 0.5).toFixed(2)} · p90 ${q(effs, 0.9).toFixed(2)} · ` +
      `撞封顶 ${((effs.filter((x) => x >= CAP_EFF).length / effs.length) * 100).toFixed(0)}%`,
  );
}
