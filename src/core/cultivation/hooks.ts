import type { ExpansionHooks } from '../expansions.ts';
import type { GameState, Unit } from '../types.ts';
import { isCultivatorUnit, isSwordCultivatorType, UNIT_IDS } from './identity.ts';
import { addExp, getExpGrowth, ensureLifespan, isDoomed } from './progression.ts';
import { 
  atkModifier, 
  armorModifier, 
  RangeModifier, 
  VisionModifier, 
  attTimesModifier, 
  SplashModifier, 
  moveModifier,
  swordMul,
  SWORD_BASE_MUL,
  calcKillExp
} from './stats.ts';
import { getCultivationPanelLines } from './panel.ts';
import { SPIRIT_STONE } from './resources.ts';
import { MINE_MOUNTAIN_STONE_BONUS } from './units.ts';
import { anomalyCellsFor, clearAnomaliesOfOthers } from './abilities/anomaly.ts';
import { bestAdjacentCultivatorRank } from './abilities/formation-guard.ts';
import { guardianFor } from './abilities/formation-guardian.ts';
import { SEAL_AURA_RADIUS, SEAL_MOVE_PCT } from './abilities/formation-seal.ts';
// query.ts 只 import type，不会和 rules.ts 形成环。
import { distBetweenUnits, idx, inBounds } from '../query.ts';

/**
 * 这个单位是不是被封印阵压住了。
 *
 * 判据和 `movePower` 里那两步保持一致：**先乘 0.5 向下取整、再减守阵者的境界**。
 * 不能直接调 movePower——那在 rules.ts 里，而 hooks 在它下面，反过来 import 会成环。
 * 所以这里只复算"封印阵造成的那部分"，其他减速（中毒、封冻）不参与判断：
 * 被别的东西压住是另一回事，不该算到封印阵头上。
 */
function sealedReasonOf(s: GameState, unit: Unit): string | null {
  const base = s.unitTypes[unit.type]?.move ?? 0;
  if (base <= 0) return null; // 建筑本来就不动，谈不上被封
  for (const f of s.units) {
    if (f.owner === unit.owner) continue;
    if (f.type !== UNIT_IDS.SEAL_FORMATION) continue;
    if (distBetweenUnits(s, f, unit) > SEAL_AURA_RADIUS) continue;
    const guard = bestAdjacentCultivatorRank(s, f) ?? 0;
    if (Math.floor(base * SEAL_MOVE_PCT) - guard <= 0) {
      return '被封印阵封住，这一回合无法行动';
    }
  }
  return null;
}

export const CULTIVATION_HOOKS: ExpansionHooks = {
	// 1. 击杀敌人获得历练（规则在 stats.ts，这里只管读写额度）
	//
	// 额度记在击杀者身上（custom.killExpThisTurn），随存档走。
	// "哪一回合"用 s.turn 判：跨回合自动归零，不用额外的清理钩子。
	onUnitKilled: (c) => {
		const killer = c.killer;
		if (!killer || !isCultivatorUnit(c.state, killer)) return;

		// 目标基础攻击力：不看造价、不看等级（召唤物没造价，英雄没等级）
		const victimAtk = c.state.unitTypes[c.victim.type]?.atk ?? 0;

		const prev = killer.custom ?? {};
		const used = prev['killExpTurn'] === c.state.turn ? ((prev['killExpThisTurn'] as number) ?? 0) : 0;
		const gain = calcKillExp(killer, used, victimAtk);

		// 不值得一战 / 额度用光：不写任何东西，免得 custom 天天被无意义地重写
		if (gain <= 0) return;

		killer.custom = { ...prev, killExpTurn: c.state.turn, killExpThisTurn: used + gain };
		addExp(killer, c.state, gain);
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
    const mul = isSwordCultivatorType(unit.type) ? SWORD_BASE_MUL : 1.0;
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
	// ── 额外视野：异象点亮的那一格 ──────────────────
	// 这是**纯函数**，会被寻路、威胁圈、记忆刷新反复调用，所以
	// anomalyCellsFor 第一行就是 `s.current !== player` 早退。
	// 放进 visibleTilesOf 意味着 AI 也认：对面能据此派兵来劫杀。
	extraVision: ({ state, player }) => anomalyCellsFor(state, player),
	// ── 守御阵：把这一下伤害接到阵身上 ──────────────
	// 只换"谁掉血"，不换"谁被命中"：命中状态、击退、反击全部留在原目标身上。
	// 规则层的 hurtUnit 保证只问一次、接替者活着且在册、不会转给自己。
	// 中毒/灼烧/自损不走这条路径（它们本来就不经过 hurtUnit）。
	redirectDamage: ({ state, victim }) => guardianFor(state, victim),
	// 视野修正
	modifyVision: ({ state, unit, base }) => {
		if (!unit || !isCultivatorUnit(state, unit)) return base;
		return Math.max(1, base + VisionModifier(unit));
	},
	// 攻击次数
	modifyAttacks: ({ state, unit, attacks }) => {
    if (unit.type === UNIT_IDS.SPIRIT_TOWER) {
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
    if (unit.type !== UNIT_IDS.SPIRIT_MINE) return yields;
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
      if (u.owner === player && u.type === UNIT_IDS.SPIRIT_TOWER && u.custom?.burstCharges) {
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

	// ── 回合结束：熄灭别人的异象 ──────────────────
	// 只清"别人"的：突破发生在自己回合，如果自己回合结束也清，
	// 那盏灯还没等到敌方回合就被自己掐了。
	onTurnEnd: ({ state, player }) => {
		clearAnomaliesOfOthers(state, player);
	},

	// ── 面板信息 ───────────────────────────────────
	// ── 完全封印：被压到 0 移动力的单位不能下任何命令 ──
	// 规则层会在移动/攻击/攻城/放技能/建造五个入口统一问它。
	// 面板上也要写一行，否则玩家只看到"点了没反应"。
	canCommand: ({ state, unit }) => sealedReasonOf(state, unit),
	getUnitPanelLines: ({ state, unit }) => {
		const lines = getCultivationPanelLines(state, unit);
		const sealed = sealedReasonOf(state, unit);
		if (sealed) lines.push(`封印：${sealed}`);
		return lines;
	},
};