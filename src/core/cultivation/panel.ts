// 面板

import type { GameState, Unit } from '../types.ts';
import { skillsOf } from '../query.ts';
import { REALMS, MAX_RANK, getRank, getExp, getExpGrowth, getLifespan, getAgingYears, AGING_DEATH_AGE, expForRank, getMaxHp, EXP_GROWTH_BLOOD } from './progression.ts';
import { isCultivatorUnit, isSwordCultivatorType, isBodyCultivatorType, isBloodCultivatorType } from './identity.ts';
import { sectLegacyMul } from './sect.ts';
import { 
  trueDamageOf,
  SWORD_BASE_MUL,
  SWORD_SWEEP_MUL,
  attTimesModifier,
  realmAtkBase,
  realmArmorBase,
  realmRangeBase,
  realmVisionBase,
  realmAtkFor,
  moveModifier,
  RangeModifier,
  BODY_ATK_MUL,
  BODY_TRUE_DAMAGE_MUL,
  BODY_MOVE_MUL,
  BODY_RANGE_MUL,
} from './stats.ts';
import { sweepReachForRank } from './skills/index.ts';
import { spiritAuraBonusOf, SPIRIT_AURA_LABEL } from './abilities/spirit-aura.ts';
import { bodyWardPct, BODY_WARD_LABEL } from './abilities/body-ward.ts';
import {
  bloodRiteRadiusForRank,
  bloodRiteExpMul,
  BLOOD_RITE_RADIUS_STEP,
  BLOOD_RITE_ALLY_EXP_MUL,
  BLOOD_RITE_LIFESPAN_COST,
} from './skills/index.ts';

// 原来在扩展里它是匿名的箭头函数，现在给它起个正式名字
export function getCultivationPanelLines(state: GameState, unit: Unit): string[] {
  if (!isCultivatorUnit(state, unit)) return [];
	const rank = getRank(unit);
	const exp = getExp(unit);
	const age = unit.age ?? 0;
	const lifespan = getLifespan(unit);
	const aging = getAgingYears(unit);

	// 升级所需总经验：走 progression 里那一份，别在这里再抄一遍公式
	const nextExp = rank < MAX_RANK ? expForRank(rank) : null;

	const lines = [
	`当前境界：第 ${rank} / ${MAX_RANK} 层   ${REALMS[rank]}期`,
	nextExp !== null
			? `修为经验：${exp} / ${nextExp}`
			: `修为经验：${exp}（已臻化境）`,
	`寿元：${age} / ${Number.isFinite(lifespan) ? lifespan : '∞'}`,
	];

	if (isSwordCultivatorType(unit.type)) {
    lines.push(`剑修：境界加成在普攻时 ×${SWORD_BASE_MUL}，剑气纵横时 ×${SWORD_SWEEP_MUL}`);
  }

  if (isBodyCultivatorType(unit.type)) {
    // 当前减伤是"此刻"的值：血一少，面板上的数字就该跟着涨，玩家才信这套机制
    const ward = Math.round(bodyWardPct(unit.hp, getMaxHp(state, unit)) * 100);
    lines.push(
      `${BODY_WARD_LABEL}：当前减伤 ${ward}%（血越少越高，残血 50%；真元与持续伤害不受影响）`,
    );
    // 上面那行「境界加成」印的是纯境界值（不乘系数），体修的射程/移动是要折算的，
    // 所以这里把**折算后实际加到多少**也写出来，免得玩家对着 +1 的射程发呆。
    lines.push(
      `体修：境界攻击 ×${BODY_ATK_MUL}（+${realmAtkFor(unit)}）· ` +
        `真元 ×${BODY_TRUE_DAMAGE_MUL}（${trueDamageOf(unit)} 点）· ` +
        `移动 ×${BODY_MOVE_MUL}（+${moveModifier(unit)}）· 射程 ×${BODY_RANGE_MUL}（+${RangeModifier(unit)}）`,
    );
  }

  if (isBloodCultivatorType(unit.type)) {
    const r = getRank(unit);
    lines.push(
      `血祭：半径 ${bloodRiteRadiusForRank(r)} 格（每 ${BLOOD_RITE_RADIUS_STEP} 级 +1），` +
        `每点伤害折 ${Math.round(bloodRiteExpMul(r) * 100)}% 修为（境界越高越低），` +
        `友军伤害只算 ${Math.round(BLOOD_RITE_ALLY_EXP_MUL * 100)}%`,
    );
    lines.push(
      `血祭代价：每次 −${BLOOD_RITE_LIFESPAN_COST} 年寿元；` +
        `打坐每回合只 +${EXP_GROWTH_BLOOD} 点，且不吃击杀历练`,
    );
  }

	const hasSwordSweep = skillsOf(state, unit).some((sk) => sk.id === 'sword-sweep');
	if (hasSwordSweep) {
	const reach = sweepReachForRank(getRank(unit));
	lines.push(`剑气纵横：向指定方向挥出 ${reach} 格直线剑气，伤害受境界加成`);
	}

	if (rank > 0) {
	const trueDmg = trueDamageOf(unit);
	/*
	 * 有光环加成时单独写一行「当前真元」。
	 *
	 * 下面那行「境界加成」印的是**境界给了多少**，不能混进光环；
	 * 但玩家算伤害时看的是"这一下真元打多少"，所以有差额就得说清楚，
	 * 否则"面板写 6、打出来 7"又要被当成 bug 排查一遍。
	 */
	// 这一行印的是"修到这一层本身给了多少"：**不乘流派系数、不扣衰老**。
	// 超龄的惩罚在下面的「油尽灯枯」单独一行，灵体/剑修的系数由各自的说明行交代。
	lines.push(
			`境界加成：
      攻击 +${realmAtkBase(rank)} · 
      护甲 +${realmArmorBase(rank)} · 
      射程 +${realmRangeBase(rank)} · 神识 +${realmVisionBase(rank)} · 
      攻击次数 +${attTimesModifier(unit)}`,
	);
	if (trueDmg > 0) lines.push(`真元：每次攻击附带 ${trueDmg} 点无视护甲的真实伤害`);
	}

  const auraBonus = spiritAuraBonusOf(state, unit);	if (auraBonus > 0) {
		lines.push(`${SPIRIT_AURA_LABEL}：每轮 +${auraBonus} 修为经验`);
	}

  /*
   * 宗门传承：只在**吃得到**的时候单独写一行。
   *
   * 这条加成是乘在打坐量上的，而打坐量（境界 + 2，剑修减半、魔修固定 1）
   * 本来就不在面板上印——两个都没写，玩家就完全看不见"师父站在旁边有没有用"。
   * 所以这里要把乘完之后的实际数字一起写出来，而不是只说"受传承影响"。
   */
  const legacy = sectLegacyMul(state, unit);
  if (legacy > 1) {
    lines.push(
      `宗门传承：打坐 ×${legacy}（师父比自己高 ${legacy + 1} 层以上）→ 每轮 +${getExpGrowth(unit) * legacy} 修为`,
    );
  }

	if (aging > 0) {
	lines.push(
			`油尽灯枯：攻击 -${aging * 2} · 护甲 -${aging} · 神识 -${aging}`,
	);
	const remaining = lifespan + AGING_DEATH_AGE - age;
	if (remaining > 0) lines.push(`坐化倒计时：${remaining} 年`);
	}

	return lines;
}