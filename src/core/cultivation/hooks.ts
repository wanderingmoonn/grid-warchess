import type { ExpansionHooks } from '../expansions.ts';
import { isCultivatorUnit } from './identity.ts';
import { addExp, getExpGrowth, ensureLifespan, isDoomed } from './progression.ts';
import { atkModifier, armorModifier, RangeModifier, VisionModifier, attTimesModifier, SplashModifier, moveModifier } from './stats.ts';
import { getCultivationPanelLines } from './panel.ts';

export const CULTIVATION_HOOKS: ExpansionHooks = {
  // 1. 击杀敌人获得经验
	onUnitKilled: (c) => {
		if (c.killer && isCultivatorUnit(c.state, c.killer)) {
		let killexp=10;
		if (c.killer.type === 'sword-cultivator'){
				killexp = killexp * 2;
		}
		addExp(c.killer, c.state, killexp); 
		}
	},
	modifyDamage: ({ state, attacker, damage }) => {
		if (!isCultivatorUnit(state, attacker)) return damage;
		// 剑修：境界加成按模式缩放（普攻 ×0.8 / 剑气纵横 ×1.2）
		const mul = attacker.type === 'sword-cultivator'
		? (attacker.custom?.swordSweepActive === true ? 1.2 : 0.8)
		: 1.0;
		return damage + Math.floor(atkModifier(attacker) * mul);
	},
	// 攻城加成
	modifySiegeDamage: ({ state, attacker, damage }) => {
		if (!isCultivatorUnit(state, attacker)) return damage;
		const mul = attacker.type === 'sword-cultivator'
		? (attacker.custom?.swordSweepActive === true ? 1.2 : 0.8)
		: 1.0;
		return Math.max(0, damage + Math.floor(atkModifier(attacker) * mul));
	},
	// 面板修正
	modifyStatAtk: ({ state, unit, atk }) => {
		if (!isCultivatorUnit(state, unit)) return atk;
		const mul = unit.type === 'sword-cultivator' ? 0.8 : 1.0;
		return atk + Math.floor(atkModifier(unit) * mul);
	},
	// 护甲修正
	modifyArmor: ({ state, defender, armor }) => {
		if (!isCultivatorUnit(state, defender)) return armor;
		return Math.max(0, armor + armorModifier(defender));
	},
	// 射程修正
	modifyRange: ({ state, unit, range }) => {
		if (!isCultivatorUnit(state, unit)) return range;
		return range + RangeModifier(unit);
	},
	// 视野修正
	modifyVision: ({ state, unit, base }) => {
		if (!unit || !isCultivatorUnit(state, unit)) return base;
		return Math.max(1, base + VisionModifier(unit));
	},
	// 攻击次数
	modifyAttacks: ({ state, unit, attacks }) => {
		if (!isCultivatorUnit(state, unit)) return attacks;
		return attTimesModifier(unit);
	},
	// 溅射半径
	modifySplash: ({ state, attacker, splash }) => {
		if (!isCultivatorUnit(state, attacker)) return splash;
		return splash+SplashModifier(attacker);
	},
	// 移动修正
	modifyMove: ({ state, unit, move }) => {
		if (!isCultivatorUnit(state, unit)) return move;
		return move + moveModifier(unit);
	},
	// ── 回合开始：寿元判定 + 打坐 ──────────────────
	onTurnStart: ({ state, player }) => {
		for (const u of state.units) {
		if (u.owner !== player || !isCultivatorUnit(state, u)) continue;
		const age = u.age ?? 0;
		// 首次访问（老存档）时把寿元落库，之后降级不会让寿命跟着回退
		const lifespan = ensureLifespan(u);

		if (isDoomed(u)) {
			if (u.hp > 0) {
			u.hp = 0;
			state.log.push({
					turn: state.turn,
					player,
					text: `${state.unitTypes[u.type].name}寿元耗尽，油尽灯枯，只待最后一丝生机散去。`,
			});
			}
			// 把清场交给核心的 sweepDead。
			// 玩家可以在清场前打出最后一击或者寻找保命手段。
			continue;
		}

		// 刚跨过寿元：写一次警告
		if (age === lifespan + 1) {
			state.log.push({
			turn: state.turn,
			player,
			text: `炼气士 寿元将尽，身体每况愈下。`,
			});
		}

		// 打坐：老死前照常修炼
		addExp(u, state, getExpGrowth(u));
		}
	},

	// ── 面板信息 ───────────────────────────────────
	getUnitPanelLines: ({ state, unit }) => getCultivationPanelLines(state, unit),
};