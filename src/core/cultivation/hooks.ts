import type { ExpansionHooks, UnitActionOption } from '../expansions.ts';
import type { GameState, PlayerId, Unit } from '../types.ts';
import { isCultivatorUnit, isCultivatorDef, isSwordCultivatorType, isBloodCultivatorType, UNIT_IDS } from './identity.ts';
import {
  SECT_ID,
  SECT_MASTER_MIN_RANK,
  sectLegacyMul,
  sectRecruitableTypes,
  sectRecruitStone,
} from './sect.ts';
import { regenMana } from './mana.ts';
import { isStunned, spellBuffsOf } from './spell-statuses.ts';
import { marksOf, marksAt } from '../marks.ts';
import { shieldOf, breakShield } from './skills/shield.ts';
import { reviveMarkOf } from './skills/revive.ts';
import { TI_JIE_LING_SHEN_BIND_RADIUS, HUN_DENG_RATIO } from './skills/summon.ts';
import { DAO_HUA_MO_RAN_LAYERS } from './skills/convert.ts';
import { knifeMarkOf } from './skills/record.ts';
import { daiTargetOf } from './transfer.ts';
import {
	giantStuckOf,
	refreshGiantStuck,
	WHITE_STATUS,
	EQUALITY_STATUS,
	SEAL_STATUS,
	TIAN_XIA_JIE_BAI_COEF,
} from './skills/rewrite.ts';
import { exchangeMana, qiAt, qiOverlayCells, qiSourceLabel, QI_MAX, stepQiField } from './qi-field.ts';
import {
  PILLS,
  addPill,
  furnaceNextTo,
  payForPill,
  pillBrewProblem,
  pillOf,
  pillsOf,
  pillUseProblem,
  takePill,
} from './pills.ts';
import { addRes } from '../resources.ts';
import {
  SPELLS,
  abandonProblem,
  forgetProblem,
  forgetSpell,
  isResearched,
  knownSpells,
  libraryNextTo,
  researchCostOf,
  researchProblem,
  researchedOf,
  silentPavilionNextTo,
  spellLearnProblem,
  spellOf,
  spellSlotsOf,
  teachSpell,
} from './spells.ts';
import {
  ARTIFACT_MOVE_MUL,
  artifactArmorBonus,
  cultivatorsCovering,
  isArtifact,
} from './artifacts.ts';
import { addExp, getExpGrowth, ensureLifespan, isDoomed, getRank } from './progression.ts';
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
import { distBetweenUnits, idx, inBounds, underConstruction, coversTile } from '../query.ts';

/**
 * 写一条**公开**战报。
 *
 * 研发、遗弃、学会法术这三件事对面迟早会通过"对面多了一门法术"察觉，
 * 藏着反而像是 bug（"他什么时候会这个的"）。所以统一走 open: true。
 */
function push(s: GameState, player: PlayerId, text: string): void {
  s.log.push({ turn: s.turn, player, text, open: true });
}

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
		/*
		 * ── 免死（族 11）────────────────────────────────────────
		 *
		 * `killUnit` 的顺序是"先从 `s.units` 摘掉、再通知钩子"，
		 * 所以这里把**同一个对象** push 回去就是复活：境界、经验、寿元、
		 * 学过的技能全在对象里，一条都没丢（G6 要守的就是这条）。
		 *
		 * 复活后把 `moved/acted` 置真：这一回合不能再动，否则等于凭空多一个回合。
		 * 也顺手 return —— 没死成就不该给对面击杀经验。
		 */
		/*
		 * ── 魂灯（族 8）──────────────────────────────────────────
		 *
		 * 比"护命符"更早判：灯是**有位置的**，而且会被敌方拆掉——
		 * 灯在，就按灯的位置接回来；灯没了，才轮到身上的护命符。
		 * 这样两条免死同时存在时，玩家看到的是"灯先亮"，符合造物的直觉。
		 */
		const lampId = c.victim.custom?.['hunDeng'] as
			| { id: string; x: number; y: number }
			| undefined;
		if (lampId) {
			const lamp = c.state.units.find((u) => u.id === lampId.id && u.hp > 0);
			if (lamp) {
				const v = c.victim;
				const maxHp = c.api.maxHpOf(c.state, v);
				v.hp = Math.max(1, Math.round(maxHp * HUN_DENG_RATIO));
				v.x = lamp.x;
				v.y = lamp.y;
				v.moved = true;
				v.acted = true;
				// 灯只能接一次：把灯熄掉（走 killUnit，战报和编制都跟着走）
				c.api.killUnit(c.state, lamp, undefined, '魂灯燃尽');
				c.state.units.push(v);
				c.api.pushLog(
					c.state,
					v.owner,
					`${c.api.utype(c.state, v.type).name}的魂魄被魂灯接住，自灯火中重生`,
					true,
				);
				return;
			}
		}

		const mark = reviveMarkOf(c.victim);
		if (mark && !mark.used) {
			const v = c.victim;
			const maxHp = c.api.maxHpOf(c.state, v);
			v.hp = Math.max(1, Math.round(maxHp * mark.ratio));
			if (mark.atKiller && c.killer) {
				v.x = c.killer.x;
				v.y = c.killer.y;
			}
			v.moved = true;
			v.acted = true;
			// `used` 记在同一个对象上：整局只生效一次，这是天然的
			v.custom = { ...(v.custom ?? {}), revive: { ...mark, used: true } };
			c.state.units.push(v);
			c.api.pushLog(
				c.state,
				v.owner,
				`${c.api.utype(c.state, v.type).name}的护命符碎了——${mark.atKiller ? '在凶手面前' : '原地'}重新站起`,
				true,
			);
			return;
		}

		/*
		 * 酆都鬼蜮：死在我方鬼蜮上的敌人不会死，变成鬼卒。
		 *
		 * 先于"护命符"之外的所有死亡逻辑判——它是**地形**在起作用（谁站上去谁挨），
		 * 和"这个人身上有没有护命符"无关。
		 */
		const ghost = marksAt(c.state, c.victim.x, c.victim.y).find(
			(m) => m.kind === 'spell-ghost' && m.owner !== c.victim.owner,
		);
		if (ghost) {
			const v = c.victim;
			v.hp = Math.max(1, Math.round(c.api.maxHpOf(c.state, v) * 0.5));
			v.moved = true;
			v.acted = true;
			c.state.units.push(v);
			c.api.convert(c.state, v, ghost.owner, `酆都鬼蜮：${unitNameOf(c.state, v)} 被拉起来，改听鬼蜮之主号令`);
			return;
		}

		/*
		 * 血脉侵蚀：被侵蚀到 0 的人不是"死"，是**倒戈**。
		 *
		 * 它和鬼蜮的区别是：鬼蜮吃的是"死在我地上的人"，侵蚀吃的是"我亲手侵蚀死的人"，
		 * 所以判据挂在单位身上（`custom.erode`）而不是地上。
		 */
		const erode = c.victim.custom?.['erode'] as { pct: number; to: string } | undefined;
		if (erode) {
			const v = c.victim;
			v.hp = Math.max(1, Math.round(c.api.maxHpOf(c.state, v) * 0.3));
			v.moved = true;
			v.acted = true;
			const rest = { ...(v.custom ?? {}) };
			delete rest['erode'];
			v.custom = rest;
			c.state.units.push(v);
			c.api.convert(c.state, v, erode.to as never, `血脉侵蚀：${unitNameOf(c.state, v)} 血被换尽，倒戈`);
			return;
		}

		const killer = c.killer;
		/*
		 * 化身分神：分身杀的人，修为归本体。
		 *
		 * 分身本身不是修士（它是另一类兵种），所以下面那条"杀敌加修为"不会给它。
		 * 这里把功劳转回本体——否则"造个分身去砍人"等于把经验扔了，
		 * 玩家会本能地觉得亏。
		 */
		const cloneOf = killer?.custom?.['cloneOf'] as string | undefined;
		if (killer && cloneOf) {
			const owner = c.state.units.find((u) => u.id === cloneOf);
			if (owner && isCultivatorUnit(c.state, owner)) {
				const victimAtk = c.state.unitTypes[c.victim.type]?.atk ?? 0;
				const gain = calcKillExp(owner, 0, victimAtk);
				if (gain > 0) addExp(owner, c.state, gain);
			}
			return;
		}

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
	/*
	 * 族 7（攻击附加）的结算点：血真的掉了之后，看施法者身上有没有"待结算"。
	 *
	 * 三条都按**实际伤害**算：偷多少灵石、换多少修为都该看对方掉了几点血，
	 * 按纸面伤害算会让高甲单位变成提款机。
	 *
	 * 结算前先把标记摘掉：溯因果会再造成伤害，而那次伤害也会走进本钩子——
	 * 不清标记就是无限连锁（而且每一层都会真实扣血）。
	 */
	onUnitDamaged: ({ state, unit, amount, source, api }) => {
		/*
		 * 心魔种道：**下一次受伤当场倒戈**。
		 *
		 * 放在"有没有待结算的攻击附加"之前判：那是施法者的账，这是挨打者身上的账，
		 * 两件事不该互相挡。倒戈之后这一下伤害照样已经落地了（钩子在扣血之后），
		 * 也就意味着"你先把他打疼，他才肯降"——正是这门法术的意象。
		 */
		const onHurt = unit.custom?.['convertOnHurt'] as { to: string } | undefined;
		if (onHurt && unit.owner !== onHurt.to) {
			const rest = { ...(unit.custom ?? {}) };
			delete rest['convertOnHurt'];
			unit.custom = rest;
			api.convert(state, unit, onHurt.to as never, `心魔种发：${unitNameOf(state, unit)} 当场倒戈`);
			return;
		}

		if (!source || amount <= 0) return;
		const pending = source.custom?.['pendingStrike'] as
			| { mode: 'steal' | 'refine' | 'cause'; ratio: number }
			| undefined;
		if (!pending) return;

		const rest = { ...(source.custom ?? {}) };
		delete rest['pendingStrike'];
		source.custom = rest;

		if (pending.mode === 'steal') {
			// 偷的是**灵石**：它是这个包唯一的通用货币，偷金币对修士没有意义
			const want = Math.floor(amount * pending.ratio);
			const victim = state.players[unit.owner];
			const have = victim ? Number((victim.res ?? {})[SPIRIT_STONE] ?? 0) : 0;
			const take = Math.max(0, Math.min(want, have));
			if (take > 0) {
				addRes(victim!, SPIRIT_STONE, -take);
				addRes(state.players[source.owner], SPIRIT_STONE, take);
				api.pushLog(state, source.owner, `天予不取：从对手处取得 ${take} 灵石`);
			}
			return;
		}

		if (pending.mode === 'refine') {
			addExp(source, state, Math.floor(amount * pending.ratio));
			const before = source.hp;
			source.hp = Math.min(api.maxHpOf(state, source), source.hp + Math.floor(amount * 0.5));
			const healed = source.hp - before;
			api.pushLog(
				state,
				source.owner,
				`炼化：伤害尽归己用` + (healed > 0 ? `，回复 ${healed} 点生命` : ''),
			);
			return;
		}

		// 溯因果：同类型的其他单位挨同样一刀（真伤，不再走护甲）
		const others = state.units.filter(
			(u) => u !== unit && u.hp > 0 && u.type === unit.type && u.owner !== source.owner,
		);
		for (const u of others) {
			api.hurt(state, u, amount, {
				source,
				logText: `${api.utype(state, u.type).name}因因果牵连，受到 ${amount} 点伤害`,
			});
		}
		if (others.length > 0) api.pushLog(state, source.owner, `溯因果：牵连 ${others.length} 名同类`);
	},
	modifyDamage: ({ state, attacker, damage }) => {
    /*
     * 天下皆白：**全场**伤害随回合数放大，施法者本人豁免（唯我独黑）。
     *
     * 放在最前面，因为它是"世界规则"而不是某人的加成——先按世界放大，
     * 再叠加各人的倍率，读起来也符合玩家的直觉。
     *
     * **不设上限**（作者明确要求）：倍率 = 当前回合 × 0.1，第 50 回合就是 ×5。
     * `Math.max(1, …)` 只是让前几回合不至于反而变弱。
     */
    const white = state.units.find(
      (u) => ((u.status?.[WHITE_STATUS] ?? 0) as number) > 0 && u.hp > 0,
    );
    if (white && attacker.id !== white.id) {
      const mul = Math.max(1, state.turn * TIAN_XIA_JIE_BAI_COEF);
      damage = Math.max(1, Math.round(damage * mul));
    }

    if (!isCultivatorUnit(state, attacker)) return damage;
    let out = damage + Math.floor(atkModifier(attacker) * swordMul(attacker));
    /*
     * 族 6 的临时加成。放在这里而不是 `modifyStatAtk`：
     *   · 体术的 ×3 是"打出来的伤害"，不是面板攻击力——写进面板会让玩家
     *     按 ×3 去算攻城和反击，而那两条走的是别的钩子。
     *   · 御风术加的是"本回合移动格数"，只有伤害结算这一拍才知道要不要加。
     */
    const buff = spellBuffsOf(attacker);
    if (buff.atkMul) out = Math.floor(out * buff.atkMul);
    if (buff.wind) out += attacker.moveSpent ?? 0;
    /*
     * 万族之劫：麾下有几种兵，就多几分攻击。
     *
     * 数的是**兵种种类**而不是个数：按个数给会让"爆兵"变成唯一解，
     * 而这条法术的意象是"万族来朝"——凑齐各族比堆同一族更契合。
     */
    if (buff.legion) {
      const kinds = new Set<string>();
      for (const u of state.units) {
        if (u.owner === attacker.owner && u.hp > 0) kinds.add(u.type);
      }
      out += kinds.size;
    }
    return out;
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
		// 护体灵光的盾甲：有盾才加，盾碎/到期就没了（护甲也只挡物理，和法术口径一致）
		return Math.max(0, armor + armorModifier(defender) + (shieldOf(defender)?.armor ?? 0));
	},
	/*
	 * 护体灵光：在扣真血之前把伤害吃掉。
	 *
	 * **碎盾那一击吃掉全部溢出**（作者明确要的手感）：不是"盾剩 5 点就只挡 5 点、
	 * 剩下 30 点穿透"，而是这一击整个被盾吃掉、盾消失。所以 `amount >= hp` 时
	 * 返回的是 `amount`，不是 `hp`。
	 */
	absorbDamage: ({ victim, amount }) => {
		const sh = shieldOf(victim);
		if (!sh) return 0;
		if (amount >= sh.hp) {
			breakShield(victim);
			return amount;
		}
		// 没碎：改 shield.hp 本身（同一个对象，写回 custom 保持一致）
		victim.custom = { ...(victim.custom ?? {}), shield: { ...sh, hp: sh.hp - amount } };
		return amount;
	},
	// 射程修正
	modifyRange: ({ state, unit, range }) => {
		if (!isCultivatorUnit(state, unit)) return range;
		// 灵目术的 +N 格（走 buff，不走兵种表）
		return range + RangeModifier(unit) + (spellBuffsOf(unit).range ?? 0);
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
	/*
	 * 谁会替这个单位挨这一下。
	 *
	 * 顺序：**先替劫灵身，再守御阵**。灵身是"专门为挡刀造出来的"，
	 * 让它先上才符合玩家的预期（造它的钱就是为这一刻花的）；
	 * 守御阵是顺手挡，不该抢在它前面把阵耗掉。
	 */
	redirectDamage: ({ state, victim }) => {
		/*
		 * 张冠李戴排在最前：它是"冲着我来的一切都给他"，
		 * 比替劫灵身（专为挡刀造的）和守御阵（顺手挡）都更根本。
		 */
		const transferred = daiTargetOf(state, victim);
		if (transferred) return transferred;

		const decoyId = victim.custom?.['lingShen'] as string | undefined;
		if (decoyId) {
			const decoy = state.units.find((u) => u.id === decoyId && u.hp > 0);
			// 距离是有意的约束：灵身被远远甩开就不该还替他挨打
			if (decoy && distBetweenUnits(state, victim, decoy) <= TI_JIE_LING_SHEN_BIND_RADIUS) {
				return decoy;
			}
		}
		return guardianFor(state, victim);
	},
	// 视野修正
	modifyVision: ({ state, unit, base }) => {
		if (!unit || !isCultivatorUnit(state, unit)) return base;
		return Math.max(1, base + VisionModifier(unit) + (spellBuffsOf(unit).vision ?? 0));
	},
	// 攻击次数
	modifyAttacks: ({ state, unit, attacks }) => {
    if (unit.type === UNIT_IDS.SPIRIT_TOWER) {
      return (unit.custom?.burstCharges as number) ?? 0;
    }
		if (isCultivatorUnit(state, unit)) {
		  const buff = spellBuffsOf(unit);
		  let out = attacks + attTimesModifier(unit) + (buff.attacks ?? 0);
		  // 破碎虚空：这一回合的攻击次数翻倍（先加后乘，"多打一次"也会被翻）
		  if (buff.attacksMul) out = Math.floor(out * buff.attacksMul);
		  return out;
    }
    return attacks;
	},
	// 溅射半径
	modifySplash: ({ state, attacker, splash }) => {
		if (!isCultivatorUnit(state, attacker)) return splash;
		return splash + SplashModifier(attacker) + (spellBuffsOf(attacker).splash ?? 0);
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
		/*
		 * 法相天地：身形撑不下四格时**动不了**。
		 *
		 * 用"移动力归零"而不是 `canCommand`：卡住的是身子，不是手脚——
		 * 他还能打、还能施法，只是挪不动。用 `canCommand` 会连攻击一起封掉，
		 * 那是另一种法术（封印）的语义。
		 */
		if (giantStuckOf(unit)) return 0;
		// 天魔解体的移动力加成也走 buff（「大幅提升移动速度」）
		return move + moveModifier(unit) + (spellBuffsOf(unit).move ?? 0);
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
		// ① 山河敕令压住的地方不许兴建（任何产兵点都不行）
		const owner = source.kind === 'city' ? source.city.owner : source.camp.owner;
		const at = source.kind === 'city' ? source.city : source.camp;
		for (const m of marksOf(state)) {
			if (m.kind !== 'spell-edict' || m.owner === owner) continue;
			if (m.x !== at.x || m.y !== at.y) continue;
			const cust = (m.custom ?? {}) as { caster?: string; cx?: number; cy?: number };
			const caster = cust.caster ? state.units.find((u) => u.id === cust.caster) : undefined;
			if (!caster || caster.x !== cust.cx || caster.y !== cust.cy) continue;
			return '山河敕令压着这片地，无法兴建';
		}

		// ①b 绝地天通：敌方在术中期间产不出修士
		const sealed = state.units.some(
			(u) => u.owner !== owner && u.hp > 0 && ((u.status?.[SEAL_STATUS] ?? 0) as number) > 0,
		);
		if (sealed && isCultivatorDef(target)) return '绝地天通：天地断绝，修士降不下来';

		// ② 宗门只收修士弟子（原来的规则，顺序不能换：敕令比"收谁"更根本）
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
	// ── 藏经阁：学法术 / 宗门大殿：研发与遗弃（2026-11-08）──
	//
	// 按钮和判定是同一份（`spellLearnProblem` / `researchProblem` / `abandonProblem`）：
	// 面板拿它决定灰不灰，这里拿它决定放不放行。两处各写一遍就会变成
	// "按钮能点、点下去被拒"。
	//
	// 两组按钮从不打架：修士站在藏经阁旁边才有「研修」，宗门大殿自己才有
	// 「研发 / 遗弃」，所以按 `group` 分组渲染就够了。
	unitActions: ({ state, unit, viewer }) => {
		if (unit.owner !== viewer) return [];
		const out: UnitActionOption[] = [];

		// 宗门大殿：研发（花灵石）+ 遗弃（腾出研发额度）
		if (unit.type === SECT_ID) {
			if (underConstruction(unit)) return [];
			for (const sp of SPELLS) {
				const done = isResearched(state, unit.owner, sp.skill.id);
				if (!done) {
					const problem = researchProblem(state, unit.owner, sp);
					out.push({
						id: `research:${sp.skill.id}`,
						group: '研发',
						label: `研发「${sp.skill.name}」`,
						detail: sp.skill.summary,
						disabled: !!problem,
						note: problem ?? `${researchCostOf(sp)} 灵石`,
					});
					continue;
				}
				out.push({
					id: `abandon:${sp.skill.id}`,
					group: '遗弃',
					label: `遗弃「${sp.skill.name}」`,
					detail: '从本方藏书目录里划掉这一门，腾出研发额度；已经学会的修士不受影响',
					confirm: `遗弃「${sp.skill.name}」？这会从本方的藏书目录里划掉它，` +
						`腾出的研发额度可以用来研发别的法术。已经学会的修士保留它，但本方再也教不了新的弟子。`,
					note: '不可撤回',
				});
			}
			return out;
		}

		// 修士：站在生效中的藏经阁旁边才能读；站在静心阁旁边才能忘
		if (!isCultivatorUnit(state, unit)) return [];

		const slots = spellSlotsOf(unit);
		const known = knownSpells(unit);

		if (libraryNextTo(state, unit)) {
			for (const sp of SPELLS) {
				if (known.some((sk) => sk.id === sp.skill.id)) continue;
				const problem = spellLearnProblem(state, unit, sp);
				out.push({
					id: `learn:${sp.skill.id}`,
					group: '研修',
					label: `研读「${sp.skill.name}」`,
					detail: sp.skill.summary,
					disabled: !!problem,
					note: problem ?? `法术位 ${known.length} / ${slots}`,
				});
			}
		}

		if (silentPavilionNextTo(state, unit)) {
			for (const sk of known) {
				const sp = spellOf(sk.id);
				if (!sp) continue;
				const problem = forgetProblem(state, unit, sp);
				out.push({
					id: `forget:${sp.skill.id}`,
					group: '遗忘',
					label: `忘掉「${sp.skill.name}」`,
					detail: '腾出一个法术位；想再学要回藏经阁重新研读',
					confirm: `忘掉「${sp.skill.name}」？这个修士会立刻失去它，` +
						`腾出的法术位可以学别的。要重新学回来，得回藏经阁再读一遍。`,
					disabled: !!problem,
					note: problem ?? `法术位 ${known.length} / ${slots}`,
				});
			}
		}

		/*
		 * 服用：身上有什么就列什么，**不需要站在任何地方**。
		 *
		 * 这是丹药和「法术」「炼丹」最本质的区别：药是随身带的，
		 * 法术要藏书楼、炼丹要炉子，而吃药只取决于"你兜里有没有"。
		 * 也正因为这样，敌方看不到这一组按钮——`unitActions` 只对本人调用，
		 * 而数量在视图层已经被 `redactUnit` 抹掉了。
		 */
		const bag = pillsOf(unit);
		for (const pill of PILLS) {
			const n = bag[pill.id] ?? 0;
			if (n <= 0) continue;
			const problem = pillUseProblem(state, unit, pill);
			out.push({
				id: `use:${pill.id}`,
				group: '服用',
				label: `服下「${pill.name}」`,
				detail: pill.summary,
				disabled: !!problem,
				note: problem ?? `还有 ${n} 颗`,
			});
		}

		// 炼丹：站在炉子旁边才列。三颗都列出来（钱不够就灰着写原因），
		// 和炼器炉"看得见目标"同一口径。
		if (furnaceNextTo(state, unit)) {
			for (const pill of PILLS) {
				const problem = pillBrewProblem(state, unit.owner, unit, pill);
				out.push({
					id: `brew:${pill.id}`,
					group: '炼丹',
					label: `炼制「${pill.name}」`,
					detail: pill.summary,
					disabled: !!problem,
					note: problem ?? `${pill.cost.gold} 金 + ${pill.cost.stone} 灵石`,
				});
			}
		}
		return out;
	},
	onUnitAction: ({ state, unit, actionId }) => {
		const m = /^(learn|research|abandon|forget|use|brew):(.+)$/.exec(actionId);
		if (!m) return `认不出这个操作：${actionId}`;
		const kind = m[1]!;

		/*
		 * 丹药先分流：`use:` / `brew:` 后面是 **PillDef 的 id**，不是法术 id。
		 * 混在下面那句 `spellOf` 里会被当成"没有这门法术"全拦掉。
		 */
		if (kind === 'use' || kind === 'brew') {
			const pill = pillOf(m[2]!);
			if (!pill) return '没有这种丹药';
			if (!isCultivatorUnit(state, unit)) return '只有修士才用丹药';
			const who = state.unitTypes[unit.type]?.name ?? unit.type;

			if (kind === 'use') {
				const problem = pillUseProblem(state, unit, pill);
				if (problem) return problem;
				// 先算效果再扣药：`apply` 返回 null 说明"这一颗现在用不上"，
				// 那时候不能把药扣掉（否则满血点一下就是白扔一颗）
				const log = pill.apply(state, unit);
				if (!log) return `这一颗「${pill.name}」现在用不上`;
				takePill(unit, pill.id);
				push(state, unit.owner, `${who}服下「${pill.name}」，${log}（还剩 ${pillsOf(unit)[pill.id] ?? 0} 颗）`);
				return null;
			}

			const problem = pillBrewProblem(state, unit.owner, unit, pill);
			if (problem) return problem;
			payForPill(state, unit.owner, pill);
			addPill(unit, pill.id);
			push(
				state,
				unit.owner,
				`${who}在炼丹炉旁炼成一颗「${pill.name}」（耗 ${pill.cost.gold} 金 + ${pill.cost.stone} 灵石）`,
			);
			return null;
		}

		const spell = spellOf(m[2]!);
		if (!spell) return '没有这门法术';

		if (kind === 'learn' || kind === 'forget') {
			if (!isCultivatorUnit(state, unit)) return '只有修士能做这件事';
			if (kind === 'learn') {
				const problem = spellLearnProblem(state, unit, spell);
				if (problem) return problem;
				if (!teachSpell(unit, spell)) return `已经会「${spell.skill.name}」了`;
				push(state, unit.owner, `${state.unitTypes[unit.type]?.name ?? unit.type}在藏经阁研读，学会了法术「${spell.skill.name}」`);
				return null;
			}
			const problem = forgetProblem(state, unit, spell);
			if (problem) return problem;
			if (!forgetSpell(unit, spell)) return `本来就不会「${spell.skill.name}」`;
			push(state, unit.owner, `${state.unitTypes[unit.type]?.name ?? unit.type}在静心阁静坐，忘掉了法术「${spell.skill.name}」`);
			return null;
		}

		// 研发 / 遗弃都发生在宗门大殿上：不是大殿就拒绝（否则一个手搓动作能随处改写阵营状态）
		if (state.unitTypes[unit.type]?.id !== SECT_ID) return '只有宗门大殿能做这件事';
		if (underConstruction(unit)) return '宗门大殿还在施工';

		if (kind === 'research') {
			const problem = researchProblem(state, unit.owner, spell);
			if (problem) return problem;
			const cost = researchCostOf(spell);
			addRes(state.players[unit.owner], SPIRIT_STONE, -cost);
			const list = ((state.researched ??= {})[unit.owner] ??= []);
			list.push(spell.skill.id);
			push(state, unit.owner, `宗门大殿研发出法术「${spell.skill.name}」（耗 ${cost} 灵石）`);
			return null;
		}

		const problem = abandonProblem(state, unit.owner, spell);
		if (problem) return problem;
		const list = researchedOf(state, unit.owner).filter((id) => id !== spell.skill.id);
		(state.researched ??= {})[unit.owner] = list;
		push(state, unit.owner, `宗门大殿遗弃了法术「${spell.skill.name}」，研发额度已腾出`);
		return null;
	},
	/*
	 * 隐藏信息：丹药是"藏起来的实力"，敌方数不出你兜里还有几颗。
	 *
	 * **只抹 `custom.pills`**，别的一概不动：境界、灵力这些本来就该看得见
	 * （面板要显示"3 期剑修"，不然连该怕谁都不知道）。buff 也不抹——
	 * 药力是**结果**，藏不住，这正是"看得见吃了药、看不见还有几颗"的分界。
	 *
	 * 只对非本人调用（fog.ts 保证），所以这里不用再判 viewer。
	 */
	redactUnit: ({ unit }) => {
		if (!unit.custom || !('pills' in unit.custom)) return;
		const next = { ...unit.custom };
		delete next.pills;
		unit.custom = next;
	},
	// ── 回合开始：寿元判定 + 打坐 ──────────────────
	onTurnStart: ({ state, player, api }) => {
		/*
		 * ── 族 10 的回合开始结算 ────────────────────────────────
		 *
		 * 三件事都放在"某个人的回合开始"这一拍，因为它们的时钟就是回合：
		 *   · 胎中之谜：倒计时 −1，到 0 倒戈；
		 *   · 血脉侵蚀：按比例掉血（**内生损耗**，不该被守御阵接走、也不触发挨打）；
		 *   · 道化魔染：站在染区里的敌人被染一层，积满两层倒戈。
		 *
		 * 换主一律走 `api.convert`（规则层唯一出口）：它会顺手把"本回合不能再动"
		 * 和"击杀额度清零"做掉。直接改 `owner` 会漏，而且不会报错。
		 */
		for (const u of [...state.units]) {
			if (u.hp <= 0 || u.owner !== player) continue;

			const convertIn = u.custom?.['convertIn'] as { turns: number; to: string } | undefined;
			if (convertIn) {
				if (convertIn.turns <= 1) {
					const rest = { ...(u.custom ?? {}) };
					delete rest['convertIn'];
					u.custom = rest;
					api.convert(state, u, convertIn.to as never, `胎中之谜解开：${unitNameOf(state, u)} 倒戈`);
				} else {
					u.custom = { ...(u.custom ?? {}), convertIn: { ...convertIn, turns: convertIn.turns - 1 } };
				}
			}

			const erode = u.custom?.['erode'] as { pct: number; to: string } | undefined;
			if (erode) {
				const dmg = Math.max(1, Math.round(api.maxHpOf(state, u) * erode.pct));
				api.hurt(state, u, dmg, { attrition: true });
				// 掉到 0 的收场在 onUnitKilled 里（那边会按 erode 直接倒戈）
			}
		}

		/*
		 * 平等图腾：境界动态化 + **连锁反应**。
		 *
		 * 迭代到不动点为止：
		 *   境界↑ → `VisionModifier` 让视野变大 → 看到更强的敌人 → 境界↑ …
		 * 视野里一个修士都没有就直接落到 0（作者要的"全部离开视野就掉 0"）。
		 *
		 * 上限 8 轮只是防"两边都挂着图腾"时的互指无限递归；正常局面两三轮就收敛。
		 */
		for (const u of state.units) {
			if (u.hp <= 0 || u.owner !== player) continue;
			const on = ((u.status?.[EQUALITY_STATUS] ?? 0) as number) > 0;
			if (!on) {
				// 状态没了就把覆盖摘掉，境界回到自己的修为
				if (u.custom && u.custom['rankOverride'] !== undefined) {
					const rest = { ...u.custom };
					delete rest['rankOverride'];
					u.custom = rest;
				}
				continue;
			}
			let best = 0;
			for (let i = 0; i < 8; i++) {
				u.custom = { ...(u.custom ?? {}), rankOverride: best };
				const vision = Math.max(
					1,
					(state.unitTypes[u.type]?.vision ?? 0) + VisionModifier(u) + (spellBuffsOf(u).vision ?? 0),
				);
				let maxEnemy = 0;
				for (const e of state.units) {
					if (e.hp <= 0 || e.owner === u.owner) continue;
					if (!isCultivatorUnit(state, e)) continue;
					if (Math.abs(e.x - u.x) + Math.abs(e.y - u.y) > vision) continue;
					maxEnemy = Math.max(maxEnemy, getRank(e));
				}
				if (maxEnemy === best) break;
				best = maxEnemy;
			}
			u.custom = { ...(u.custom ?? {}), rankOverride: best };
		}

		/*
		 * 斩仙飞刀：记满三回合，刀落。
		 *
		 * 判"挪没挪开"用**记录点**（切比雪夫 1 格内算没动）：草案里的"记录位置"
		 * 只有在"跑得掉"时才有意义，否则它就只是一个延迟 3 回合的伤害。
		 * 落刀用 `attrition`——这一刀没有攻方，也不该被守御阵接走。
		 */
		for (const u of [...state.units]) {
			if (u.hp <= 0) continue;
			const mark = knifeMarkOf(u);
			if (!mark || mark.by !== player) continue;
			if (mark.turns > 1) {
				u.custom = { ...(u.custom ?? {}), feiDao: { ...mark, turns: mark.turns - 1 } };
				continue;
			}
			const rest = { ...(u.custom ?? {}) };
			delete rest['feiDao'];
			u.custom = rest;
			const moved = Math.max(Math.abs(u.x - mark.x), Math.abs(u.y - mark.y));
			if (moved > 1) {
				api.pushLog(state, player, `斩仙飞刀落空：${unitNameOf(state, u)} 已经不在记录的位置`);
				continue;
			}
			api.hurt(state, u, mark.dmg, {
				attrition: true,
				logText: `斩仙飞刀落下：${unitNameOf(state, u)} 受到 ${mark.dmg} 点伤害`,
			});
		}

		// 法相天地：每回合重算一次"卡住没有"（挡路的人走开就自动解开）
		for (const u of state.units) {
			if (u.hp <= 0 || u.owner !== player) continue;
			if (u.custom?.['footprint'] !== 2) continue;
			refreshGiantStuck(state, api, u);
		}

		// 道化魔染：染区里每回合 +1 层
		for (const mark of marksOf(state)) {
			if (mark.kind !== 'spell-tint' || mark.owner !== player) continue;
			for (const u of state.units) {
				if (u.hp <= 0 || u.owner === mark.owner) continue;
				if (!coversTile(state, u, mark.x, mark.y)) continue;
				const tint = u.custom?.['tint'] as { to: string; layers: number } | undefined;
				const layers = (tint?.layers ?? 0) + 1;
				if (layers >= DAO_HUA_MO_RAN_LAYERS) {
					const rest = { ...(u.custom ?? {}) };
					delete rest['tint'];
					u.custom = rest;
					api.convert(state, u, mark.owner, `道化魔染：${unitNameOf(state, u)} 被染透，倒戈`);
				} else {
					u.custom = { ...(u.custom ?? {}), tint: { to: mark.owner, layers } };
				}
			}
		}

		// 灵气场：每方回合走一步。必须在遍历单位之前——它和"谁在场上"无关，
		// 是环境自己的演化；后面的交换读的正是这一步之后的结果。
		stepQiField(state);

		// 众妙之门：每回合给半径内的友方修士添一份修为。
		// 放在"遍历单位刷灵力"之前——它不依赖灵力，也不该被某个修士的死亡顺序影响。
		for (const gate of state.units) {
			if (gate.hp <= 0 || gate.owner !== player) continue;
			const radius = Number(gate.custom?.['gateRadius'] ?? 0);
			const exp = Number(gate.custom?.['gateExp'] ?? 0);
			if (radius <= 0 || exp <= 0) continue;
			for (const u of state.units) {
				if (u.owner !== player || !isCultivatorUnit(state, u)) continue;
				if (distBetweenUnits(state, gate, u) > radius) continue;
				addExp(u, state, exp);
			}
		}

		for (const u of state.units) {
      if (u.owner !== player) continue;
      if (u.owner === player && u.type === UNIT_IDS.SPIRIT_TOWER && u.custom?.burstCharges) {
        delete u.custom.burstCharges;
      }
      if (!isCultivatorUnit(state, u)) continue;
      // 灵力：刷新上限并回一点。放在最前面——它和寿元无关，
      // 一个这回合就要坐化的修士，灵力也该按当前境界结算。
      regenMana(u);
      // 灵气交换：必须等在 regenMana 之后。它补的是"基础恢复完"剩下的缺口——
      // 放在前面，玩家看到的就是"我缺 30、环境补了 8、然后又 +30"这种算不清的账。
      exchangeMana(state, u);
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
	onTurnEnd: ({ state, player, hurt, log }) => {
		clearAnomaliesOfOthers(state, player);

		/*
		 * 化身分神到期。
		 *
		 * 在自己的回合末结算，而不是"每回合都减"：分身是"自己的"召唤物，
		 * 按主人的回合数计才符合"持续 N 回合"的读法。
		 *
		 * 用 `hurt` 而不是直接删：扣血到 0 之后由规则层统一清场，
		 * 死亡流程（战报、经验回流）一条都不会漏。
		 */
		for (const u of state.units) {
			if (u.owner !== player || u.hp <= 0) continue;
			const turns = Number(u.custom?.['cloneTurns'] ?? 0);
			if (!turns) continue;
			const left = turns - 1;
			if (left > 0) {
				u.custom = { ...(u.custom ?? {}), cloneTurns: left };
				continue;
			}
			log(player, `${state.unitTypes[u.type]?.name ?? '化身'}的化身消散了`);
			hurt(u, u.hp);
		}
	},

	// ── 面板信息 ───────────────────────────────────
	// ── 完全封印：被压到 0 移动力的单位不能下任何命令 ──
	// 规则层会在移动/攻击/攻城/放技能/建造五个入口统一问它。
	// 面板上也要写一行，否则玩家只看到"点了没反应"。
	//
	// 麻痹也走这一条：「动不了」必须对移动、攻击、施法同时生效。分散着写
	// 迟早出现"能动但打不了"这种半瘫，而且只在特定动作上复现，很难查。
	// 封印优先于麻痹报理由——封印是持续状态，麻痹只是这一回合的事，
	// 先告诉玩家更根本的那条。
	canCommand: ({ state, unit }) => sealedReasonOf(state, unit) ?? (isStunned(unit) ? '麻痹中，无法行动' : null),
	/*
	 * 山河敕令压住的地不能兴建。
	 *
	 * 判据和留痕那边一致：**施法者还站在原地**才算数（人走了场就散了，
	 * 只是散场的时机在回合结算，这里不能再等那一拍，所以自己复核一次）。
	 * 只封别人的敕令——自己人的场地当然不挡自己。
	 */
	/*
	 * 山河敕令压住的地不能兴建 —— 已经并进上面那个 `produceBlocked` 的 ① 段。
	 * 同一个钩子只能有一个实现，分两处写会互相覆盖（TS 也会直接报重复键）。
	 */
	getUnitPanelLines: ({ state, unit, viewer }) => {
		const lines = getCultivationPanelLines(state, unit, viewer);
		const sealed = sealedReasonOf(state, unit);
		if (sealed) lines.push(`封印：${sealed}`);
		return lines;
	},
	// 空地上有什么，核心不知道——它只认识"平原/森林"，灵气浓度是扩展写在
	// `Tile.custom.qi` 里的。所以文案也由扩展出。
	getTilePanelLines: ({ state, x, y }) => {
		const q = qiAt(state, x, y);
		const src = qiSourceLabel(state, x, y);
		return [`灵气浓度：${Math.round(q)} / ${QI_MAX}${src ? `（${src}）` : ''}`];
	},
	/*
	 * 顶栏那个「灵气」chip：悬停看全图、点一下钉住（交互在 main.ts）。
	 *
	 * 核心拿到的是"哪几格染什么色"，不知道绿色代表浓度——所以这个视图
	 * 换个语境能变成"污染视图""视野视图"，核心一行不用改。
	 */
	boardViews: () => [
		{
			id: 'cultivation-qi',
			label: '灵气',
			hint: '悬停查看视野内的灵气浓度；点一下钉住，再点取消',
			cells: ({ state }) => qiOverlayCells(state),
		},
	],
};

/** 战报里用的兵种名；兵种表被改坏也不该让钩子炸掉 */
function unitNameOf(s: GameState, u: Unit): string {
	return s.unitTypes[u.type]?.name ?? u.type;
}
