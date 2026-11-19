/**
 * 把「兵种卡等级」编译成**这一 run 专用的兵种表**。
 *
 * 关键做法：不去改 `computeDamage` / `attackPowerNow`，而是造一份覆盖项，
 * 通过 `createMatch(config, seed, units)` 的第三参数注进去。规则内核一个字不动，
 * 面板上显示的也是提升后的数值（它读的就是这张表）。
 */

import { UNIT_TYPES } from '../config.ts';
import type { UnitTypeDef } from '../types.ts';
import { cardLevel } from './cards.ts';

/**
 * 每一级卡的加成**按百分比**（2026-11-19 定，替换掉原来的固定 +1/+2）。
 *
 * 为什么必须按比例：固定值对低攻兵（atk 11）等于 +9%，对高攻兵几乎没有感觉，
 * 越到后期越像"没升"。按比例之后每一级对任何兵种都是同样分量的质变，
 * 数值也就不用跟着兵种表一路重调。
 *
 * 取整用 `Math.round`。**2026-11-19 从 12% 提到 25%**：12% 对民兵（atk 11）只有 1 点，
 * 四舍五入之后面板几乎看不出变化，玩家会以为"合成没生效"。
 */
export const PER_LEVEL_PCT = { atk: 0.25, maxHp: 0.25 } as const;

/**
 * @param counts 卡 id → 抽到的张数
 * @param base   基础兵种表（默认原版表；测试里可以塞假表）
 */
export function compileUnits(
  counts: Record<string, number>,
  base: Record<string, UnitTypeDef> = UNIT_TYPES as unknown as Record<string, UnitTypeDef>,
): Record<string, UnitTypeDef> {
  const out: Record<string, UnitTypeDef> = {};
  for (const [id, n] of Object.entries(counts)) {
    const lv = cardLevel(n);
    if (lv <= 0) continue;
    const def = base[id];
    // 卡池里写了不存在的兵种（关卡自定义兵种被删掉）：跳过，不要造出一条空定义
    if (!def) continue;
    out[id] = {
      ...def,
      atk: Math.round(def.atk * (1 + PER_LEVEL_PCT.atk * lv)),
      maxHp: Math.round(def.maxHp * (1 + PER_LEVEL_PCT.maxHp * lv)),
    };
  }
  return out;
}

/** 合并：run 表覆盖原表（原表不能丢——没升级的兵种还要能造） */
export function mergeUnits(
  base: Record<string, UnitTypeDef> | undefined,
  overrides: Record<string, UnitTypeDef>,
): Record<string, UnitTypeDef> {
  return { ...(base ?? {}), ...overrides };
}
