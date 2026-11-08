import type { ExpansionHooks } from '../expansions.ts';
import type { GameState, Unit } from '../types.ts';
import { isCultivatorUnit, isCultivatorDef, isSwordCultivatorType, isBloodCultivatorType, UNIT_IDS } from './identity.ts';
import {
  SECT_ID,
  SECT_MASTER_MIN_RANK,
  sectLegacyMul,
  sectRecruitableTypes,
  sectRecruitStone,
} from './sect.ts';
import {
  ARTIFACT_MOVE_MUL,
  artifactArmorBonus,
  cultivatorsCovering,
  isArtifact,
} from './artifacts.ts';
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
		// 魔修不吃击杀历练：它的修为全部来自「血祭」，那条路已经绕过了每回合上限。
		// 再叠一份击杀经验就是双通道，升级节奏会直接翻倍（见 skills/blood-rite.ts）。
		if (isBloodCultivatorType(killer.type)) return;

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
	modifyArmor: ({ state, defender, armor, armorOf, visionOf }) => {
		// 法器：神识范围内按修士护甲加甲（「器灵」）。
		// 取范围内**护甲最高**的那位的一半，不叠加——堆修士不该变成乘法收益。
		if (isArtifact(state, defender)) {
			const bonus = artifactArmorBonus(
				state,
				defender,
				visionOf ?? (() => 0),
				armorOf ?? (() => 0),
			);
			return armor + bonus;
		}
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
	modifyMove: ({ state, unit, move, visionOf }) => {
		// 法器：出了己方修士的神识就减半（「器灵」）。
		// 留 1 格保底——移动力被减速压到 1 时再减半会变成 0，
		// 那不是"飞剑掉地上"，那是"这件东西被永久钉死了"。
		if (isArtifact(state, unit)) {
			if (move <= 0) return move;
			const watched = visionOf ? cultivatorsCovering(state, unit, visionOf).length > 0 : false;
			if (watched) return move;
			return Math.max(1, Math.floor(move * ARTIFACT_MOVE_MUL));
		}
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
	// ── 宗门大殿（2026-11-08）──────────────────────
	//
	// 三条钩子干的是同一件事的两个面：**宗门只认"贴着它站的修士"**。
	//   · produceBlocked：有 ≥2 期的师父站着，才招得出这个流派；
	//   · modifyCost / modifyResourceCost：宗门里招弟子不收金币，改收灵石；
	//   · onTurnStart（下面）：贴着宗门打坐的弟子吃「传承」加成。
	//
	// 定价必须走钩子而不是写死在兵种表上：同一件修士，城市产线仍然卖金币，
	// 只有宗门这一条线收灵石。这就是 `source` 那个参数存在的全部理由。
	produceBlocked: ({ state, source, target }) => {
		if (source.kind !== 'camp') return null;
		if (state.unitTypes[source.camp.type]?.id !== SECT_ID) return null;
		if (!isCultivatorDef(target)) return `${state.unitTypes[source.camp.type].name}只收修士弟子`;
		// 灵体这类召唤物到不了这里（produceAt 在更前面就挡了），不重复判
		const allowed = sectRecruitableTypes(state, source.camp);
		if (!allowed.has(target.id)) {
			return `附近没有 ${SECT_MASTER_MIN_RANK} 期以上的${target.name}师傅`;
		}
		return null;
	},
	modifyCost: ({ state, source, cost }) => {
		if (source?.kind !== 'camp') return cost;
		return state.unitTypes[source.camp.type]?.id === SECT_ID ? 0 : cost;
	},
	modifyResourceCost: ({ state, source, baseCost, cost }) => {
		if (source?.kind !== 'camp') return cost;
		if (state.unitTypes[source.camp.type]?.id !== SECT_ID) return cost;
		// 金币那一段已经被 modifyCost 归零；这里按**原始金币价**折成灵石，
		// 而不是按折后价——以后要是再来一条"宗门打折"的规则，两次折算不会打架。
		return { ...cost, [SPIRIT_STONE]: (cost[SPIRIT_STONE] ?? 0) + sectRecruitStone(baseCost) };
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
      //
      // 宗门传承按"贴着宗门站的最高境界 − 自己 − 1"放大这一次打坐。
      // 乘在这里而不是改进 getExpGrowth：那个函数只拿得到 Unit，
      // 看不见棋盘上有没有宗门，改进它就得把 GameState 塞进去（或做缓存），
      // 而缓存会过期——师父一走加成还挂着，玩家根本没法验证规则。
      addExp(u, state, getExpGrowth(u) * sectLegacyMul(state, u));
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