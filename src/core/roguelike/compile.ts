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

/** 每一级卡给多少（数值待校准，集中在这里改） */
export const PER_LEVEL = { atk: 1, maxHp: 2 } as const;

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
      atk: def.atk + PER_LEVEL.atk * lv,
      maxHp: def.maxHp + PER_LEVEL.maxHp * lv,
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
