/**
 * 技能总入口。
 *
 * 只做两件事：
 *   1. **import 每个技能文件** —— 注册（registerSkillEffect / registerSkillReadyCheck /
 *      registerSkillPreview / onRankUp）是模块加载时的副作用，不 import 就静默失效；
 *   2. **汇总导出** —— 兵种表（units.ts）和规则书从这里取 SkillDef 与数值常量。
 *
 * 所以「新增一个技能」= 在本目录加一个文件 + 在下面加一行 export，
 * 不用再去别处登记。
 *
 * ⚠️ 红线：本目录的文件都不许 import `../units.ts`。
 * units.ts 要从这里取 SkillDef，反过来 import 就成环；
 * Node 的 ESM 环是运行时才炸（undefined / TDZ），编译期完全看不出来。
 */

export { SKY_STEP_SKILL, SKY_STEP_RANK, SKY_STEP_MOVE_COST } from './sky-step.ts';
export {
  SWORD_SWEEP_SKILL,
  SWEEP_BASE_REACH,
  SWEEP_REACH_STEP,
  SWEEP_EXP_CAST,
  SWEEP_EXP_PER_HIT,
  sweepReachForRank,
} from './sword-sweep.ts';
export {
  BLOOD_RITE_SKILL,
  BLOOD_RITE_RADIUS_BASE,
  BLOOD_RITE_RADIUS_STEP,
  BLOOD_RITE_EXP_PER_DAMAGE,
  BLOOD_RITE_EXP_DECAY,
  BLOOD_RITE_ALLY_EXP_MUL,
  BLOOD_RITE_LIFESPAN_COST,
  bloodRiteRadiusForRank,
  bloodRiteExpMul,
  bloodRiteCells,
} from './blood-rite.ts';
export {
  SPIRIT_REBIRTH_SKILL,
  SPIRIT_REBIRTH_RANK_DROP,
  SPIRIT_REBIRTH_EXP_DIV,
  SPIRIT_REBIRTH_HP_RATIO,
} from './spirit-rebirth.ts';
export { TOWER_CHARGE_SKILL, TOWER_CHARGE_COST, TOWER_BURST_CHARGES } from './spirit-tower-shot.ts';
export {
  TELEPORT_SKILL,
  TELEPORT_COST,
  TELEPORT_RADIUS,
  TELEPORT_OVERLOAD_LOG,
} from './teleport-swap.ts';
export { learnSkill, CULTIVATOR_SKILL_UNLOCKS } from './unlocks.ts';
