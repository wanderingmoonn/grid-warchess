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

export const STONE_WARD_ID = 'artifact-stone-ward';
export const STONE_WARD_LABEL = '磐石';
export const STONE_WARD_RADIUS = 2;
/** +10%：对 3 甲的单位本应取整成 0，规则层给了 +1 保底，所以前期也有感 */
export const STONE_WARD_ARMOR_PCT = 0.1;

export const FIRE_QI_ID = 'artifact-fire-qi';
export const FIRE_QI_LABEL = '真火';
export const FIRE_QI_RADIUS = 2;
export const FIRE_QI_TRUE_PCT = 0.1;

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

export const STONE_WARD: AbilityDef = {
  id: STONE_WARD_ID,
  name: STONE_WARD_LABEL,
  summary: `半径 ${STONE_WARD_RADIUS} 格内的友军护甲 +${Math.round(
    STONE_WARD_ARMOR_PCT * 100,
  )}%（不足 1 点按 1 点算；多条同类光环取最强的一条）。`,
  group: 'defense',
  hooks: {
    // 用百分比而不是 allyArmor：那条是加法，对杂兵翻倍、对重甲是零头，
    // 而护甲本来就是个"越高越值钱"的数——按比例给才在不同阶段同一个权重。
    aura: { label: STONE_WARD_LABEL, allyArmorPct: STONE_WARD_ARMOR_PCT, radius: STONE_WARD_RADIUS },
  } satisfies AbilityHooks,
};

export const FIRE_QI: AbilityDef = {
  id: FIRE_QI_ID,
  name: FIRE_QI_LABEL,
  summary: `半径 ${FIRE_QI_RADIUS} 格内的友军真元 +${Math.round(
    FIRE_QI_TRUE_PCT * 100,
  )}%（不足 1 点按 1 点算；真元只有修士有，所以受益的也是修士）。`,
  group: 'attack',
  hooks: {
    aura: { label: FIRE_QI_LABEL, allyTrueDamagePct: FIRE_QI_TRUE_PCT, radius: FIRE_QI_RADIUS },
  } satisfies AbilityHooks,
};
