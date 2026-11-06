import type { ExpansionHooks } from '../expansions.ts';
import { isCultivatorUnit } from './identity.ts';
import { addExp, getExpGrowth, ensureLifespan, isDoomed, KILL_EXP, SWORD_KILL_MUL } from './progression.ts';
import { 
  atkModifier, 
  armorModifier, 
  RangeModifier, 
  VisionModifier, 
  attTimesModifier, 
  SplashModifier, 
  moveModifier,
  swordMul,
  SWORD_BASE_MUL
} from './stats.ts';
import { getCultivationPanelLines } from './panel.ts';
import { SPIRIT_STONE } from './resources.ts';
import { MINE_MOUNTAIN_STONE_BONUS } from './units.ts';
// query.ts 只 import type，不会和 rules.ts 形成环。
import { idx, inBounds } from '../query.ts';

export const CULTIVATION_HOOKS: ExpansionHooks = {
  // 1. 击杀敌人获得经验
	onUnitKilled: (c) => {
		if (c.killer && isCultivatorUnit(c.state, c.killer)) {
		const killexp = c.killer.type === 'sword-cultivator' ? KILL_EXP * SWORD_KILL_MUL : KILL_EXP;
		addExp(c.killer, c.state, killexp); 
		}
	},
	modifyDamage: ({ state, attacker, damage }) => {
    if (!isCultivatorUnit(state, attacker)) return damage;
    return damage + Math.floor(atkModifier(attacker) * swordMul(attacker));
  },
	modifySiegeDamage: ({ state, attacker, damage }) => {
    if (!isCultivatorUnit(state, attacker)) return damage;
    return Math.max(0, damage + Math.floor(atkModifier(attacker) * swordMul(attacker)));
  },
	// 面板显示的是「普攻期望」：不随剑气纵横开关跳动，所以固定用 SWORD_BASE_MUL，
  // 不走 swordMul。这是策划决定，不是遗漏——改之前先确认需求。
  modifyStatAtk: ({ state, unit, atk }) => {
    if (!isCultivatorUnit(state, unit)) return atk;
    const mul = unit.type === 'sword-cultivator' ? SWORD_BASE_MUL : 1.0;
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
    if (unit.type === 'cultivation-spirit-tower') {
      return (unit.custom?.burstCharges as number) ?? 0;
    }
		if (isCultivatorUnit(state, unit)) {
		  return attacks + attTimesModifier(unit);
    }
    return attacks;
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
  modifyYield: ({ state, unit, yields }) => {
    if (unit.type !== 'cultivation-spirit-mine') return yields;
    let mountainCount = 0;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const nx = unit.x + dx;
      const ny = unit.y + dy;
      // 必须显式判边界：直接写 (y+dy)*w+(x+dx) 的话，x 越界会绕到相邻行的
      // 另一头——灵矿站在最左列时，会把**上一行最右格**的山当成自己旁边，
      // 白拿 2 灵石（实测过）。
      if (!inBounds(state, nx, ny)) continue;
      const tile = state.tiles[idx(state, nx, ny)];
      if (tile && tile.terrain === 'mountain') {
        mountainCount++;
      }
    }
    if (mountainCount > 0) {
      // 每相邻一座高山，额外 +2 灵石
      const bonus = mountainCount * MINE_MOUNTAIN_STONE_BONUS;
      yields[SPIRIT_STONE] = (yields[SPIRIT_STONE] ?? 0) + bonus;
    }
    return yields;
  },
	// ── 回合开始：寿元判定 + 打坐 ──────────────────
	onTurnStart: ({ state, player }) => {
		for (const u of state.units) {
      if (u.owner !== player) continue;
      if (u.owner === player && u.type === 'cultivation-spirit-tower' && u.custom?.burstCharges) {
        delete u.custom.burstCharges;
      }
      if (!isCultivatorUnit(state, u)) continue;
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
        text: `${state.unitTypes[u.type].name}寿元将尽，身体每况愈下。`,
        });
      }

      // 打坐：老死前照常修炼
      addExp(u, state, getExpGrowth(u));
		}
	},

	// ── 面板信息 ───────────────────────────────────
	getUnitPanelLines: ({ state, unit }) => getCultivationPanelLines(state, unit),
};