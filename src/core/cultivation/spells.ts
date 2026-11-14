/**
 * 法术：能学、能带、要花灵力放的那一类技能。
 *
 * ── 与"技能"的分界（2026-11-08 敲定）────────────────────────
 *
 * 一个修士身上可能同时有三种东西，长得一模一样（都是 `SkillDef`、都在技能栏里）：
 *
 *   1. **流派技能**：写在兵种表上（剑气纵横、血祭）。天生会，不占法术位。
 *   2. **境界技能**：升级自动领悟（御空）。不占法术位，也不该允许被遗忘。
 *   3. **法术**：只能去藏经阁学，占法术位，放一次扣灵力。就是本文件管的这批。
 *
 * 判据是**这张注册表**，不是 `SkillDef` 上的标记：法术是扩展的概念，核心的
 * `SkillDef` 里多一个 `spell` 字段等于让所有人都得知道修真包存在。查表还有个
 * 附带好处——老存档里存的是当年那份 `SkillDef` 快照，只要 id 还在表里，
 * "它是不是法术"就永远算得对。
 *
 * ── 能带几个 ────────────────────────────────────────────
 *
 * `⌊境界 ÷ 2⌋ + 2 × 生效中的藏经阁`。0～1 期是 0 个（连门槛都还没到），
 * 所以"新招的弟子一个法术都学不了"是设计，不是 bug。
 *
 * 藏经阁必须**贴着自家宗门**才算生效：宗门被拆了，书还在、人还在，
 * 但那座藏书楼已经没人管了——这是"宗门是根"的另一种表达。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（见 skills/sky-step.ts 顶部）。
 * 需要宗门/藏经阁的 id 时从 `identity.ts` 取。
 */
import type { GameState, PlayerId, Unit } from '../types.ts';
import type { SkillDef } from '../types.ts';
import { distBetweenUnits } from '../query.ts';
import { resOf } from '../resources.ts';
import { SPIRIT_STONE } from './resources.ts';
import { UNIT_IDS } from './identity.ts';
import { getRank } from './progression.ts';
import {
  PALM_THUNDER_COST,
  PALM_THUNDER_SKILL,
  MIE_SHEN_QIANG_COST,
  MIE_SHEN_QIANG_MIN_RANK,
  MIE_SHEN_QIANG_SKILL,
  WU_LEI_ZHENG_FA_COST,
  WU_LEI_ZHENG_FA_MIN_RANK,
  WU_LEI_ZHENG_FA_SKILL,
  YUAN_CI_SHEN_GUANG_COST,
  YUAN_CI_SHEN_GUANG_MIN_RANK,
  YUAN_CI_SHEN_GUANG_SKILL,
} from './skills/bolt.ts';
import {
  BAI_LI_DU_ZHANG_COST,
  BAI_LI_DU_ZHANG_SKILL,
  HOU_TU_ZHEN_YUE_COST,
  HOU_TU_ZHEN_YUE_MIN_RANK,
  HOU_TU_ZHEN_YUE_SKILL,
  MIAO_COST,
  MIAO_SKILL,
  RU_LAI_SHEN_ZHANG_COST,
  RU_LAI_SHEN_ZHANG_MIN_RANK,
  RU_LAI_SHEN_ZHANG_SKILL,
  SEN_COST,
  SEN_SKILL,
  WU_XING_SPELL_MIN_RANK,
  XIN_COST,
  XIN_SKILL,
  YAN_COST,
  YAN_SKILL,
  YAO_COST,
  YAO_SKILL,
  YI_SHAN_TIAN_HAI_COST,
  YI_SHAN_TIAN_HAI_MIN_RANK,
  YI_SHAN_TIAN_HAI_SKILL,
  ZHAI_XING_NA_YUE_COST,
  ZHAI_XING_NA_YUE_MIN_RANK,
  ZHAI_XING_NA_YUE_SKILL,
  GANG_WIND_COST,
  GANG_WIND_MIN_RANK,
  GANG_WIND_RESEARCH_COST,
  GANG_WIND_SKILL,
} from './skills/blast.ts';
import {
  SHI_FANG_HUO_HAI_COST,
  SHI_FANG_HUO_HAI_MIN_RANK,
  SHI_FANG_HUO_HAI_SKILL,
  WAN_REN_DAO_SHAN_COST,
  WAN_REN_DAO_SHAN_MIN_RANK,
  WAN_REN_DAO_SHAN_SKILL,
  SHAN_HE_CHI_LING_COST,
  SHAN_HE_CHI_LING_MIN_RANK,
  SHAN_HE_CHI_LING_SKILL,
  CHUN_FENG_HUA_YU_COST,
  CHUN_FENG_HUA_YU_MIN_RANK,
  CHUN_FENG_HUA_YU_SKILL,
} from './skills/field.ts';
import {
  LING_MU_SHU_COST,
  LING_MU_SHU_MIN_RANK,
  LING_MU_SHU_SKILL,
  TI_SHU_COST,
  TI_SHU_MIN_RANK,
  TI_SHU_SKILL,
  TIAN_MO_JIE_TI_COST,
  TIAN_MO_JIE_TI_MIN_RANK,
  TIAN_MO_JIE_TI_SKILL,
  YU_FENG_SHU_COST,
  YU_FENG_SHU_MIN_RANK,
  YU_FENG_SHU_SKILL,
} from './skills/buff.ts';
import { WUXING_SPELLS } from './skills/wuxing.ts';
import {
  LIAN_HUA_COST,
  LIAN_HUA_MIN_RANK,
  LIAN_HUA_SKILL,
  SU_YIN_GUO_COST,
  SU_YIN_GUO_MIN_RANK,
  SU_YIN_GUO_SKILL,
  TIAN_YU_BU_QU_COST,
  TIAN_YU_BU_QU_MIN_RANK,
  TIAN_YU_BU_QU_SKILL,
} from './skills/strike-bonus.ts';
import {
  LIAN_LING_COST,
  LIAN_LING_MIN_RANK,
  LIAN_LING_SKILL,
  XING_WAN_LI_COST,
  XING_WAN_LI_MIN_RANK,
  XING_WAN_LI_SKILL,
} from './skills/economy.ts';
import {
  FU_ZHI_DAO_COST,
  FU_ZHI_DAO_MIN_RANK,
  FU_ZHI_DAO_SKILL,
  JU_HUN_SUO_MING_COST,
  JU_HUN_SUO_MING_MIN_RANK,
  JU_HUN_SUO_MING_SKILL,
  QIAN_YIN_SHU_COST,
  QIAN_YIN_SHU_MIN_RANK,
  QIAN_YIN_SHU_SKILL,
} from './skills/pull.ts';
import {
  HU_TI_LING_GUANG_COST,
  HU_TI_LING_GUANG_MIN_RANK,
  HU_TI_LING_GUANG_SKILL,
} from './skills/shield.ts';
import {
  TI_SI_ZHUAN_SHENG_COST,
  TI_SI_ZHUAN_SHENG_MIN_RANK,
  TI_SI_ZHUAN_SHENG_SKILL,
  WANG_CHUAN_NI_LIU_COST,
  WANG_CHUAN_NI_LIU_MIN_RANK,
  WANG_CHUAN_NI_LIU_SKILL,
  ZHU_JIAO_GUANG_HUAN_COST,
  ZHU_JIAO_GUANG_HUAN_MIN_RANK,
  ZHU_JIAO_GUANG_HUAN_SKILL,
} from './skills/revive.ts';
import {
  SA_DOU_CHENG_BING_COST,
  SA_DOU_CHENG_BING_MIN_RANK,
  SA_DOU_CHENG_BING_SKILL,
} from './skills/summon.ts';
import {
  DAO_HUA_MO_RAN_COST,
  DAO_HUA_MO_RAN_MIN_RANK,
  DAO_HUA_MO_RAN_SKILL,
  FENG_DU_GUI_YU_COST,
  FENG_DU_GUI_YU_MIN_RANK,
  FENG_DU_GUI_YU_SKILL,
  TAI_ZHONG_ZHI_MI_COST,
  TAI_ZHONG_ZHI_MI_MIN_RANK,
  TAI_ZHONG_ZHI_MI_SKILL,
  XIN_MO_ZHONG_DAO_COST,
  XIN_MO_ZHONG_DAO_MIN_RANK,
  XIN_MO_ZHONG_DAO_SKILL,
  XUE_MAI_QIN_SHI_COST,
  XUE_MAI_QIN_SHI_MIN_RANK,
  XUE_MAI_QIN_SHI_SKILL,
} from './skills/convert.ts';
import {
  DAO_SAN_QIAN_COST,
  DAO_SAN_QIAN_MIN_RANK,
  DAO_SAN_QIAN_SKILL,
  PO_SUI_XU_KONG_COST,
  PO_SUI_XU_KONG_MIN_RANK,
  PO_SUI_XU_KONG_SKILL,
  QIONG_JI_COST,
  QIONG_JI_MIN_RANK,
  QIONG_JI_SKILL,
  WAN_ZU_ZHI_JIE_COST,
  WAN_ZU_ZHI_JIE_MIN_RANK,
  WAN_ZU_ZHI_JIE_SKILL,
  YI_YUAN_FU_SHI_COST,
  YI_YUAN_FU_SHI_MIN_RANK,
  YI_YUAN_FU_SHI_SKILL,
  ZHU_XIE_BI_YI_COST,
  ZHU_XIE_BI_YI_MIN_RANK,
  ZHU_XIE_BI_YI_SKILL,
  TIAN_XIA_JIE_BAI_COST,
  TIAN_XIA_JIE_BAI_MIN_RANK,
  TIAN_XIA_JIE_BAI_SKILL,
  PING_DENG_TU_TENG_COST,
  PING_DENG_TU_TENG_MIN_RANK,
  PING_DENG_TU_TENG_SKILL,
  JUE_DI_TIAN_TONG_COST,
  JUE_DI_TIAN_TONG_MIN_RANK,
  JUE_DI_TIAN_TONG_SKILL,
  FA_XIANG_TIAN_DI_COST,
  FA_XIANG_TIAN_DI_MIN_RANK,
  FA_XIANG_TIAN_DI_SKILL,
} from './skills/rewrite.ts';
import {
  DING_TOU_QI_JIAN_COST,
  DING_TOU_QI_JIAN_MIN_RANK,
  DING_TOU_QI_JIAN_SKILL,
  HU_MING_LUO_MA_COST,
  HU_MING_LUO_MA_MIN_RANK,
  HU_MING_LUO_MA_SKILL,
  ZHAN_XIAN_FEI_DAO_COST,
  ZHAN_XIAN_FEI_DAO_MIN_RANK,
  ZHAN_XIAN_FEI_DAO_SKILL,
} from './skills/record.ts';
import {
  ZHANG_GUAN_LI_DAI_COST,
  ZHANG_GUAN_LI_DAI_MIN_RANK,
  ZHANG_GUAN_LI_DAI_SKILL,
} from './skills/transfer.ts';
import {
  HUA_SHEN_FEN_SHEN_COST,
  HUA_SHEN_FEN_SHEN_MIN_RANK,
  HUA_SHEN_FEN_SHEN_SKILL,
  HUN_DENG_COST,
  HUN_DENG_MIN_RANK,
  HUN_DENG_SKILL,
  TI_JIE_LING_SHEN_COST,
  TI_JIE_LING_SHEN_MIN_RANK,
  TI_JIE_LING_SHEN_SKILL,
  ZHONG_MIAO_ZHI_MEN_COST,
  ZHONG_MIAO_ZHI_MEN_MIN_RANK,
  ZHONG_MIAO_ZHI_MEN_SKILL,
} from './skills/summon.ts';
import { SPIRIT_BREATH_COST, SPIRIT_BREATH_SKILL } from './skills/spirit-breath.ts';

/** 一条法术的元数据。`skill` 是它作为技能那一面的全部数据 */
export interface SpellDef {
  skill: SkillDef;
  /** 施放一次要多少灵力 */
  cost: number;
  /**
   * 研发这条法术要多少灵石。不写就用 `RESEARCH_STONE_COST`。
   *
   * 研发**只收灵石**：这个包已经证明"灵石去处太少"，而法术是最适合拿灵石换的
   * 东西——它不进军队编制、不能囤、也不能折回金币。想让某个法术更贵，
   * 就在这里单独写一个数（越强的法术越该贵）。
   */
  researchCost?: number;
  /**
   * 限定流派（兵种 id 列表）。不写 = 所有修士都能学。
   *
   * 这是"让几个流派长得不一样"的最后一道闸：越强的法术越该限定流派，
   * 而通用法术（比如掌心雷）谁都能学，才不会出现"四条流派只有一套法术"。
   */
  schools?: readonly string[];
  /**
   * 学它要求的最低境界（不写 = 0）。
   *
   * 和「法术位」是两件事，别混：
   *   · 法术位 = `⌊境界 ÷ 2⌋`，管的是"**背得下几门**"；
   *   · 这一个管的是"**够不够格学**"。
   *
   * 为什么需要它：法术位在 2 期就有 1 个，而 2 期的兵只有 55 点血——
   * 一门按"境界 ×9"定标的 AOE 落在那个局面里就是降维打击。
   * 有了这道闸，强法术可以放心地按高境界定标，不用为了低境界的安全把数值压平。
   */
  minRank?: number;
}

/**
 * 法术池。
 *
 * 加一条法术 = 写一个技能文件 + 在这里登记一行，别处一个字都不用改。
 *
 * 现在的三条是三种不同的"补强姿势"，正好可以当模板：
 *   · 掌心雷——**补刀**：便宜、无视护甲、只打一个；
 *   · 吐纳术——**成长**：不动战斗数值，把环境灵气换成修为；
 *   · 罡风——**面积**：远、大、无视护甲，专门回答"被三台机甲围住怎么办"。
 */
export const SPELLS: readonly SpellDef[] = [
  { skill: PALM_THUNDER_SKILL, cost: PALM_THUNDER_COST },
  { skill: SPIRIT_BREATH_SKILL, cost: SPIRIT_BREATH_COST },
  {
    skill: GANG_WIND_SKILL,
    cost: GANG_WIND_COST,
    researchCost: GANG_WIND_RESEARCH_COST,
    minRank: GANG_WIND_MIN_RANK,
  },
  // ── 族 1 · 直伤（2026-11-14）──────────────────────────
  //
  // 这三门和掌心雷共用 `skills/bolt.ts` 的实现，各自只贡献一行数据。
  // `minRank` 是"够不够格学"，和法术位（背得下几门）是两件事，见 SpellDef 上方。
  { skill: MIE_SHEN_QIANG_SKILL, cost: MIE_SHEN_QIANG_COST, minRank: MIE_SHEN_QIANG_MIN_RANK },
  {
    skill: YUAN_CI_SHEN_GUANG_SKILL,
    cost: YUAN_CI_SHEN_GUANG_COST,
    minRank: YUAN_CI_SHEN_GUANG_MIN_RANK,
  },
  {
    skill: WU_LEI_ZHENG_FA_SKILL,
    cost: WU_LEI_ZHENG_FA_COST,
    minRank: WU_LEI_ZHENG_FA_MIN_RANK,
  },
  // ── 族 2 · 范围伤害（2026-11-14）──────────────────────
  //
  // 10 条法术一套实现（`skills/blast.ts`）。五行五法（焱垚鑫淼森）都标了
  // `custom.element`，族 5（五行免耗）以后要读它——这是"五行属性存哪"的答案：
  // 存在技能自己的 `custom` 里，不往 `Unit` 上开字段。
  {
    skill: RU_LAI_SHEN_ZHANG_SKILL,
    cost: RU_LAI_SHEN_ZHANG_COST,
    minRank: RU_LAI_SHEN_ZHANG_MIN_RANK,
  },
  {
    skill: HOU_TU_ZHEN_YUE_SKILL,
    cost: HOU_TU_ZHEN_YUE_COST,
    minRank: HOU_TU_ZHEN_YUE_MIN_RANK,
  },
  { skill: BAI_LI_DU_ZHANG_SKILL, cost: BAI_LI_DU_ZHANG_COST },
  {
    skill: YI_SHAN_TIAN_HAI_SKILL,
    cost: YI_SHAN_TIAN_HAI_COST,
    minRank: YI_SHAN_TIAN_HAI_MIN_RANK,
  },
  {
    skill: ZHAI_XING_NA_YUE_SKILL,
    cost: ZHAI_XING_NA_YUE_COST,
    minRank: ZHAI_XING_NA_YUE_MIN_RANK,
  },
  { skill: YAN_SKILL, cost: YAN_COST, minRank: WU_XING_SPELL_MIN_RANK },
  { skill: YAO_SKILL, cost: YAO_COST, minRank: WU_XING_SPELL_MIN_RANK },
  { skill: XIN_SKILL, cost: XIN_COST, minRank: WU_XING_SPELL_MIN_RANK },
  { skill: MIAO_SKILL, cost: MIAO_COST, minRank: WU_XING_SPELL_MIN_RANK },
  { skill: SEN_SKILL, cost: SEN_COST, minRank: WU_XING_SPELL_MIN_RANK },
  // ── 族 3 · 场域（2026-11-14）──────────────────────────
  //
  // 这两门自己不结算伤害：只把留痕放到格子上，之后由 core/marks.ts 在
  // "有人走进来"和"每轮开始"时触发（见 spell-marks.ts）。
  { skill: SHI_FANG_HUO_HAI_SKILL, cost: SHI_FANG_HUO_HAI_COST, minRank: SHI_FANG_HUO_HAI_MIN_RANK },
  { skill: WAN_REN_DAO_SHAN_SKILL, cost: WAN_REN_DAO_SHAN_COST, minRank: WAN_REN_DAO_SHAN_MIN_RANK },
  { skill: SHAN_HE_CHI_LING_SKILL, cost: SHAN_HE_CHI_LING_COST, minRank: SHAN_HE_CHI_LING_MIN_RANK },
  { skill: CHUN_FENG_HUA_YU_SKILL, cost: CHUN_FENG_HUA_YU_COST, minRank: CHUN_FENG_HUA_YU_MIN_RANK },
  // ── 族 6 · 自身增益（2026-11-14）──────────────────────
  //
  // 四条都不需要选点（`targeting: 'none'`）：加在自己身上。
  // 数值挂在 `Unit.custom.spellBuff`，状态 `spell-buff` 只数回合——
  // 因为 `StatusDef.modifyAtk` 引擎还没接上，写进状态里会"面板有、伤害没有"。
  { skill: LING_MU_SHU_SKILL, cost: LING_MU_SHU_COST, minRank: LING_MU_SHU_MIN_RANK },
  { skill: TI_SHU_SKILL, cost: TI_SHU_COST, minRank: TI_SHU_MIN_RANK },
  { skill: TIAN_MO_JIE_TI_SKILL, cost: TIAN_MO_JIE_TI_COST, minRank: TIAN_MO_JIE_TI_MIN_RANK },
  { skill: YU_FENG_SHU_SKILL, cost: YU_FENG_SHU_COST, minRank: YU_FENG_SHU_MIN_RANK },
  // ── 族 5 · 五行免耗（2026-11-14）──────────────────────
  //
  // 七条只差两个参数（免几次 / 按什么关系），所以是**一张表摊出来的**，
  // 不用逐条手写（见 wuxing.ts 的 ROWS_DEF）。
  ...WUXING_SPELLS,
  // ── 族 7 · 攻击附加（2026-11-14）──────────────────────
  { skill: TIAN_YU_BU_QU_SKILL, cost: TIAN_YU_BU_QU_COST, minRank: TIAN_YU_BU_QU_MIN_RANK },
  { skill: LIAN_HUA_SKILL, cost: LIAN_HUA_COST, minRank: LIAN_HUA_MIN_RANK },
  { skill: SU_YIN_GUO_SKILL, cost: SU_YIN_GUO_COST, minRank: SU_YIN_GUO_MIN_RANK },
  // ── 族 9 · 资源经济（2026-11-14）──────────────────────
  { skill: LIAN_LING_SKILL, cost: LIAN_LING_COST, minRank: LIAN_LING_MIN_RANK },
  { skill: XING_WAN_LI_SKILL, cost: XING_WAN_LI_COST, minRank: XING_WAN_LI_MIN_RANK },
  // ── 族 4 · 拉拽（2026-11-14）──────────────────────
  { skill: QIAN_YIN_SHU_SKILL, cost: QIAN_YIN_SHU_COST, minRank: QIAN_YIN_SHU_MIN_RANK },
  { skill: FU_ZHI_DAO_SKILL, cost: FU_ZHI_DAO_COST, minRank: FU_ZHI_DAO_MIN_RANK },
  { skill: JU_HUN_SUO_MING_SKILL, cost: JU_HUN_SUO_MING_COST, minRank: JU_HUN_SUO_MING_MIN_RANK },
  // ── 护盾（2026-11-14）──────────────────────────────
  //
  // 作者澄清：护体灵光是**盾**，不是召唤物——有它自己的护甲和血量，盾碎那一击
  // 的溢出也被吃掉。所以它不在族 8（召唤）里，走的是核心的 `absorbDamage` 钩子。
  { skill: HU_TI_LING_GUANG_SKILL, cost: HU_TI_LING_GUANG_COST, minRank: HU_TI_LING_GUANG_MIN_RANK },
  // ── 族 11 · 死亡触发（2026-11-14）────────────────────
  //
  // 主角光环 / 替死转生是**免死**：放回去的是同一个对象，境界经验寿元全在。
  // 忘川逆流是**招魂**：从 `s.fallen` 造新形体，修为不随形体回来。
  { skill: ZHU_JIAO_GUANG_HUAN_SKILL, cost: ZHU_JIAO_GUANG_HUAN_COST, minRank: ZHU_JIAO_GUANG_HUAN_MIN_RANK },
  { skill: TI_SI_ZHUAN_SHENG_SKILL, cost: TI_SI_ZHUAN_SHENG_COST, minRank: TI_SI_ZHUAN_SHENG_MIN_RANK },
  { skill: WANG_CHUAN_NI_LIU_SKILL, cost: WANG_CHUAN_NI_LIU_COST, minRank: WANG_CHUAN_NI_LIU_MIN_RANK },
  // ── 族 8 · 召唤（2026-11-14，先一条）──────────────────
  { skill: SA_DOU_CHENG_BING_SKILL, cost: SA_DOU_CHENG_BING_COST, minRank: SA_DOU_CHENG_BING_MIN_RANK },
  // 另外四条是**绑定**：替劫（代受伤害）、化身（可行动+经验回流）、
  // 众妙之门（光环建筑）、魂灯（死亡锚点）。共用"造出来"，剩下的各写各的。
  { skill: TI_JIE_LING_SHEN_SKILL, cost: TI_JIE_LING_SHEN_COST, minRank: TI_JIE_LING_SHEN_MIN_RANK },
  { skill: HUA_SHEN_FEN_SHEN_SKILL, cost: HUA_SHEN_FEN_SHEN_COST, minRank: HUA_SHEN_FEN_SHEN_MIN_RANK },
  { skill: ZHONG_MIAO_ZHI_MEN_SKILL, cost: ZHONG_MIAO_ZHI_MEN_COST, minRank: ZHONG_MIAO_ZHI_MEN_MIN_RANK },
  { skill: HUN_DENG_SKILL, cost: HUN_DENG_COST, minRank: HUN_DENG_MIN_RANK },
  // ── 族 10 · 转化 / 策反（2026-11-14）────────────────────
  //
  // 五条只差"什么时候变"：倒计时 / 受伤 / 侵蚀致死 / 死在我的地上 / 染满两层。
  // 换主一律走 `api.convert`（规则层唯一出口），境界技能丹药全保留。
  { skill: TAI_ZHONG_ZHI_MI_SKILL, cost: TAI_ZHONG_ZHI_MI_COST, minRank: TAI_ZHONG_ZHI_MI_MIN_RANK },
  { skill: XIN_MO_ZHONG_DAO_SKILL, cost: XIN_MO_ZHONG_DAO_COST, minRank: XIN_MO_ZHONG_DAO_MIN_RANK },
  { skill: XUE_MAI_QIN_SHI_SKILL, cost: XUE_MAI_QIN_SHI_COST, minRank: XUE_MAI_QIN_SHI_MIN_RANK },
  { skill: FENG_DU_GUI_YU_SKILL, cost: FENG_DU_GUI_YU_COST, minRank: FENG_DU_GUI_YU_MIN_RANK },
  { skill: DAO_HUA_MO_RAN_SKILL, cost: DAO_HUA_MO_RAN_COST, minRank: DAO_HUA_MO_RAN_MIN_RANK },
  // ── 簇 C · 规则豁免与全局改写（2026-11-14）──────────────
  //
  // 这几条改的是规则而不是数值：学法术的门槛、身上挂着的东西、攻击次数、
  // 攻击力怎么算、射程管不管用。四条"要动地基"的（平等图腾/天下皆白/
  // 绝地天通/法相天地）还没做，原因写在 rewrite.ts 的文件头。
  { skill: DAO_SAN_QIAN_SKILL, cost: DAO_SAN_QIAN_COST, minRank: DAO_SAN_QIAN_MIN_RANK },
  { skill: YI_YUAN_FU_SHI_SKILL, cost: YI_YUAN_FU_SHI_COST, minRank: YI_YUAN_FU_SHI_MIN_RANK },
  { skill: ZHU_XIE_BI_YI_SKILL, cost: ZHU_XIE_BI_YI_COST, minRank: ZHU_XIE_BI_YI_MIN_RANK },
  { skill: WAN_ZU_ZHI_JIE_SKILL, cost: WAN_ZU_ZHI_JIE_COST, minRank: WAN_ZU_ZHI_JIE_MIN_RANK },
  { skill: PO_SUI_XU_KONG_SKILL, cost: PO_SUI_XU_KONG_COST, minRank: PO_SUI_XU_KONG_MIN_RANK },
  { skill: QIONG_JI_SKILL, cost: QIONG_JI_COST, minRank: QIONG_JI_MIN_RANK },
  // 三条"全局改写"（2026-11-14，口径由作者当场定）
  { skill: TIAN_XIA_JIE_BAI_SKILL, cost: TIAN_XIA_JIE_BAI_COST, minRank: TIAN_XIA_JIE_BAI_MIN_RANK },
  { skill: PING_DENG_TU_TENG_SKILL, cost: PING_DENG_TU_TENG_COST, minRank: PING_DENG_TU_TENG_MIN_RANK },
  { skill: JUE_DI_TIAN_TONG_SKILL, cost: JUE_DI_TIAN_TONG_COST, minRank: JUE_DI_TIAN_TONG_MIN_RANK },
  { skill: FA_XIANG_TIAN_DI_SKILL, cost: FA_XIANG_TIAN_DI_COST, minRank: FA_XIANG_TIAN_DI_MIN_RANK },
  // ── 簇 B · 记录与延迟处决 + 呼名落马术（2026-11-14）──────
  //
  // 这三条里两条要玩家先填值（G5）：`SkillDef.input` 决定面板多一行输入框，
  // 规则层在空值时直接拒（理由在 doHeroSkill 里统一给）。
  { skill: ZHAN_XIAN_FEI_DAO_SKILL, cost: ZHAN_XIAN_FEI_DAO_COST, minRank: ZHAN_XIAN_FEI_DAO_MIN_RANK },
  { skill: DING_TOU_QI_JIAN_SKILL, cost: DING_TOU_QI_JIAN_COST, minRank: DING_TOU_QI_JIAN_MIN_RANK },
  { skill: HU_MING_LUO_MA_SKILL, cost: HU_MING_LUO_MA_COST, minRank: HU_MING_LUO_MA_MIN_RANK },
  // 簇 D · 效果转移（2026-11-14）：改的是两个"目标入口"，不是一张影响清单
  { skill: ZHANG_GUAN_LI_DAI_SKILL, cost: ZHANG_GUAN_LI_DAI_COST, minRank: ZHANG_GUAN_LI_DAI_MIN_RANK },
];

/** 每座生效中的藏经阁给本阵营加几个**可研发**的法术位 */
export const LIBRARY_SPELL_SLOTS = 2;

/**
 * 阵营的研发基数。
 *
 * 0 意味着"没有藏经阁就一条法术都研发不了"——这是有意的：宗门大殿会摆坛作法，
 * 但**书**在藏经阁里。想开一门新法术，先把藏书楼盖起来。
 */
export const RESEARCH_BASE_SLOTS = 0;

/** 研发一条法术默认要多少灵石（`SpellDef.researchCost` 缺省时用它） */
export const RESEARCH_STONE_COST = 60;

/** 按 id 查法术。找不到 = 这不是法术（流派技能、境界技能都走这里返回 undefined） */
export function spellOf(skillId: string): SpellDef | undefined {
  return SPELLS.find((sp) => sp.skill.id === skillId);
}

/** 这个修士学过的法术（`extraSkills` 里属于法术池的那些） */
export function knownSpells(u: Unit): SkillDef[] {
  return (u.extraSkills ?? []).filter((sk) => !!spellOf(sk.id));
}

/**
 * 这座"配楼"（藏经阁 / 静心阁）现在算不算生效：必须贴着**自家**宗门。
 *
 * 为什么不是"建的时候有就行"：宗门被推掉之后那两座楼就该一起废掉，
 * 否则玩家会看到"我宗门没了，法术额度还在"，然后怀疑是不是显示错了。
 *
 * 藏经阁和静心阁共用这一条：它们都是"宗门的下属机构"，
 * 判定如果各写一遍，迟早出现"藏书楼算、静心阁不算"这种对不上的事。
 */
export function pavilionIsActive(s: GameState, b: Unit): boolean {
  if (b.hp <= 0) return false;
  return s.units.some(
    (u) =>
      u.type === UNIT_IDS.SECT &&
      u.owner === b.owner &&
      u.hp > 0 &&
      distBetweenUnits(s, u, b) <= 1,
  );
}

/** 旧名：藏经阁版本的判据（规则书和测试都还这么叫）。等价于 `pavilionIsActive`。 */
export function libraryIsActive(s: GameState, lib: Unit): boolean {
  return pavilionIsActive(s, lib);
}

/** 某一方生效中的某类配楼 */
export function activePavilionsOf(s: GameState, owner: PlayerId, type: string): Unit[] {
  return s.units.filter((u) => u.type === type && u.owner === owner && pavilionIsActive(s, u));
}

/** 这一方还有几座生效中的藏经阁（= 研发额度的来源） */
export function activeLibrariesOf(s: GameState, owner: PlayerId): Unit[] {
  return activePavilionsOf(s, owner, UNIT_IDS.SCRIPTURE_PAVILION);
}

/** 这个修士脚下挨着的、生效中的藏经阁（学法术就在它旁边） */
export function libraryNextTo(s: GameState, u: Unit): Unit | null {
  for (const lib of activeLibrariesOf(s, u.owner)) {
    if (distBetweenUnits(s, lib, u) <= 1) return lib;
  }
  return null;
}

/** 这个修士脚下挨着的、生效中的静心阁（忘法术就在它旁边） */
export function silentPavilionNextTo(s: GameState, u: Unit): Unit | null {
  for (const pav of activePavilionsOf(s, u.owner, UNIT_IDS.SILENT_PAVILION)) {
    if (distBetweenUnits(s, pav, u) <= 1) return pav;
  }
  return null;
}

/**
 * 这个修士自己身上能带几个法术：`⌊境界 ÷ 2⌋`。
 *
 * 注意这里**不**含藏经阁：藏经阁加的是"这个阵营能研发多少门法术"
 * （见 `researchCapOf`），不是"某个修士能背几门"。
 *
 * 这两件事以前被我混成一条，两个上限变成一个，于是"多盖几座藏书楼"
 * 能直接让一个筑基修士背下全部法术。它们的语义完全不同：
 *   · 研发上限 = 这一方**知道**多少门法术（藏书目录有多长）；
 *   · 法术位   = 一个修士**记得住**多少门（境界越高，能背的越多）。
 */
export function spellSlotsOf(u: Unit): number {
  return Math.floor(getRank(u) / 2);
}

/**
 * 这一方**已研发**的法术（阵营级）。
 *
 * 存在 `state.researched[玩家]` 里：研发是阵营能力，本方所有藏经阁通用，
 * 换一座宗门不该从零开始。
 */
export function researchedOf(s: GameState, owner: PlayerId): string[] {
  return (s.researched ?? {})[owner] ?? [];
}

export function isResearched(s: GameState, owner: PlayerId, spellId: string): boolean {
  return researchedOf(s, owner).includes(spellId);
}

/**
 * 这一方能研发几门法术：`0 + 2 × 生效中的藏经阁`。
 *
 * 藏经阁必须贴着自家宗门才算生效（见 `libraryIsActive`），
 * 所以"宗门被拆 → 藏书楼失效 → 研发额度下降"是一条链，不是三条规则。
 */
export function researchCapOf(s: GameState, owner: PlayerId): number {
  return RESEARCH_BASE_SLOTS + LIBRARY_SPELL_SLOTS * activeLibrariesOf(s, owner).length;
}

/** 研发这一门要多少灵石 */
export function researchCostOf(spell: SpellDef): number {
  return spell.researchCost ?? RESEARCH_STONE_COST;
}

/**
 * 能不能研发这一门。返回字符串 = 不能，字符串是给玩家看的理由。
 *
 * 面板（按钮灰不灰）和规则层（放不放行）共用这一份，理由和 `spellLearnProblem`
 * 是同一个道理：两处各写一遍必然出现"能点、点下去被拒"。
 */
export function researchProblem(s: GameState, owner: PlayerId, spell: SpellDef): string | null {
  if (isResearched(s, owner, spell.skill.id)) return `已经研发过「${spell.skill.name}」`;
  const cap = researchCapOf(s, owner);
  const used = researchedOf(s, owner).length;
  if (used >= cap) {
    return cap <= 0
      ? '没有藏经阁：一门法术都研发不了（先盖一座贴着宗门的藏经阁）'
      : `研发额度满了（${used} / ${cap}）：多盖一座藏经阁，或者遗弃一门旧法术`;
  }
  const cost = researchCostOf(spell);
  const stones = resOf(s.players[owner], SPIRIT_STONE);
  if (stones < cost) {
    return `灵石不足（要 ${cost}，现在 ${stones}）`;
  }
  return null;
}

/** 这一门能不能遗弃：只有研发过的才谈得上遗弃 */
export function abandonProblem(s: GameState, owner: PlayerId, spell: SpellDef): string | null {
  if (!isResearched(s, owner, spell.skill.id)) return `还没研发过「${spell.skill.name}」`;
  return null;
}

/**
 * 能不能学这一条法术。返回字符串 = 不能，字符串是给玩家看的理由。
 *
 * 三道闸，顺序也是玩家理解的顺序：
 *   1. 本方**研发过**它（没研发的东西藏经阁里没有）；
 *   2. 流派限制（有些法术只有某一支学得会）；
 *   3. 自己的法术位（`⌊境界 ÷ 2⌋`）还空着。
 *
 * 另外还有一条前置：得站在**生效中**的藏经阁旁边，否则连书都摸不到。
 */
export function spellLearnProblem(s: GameState, u: Unit, spell: SpellDef): string | null {
  if (knownSpells(u).some((sk) => sk.id === spell.skill.id)) {
    return `已经会「${spell.skill.name}」了`;
  }
  if (!isResearched(s, u.owner, spell.skill.id)) {
    return `本方还没研发「${spell.skill.name}」——先在宗门大殿里研发它`;
  }
  /*
   * 大道三千：参过这一门的人，学法术时**不受流派限制**。
   *
   * 闸设在"学"这一侧而不是法术自己身上：流派限制是 `spell.schools` 这道数据，
   * 由这里统一判。让每一条想"无视流派"的法术各自去绕，等于把同一道闸抄 26 遍。
   */
  const daoAll = u.custom?.['daoAll'] === true;
  if (!daoAll && spell.schools && !spell.schools.includes(u.type)) {
    return `这一门只有${spell.schools.map((id) => s.unitTypes[id]?.name ?? id).join('、')}学得会`;
  }
  // 境界门槛：比法术位更硬的一条。法术位管"背得下几门"，这条管"够不够格学"。
  // 放在藏经阁之前——"你境界不够"是比"你没站对地方"更根本的拒绝理由。
  const minRank = spell.minRank ?? 0;
  if (getRank(u) < minRank) {
    return `境界不足：这门法术要 ${minRank} 期以上（你 ${getRank(u)} 期）`;
  }
  if (!libraryNextTo(s, u)) {
    return `要站在藏经阁旁边才能读（宗门没了，藏书楼也废了）`;
  }
  const cap = spellSlotsOf(u);
  const known = knownSpells(u).length;
  if (known >= cap) {
    return cap <= 0
      ? `境界不够：0～1 期没有法术位（至少 2 期）`
      : `法术位满了（${known} / ${cap}）：境界再高一点，或者去静心阁忘掉一门`;
  }
  return null;
}

/** 把法术记进身上。返回 true 表示这是一次新学会 */
export function teachSpell(u: Unit, spell: SpellDef): boolean {
  u.extraSkills ??= [];
  if (u.extraSkills.some((sk) => sk.id === spell.skill.id)) return false;
  u.extraSkills.push(spell.skill);
  return true;
}

/**
 * 能不能忘掉这一门。返回字符串 = 不能，字符串是给玩家看的理由。
 *
 * 只能忘**法术**（在 `SPELLS` 里的那些）：
 *   · 流派技能（剑气纵横、血祭）写在兵种表上，根本不在 `extraSkills` 里；
 *   · 境界技能（御空）是升级自动领悟的，忘了下次升级又会"重新领悟"——
 *     与其做一条"忘了就再也不给"的特例，不如不许忘。
 */
export function forgetProblem(s: GameState, u: Unit, spell: SpellDef): string | null {
  if (!knownSpells(u).some((sk) => sk.id === spell.skill.id)) {
    return `本来就不会「${spell.skill.name}」`;
  }
  if (!silentPavilionNextTo(s, u)) {
    return '要站在静心阁旁边才能忘（宗门没了，静心阁也废了）';
  }
  return null;
}

/** 真的忘掉。返回 true 表示这一次确实删掉了东西 */
export function forgetSpell(u: Unit, spell: SpellDef): boolean {
  const before = u.extraSkills ?? [];
  if (!before.some((sk) => sk.id === spell.skill.id)) return false;
  u.extraSkills = before.filter((sk) => sk.id !== spell.skill.id);
  return true;
}
