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
import type { GameState, Unit } from '../types.ts';
import type { SkillDef } from '../types.ts';
import { distBetweenUnits } from '../query.ts';
import { UNIT_IDS } from './identity.ts';
import { getRank } from './progression.ts';
import { PALM_THUNDER_COST, PALM_THUNDER_SKILL } from './skills/palm-thunder.ts';

/** 一条法术的元数据。`skill` 是它作为技能那一面的全部数据 */
export interface SpellDef {
  skill: SkillDef;
  /** 施放一次要多少灵力 */
  cost: number;
  /**
   * 限定流派（兵种 id 列表）。不写 = 所有修士都能学。
   *
   * 这是"让几个流派长得不一样"的最后一道闸：越强的法术越该限定流派，
   * 而通用法术（比如掌心雷）谁都能学，才不会出现"四条流派只有一套法术"。
   */
  schools?: readonly string[];
}

/**
 * 法术池。
 *
 * 目前只有一条样板，等设计者的 100 份草案落地后往这里加即可——
 * 加一条法术 = 写一个技能文件 + 在这里登记一行，别处一个字都不用改。
 */
export const SPELLS: readonly SpellDef[] = [
  { skill: PALM_THUNDER_SKILL, cost: PALM_THUNDER_COST },
];

/** 每座生效中的藏经阁给本阵营加几个法术位 */
export const LIBRARY_SPELL_SLOTS = 2;

/** 按 id 查法术。找不到 = 这不是法术（流派技能、境界技能都走这里返回 undefined） */
export function spellOf(skillId: string): SpellDef | undefined {
  return SPELLS.find((sp) => sp.skill.id === skillId);
}

/** 这个修士学过的法术（`extraSkills` 里属于法术池的那些） */
export function knownSpells(u: Unit): SkillDef[] {
  return (u.extraSkills ?? []).filter((sk) => !!spellOf(sk.id));
}

/**
 * 这座藏经阁现在算不算生效：必须贴着**自家**宗门。
 *
 * 为什么不是"建的时候有就行"：宗门被推掉之后那座楼就该废掉，
 * 否则玩家会看到"我宗门没了，法术位还在"，然后怀疑是不是显示错了。
 */
export function libraryIsActive(s: GameState, lib: Unit): boolean {
  if (lib.hp <= 0) return false;
  return s.units.some(
    (u) =>
      u.type === UNIT_IDS.SECT &&
      u.owner === lib.owner &&
      u.hp > 0 &&
      distBetweenUnits(s, u, lib) <= 1,
  );
}

/** 某一方生效中的藏经阁 */
export function activeLibrariesOf(s: GameState, owner: string): Unit[] {
  return s.units.filter(
    (u) => u.type === UNIT_IDS.SCRIPTURE_PAVILION && u.owner === owner && libraryIsActive(s, u),
  );
}

/** 这个修士脚下挨着的、生效中的藏经阁（学法术就在它旁边） */
export function libraryNextTo(s: GameState, u: Unit): Unit | null {
  for (const lib of activeLibrariesOf(s, u.owner)) {
    if (distBetweenUnits(s, lib, u) <= 1) return lib;
  }
  return null;
}

/** 这个修士能带几个法术：境界给一半，藏经阁每座 +2 */
export function spellCapOf(s: GameState, u: Unit): number {
  return Math.floor(getRank(u) / 2) + LIBRARY_SPELL_SLOTS * activeLibrariesOf(s, u.owner).length;
}

/**
 * 能不能学这一条法术。返回字符串 = 不能，字符串是给玩家看的理由。
 *
 * 规则层（`onUnitAction`）和面板（`unitActions` 把按钮灰掉）共用这一份，
 * 所以"能点"和"点得动"永远不会打架。
 */
export function spellLearnProblem(s: GameState, u: Unit, spell: SpellDef): string | null {
  if (knownSpells(u).some((sk) => sk.id === spell.skill.id)) {
    return `已经会「${spell.skill.name}」了`;
  }
  if (spell.schools && !spell.schools.includes(u.type)) {
    return `这一门只有${spell.schools.map((id) => s.unitTypes[id]?.name ?? id).join('、')}学得会`;
  }
  if (!libraryNextTo(s, u)) {
    return `要站在藏经阁旁边才能读（宗门没了，藏书楼也废了）`;
  }
  const cap = spellCapOf(s, u);
  const known = knownSpells(u).length;
  if (known >= cap) {
    return cap <= 0
      ? `境界不够：${Math.floor(getRank(u) / 2) || 0} 期没有法术位（至少 2 期）`
      : `法术位满了（${known} / ${cap}）：再找一座藏经阁，或者去静心阁忘掉一门`;
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
