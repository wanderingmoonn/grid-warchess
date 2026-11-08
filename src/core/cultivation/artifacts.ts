/**
 * 法器：修士炼出来的器物，不是活人。
 *
 * 它们不修炼、不吃灵气滋养、也没有境界——那"凭什么值这个价"就得靠别的东西。
 * 这里定的是**所有法器共有**的两条规则，具体每件法器的性格（光环、射程、
 * 产地）写在 units.ts 里。
 *
 * ── 器灵：法器得有人在看着 ────────────────────────────────
 *
 * 法器是"御"出来的，不是自己会动的。所以：
 *   · 离开己方修士的神识范围 → 移动力减半（飞剑掉地上，只能拖着走）；
 *   · 在神识范围内 → 护甲 + 范围内护甲最高的那位修士的护甲 ÷ 2
 *     （修士以神识护持，剑随人走）。
 *
 * 两个效果都**取最优的一条**，不叠加：三个修士站在旁边不该变成三倍加成，
 * 和所有光环类效果同一个口径。
 *
 * 为什么用 `artifact` 标记判、而不是"带某条能力"：这是身份，不是可选机制。
 * 漏写能力就是"这件法器坏了"，而漏写标记会被测试当场逮住
 * （cultivation.test 有一条"每件法器都带这两条能力"）。
 *
 * ── 温养：贴着修士就能自己复原 ──────────────────────────────
 *
 * 没有这一条，法器就是一次性消耗品——掉的血永远回不来，玩家会不敢用它。
 * 回血量按**境界最高的那位**算：1 + ⌊境界 ÷ 2⌋ 点/回合。
 * 0 级修士只有 1 点，9 级 5 点；青木剑 36 血，3 级修士要 18 个回合才养满，
 * 是"缓慢恢复"而不是"打完就满血"。
 *
 * 只算**己方**修士：灵气滋养那条是"灵气不认人"，温养不是——别人家的修士
 * 没理由替你养剑。灵体算修士（见 identity.ts），师傅化灵了剑还认他。
 */
import type { GameState, Unit, UnitTypeDef } from '../types.ts';
import type { AbilityDef } from '../abilities.ts';
import type { AbilityHooks } from '../ability-hooks.ts';
import { TURN_START } from '../ability-hooks.ts';
import { distBetweenUnits } from '../query.ts';
import { isCultivatorUnit } from './identity.ts';
import { getRank } from './progression.ts';

export const ARTIFACT_SPIRIT_ID = 'artifact-spirit';
export const ARTIFACT_SPIRIT_LABEL = '器灵';
export const WARM_NOURISH_ID = 'warm-nourish';
export const WARM_NOURISH_LABEL = '温养';

/** 神识外移动力减半；留一格保底，别让减速过的法器彻底卡死 */
export const ARTIFACT_MOVE_MUL = 0.5;
/** 神识内加甲 = 修士护甲 ÷ 这个数 */
export const ARTIFACT_ARMOR_DIVISOR = 2;
/** 温养的半径 */
export const WARM_NOURISH_RADIUS = 2;
/** 温养基础回血（0 级修士也养得动） */
export const WARM_NOURISH_BASE = 1;
/** 每级境界多回多少（向上取整前的系数） */
export const WARM_NOURISH_RANK_MUL = 0.5;

/** 从兵种定义查。给"手里只有 def"的场合用。 */
export function isArtifactDef(def: UnitTypeDef | undefined | null): boolean {
  return !!def && def.artifact === true;
}

export function isArtifact(s: GameState, u: Unit): boolean {
  return isArtifactDef(s.unitTypes[u.type]);
}

/**
 * 神识覆盖着这个法器的己方修士。
 *
 * `visionOf` 由规则层注入：神识 = 兵种视野 + 境界加成 + 驻军 + 状态，
 * 这些东西扩展自己算不出来（会漏掉一半），而"算少了"的表现是
 * 玩家的剑莫名其妙掉地上。
 *
 * 只认**活着的、同阵营的**：死人不看路，敌人的神识也不会替你御剑。
 */
export function cultivatorsCovering(
  s: GameState,
  u: Unit,
  visionOf: (x: Unit) => number,
): Unit[] {
  const out: Unit[] = [];
  for (const c of s.units) {
    if (c.id === u.id || c.owner !== u.owner) continue;
    if (c.hp <= 0) continue;
    if (!isCultivatorUnit(s, c)) continue;
    if (distBetweenUnits(s, c, u) > visionOf(c)) continue;
    out.push(c);
  }
  return out;
}

/**
 * 器灵给的护甲：范围内**护甲最高**的那位修士的一半，向下取整。
 *
 * 取最高而不是相加：堆修士不该变成乘法收益。
 * 半血修士照样能护持（护甲不看血），所以这里不按血量打折。
 */
export function artifactArmorBonus(
  s: GameState,
  u: Unit,
  visionOf: (x: Unit) => number,
  armorOf: (x: Unit) => number,
): number {
  const watchers = cultivatorsCovering(s, u, visionOf);
  if (watchers.length === 0) return 0;
  let best = 0;
  for (const c of watchers) best = Math.max(best, armorOf(c));
  return Math.floor(best / ARTIFACT_ARMOR_DIVISOR);
}

/** 温养这一回合能回多少（0 = 半径内没有己方修士） */
export function warmNourishHeal(s: GameState, u: Unit): number {
  let bestRank = -1;
  for (const c of s.units) {
    if (c.id === u.id || c.owner !== u.owner) continue;
    if (c.hp <= 0) continue;
    if (!isCultivatorUnit(s, c)) continue;
    if (distBetweenUnits(s, c, u) > WARM_NOURISH_RADIUS) continue;
    bestRank = Math.max(bestRank, getRank(c));
  }
  if (bestRank < 0) return 0;
  return WARM_NOURISH_BASE + Math.floor(bestRank * WARM_NOURISH_RANK_MUL);
}

/**
 * 「器灵」。
 *
 * 注意它**没有 hooks**：效果写在 rules 的 modifyMove / modifyArmor 里，
 * 靠兵种上的 `artifact` 标记统一开。理由是这样只需要一份判定——
 * 挂成能力钩子的话，每件法器都要在 AbilityHooks 里各写一遍，
 * 而"移动力总量"根本没有对应的能力钩子（只有步耗倍率，面板会显示成错的）。
 */
export const ARTIFACT_SPIRIT: AbilityDef = {
  id: ARTIFACT_SPIRIT_ID,
  name: ARTIFACT_SPIRIT_LABEL,
  summary:
    `离开己方修士的神识范围，移动力减半（至少留 1 格）；` +
    `在神识范围内，护甲 + 范围内护甲最高的那位修士的护甲 ÷ ${ARTIFACT_ARMOR_DIVISOR}。`,
  group: 'support',
};

export const WARM_NOURISH: AbilityDef = {
  id: WARM_NOURISH_ID,
  name: WARM_NOURISH_LABEL,
  summary:
    `回合开始时，若半径 ${WARM_NOURISH_RADIUS} 格内有己方修士，` +
    `恢复 ${WARM_NOURISH_BASE} + ⌊最高境界 ÷ 2⌋ 点生命（多个修士只按最高的那位算）。`,
  group: 'support',
  hooks: {
    radius: WARM_NOURISH_RADIUS,
    onTurnStart: [
      {
        stage: TURN_START.aura,
        apply: (c) => {
          const heal = warmNourishHeal(c.state, c.self);
          if (heal <= 0) return;
          const max = c.api.maxHpOf(c.state, c.self);
          if (c.self.hp >= max) return;
          const before = c.self.hp;
          c.self.hp = Math.min(max, c.self.hp + heal);
          const gained = c.self.hp - before;
          if (gained <= 0) return;
          const def = c.api.utype(c.state, c.self.type);
          // 私有战报：温养是"我这件东西在恢复"，对面没必要看
          c.api.pushLog(c.state, c.owner, `${def.name} 得修士温养，恢复 ${gained} 点生命`, false);
        },
      },
    ],
  } satisfies AbilityHooks,
};

/** 所有法器都该带的两条能力（守卫测试按它核对） */
export const ARTIFACT_COMMON_ABILITIES = [ARTIFACT_SPIRIT_ID, WARM_NOURISH_ID] as const;
