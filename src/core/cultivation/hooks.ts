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
import { distBetweenUnits, idx, inBounds, underConstruction } from '../query.ts';

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
	onTurnStart: ({ state, player }) => {
		for (const u of state.units) {
      if (u.owner !== player) continue;
      if (u.owner === player && u.type === UNIT_IDS.SPIRIT_TOWER && u.custom?.burstCharges) {
        delete u.custom.burstCharges;
      }
      if (!isCultivatorUnit(state, u)) continue;
      // 灵力：刷新上限并回一点。放在最前面——它和寿元无关，
      // 一个这回合就要坐化的修士，灵力也该按当前境界结算。
      regenMana(u);
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
	getUnitPanelLines: ({ state, unit, viewer }) => {
		const lines = getCultivationPanelLines(state, unit, viewer);
		const sealed = sealedReasonOf(state, unit);
		if (sealed) lines.push(`封印：${sealed}`);
		return lines;
	},
};