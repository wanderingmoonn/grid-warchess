/**
 * 法器自带的专属光环。
 *
 * 和 `artifacts.ts` 的分工：那里是**所有法器共有**的东西（器灵、温养），
 * 这里是每件法器自己的性格。一件法器一条，数值都写成常量，
 * 规则书和面板直接引用，不手抄数字。
 *
 * 为什么放在 abilities/ 而不是 units.ts 里：光环要挂到 `hooks.aura` 上才生效，
 * 而 UnitTypeDef 只写能力 id。放在这里，兵种数据那边就只剩一行
 * `abilities: [..., SWORD_QI_ID]`，改数值不用翻兵种表。
 */
import type { AbilityDef } from '../../abilities.ts';
import type { AbilityHooks } from '../../ability-hooks.ts';

export const SWORD_QI_ID = 'artifact-sword-qi';
export const SWORD_QI_LABEL = '剑气环';
/** 半径 2：比指挥光环同档，正好覆盖"修士 + 法器"这一小团 */
export const SWORD_QI_RADIUS = 2;
/** +15%：比例而非点数，所以对杂兵和重甲都一样是 15% */
export const SWORD_QI_ATK_PCT = 0.15;

export const SWORD_QI: AbilityDef = {
  id: SWORD_QI_ID,
  name: SWORD_QI_LABEL,
  summary: `半径 ${SWORD_QI_RADIUS} 格内的友军攻击力 +${Math.round(
    SWORD_QI_ATK_PCT * 100,
  )}%（多条同类光环取最强的一条，不叠乘）。`,
  group: 'attack',
  hooks: {
    // 用 allyAtkPct 而不是 allyAtk：这是"按比例统御"，对谁都一样。
    // 加法版的 allyAtk 对杂兵是翻倍、对高攻单位是零头，放法器上会很怪。
    aura: { label: SWORD_QI_LABEL, allyAtkPct: SWORD_QI_ATK_PCT, radius: SWORD_QI_RADIUS },
  } satisfies AbilityHooks,
};
