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
 * 法术按**族**分文件（`bolt` 直伤 / `blast` 范围 / `field` 场域），
 * 一族一个文件、族里的每条法术是文件里的一行数据。所以这里按族导出，
 * 不再按法术名导出——掌心雷和罡风已经并进各自的族，没有单独文件了。
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
  SPRING_SURGE_SKILL,
  SPRING_HEAL_RATIO,
  SPRING_HP_PER_STONE,
  SPRING_MIN_COST,
  SPRING_FLOOR_HEAL,
  SPRING_RADIUS,
  springHealAmount,
  springStoneCost,
  springTargets,
} from './spirit-spring.ts';
export {
  TELEPORT_SKILL,
  TELEPORT_COST,
  TELEPORT_RADIUS,
  TELEPORT_OVERLOAD_LOG,
} from './teleport-swap.ts';
export { learnSkill, CULTIVATOR_SKILL_UNLOCKS } from './unlocks.ts';
export {
  SPIRIT_BREATH_SKILL,
  SPIRIT_BREATH_COST,
  SPIRIT_BREATH_DRAIN,
  SPIRIT_BREATH_QI_PER_EXP,
  SPIRIT_BREATH_MIN_QI,
  SPIRIT_BREATH_EXP_PER_RANK,
  SPIRIT_BREATH_EXP_FLOOR,
  spiritBreathCap,
  spiritBreathExp,
} from './spirit-breath.ts';

/* 族 1 · 直伤：掌心雷（样板）、灭神枪、元磁神光、五雷正法 */
export {
  BOLT_ROWS,
  PALM_THUNDER_SKILL,
  PALM_THUNDER_COST,
  PALM_THUNDER_RANGE,
  PALM_THUNDER_BASE,
  PALM_THUNDER_PER_RANK,
  palmThunderDamage,
  MIE_SHEN_QIANG_SKILL,
  YUAN_CI_SHEN_GUANG_SKILL,
  WU_LEI_ZHENG_FA_SKILL,
  MIE_SHEN_QIANG_COST,
  MIE_SHEN_QIANG_MIN_RANK,
  YUAN_CI_SHEN_GUANG_COST,
  YUAN_CI_SHEN_GUANG_MIN_RANK,
  WU_LEI_ZHENG_FA_COST,
  WU_LEI_ZHENG_FA_MIN_RANK,
  boltDamage,
} from './bolt.ts';

/* 族 2 · 范围伤害：罡风（样板）加 10 条魂法/武术，形状一样、余韵不同 */
export {
  BLAST_ROWS,
  GANG_WIND_SKILL,
  GANG_WIND_COST,
  GANG_WIND_RANGE,
  GANG_WIND_RADIUS,
  GANG_WIND_BASE,
  GANG_WIND_PER_RANK,
  GANG_WIND_MIN_RANK,
  GANG_WIND_RESEARCH_COST,
  gangWindDamage,
  gangWindInRange,
  RU_LAI_SHEN_ZHANG_SKILL,
  HOU_TU_ZHEN_YUE_SKILL,
  BAI_LI_DU_ZHANG_SKILL,
  YI_SHAN_TIAN_HAI_SKILL,
  ZHAI_XING_NA_YUE_SKILL,
  YAN_SKILL,
  YAO_SKILL,
  XIN_SKILL,
  MIAO_SKILL,
  SEN_SKILL,
  RU_LAI_SHEN_ZHANG_COST,
  RU_LAI_SHEN_ZHANG_MIN_RANK,
  HOU_TU_ZHEN_YUE_COST,
  HOU_TU_ZHEN_YUE_MIN_RANK,
  BAI_LI_DU_ZHANG_COST,
  YI_SHAN_TIAN_HAI_COST,
  YI_SHAN_TIAN_HAI_MIN_RANK,
  ZHAI_XING_NA_YUE_COST,
  ZHAI_XING_NA_YUE_MIN_RANK,
  YAN_COST,
  YAO_COST,
  XIN_COST,
  MIAO_COST,
  SEN_COST,
  WU_XING_SPELL_MIN_RANK,
  blastDamage,
} from './blast.ts';

/* 族 3 · 场域：把一片地变成危险区（留痕交给 core/marks.ts 结算） */
export {
  FIELD_ROWS,
  SHI_FANG_HUO_HAI_SKILL,
  WAN_REN_DAO_SHAN_SKILL,
  SHAN_HE_CHI_LING_SKILL,
  CHUN_FENG_HUA_YU_SKILL,
  SHI_FANG_HUO_HAI_COST,
  SHI_FANG_HUO_HAI_MIN_RANK,
  SHI_FANG_HUO_HAI_RADIUS,
  WAN_REN_DAO_SHAN_COST,
  WAN_REN_DAO_SHAN_MIN_RANK,
  WAN_REN_DAO_SHAN_RADIUS,
  SHAN_HE_CHI_LING_COST,
  SHAN_HE_CHI_LING_MIN_RANK,
  SHAN_HE_CHI_LING_RADIUS,
  CHUN_FENG_HUA_YU_COST,
  CHUN_FENG_HUA_YU_MIN_RANK,
  CHUN_FENG_HUA_YU_RADIUS,
  CHUN_FENG_HUA_YU_QI,
  CHUN_FENG_HUA_YU_ROUNDS,
  fieldDamage,
  placeField,
} from './field.ts';

/* 族 6 · 自身增益：把"这一阵子更强"写进状态（数值在 custom，状态只数回合） */
export {
  BUFF_ROWS,
  LING_MU_SHU_SKILL,
  TI_SHU_SKILL,
  TIAN_MO_JIE_TI_SKILL,
  YU_FENG_SHU_SKILL,
  LING_MU_SHU_COST,
  LING_MU_SHU_MIN_RANK,
  LING_MU_SHU_ROUNDS,
  LING_MU_SHU_VISION,
  LING_MU_SHU_RANGE,
  TI_SHU_COST,
  TI_SHU_MIN_RANK,
  TI_SHU_ROUNDS,
  TI_SHU_ATK_MUL,
  TIAN_MO_JIE_TI_COST,
  TIAN_MO_JIE_TI_MIN_RANK,
  TIAN_MO_JIE_TI_ROUNDS,
  TIAN_MO_JIE_TI_HP_PCT,
  YU_FENG_SHU_COST,
  YU_FENG_SHU_MIN_RANK,
  YU_FENG_SHU_ROUNDS,
} from './buff.ts';
