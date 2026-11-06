// 面板

import type { GameState, Unit } from '../types.ts';
import { skillsOf } from '../query.ts';
import { REALMS, MAX_RANK, getRank, getExp, getLifespan, getAgingYears, AGING_DEATH_AGE } from './progression.ts';
import { isCultivatorUnit } from './identity.ts';
import { 
  trueDamageOf,
  SWORD_BASE_MUL,
  SWORD_SWEEP_MUL,
  attTimesModifier,
  realmAtkBase,
  realmArmorBase,
  realmRangeBase,
  realmVisionBase,
} from './stats.ts';
import { getSwordSweepReach } from './skills.ts';
import { spiritAuraBonusOf, SPIRIT_AURA_LABEL } from './abilities/spirit-aura.ts';

// 原来在扩展里它是匿名的箭头函数，现在给它起个正式名字
export function getCultivationPanelLines(state: GameState, unit: Unit): string[] {
  if (!isCultivatorUnit(state, unit)) return [];
	const rank = getRank(unit);
	const exp = getExp(unit);
	const age = unit.age ?? 0;
	const lifespan = getLifespan(unit);
	const aging = getAgingYears(unit);

	// 升级所需总经验
	const nextExp = rank < MAX_RANK ? Math.floor(10 + 10 * rank * (rank+1) + 0.05 * 4 ** rank) : null;

	const lines = [
	`当前境界：第 ${rank} / ${MAX_RANK} 层   ${REALMS[rank]}期`,
	nextExp !== null
			? `修为经验：${exp} / ${nextExp}`
			: `修为经验：${exp}（已臻化境）`,
	`寿元：${age} / ${Number.isFinite(lifespan) ? lifespan : '∞'}`,
	];

	if (unit.type === 'sword-cultivator') {
    lines.push(`剑修：境界加成在普攻时 ×${SWORD_BASE_MUL}，剑气纵横时 ×${SWORD_SWEEP_MUL}`);
  }

	const hasSwordSweep = skillsOf(state, unit).some((sk) => sk.id === 'sword-sweep');
	if (hasSwordSweep) {
	const reach = getSwordSweepReach(state, unit);
	lines.push(`剑气纵横：向指定方向挥出 ${reach} 格直线剑气，伤害受境界加成`);
	}

	if (rank > 0) {
	const trueDmg = trueDamageOf(unit);
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

  const auraBonus = spiritAuraBonusOf(state, unit);
	if (auraBonus > 0) {
		lines.push(`${SPIRIT_AURA_LABEL}：每轮 +${auraBonus} 修为经验`);
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