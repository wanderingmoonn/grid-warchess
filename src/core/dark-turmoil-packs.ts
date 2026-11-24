/**
 * 「黑暗动乱」：依赖修真包的剧情扩展（最小可跑版）。
 *
 * ── 这个包要讲什么 ────────────────────────────────────────────────
 *
 * 尸骸仙帝：实力凌驾于九级修士之上，但**和九级修士不一样，它还会老**。
 * 平时缩在「沉眠地」苟延残喘，寿元将尽时出山发动黑暗动乱，
 * 吃掉一切能吃的生物换寿元，然后回去接着睡。
 *
 * ── 这一版做到哪 ─────────────────────────────────────────────────
 *
 * 只做"最小可跑"的那条循环：**衰老 → 寿元不够 → 吞噬同伴续命 → 还是老死**。
 * 仆从、诡异、攻城、关卡结构都还没做。数值全是占位，先看手感再调。
 *
 * ── 几条实现上的约定（改之前先读）────────────────────────────────
 *
 * 1. **不走修真的境界系统**。尸骸仙帝不是修士兵种，`isCultivatorUnit` 不认识它，
 *    所以修真包的"寿元/化道"逻辑不会碰它——反过来，它的寿元也得我们自己记。
 *    好处是不用动修真包，也不用假装它是十级。
 * 2. **年龄用引擎的 `u.age`**。核心每回合给所有单位 `age += 1`（rules.ts 的回合开始），
 *    我们只在"不在沉眠地"时再补 1——这就是"平时 +2、沉眠地 +1"。
 *    不去改核心的年龄规则，也不去拦它。
 * 3. **寿元存在 `custom.lifespan`**（和修真包同一个字段名，但由我们自己读写）。
 *    修真包的 `isDoomed` 只对修士生效，所以不会替我们判死。
 * 4. **对玩家只说模糊的话**。面板上不印具体年数，只说"将熄 / 将尽 / 尚可 / 绵长"——
 *    寿元是这个 boss 的节奏，不该变成一个玩家能精算的倒计时。
 */

import type { Expansion } from './expansions.ts';
import { DAMAGE_STAGE, HIT_STAGE, STRIKE_STAGE, TURN_START } from './ability-hooks.ts';
import type { AbilityApi } from './ability-hooks.ts';
import type { AbilityDef } from './abilities.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';
import { registerSkillAi, registerSkillEffect } from './skill-hooks.ts';
import { registerStatus } from './statuses.ts';
import type { UnitAiCtx, UnitAiProfile, UnitAiResult, UnitAiCandidate } from './expansions.ts';

export const EMPEROR = 'corpse-emperor';
export const SLUMBER = 'slumber-site';
/** 吞噬的寿元 */
const DEVOUR_LIFESPAN = 10;
/** 出生时的寿元（占位值，调的时候改这里） */
const LIFESPAN = 200;
/*
 * 登场年龄现在写在 `AGING` 那张表里（和寿元放在一起），因为它已经不是"全局一个数"：
 * 仙帝 140 / 200，红尘仙 120 / 160。
 *
 * 2026-11-19 那次调的是仙帝：原来 178（只剩 22 年），玩家连修真的门都没摸到，
 * 他就自己老死了——压迫感变成了"没戏"。现在剩 60 年，在沉眠地里每回合 +1，
 * 出山才 +2。**想让玩家更宽裕就往上调这个数**，它是这一关唯一的"倒计时旋钮"。
 */
/** 在沉眠地几格内算"在休整" */
const SLUMBER_RADIUS = 2;
/** 剩余寿元低于这个数才考虑吃同伴 */
const STARVE_LEFT = 8;
/** 周围（这个格数内）敌人少于这个数，就算"不够吃" */
const STARVE_FOES = 2;
/** 出山之后，寿元回到这个数就回去（"吃到够用"） */
const HARVEST_HOME_LEFT = 60;
/** 在外最多待这么多回合，之后就算没吃够也往家走 */
const HARVEST_MAX_OUT = 40;
/** 但寿元低于这个数就不算"没吃够"——那时候它还得继续找吃的 */
const HARVEST_HUNGRY_LEFT = 30;

/**
 * 「出山」：仙帝的来去循环。
 *
 * 两件事：**记住沉眠地在哪**，以及**什么时候该回去**。
 *
 * 回去的判据（作者给的，两条任一成立）：
 *   · 寿元吃掉够用了（回到 `HARVEST_HOME_LEFT`）；
 *   · 在外超过 `HARVEST_MAX_OUT` 个回合、且寿元还在 `HARVEST_HUNGRY_LEFT` 以上
 *     ——"没吃够也得回去了"。
 *
 * 注意第三条的用意：寿元已经掉到 30 以下时**不算没吃够**，它还得继续找吃的。
 * 所以这个兵不是"出门 40 回合必回家"，而是"40 回合后，只要不是快饿死就回家"。
 *
 * 没有这条之前它出山就一路往西，永远不回来——玩家顶不住，剧本也散架了。
 */
const EMPEROR_CYCLE: AbilityDef = {
  id: 'emperor-cycle',
  name: '出山',
  summary: `寿元回到 ${HARVEST_HOME_LEFT} 就回沉眠地；在外超过 ${HARVEST_MAX_OUT} 回合且寿元还在 ${HARVEST_HUNGRY_LEFT} 以上，也会回去。`,
  group: 'support',
  valueLabel: () => `寿元 ≥ ${HARVEST_HOME_LEFT} 就回巢`,
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.self,
        apply: (c) => {
          const { state, self } = c;
          const home = state.units.find((u) => u.owner === self.owner && u.type === SLUMBER && u.hp > 0);
          if (home) self.custom = { ...(self.custom ?? {}), homeX: home.x, homeY: home.y };
          const out = Number(self.custom?.outTurns ?? 0);
          self.custom = { ...(self.custom ?? {}), outTurns: inSlumber(state, self) ? 0 : out + 1 };
        },
      },
    ],
  },
};

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** 这个单位是不是尸骸仙帝 */
const isEmperor = (u: { type: string }): boolean => u.type === EMPEROR;

/** 读我们自己的寿元（没写过就是 undefined） */
function lifespanOf(u: Unit): number | undefined {
  const v = u.custom?.lifespan;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 剩几年（可以为负） */
function yearsLeft(u: Unit): number {
  return (lifespanOf(u) ?? LIFESPAN) - (u.age ?? 0);
}

/** 附近有没有沉眠地 */
function inSlumber(state: GameState, u: Unit): boolean {
  for (const s of state.units) {
    if (s.owner !== u.owner || s.type !== SLUMBER || s.hp <= 0) continue;
    if (dist(s, u) <= SLUMBER_RADIUS) return true;
  }
  return false;
}

/** 模糊的寿元描述：四档，不给数字 */
function lifespanWords(left: number): string {
  if (left <= 0) return '已熄';
  const ratio = left / LIFESPAN;
  if (ratio < 0.05) return '将熄';
  if (ratio < 0.18) return '将尽';
  if (ratio < 0.5) return '尚可';
  return '绵长';
}

/* ══════════════════════════════════════════════════════════════════
 * 一、兵种
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 尸骸仙帝。
 *
 * 数值按"**九级修士之上**"重调（2026-11-19，作者指出原值根本不够看）。
 *
 * 基准（现算的，不是抄的）：一个九级炼气士 = 基础 10 攻 / 0 甲 / 20 血
 * + 境界加成 攻 257 / 甲 119 / 血 9976 / 真元 66 / 射 +4 / 移 +3 / 5 段 / 溅射 2。
 * 也就是 **攻 267 · 甲 119 · 血 9996 · 真伤 66 · 5 段**。
 *
 * 所以这里每一项都要在上面那组之上：攻 340 / 甲 140 / 血 12000 / 暗蚀 80 / 6 段。
 * **唯一的例外是移动力 3**（九级修士是 5）——那是它刻意的弱点：
 * 追不上你，但它射程 6，你也别指望跑得掉。
 *
 * 不去复刻修士那套公式：它本来就不是修士兵种，复刻了也会随修真包改数值漂移。
 *
 * 魔法段（`magicAtk`）已经删掉，120 点并进暗蚀——魔法段是奇想包的东西，这个包不借。
 *
 * 造价写这么高不是让它能造（`summonedOnly` 挡死产线），是给 AI 估值用的：
 * AI 会据此认为"这东西极贵、不能随便送"。
 */
const SHADOW_STEP_SKILL = {
  id: 'shadow-step',
  name: '暗影跳跃',
  summary: '瞬间移动到任意一个暗影格子。走完可以跳、跳完还能走，但攻击之后就不行了。',
  effect: 'shadow-step',
  targeting: 'point' as const,
  radius: 40,
  multiCast: false,
  cooldown: 1,
};

const EMPEROR_DEF: UnitTypeDef = {
  id: EMPEROR,
  name: '尸骸仙帝',
  short: '帝',
  era: 6,
  category: 'combat',
  cost: 2400,
  move: 3,
  atk: 340,
  armor: 140,
  maxHp: 12000,
  range: 6,
  vision: 9,
  burst: 5,
  splash: 2,
  // 黑暗的源头：它自己就在空中、投下 8 格暗影
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 8,
  /*
   * 2026-11-19 作者给的全套词条——"作为黑暗的源头，不能只有白板"。
   * 这一串等于把三系的核心机制全挂在一个兵身上：自己繁殖（化影/黑暗之源/衍脉）、
   * 杀什么长什么（暗影侵蚀/侵染/点化）、越打越厚（化血/增生/汲取）、
   * 还能把人往黑暗里拽（勾魂）、破城断传承。
   * 只有走修真路线练到高层，才有和它对线的资格。
   */
  // 他会自己决定什么时候回沉眠地（没有 profile 的话只会一路往西，永不回头）
  aiAutonomy: 0.35,
  aiProfile: 'emperor-cycle',
  abilities: [
    'swift-aging',
    'emperor-cycle',
    'shadow-erosion',
    'blood-clot',
    'soul-hook',
    'shadow-spawn',
    'blood-infect',
    'shadow-possess',
    'break-lineage',
    'blood-siphon',
    'dull-wit',
    'blood-grow',
    'bone-transmute',
    'dark-source',
    'lineage-well',
  ],
  skills: [
    SHADOW_STEP_SKILL,
    {
      id: 'devour',
      name: '吞噬',
      summary:
        '吞下一个**自己人**，用它的生机换自己的寿元。不耗灵力、没有冷却，' +
        '因为这是它续命的本能，不是战术选择。',
      effect: 'soul-devour',
      targeting: 'point',
      radius: 2,
      power: 1,
      multiCast: true,
    },
  ],
};

/**
 * 沉眠地：一座不会动的建筑。
 *
 * 为什么是建筑而不是"一块地形"：地形改起来要动关卡数据，而建筑可以被刷、
 * 可以被拆、可以进兵种表——也就能被玩家针对（拆了它，仙帝就没地方歇了）。
 * 这一版先只让它"减半衰老"，被拆之后的后果以后再说。
 */
const SLUMBER_DEF: UnitTypeDef = {
  id: SLUMBER,
  name: '沉眠地',
  short: '眠',
  era: 6,
  category: 'building',
  cost: 400,
  move: 0,
  atk: 0,
  armor: 40,
  maxHp: 300,
  range: 0,
  vision: 4,
  summonedOnly: true,
};

/* ══════════════════════════════════════════════════════════════════
 * 二、吞噬：技能效果
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 吞噬自己人。
 *
 * 三条规矩：
 *   · **只能吞自己人**（点敌人那格一律拒绝）——这是"应急食品"，不是攻击技能；
 *   · 目标必须是活着的同伴，且不是自己；
 *   · 走 `api.killUnit` 而不是删数组：那样才走完整的死亡流程
 *     （战报、击杀计数、后续钩子），否则"吃掉"在账面上等于没发生。
 *
 * 换到的寿元直接加在 `custom.lifespan` 上。加寿元不会让它变年轻，
 * 只是让它"还能再撑几年"——所以年龄只增不减，杀得再多也只是续命。
 */
/**
 * 「吞噬」的黑名单：这三样是仙帝自己的来历，不是食物。
 *
 *   · 骨灰罐 —— 他最初就是从这里面爬出来的；
 *   · 成帝碑 —— 他成道的地方；
 *   · 沉眠地 —— 他歇脚的地方（吃了它，自己也没地方睡了）。
 *
 * 写在函数里而不是模块顶层常量：这三个 id 定义在本文件靠后的段落，
 * 顶层建 Set 会撞上 TDZ。
 */
function isDevourBanned(type: string): boolean {
  return type === FUNERARY_URN || type === IMPERIAL_STELE || type === SLUMBER;
}

registerSkillEffect('soul-devour', (c) => {
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '要先选一个同伴所在的格子';
    return;
  }
  // 目标格里找自己人（不占地建筑也行：它们也是"生机"）
  const victim = c.state.units.find(
    (u) => u.owner === c.self.owner && u.hp > 0 && u.id !== c.self.id && u.x === t.x && u.y === t.y,
  );
  if (!victim) {
    c.result.ok = false;
    c.result.reason = '那一格没有可以吞的同伴';
    return;
  }
  if (isDevourBanned(victim.type)) {
    c.result.ok = false;
    c.result.reason = '那不是食物——它吞不掉自己的过去。';
    return;
  }
  const name = c.state.unitTypes[victim.type]?.name ?? victim.type;
  c.api.killUnit(c.state, victim, c.self, `${name}被尸骸仙帝吞下`);
  const before = lifespanOf(c.self) ?? LIFESPAN;
  c.self.custom = { ...(c.self.custom ?? {}), lifespan: before + DEVOUR_LIFESPAN };
  c.result.log = `尸骸仙帝吞噬了${name}，寿元 +${DEVOUR_LIFESPAN}`;
});

/* ══════════════════════════════════════════════════════════════════
 * 三、吞噬：AI 提示
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 什么时候该吃自己人。
 *
 * 三个条件缺一不可（少一条就会变成"它没事就在吃小弟"，玩家看着莫名其妙）：
 *   1. 寿元快没了（剩余 ≤ 8 年）；
 *   2. 周围没什么敌人可吃（2 格内？不，是 8 格内的敌人 < 2）；
 *   3. 半径内确实有一个自己能吞的同伴。
 *
 * 挑谁：**境界最低的优先**，境界一样挑最便宜的——和设计里"从低级开始清理"一致。
 * 返回 200 分：这是保命动作，压过普攻（≈89），但不如"必须做"（1000）。
 */
registerSkillAi('soul-devour', (c) => {
  const left = yearsLeft(c.unit);
  if (left > STARVE_LEFT) return null;
  const nearFoes = c.foes.filter((f) => dist(f, c.unit) <= 8).length;
  if (nearFoes >= STARVE_FOES) return null;

  const reach = c.skill.radius ?? 2;
  const candidates = c.allies
    .filter((a) => a.id !== c.unit.id && a.hp > 0 && dist(a, c.unit) <= reach && !isDevourBanned(a.type))
    // 境界低的先吃；同境界吃便宜的（省得先吃掉主力）
    .sort((a, b) => {
      const ra = Number(a.custom?.rank ?? 0);
      const rb = Number(b.custom?.rank ?? 0);
      if (ra !== rb) return ra - rb;
      const ca = c.state.unitTypes[a.type]?.cost ?? 0;
      const cb = c.state.unitTypes[b.type]?.cost ?? 0;
      return ca - cb;
    });
  const pick = candidates[0];
  if (!pick) return null;
  return { score: 200, x: pick.x, y: pick.y };
});

/* ══════════════════════════════════════════════════════════════════
 * 四、衰老与老死
 * ══════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════════════════
 * 五、影系（2026-11-18）
 *
 * 诡异的第一支：不听指挥，按自己的本能行动。
 * 三个兵 + 一个通用技能（暗影跳跃）。
 *
 * ── 真伤为什么叫「暗蚀」────────────────────────────────────────────
 *
 * 修真那边叫"真元"——那是修士的东西。诡异用同一个词会很出戏，所以单独起名
 * **暗蚀**：无视护甲、每次攻击额外结算一次。实现上和真元是同一条路
 * （`DAMAGE_STAGE.trueDamage` 上加一段），只是换了个名字和一段数值表。
 *
 * ── 数值全是占位的 ────────────────────────────────────────────────
 *
 * 关卡节奏还没定，先按"能看出性格"给：暗影脆而快、蚀影慢而硬一点、影主厚而远。
 * 调的时候改下面这张表，别去改逻辑。
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 化影：几个自己的回合召唤出一个暗影。
 *
 * 2026-11-18 两次调整：4 → 5（跑批发现滚雪球）→ **调回 4**（作者判断：
 * AI 能打赢的局对玩家来说太简单了，以后只要 AI 输得不太难看就没必要削弱）。
 */
export const SUMMON_EVERY = 4;

export const SHADOW_BEAST = 'shadow-beast';
export const SHADE = 'shade';
export const SHADOW_LORD = 'shadow-lord';

/** 暗蚀：每次攻击附带的、无视护甲的伤害。占位值 */
/** 本包注册的能力，按 id 索引（面板印词条时查它，不依赖全局注册表） */
const PACK_ABILITIES = new Map<string, AbilityDef>();

const EROSION_BY_TYPE: Record<string, number> = {
  [SHADOW_BEAST]: 8,
  [SHADE]: 4,
  [SHADOW_LORD]: 15,
  // 血系（2026-11-18）：淤血没有暗蚀，血肉弱，血核强
  'blood-pool': 0,
  flesh: 5,
  'blood-core': 12,
  // 不成系的三个（2026-11-18）：黑蝗几乎不疼、黑茧中等、诡异中等偏高
  'black-locust': 3,
  'black-cocoon': 8,
  unnamable: 10,
  // 裔系里只有子嗣带暗蚀（作者：它"同时拥有真元和暗蚀"）。
  // 眷属/后裔不写：写了也没用——没有「暗蚀」这条能力，那个数不会被读到。
  offspring: 20,
  'mortal-immortal': 50,
  // 仙帝：原 magicAtk 120 指的是同一段伤害，改成暗蚀后取 80
  'corpse-emperor': 80,
};

function erosionOf(u: Unit): number {
  return EROSION_BY_TYPE[u.type] ?? 0;
}

/**
 * 「暗蚀」：和修真的真元走同一条路——在护甲结算之后的 `trueDamage` 阶段加一段伤害。
 *
 * 为什么不做成新字段：伤害管线已经有这个阶段，真元、天气的真伤都挂在这里；
 * 再开一条"无视护甲的额外伤害"只会让"到底谁先算"变成一团。
 */
const EROSION_ABILITY: AbilityDef = {
  id: 'shadow-erosion',
  name: '暗蚀',
  summary: '每次攻击附带一段无视护甲的暗蚀伤害。',
  valueLabel: (def) => `${EROSION_BY_TYPE[def.id] ?? 0} 点`,
  group: 'attack',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.trueDamage,
        apply: (c) => {
          if (c.side !== 'attacker') return;
          const amt = erosionOf(c.self);
          if (amt > 0) c.damage += amt;
        },
      },
    ],
  },
};

/**
 * 「暗影侵蚀」：击杀的单位原地变成蚀影。
 *
 * 从"暗影专属的钩子"改成**词条**（2026-11-18）：以前这条挂在扩展的
 * `onUnitKilled` 里、按兵种 id 判断，别的兵想拥有它只能改代码。
 * 现在谁挂这条能力，谁就带这个后果——贴到新单位上不用动一行逻辑。
 */
const SHADOW_POSSESS: AbilityDef = {
  id: 'shadow-possess',
  name: '暗影侵蚀',
  summary: '击杀单位时，在被击杀的位置生成一个蚀影。',
  group: 'attack',
  hooks: {
    onKill: (c) => {
      if (c.victim.owner === c.self.owner) return;
      const spot = c.api.canStandAt(c.state, c.victim.x, c.victim.y, SHADOW_BEAST)
        ? { x: c.victim.x, y: c.victim.y }
        : freeNear(c.state, c.victim, SHADOW_BEAST, c.api);
      if (!spot) return;
      c.api.spawn(c.state, c.self.owner, SHADOW_BEAST, spot.x, spot.y);
      c.state.log.push({ turn: c.state.turn, player: c.self.owner, text: '被暗影吞噬的尸体爬了起来——蚀影。' });
    },
  },
};

/**
 * 「化影」：每若干回合分裂出一个暗影，**这一回合攻击过则更快**。
 *
 * "攻击过"用一个自定义标记 `custom.hit` 记：攻击时由 `onStrike` 置 1，
 * 回合开始时读一次再清零。为什么不看 `unit.acted`——能力钩子跑在回合开始时，
 * 那一刻 `acted` 已经被重置成 false 了，读不到上一回合打没打。
 */
const SHADOW_SPAWN: AbilityDef = {
  id: 'shadow-spawn',
  name: '化影',
  summary: `每 ${SUMMON_EVERY} 个自己的回合分裂出**两团**暗影；这一回合攻击过的话，来得更快。`,
  group: 'support',
  hooks: {
    onStrike: [
      {
        stage: STRIKE_STAGE.afterDamage,
        apply: (c) => {
          c.self.custom = { ...(c.self.custom ?? {}), hit: 1 };
        },
      },
    ],
    onTurnStart: [
      {
        stage: TURN_START.summon,
        apply: (c) => {
          let left = Number(c.self.custom?.summonIn ?? SUMMON_EVERY);
          const fast = Number(c.self.custom?.hit ?? 0) === 1;
          left -= fast ? 2 : 1;
          c.self.custom = { ...(c.self.custom ?? {}), hit: 0 };
          if (left <= 0) {
            /*
             * 一次分裂**两团**（2026-11-18）：暗影太脆，一个一个来根本铺不开。
             * 两团分开找位置，第二团找不到也照样算这一次召唤完成——
             * 不能因为场上挤就永远卡在"差一格"。
             */
            let born = 0;
            for (let i = 0; i < 2; i += 1) {
              const spot = freeNear(c.state, c.self, SHADE, c.api);
              if (!spot) break;
              c.api.spawn(c.state, c.self.owner, SHADE, spot.x, spot.y);
              born += 1;
            }
            if (born > 0) {
              left = SUMMON_EVERY;
              c.state.log.push({
                turn: c.state.turn,
                player: c.self.owner,
                text: born > 1 ? '影主分裂出两团暗影。' : '影主分裂出一团暗影。',
              });
            } else {
              left = 1; // 一格都没有，下回合再试
            }
          }
          c.self.custom = { ...(c.self.custom ?? {}), summonIn: left };
        },
      },
    ],
  },
};

/* ── 通用技能：暗影跳跃 ─────────────────────────────────────────── */

/** 这一格在暗影领域里吗（只认地球） */
function inShadowCell(state: GameState, x: number, y: number, board?: string): boolean {
  if (board && board !== 'earth') return false;
  const cells = state.overlays?.[SHADOW_KEY];
  if (!cells || cells.length === 0) return false;
  return cells.includes(y * state.w + x);
}

/**
 * 暗影跳跃：瞬移到任意一个暗影格子。
 *
 * 四条规矩：
 *   · 落点必须在暗影领域里——这是它唯一的交通方式，也是这个系列的性格；
 *   · 落点站得下（不能叠在别人身上）；
 *   · **攻击过就不能再跳**：跳是"换个位置"，不是"打完再溜"。但**走完可以跳**、
 *     **跳完也能走**——它和普通移动不是同一个额度，所以这里不碰 `moved`；
 *   · 冷却 1 个自己的回合（等于每回合一次），另由 `skillTurn` 兜住"一回合一次"。
 */
registerSkillEffect('shadow-step', (c) => {
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '要先选一个暗影格子';
    return;
  }
  if (c.self.acted) {
    c.result.ok = false;
    c.result.reason = '攻击之后就不能再跳了';
    return;
  }
  if (!inShadowCell(c.state, t.x, t.y, c.self.board)) {
    c.result.ok = false;
    c.result.reason = '只能跳进暗影领域';
    return;
  }
  if (!c.api.canStandAt(c.state, t.x, t.y, c.self.type)) {
    c.result.ok = false;
    c.result.reason = '那一格站不下';
    return;
  }
  const from = `${c.self.x},${c.self.y}`;
  c.self.x = t.x;
  c.self.y = t.y;
  c.result.log = `暗影跳跃：${from} → ${t.x},${t.y}`;
});

/* ── 三个兵 ─────────────────────────────────────────────────────── */

/**
 * 蚀影（被暗影侵蚀的生物）。
 *
 * 名字是补的：原文"被暗影侵蚀的生物"太长，做兵种名牌放不下。
 * 备选：影蚀体 / 侵影。定稿改这里就行。
 */
const SHADOW_BEAST_DEF: UnitTypeDef = {
  id: SHADOW_BEAST,
  name: '蚀影',
  short: '蚀',
  era: 6,
  category: 'combat',
  cost: 90,
  move: 2,
  atk: 22,
  armor: 6,
  maxHp: 55,
  range: 1,
  vision: 5,
  summonedOnly: true,
  shadowRadius: 4,
  aiAutonomy: 1,
  aiProfile: 'shadow-beast-edge',
  /*
   * 2026-11-18 作者调整：蚀影不再有「化影」（那是影主的特权），改挂「暗影侵蚀」。
   * 现在影系三兵人人都有侵蚀，但**只有影主能生出暗影**——
   * 之前"暗影生蚀影、蚀影又生暗影"把血系"自己繁殖"的特点抢走了。
   */
  abilities: ['shadow-erosion', 'shadow-possess', 'dull-wit'],
  skills: [SHADOW_STEP_SKILL],
};

/**
 * 暗影（一团会杀人的影子）。
 *
 * 血薄、甲厚——"打不着实体"这件事用护甲表示，而不是给它闪避率：
 * 这套引擎里没有命中判定，护甲是唯一"看起来打中了，其实没伤到"的表达。
 * 杀死单位后在原地生出蚀影——所以它越打越多，玩家的清场顺序会变得重要。
 */
const SHADE_DEF: UnitTypeDef = {
  id: SHADE,
  name: '暗影',
  short: '影',
  era: 6,
  category: 'combat',
  cost: 120,
  move: 5,
  atk: 10,
  /*
   * 血量 40 → 30、护甲 12 → 16（2026-11-18 作者）。
   * 更薄、更"没有实体"——它是靠数量和不占地面的飞行层活着的，
   * 不该硬到能站住对拼。
   */
  armor: 16,
  maxHp: 30,
  range: 2,
  vision: 6,
  burst: 3,
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 2,
  aiAutonomy: 1,
  aiProfile: 'shade-spread',
  abilities: ['shadow-erosion', 'shadow-possess', 'dull-wit'],
  skills: [SHADOW_STEP_SKILL],
};

/**
 * 影主（第一任暗影之主是尸骸仙帝的影子）。
 *
 * 远程、厚、甲高、攻击次数多，还会自己召唤暗影——它不走，它让暗影走。
 * 计时器用 `custom.summonIn`，写在钩子里（见 `tickShadowLords`）。
 */
const SHADOW_LORD_DEF: UnitTypeDef = {
  id: SHADOW_LORD,
  name: '影主',
  short: '主',
  era: 6,
  category: 'combat',
  cost: 400,
  move: 2,
  atk: 40,
  // 15 → 10（同上）：两个影主在前线时，15 甲让玩家整局打不掉一只。
  armor: 10,
  maxHp: 220,
  range: 4,
  vision: 8,
  burst: 2,
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 8,
  aiAutonomy: 1,
  aiProfile: 'shadow-lord-kite',
  // 影主也带「暗影侵蚀」：它自己打死的也要站起来
  abilities: ['shadow-erosion', 'shadow-spawn', 'shadow-possess', 'dull-wit'],
  skills: [SHADOW_STEP_SKILL],
};

/* ── 行为：三个 profile ─────────────────────────────────────────── */

/** 四向可达格（含脚下），和技能/走位同一套判断 */
function steps(c: UnitAiCtx, n: number): Array<{ x: number; y: number; d: number }> {
  const start = { x: c.unit.x, y: c.unit.y, d: 0 };
  const seen = new Map<string, { x: number; y: number; d: number }>([[`${start.x},${start.y}`, start]]);
  let frontier = [start];
  for (let i = 0; i < n; i += 1) {
    const next: typeof frontier = [];
    for (const p of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = p.x + dx;
        const y = p.y + dy;
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        if (!c.api.canStandAt(c.state, x, y, c.unit.type)) continue;
        const node = { x, y, d: p.d + 1 };
        seen.set(key, node);
        next.push(node);
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}

/** 这一格贴着暗影边界吗（自己在暗影里，四邻里至少有一个不在） */
function onShadowEdge(c: UnitAiCtx, x: number, y: number): boolean {
  if (!inShadowCell(c.state, x, y, c.unit.board)) return false;
  return (
    !inShadowCell(c.state, x + 1, y, c.unit.board) ||
    !inShadowCell(c.state, x - 1, y, c.unit.board) ||
    !inShadowCell(c.state, x, y + 1, c.unit.board) ||
    !inShadowCell(c.state, x, y - 1, c.unit.board)
  );
}

/** 能不能跳（冷却/这一回合放没放/攻击过没有）。只看自己身上那几个字段，不查规则层 */
function canStep(c: UnitAiCtx): boolean {
  if (c.unit.acted) return false;
  if (c.unit.skillTurn === c.state.turn) return false;
  return (c.unit.skillCd?.['shadow-step'] ?? 0) <= 0;
}

/**
 * 在暗影领域里挑一个"跳过去"的落点。`score` 越大越好；返回 null 表示没有更好的。
 *
 * 为什么要传打分函数：三个兵对同一个落点的看法完全不同——
 * 蚀影要边界、影主要最深处。挑点的逻辑只有一份，口味由调用方给。
 */
function bestShadowJump(
  c: UnitAiCtx,
  score: (x: number, y: number) => number,
): { x: number; y: number; s: number } | null {
  const cells = c.state.overlays?.[SHADOW_KEY] ?? [];
  if (cells.length === 0) return null;
  let best: { x: number; y: number; s: number } | null = null;
  for (const i of cells) {
    const x = i % c.state.w;
    const y = Math.floor(i / c.state.w);
    if (x === c.unit.x && y === c.unit.y) continue;
    if (!c.api.canStandAt(c.state, x, y, c.unit.type)) continue;
    const s = score(x, y);
    if (!best || s > best.s) best = { x, y, s };
  }
  return best;
}

/**
 * 同类之间"不过分靠近"的打分惩罚。
 *
 * 2026-11-18 作者定的手感：影主之间、血核之间平均保持 **2 格**；
 * 影主和血核之间不限制（各是各的根，凑一起反而更好看）。
 * 所以惩罚只按**同兵种**算：距离 2 及格，1 和 0 才扣分——
 * 这样"往暗影深处走"和"别贴在一起"叠起来，平衡点正好落在 2 格左右。
 */
function kinCrowd(c: UnitAiCtx, at: { x: number; y: number }, type: string): number {
  const kin = c.allies.filter((a) => a.type === type && a.id !== c.unit.id && a.hp > 0);
  if (kin.length === 0) return 0;
  const near = Math.min(...kin.map((k) => dist(k, at)));
  return near >= 2 ? 0 : (2 - near) * 14;
}

/** 离最近敌人有多远（没有敌人时给 Infinity） */
function nearestFoe(c: UnitAiCtx, at: { x: number; y: number }): number {
  return Math.min(...c.foes.map((f) => dist(f, at)), Infinity);
}

/** 这个敌人身边有几个同伴（"落单"的判据：身边没人） */
function escortOf(c: UnitAiCtx, target: Unit): number {
  return c.foes.filter((f) => f.id !== target.id && dist(f, target) <= 2).length;
}

/** 威胁大小：能打出多少伤害（物攻 + 法攻），血越少越"好欺负"只是附加项 */
function threatOf(c: UnitAiCtx, u: Unit): number {
  const d = c.state.unitTypes[u.type];
  return (d?.atk ?? 0) + (d?.magicAtk ?? 0);
}

/**
 * 蚀影：**优先扑落单的生物**，站在暗影边界上。
 *
 * "落单"的定义：两格内没有别的敌人。为什么用这个而不是"血最少"——
 * 它是从黑影里伸出来的手，抓的是掉队的人；扑进人堆只会被围死。
 *
 * 顺序：先看有没有落单的能打到 → 站不到边界就找边界（走不到就跳过去）。
 */
const SHADOW_BEAST_AI: UnitAiProfile = {
  id: 'shadow-beast-edge',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 1;
    const inRange = c.foes.filter((f) => dist(f, c.unit) <= range);

    // 1）够得着的落单目标，优先级最高
    const lone = inRange
      .filter((f) => escortOf(c, f) === 0)
      .sort((a, b) => a.hp - b.hp)[0];
    if (lone) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: lone.id }, score: 180 });

    /*
     * 2）够不着但看得见的落单目标：**从影子里扑过去**。
     *
     * 这是暗影跳跃存在的意义——它是伏击者，不是追人的猎犬。
     * 条件：目标落单 + 它旁边有一格在暗影里（从那里出来正好贴脸）。
     */
    if (canStep(c)) {
      const far = c.foes
        .filter((f) => dist(f, c.unit) > range && escortOf(c, f) === 0)
        .sort((a, b) => a.hp - b.hp)[0];
      if (far) {
        const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dy]) => ({ x: far.x + dx!, y: far.y + dy! }))
          .find((p2) => inShadowCell(c.state, p2.x, p2.y, c.unit.board) && c.api.canStandAt(c.state, p2.x, p2.y, c.unit.type));
        if (spot) {
          add.push({
            action: { type: 'HERO_SKILL', unitId: c.unit.id, skillId: 'shadow-step', targetX: spot.x, targetY: spot.y },
            score: 165,
          });
        }
      }
    }

    // 3）守住边界：已经在边界就不动，让全局去决定打谁
    if (!onShadowEdge(c, c.unit.x, c.unit.y)) {
      const walk = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0 && onShadowEdge(c, p.x, p.y));
      const walkBest = walk.sort((a, b) => nearestFoe(c, a) - nearestFoe(c, b))[0];
      if (walkBest) {
        add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: walkBest.x, y: walkBest.y }, score: 120 });
      } else if (canStep(c)) {
        // 走不到边界：跳过去（暗影域里离敌人最近的边界格）
        const jump = bestShadowJump(c, (x, y) =>
          onShadowEdge(c, x, y) ? -nearestFoe(c, { x, y }) : -9999,
        );
        if (jump && jump.s > -9999) {
          add.push({ action: { type: 'HERO_SKILL', unitId: c.unit.id, skillId: 'shadow-step', targetX: jump.x, targetY: jump.y }, score: 130 });
        }
      }
    }
    return add.length ? { add } : {};
  },
};

/**
 * 暗影：**优先补刀**，同时跟同类散开。
 *
 * 补刀的定义就是字面意思：射程内挑血最少的打。它一回合 3 段，
 * 常常"第一段砍死、后两段换目标"，所以这里只负责指出"先打谁"，
 * 剩下的交给全局（每一步都会重算）。
 */
const SHADE_AI: UnitAiProfile = {
  id: 'shade-spread',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 2;
    const inRange = c.foes.filter((f) => dist(f, c.unit) <= range);
    const prey = [...inRange].sort((a, b) => a.hp - b.hp)[0];
    if (prey) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: prey.id }, score: 170 });

    // 同类太近就散开（叠着浪费暗影半径，也浪费输出位）
    const kin = c.allies.filter((a) => a.type === SHADE && a.id !== c.unit.id && a.hp > 0);
    if (kin.length > 0 && Math.min(...kin.map((k) => dist(k, c.unit))) <= 3) {
      const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
      let best: { x: number; y: number } | null = null;
      let bestScore = -Infinity;
      for (const p of tiles) {
        const away = Math.min(...kin.map((k) => dist(k, p)), Infinity);
        const near = nearestFoe(c, p);
        const score = away * 2 - near * 0.3;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      if (best) add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 120 });
    }
    return add.length ? { add } : {};
  },
};

/**
 * 「暗影深处」：暗影领域里离边界最远的那一格。
 *
 * 为什么不用重心：重心可以是**暗影外**的格子（一团环形、或者两块分开的黑雾，
 * 重心正好落在中间那块亮处），也可能被一块又长又细的影子拉到边界上。
 * "离边界最远"这一格**按定义就在暗影里**，而且越深的格子越安全——
 * 影主往里一缩，玩家就得把整片黑雾翻开才找得到它。
 *
 * 代价每次都要 BFS 一遍，所以按 overlay 数组对象缓存（同一回合里数组不变）。
 */
const depthCache = new WeakMap<number[], Map<number, number>>();

function shadowDepth(state: GameState): Map<number, number> {
  const cells = state.overlays?.[SHADOW_KEY] ?? [];
  const hit = depthCache.get(cells);
  if (hit) return hit;
  const set = new Set(cells);
  const depth = new Map<number, number>();
  // 多源 BFS：从"挨着非暗影（或地图外）的暗影格"出发，逐层往里
  const queue: number[] = [];
  for (const i of cells) {
    const x = i % state.w;
    const y = Math.floor(i / state.w);
    const edge =
      !set.has((y) * state.w + x + 1) || !set.has(y * state.w + x - 1) ||
      !set.has((y + 1) * state.w + x) || !set.has((y - 1) * state.w + x);
    if (edge) {
      depth.set(i, 1);
      queue.push(i);
    }
  }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const i = queue[qi]!;
    const d = depth.get(i)!;
    const x = i % state.w;
    const y = Math.floor(i / state.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= state.w || ny >= state.h) continue;
      const j = ny * state.w + nx;
      if (!set.has(j) || depth.has(j)) continue;
      depth.set(j, d + 1);
      queue.push(j);
    }
  }
  depthCache.set(cells, depth);
  return depth;
}

/** 暗影最深的一格（同深度取离自己近的，少走两步） */
function deepestShadow(state: GameState, from: { x: number; y: number }): { x: number; y: number } | null {
  const depth = shadowDepth(state);
  let best: { x: number; y: number } | null = null;
  let bestD = -1;
  let bestDist = Infinity;
  for (const [i, d] of depth) {
    if (d < bestD) continue;
    const x = i % state.w;
    const y = Math.floor(i / state.w);
    const dd = dist(from, { x, y });
    if (d > bestD || dd < bestDist) {
      bestD = d;
      bestDist = dd;
      best = { x, y };
    }
  }
  return best;
}

/**
 * 影主：**优先打威胁大的**；不贴身；没事的时候往暗影最深处躲。
 *
 * 三条按优先级排：
 *   1. 射程内有敌人 → 打"能打出最多伤害的那个"（影主自己怕的就是它）；
 *   2. 敌人贴到 3 格内 → 退；
 *   3. 一个敌人都看不见 → 回暗影深处（走不到就跳）。
 *
 * 第 3 条是本轮新加的：以前它只会"不退就交给全局"，全局会把它往前线拱。
 * 影主跑到前线等于把召唤器送到刀口上，压力太大。
 */
const SHADOW_LORD_AI: UnitAiProfile = {
  id: 'shadow-lord-kite',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 4;
    const inRange = c.foes.filter((f) => dist(f, c.unit) <= range);

    // 1）打威胁最大的
    const scary = [...inRange].sort((a, b) => threatOf(c, b) - threatOf(c, a) || a.hp - b.hp)[0];
    if (scary) {
      add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: scary.id }, score: 190 });
      return { add };
    }

    // 2）贴身了就往后退
    const nearest = nearestFoe(c, c.unit);
    if (nearest <= 3) {
      const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
      let best: { x: number; y: number } | null = null;
      let bestNear = nearest;
      for (const p of tiles) {
        const near = nearestFoe(c, p);
        if (near > bestNear) {
          bestNear = near;
          best = p;
        }
      }
      if (best) {
        add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 150 });
      }
      return { add };
    }

    // 3）没敌人：回暗影深处
    const deep = deepestShadow(c.state, c.unit);
    if (!deep) return {};
    /*
     * 站在最深处也**不直接摆烂走人**：同类别贴太近时它还是要挪一格。
     * "不动"交给下面的打分判（站着的分 vs 挪一步的分），不在这儿一刀切返回。
     */
    /*
     * 深处还很远（走路一步到不了）就直接跳进去——"化进影子里"，
     * 比一步步往回爬更像影主。近了才走，免得每回合都在天上闪。
     */
    const gap = dist(c.unit, deep);
    if (canStep(c) && gap > Math.max(1, c.def.move) + 2) {
      add.push({
        action: { type: 'HERO_SKILL', unitId: c.unit.id, skillId: 'shadow-step', targetX: deep.x, targetY: deep.y },
        score: 140,
      });
      return { add };
    }
    /*
     * 走位打分 = 离深处多近 − 和同类的挤压。只在"比站着更好"时才挪，
     * 所以两个影主会各自找一个又深、彼此又隔开两格的位置，而不是叠在同一个最深点上。
     */
    const here = -gap - kinCrowd(c, c.unit, SHADOW_LORD);
    let best: { x: number; y: number; s: number } | null = null;
    for (const p of steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0)) {
      const s2 = -dist(p, deep) - kinCrowd(c, p, SHADOW_LORD);
      if (s2 > here + 0.5 && (!best || s2 > best.s)) best = { x: p.x, y: p.y, s: s2 };
    }
    if (best) add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 120 });
    return add.length ? { add } : {};
  },
};

/* ── 影主的召唤计时器 ───────────────────────────────────────────── */



/** 找到附近一格能站的位置（八邻域，先近后远） */
function freeNear(state: GameState, u: Unit, type: string, api: AbilityApi): { x: number; y: number } | null {
  for (let r = 1; r <= 3; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.abs(dx) + Math.abs(dy) !== r) continue;
        const x = u.x + dx;
        const y = u.y + dy;
        if (api.canStandAt(state, x, y, type)) return { x, y };
      }
    }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════
 * 六、血系（2026-11-18）
 *
 * 诡异的第二支。三个兵共用四条机制：
 *
 *   化血  造成的伤害累计成"血"，攒够了在旁边长出一滩**淤血**（一回合最多两滩）
 *   侵染  击杀的单位**变成血肉**（不是死，是换了个兵种站起来）
 *   汲取  按造成的伤害等量回血（血肉 / 血核，淤血没有）
 *   增生  血核专属：每回合回一点血；**满血**时攒计数，攒够长出一团血肉
 *
 * 为什么"化血/侵染/增生"都做成副作用而不是技能：它们不需要玩家（或者 AI）
 * 去点按钮——这本来就是它们活着的方式。做成技能只会多出"忘记点"这种失败状态。
 *
 * 数值全是占位：先让"越打越多"这条曲线看得出来。
 * ══════════════════════════════════════════════════════════════════ */

export const BLOOD_POOL = 'blood-pool';
export const FLESH = 'flesh';
export const BLOOD_CORE = 'blood-core';

/**
 * 造成多少伤害攒够一滩淤血。
 *
 * 60 → 100 → **80**（作者定的终值）：淤血一回合 3 段 ×14 攻 ≈ 42 点，
 * 60 时三滩一起打 1.5 回合就长一滩，滚得比玩家清得还快；80 是折中。
 *
 * 导出给探针：断言"攒够阈值就长"，而不是"攒够 60 就长"——数值一调探针就红，
 * 那是探针在替数值背锅（项目自己的规矩）。
 */
export const CLOT_DAMAGE = 80;
/** 一回合最多长几滩（不封顶会雪崩：一次溅射打五个兵就长五滩） */
const CLOT_PER_TURN = 2;
/** 血核满血多少回合长一团血肉（导出给探针） */
export const GROW_TURNS = 3;
/** 血核每回合回多少血（增生） */
const GROW_HEAL = 12;
/**
 * 血系的四条词条（2026-11-18 改成能力）。
 *
 * 改之前它们写死在扩展钩子里、按兵种 id 判断（`isBlood(type)`），
 * 结果是"想给新兵加个化血"必须改代码，而且**面板和规则书各写一份说明**
 * （血肉/血核的暗蚀只出现在面板上，就是这么漏的）。
 * 现在谁挂这条能力，谁就带这个后果，数值由 `valueLabel` 统一给面板和规则书。
 */

/**
 * 「化血」：造成的伤害累计成"血"，攒够就在旁边长出一滩淤血。
 *
 * 两件事合在一条词条里：伤害记账（damage 钩子）+ 结算（回合开始的召唤段）。
 * 上限 `CLOT_PER_TURN` 是防雪崩的——一次溅射打五个兵就长五滩，两回合滚成十几滩。
 */
const BLOOD_CLOT: AbilityDef = {
  id: 'blood-clot',
  name: '化血',
  summary: `造成的伤害累计成「血」：每 ${CLOT_DAMAGE} 点就在旁边长出一滩淤血（一回合最多两滩）。`,
  group: 'attack',
  hooks: {
    damage: [
      {
        stage: DAMAGE_STAGE.trueDamage,
        apply: (c) => {
          if (c.side !== 'attacker') return;
          const dmg = Math.max(0, Math.round(c.damage));
          if (dmg <= 0) return;
          const blood = Number(c.self.custom?.blood ?? 0) + dmg;
          c.self.custom = { ...(c.self.custom ?? {}), blood };
        },
      },
    ],
    onTurnStart: [
      {
        stage: TURN_START.summon,
        apply: (c) => {
          let blood = Number(c.self.custom?.blood ?? 0);
          if (blood < CLOT_DAMAGE) return;
          const rounds = Math.min(CLOT_PER_TURN, Math.floor(blood / CLOT_DAMAGE));
          let born = 0;
          for (let i = 0; i < rounds; i += 1) {
            const spot = freeNear(c.state, c.self, BLOOD_POOL, c.api);
            if (!spot) break;
            c.api.spawn(c.state, c.self.owner, BLOOD_POOL, spot.x, spot.y);
            born += 1;
          }
          if (born > 0) {
            blood -= born * CLOT_DAMAGE;
            c.state.log.push({ turn: c.state.turn, player: c.self.owner, text: '血又厚了一层——新的淤血聚了起来。' });
          }
          c.self.custom = { ...(c.self.custom ?? {}), blood };
        },
      },
    ],
  },
};

/** 「汲取」：按造成的伤害等量回血（上限不超过生命上限）。 */
const BLOOD_SIPHON: AbilityDef = {
  id: 'blood-siphon',
  name: '汲取',
  summary: '按造成的伤害等量回复自己的生命，上限不超过生命上限。',
  group: 'attack',
  hooks: {
    onStrike: [
      {
        stage: STRIKE_STAGE.afterDamage,
        apply: (c) => {
          if (c.damage <= 0 || c.self.hp <= 0) return;
          const max = c.api.maxHpOf(c.state, c.self);
          const healed = Math.min(max - c.self.hp, Math.round(c.damage));
          if (healed > 0) {
            c.self.hp += healed;
            c.result.healed = healed;
          }
        },
      },
    ],
  },
};

/** 「侵染」：击杀的单位变成血肉（和「暗影侵蚀」同一类后果，产物不同）。 */
const BLOOD_INFECT: AbilityDef = {
  id: 'blood-infect',
  name: '侵染',
  summary: '击杀单位时，在被击杀的位置生成一团血肉。',
  group: 'attack',
  hooks: {
    onKill: (c) => {
      if (c.victim.owner === c.self.owner) return;
      const spot = c.api.canStandAt(c.state, c.victim.x, c.victim.y, FLESH)
        ? { x: c.victim.x, y: c.victim.y }
        : freeNear(c.state, c.victim, FLESH, c.api);
      if (!spot) return;
      c.api.spawn(c.state, c.self.owner, FLESH, spot.x, spot.y);
      c.state.log.push({ turn: c.state.turn, player: c.self.owner, text: '尸体鼓胀变形，重新站了起来——血肉。' });
    },
  },
};

/**
 * 「增生」：每回合回一点血；**满血**时攒计数，攒够剥出一团血肉。
 *
 * "满血才攒"是这条的题眼：逼玩家在它满血的时候动手，而不是先削一半再放着。
 */
const BLOOD_GROW: AbilityDef = {
  id: 'blood-grow',
  name: '增生',
  summary: `每回合回复 ${GROW_HEAL} 点生命；生命已满时累计 1 层，攒够 ${GROW_TURNS} 层剥出一团血肉。`,
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.summon,
        apply: (c) => {
          const max = c.api.maxHpOf(c.state, c.self);
          if (c.self.hp < max) c.self.hp = Math.min(max, c.self.hp + GROW_HEAL);
          if (c.self.hp < max) {
            c.self.custom = { ...(c.self.custom ?? {}), grow: 0 };
            return;
          }
          const grow = Number(c.self.custom?.grow ?? 0) + 1;
          if (grow < GROW_TURNS) {
            c.self.custom = { ...(c.self.custom ?? {}), grow };
            return;
          }
          const spot = freeNear(c.state, c.self, FLESH, c.api);
          if (!spot) {
            c.self.custom = { ...(c.self.custom ?? {}), grow: GROW_TURNS - 1 };
            return;
          }
          c.api.spawn(c.state, c.self.owner, FLESH, spot.x, spot.y);
          c.self.custom = { ...(c.self.custom ?? {}), grow: 0 };
          c.state.log.push({ turn: c.state.turn, player: c.self.owner, text: '血核鼓起一块——血肉从它身上剥了下来。' });
        },
      },
    ],
  },
};

/* ── 三个兵 ─────────────────────────────────────────────────────── */

/** 淤血：一滩活着的脓血。中速、中近程、多段、脆但甲高。 */
const BLOOD_POOL_DEF: UnitTypeDef = {
  id: BLOOD_POOL,
  name: '淤血',
  short: '淤',
  era: 6,
  category: 'combat',
  cost: 100,
  move: 3,
  atk: 14,
  armor: 10,
  maxHp: 45,
  range: 2,
  vision: 5,
  burst: 3,
  summonedOnly: true,
  shadowRadius: 1,
  aiAutonomy: 1,
  aiProfile: 'blood-pool-seek',
  abilities: ['blood-clot', 'blood-infect', 'dull-wit'],
};

/** 血肉：一团活着的死肉。慢、近战、血厚甲高，会吸血。 */
const FLESH_DEF: UnitTypeDef = {
  id: FLESH,
  name: '血肉',
  short: '肉',
  era: 6,
  category: 'combat',
  cost: 150,
  move: 2,
  atk: 26,
  // 12 → 8（2026-11-18 跑批后调）：160 血 + 12 甲 + 每回合吸 31 血，
  // 第 5 代的兵打它净伤害是负的，整局杀不掉一团。
  armor: 8,
  // 160 → 130（2026-11-18 作者：血系太肉，既给影系铺暗影又打不死）
  maxHp: 130,
  range: 1,
  vision: 4,
  summonedOnly: true,
  shadowRadius: 1,
  aiAutonomy: 1,
  aiProfile: 'flesh-away-core',
  abilities: ['blood-clot', 'blood-infect', 'blood-siphon', 'shadow-erosion', 'dull-wit'],
};

/** 血核：血肉结晶。慢、中近程、溅射大、会增生。 */
const BLOOD_CORE_DEF: UnitTypeDef = {
  id: BLOOD_CORE,
  name: '血核',
  short: '核',
  era: 6,
  category: 'combat',
  cost: 380,
  move: 2,
  atk: 45,
  armor: 10,
  maxHp: 200,
  range: 3,
  vision: 6,
  // 溅射：它是"结晶炸开"，不是"精准点射"
  splash: 2,
  summonedOnly: true,
  shadowRadius: 4,
  aiAutonomy: 1,
  aiProfile: 'blood-core-deep',
  abilities: ['blood-clot', 'blood-infect', 'blood-siphon', 'blood-grow', 'shadow-erosion', 'dull-wit'],
};

/* ── 结算：化血长出淤血、血核增生 ───────────────────────────────── */

/* ── 行为：三个 profile ─────────────────────────────────────────── */

/** 这个单位是不是敌方经济单位（产线的、挖矿的、盖房的） */
const isEconomy = (c: UnitAiCtx, u: Unit): boolean => c.state.unitTypes[u.type]?.category === 'economy';

/**
 * 淤血：**贴着血肉走，去咬敌人的饭碗**。
 *
 * 为什么盯经济单位：它一滩一滩地爬，正面打不过任何正规军；但钻到矿区里，
 * 对面就得回头清场——这正是"血系拖住你发育"的方式。
 * 优先靠近血量：它和血肉是一摊东西，聚在一起才挡得住清场。
 */
const BLOOD_POOL_AI: UnitAiProfile = {
  id: 'blood-pool-seek',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 2;

    // 1）够得着的经济单位优先打
    const eco = c.foes
      .filter((f) => dist(f, c.unit) <= range && isEconomy(c, f))
      .sort((a, b) => a.hp - b.hp)[0];
    const any = c.foes.filter((f) => dist(f, c.unit) <= range).sort((a, b) => a.hp - b.hp)[0];
    const prey = eco ?? any;
    if (prey) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: prey.id }, score: eco ? 175 : 120 });

    // 2）往"血肉 / 经济单位"那边凑
    const kin = c.allies.filter((a) => a.type === FLESH && a.hp > 0);
    const targets = [...kin, ...c.foes.filter((f) => isEconomy(c, f))];
    if (targets.length > 0) {
      const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
      let best: { x: number; y: number } | null = null;
      let bestD = Math.min(...targets.map((t) => dist(t, c.unit)));
      for (const p of tiles) {
        const d = Math.min(...targets.map((t) => dist(t, p)));
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best) add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 110 });
    }
    return add.length ? { add } : {};
  },
};

/**
 * 血肉：**离血核远一点**，优先啃护甲薄的。
 *
 * 为什么要离血核远：血核是这一片的根，血肉挤在根上等于把鸡蛋放在一个篮子里；
 * 散开之后玩家得同时处理好几摊，清场成本翻倍。
 * 打护甲薄的则是它的本能——26 攻打在高甲上几乎是 0。
 */
const FLESH_AI: UnitAiProfile = {
  id: 'flesh-away-core',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 1;

    const soft = c.foes
      .filter((f) => dist(f, c.unit) <= range)
      .sort((a, b) => (c.state.unitTypes[a.type]?.armor ?? 0) - (c.state.unitTypes[b.type]?.armor ?? 0))[0];
    if (soft) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: soft.id }, score: 170 });

    /*
     * 散开：离血核远一点，**也离别的血肉远一点**。
     *
     * 2026-11-18 修：原来的写法只挑"离血核最远的那一格"，对每一团血肉都是同一个
     * 全局最优点——于是它们全往同一个角上走，看起来就是"喜欢聚集"。
     * 现在打分同时算"离血核"和"离最近同伴"，两者都远才是好位置。
     */
    const core = c.allies.find((a) => a.type === BLOOD_CORE && a.hp > 0);
    const kin = c.allies.filter((a) => a.type === FLESH && a.id !== c.unit.id && a.hp > 0);
    const tooClose = (core ? dist(core, c.unit) <= 3 : false) || kin.some((k) => dist(k, c.unit) <= 2);
    if (tooClose) {
      const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
      let best: { x: number; y: number } | null = null;
      let bestScore = -Infinity;
      for (const p of tiles) {
        const awayCore = core ? dist(core, p) : 0;
        const awayKin = Math.min(...kin.map((k) => dist(k, p)), 6);
        const score = awayCore + awayKin * 1.2;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      if (best) add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 120 });
    }
    return add.length ? { add } : {};
  },
};

/**
 * 血核：**待在暗影最深处**，打威胁最大的。
 *
 * 它自己铺的暗影半径 4，躲进去之后玩家的兵要走过来、还要顶着半视野半射程——
 * 和影主是同一条逻辑，只是血核不会跳，只能一步步挪。
 */
const BLOOD_CORE_AI: UnitAiProfile = {
  id: 'blood-core-deep',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 3;

    const scary = [...c.foes.filter((f) => dist(f, c.unit) <= range)].sort(
      (a, b) => threatOf(c, b) - threatOf(c, a) || a.hp - b.hp,
    )[0];
    if (scary) {
      add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: scary.id }, score: 190 });
      return { add };
    }

    const deep = deepestShadow(c.state, c.unit);
    if (!deep) return {};
    // 和影主同一条逻辑：往深处走，但别和同类挤在一格（站在深处也一样要判）
    const here = -dist(c.unit, deep) - kinCrowd(c, c.unit, BLOOD_CORE);
    let best: { x: number; y: number; s: number } | null = null;
    for (const p of steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0)) {
      const s2 = -dist(p, deep) - kinCrowd(c, p, BLOOD_CORE);
      if (s2 > here + 0.5 && (!best || s2 > best.s)) best = { x: p.x, y: p.y, s: s2 };
    }
    if (best) add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 120 });
    return add.length ? { add } : {};
  },
};

/* ══════════════════════════════════════════════════════════════════
 * 七、骨系（2026-11-18）
 *
 * 三系列里唯一"能造出前两系列"的一支：骸骨吞血肉变尸骸、尸骸吞暗影变不详；
 * 死了还要掉一地零件（淤血、骸骨、暗影）。
 *
 * 所以骨系真正的威胁不是个体强度，是**它会自己长出影系和血系**——
 * 玩家清场顺序不对，一具骸骨能滚成一整支队伍。
 *
 * 六个词条：
 *   寻躯（骸骨）  回合末吞掉相邻的血肉，自己变尸骸
 *   复苏（尸骸）  回合末吞掉相邻的暗影，自己变不详
 *   腾空          本回合攻击过就起飞；没攻击过就降落（地面被占则延后）
 *   拼装（尸骸）  死亡时留一个半血骸骨 + 两滩淤血
 *   点化（不详）  击杀变成骸骨 + 淤血 + 暗影各一个
 *   解离（不详）  被击杀时掉两滩淤血 + 一个骸骨 + 一个暗影
 *
 * 数值全是占位。
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 「凝结」基建：`custom.formTo` 标记的单位，**这个回合不能动**，
 * 下一个回合结束时变成目标兵种（血量按比例换算）。
 *
 * 为什么从词条里提出来：寻躯、复苏、升华都是"吞下/锁定 → 等一回合 → 变形"，
 * 但升华的目标是**别人**（黑茧吞掉自己，让旁边的暗影变影主）——
 * 目标身上并没有那条能力，所以"锁"和"变"只能落在扩展这一层按 `custom.formTo` 认。
 * 词条只负责**触发**（吃掉谁、记什么），怎么变由这里统一做。
 */
function freezeForming(state: GameState, player: PlayerId): void {
  for (const u of state.units) {
    if (u.owner !== player || u.hp <= 0) continue;
    if (typeof u.custom?.formTo === 'string') u.moved = true;
  }
}

function completeForming(state: GameState, player: PlayerId): void {
  for (const u of state.units) {
    if (u.owner !== player || u.hp <= 0) continue;
    const to = u.custom?.formTo;
    if (typeof to !== 'string') continue;
    transform(u, to, state);
    u.custom = { ...(u.custom ?? {}), formTo: undefined };
    state.log.push({
      turn: state.turn,
      player: u.owner,
      text: `${state.unitTypes[to]?.name ?? to}站了起来。`,
    });
  }
}

export const BONE_SKELETON = 'bone-skeleton';
export const BONE_CORPSE = 'bone-corpse';
export const BONE_UNNAMED = 'bone-unnamed';

/** 在指定格生成；站不下返回 null（调用方自己决定要不要找旁边） */
function spawnAt(
  state: GameState,
  api: AbilityApi,
  owner: PlayerId,
  type: string,
  x: number,
  y: number,
): Unit | null {
  if (!api.canStandAt(state, x, y, type)) return null;
  api.spawn(state, owner, type, x, y);
  return state.units.find((u) => u.type === type && u.x === x && u.y === y) ?? null;
}

/**
 * 单位原地"变形"成另一个兵种。
 *
 * 血量**按比例**换算，不是简单截断（2026-11-18 作者指出）：
 * 一具 70 血的骸骨满血变成 150 血的尸骸，应该是 150；半血（35）变成 75。
 * 简单 `min(hp, newMax)` 会让"半血骸骨"变成"半血尸骸里最亏的那种"——
 * 变形等于白送一堆血，白白让玩家占了便宜、也说不通。
 */
function transform(u: Unit, type: string, state: GameState): void {
  const oldMax = state.unitTypes[u.type]?.maxHp ?? 1;
  const ratio = oldMax > 0 ? Math.max(0, Math.min(1, u.hp / oldMax)) : 0;
  u.type = type;
  const newMax = state.unitTypes[type]?.maxHp ?? u.hp;
  u.hp = Math.max(1, Math.round(newMax * ratio));
}

/** 身边（曼哈顿 1 格）某类活着的单位 */
function adjacentOf(state: GameState, u: Unit, type: string): Unit | undefined {
  return state.units.find(
    (o) => o.hp > 0 && o.owner === u.owner && o.type === type && Math.abs(o.x - u.x) + Math.abs(o.y - u.y) <= 1,
  );
}

/* ── 词条 ─────────────────────────────────────────────────────────── */

/**
 * 「吞噬变形」类词条（寻躯 / 复苏共用一个实现）。
 *
 * 两段式：
 *   1. 回合末吞下相邻的目标单位，记下 `custom.formTo`；
 *   2. **下一个自己回合结束时，如果这一回合没动过**，才真正变形。
 *
 * 为什么加这一回合（2026-11-18 作者）：立刻变形等于"打掉一个兵、场上立刻多一个
 * 更强的兵"，玩家没有反应窗口。加一回合之后，玩家能看到"它正在凝聚"并抢在
 * 变形前把它打掉——这才是骨系该有的压力节奏。
 */
function devourFormAbility(o: {
  id: string;
  name: string;
  summary: string;
  eat: string;
  become: string;
  eatText: (name: string) => string;
}): AbilityDef {
  return {
    id: o.id,
    name: o.name,
    summary: o.summary,
    group: 'support',
    hooks: {
      onTurnEnd: [
        {
          stage: 0,
          apply: (c) => {
            if (typeof c.self.custom?.formTo === 'string') return; // 已经在凝结，别重复吃
            const prey = adjacentOf(c.state, c.self, o.eat);
            if (!prey) return;
            const preyName = c.state.unitTypes[prey.type]?.name ?? prey.type;
            c.api.killUnit(c.state, prey, undefined, o.eatText(preyName));
            c.self.custom = { ...(c.self.custom ?? {}), formTo: o.become };
            c.state.log.push({
              turn: c.state.turn,
              player: c.self.owner,
              text: `它吞下了${preyName}，开始凝聚——下一回合原地不动就会变成新的东西。`,
            });
          },
        },
      ],
    },
  };
}

/** 「寻躯」：骸骨吞血肉 → 凝结一回合 → 尸骸 */
const BONE_SEEK = devourFormAbility({
  id: 'bone-seek-body',
  name: '寻躯',
  summary: '回合结束若相邻有血肉，吞掉它；下一个回合原地不动，就会变成尸骸。',
  eat: FLESH,
  become: BONE_CORPSE,
  eatText: () => `血肉被骸骨吞下`,
});

/** 「复苏」：尸骸吞暗影 → 凝结一回合 → 不详 */
const BONE_REVIVE = devourFormAbility({
  id: 'bone-revive',
  name: '复苏',
  summary: '回合结束若相邻有暗影，吞掉它；下一个回合原地不动，就会变成不详。',
  eat: SHADE,
  become: BONE_UNNAMED,
  eatText: () => `暗影被尸骸吞下`,
});

/**
 * 「腾空」：这一回合攻击过就起飞；没攻击过就降落。
 *
 * 降落的判定：**地面那一格有别的单位**就落不下去，延后一回合（留在空中）。
 * 这条让它不能被近战随便贴住——打完了就飞起来，只有远程和飞行够得着。
 */
const BONE_AIRBORNE: AbilityDef = {
  id: 'bone-airborne',
  name: '腾空',
  summary: '本回合攻击过就升到空中层；没攻击过则尝试降落，落点被占则再等一回合。',
  group: 'move',
  hooks: {
    onTurnEnd: [
      {
        stage: 0,
        apply: (c) => {
          if (c.self.acted) {
            if (c.self.layer !== 'air') {
              c.self.layer = 'air';
              c.state.log.push({ turn: c.state.turn, player: c.self.owner, text: '它打了这一下，随即腾空。' });
            }
            return;
          }
          if (c.self.layer !== 'air') return;
          const blocked = c.state.units.some(
            (o) => o.id !== c.self.id && o.hp > 0 && o.x === c.self.x && o.y === c.self.y && o.layer !== 'air',
          );
          if (blocked) return; // 地面被占，继续飘着
          c.self.layer = undefined;
        },
      },
    ],
  },
};

/** 「拼装」：死亡时留下一个半血骸骨，周围再长出两滩淤血。 */
const BONE_ASSEMBLE: AbilityDef = {
  id: 'bone-assemble',
  name: '拼装',
  summary: '死亡时在原地留下一个半血的骸骨，并在周围长出两滩淤血。',
  group: 'defense',
  hooks: {
    onDeath: (c) => {
      /*
       * 死亡钩子里**尸体还占着那一格**（清场在钩子之后），所以"原地生成"必然失败。
       * 先试原地、失败就落相邻格——玩家看到的仍然是"散了架，骨头在旁边站起来"。
       */
      const bone =
        spawnAt(c.state, c.api, c.victim.owner, BONE_SKELETON, c.victim.x, c.victim.y) ??
        c.api.spawnNear(c.state, c.victim.owner, BONE_SKELETON, c.victim);
      if (bone) bone.hp = Math.max(1, Math.floor((c.state.unitTypes[BONE_SKELETON]?.maxHp ?? 70) / 2));
      for (let i = 0; i < 2; i += 1) c.api.spawnNear(c.state, c.victim.owner, BLOOD_POOL, c.victim);
      c.result.blasts += 1; // 让主流程知道"多了东西"，清场时别漏
      c.state.log.push({ turn: c.state.turn, player: c.victim.owner, text: '尸骸散了架——骨头和血又各自站了起来。' });
    },
  },
};

/** 「点化」：击杀的单位被拆成骸骨 + 淤血 + 暗影各一个。 */
const BONE_TRANSMUTE: AbilityDef = {
  id: 'bone-transmute',
  name: '点化',
  summary: '击杀单位时，在被击杀处生成一个骸骨、一滩淤血、一团暗影（放不下就落在相邻格）。',
  group: 'attack',
  hooks: {
    onKill: (c) => {
      if (c.victim.owner === c.self.owner) return;
      // 击杀的瞬间尸体还在那一格，所以先试原地、不行就落旁边
      const bone =
        spawnAt(c.state, c.api, c.self.owner, BONE_SKELETON, c.victim.x, c.victim.y) ??
        c.api.spawnNear(c.state, c.self.owner, BONE_SKELETON, c.victim);
      void bone;
      c.api.spawnNear(c.state, c.self.owner, BLOOD_POOL, c.victim);
      c.api.spawnNear(c.state, c.self.owner, SHADE, c.victim);
      c.state.log.push({ turn: c.state.turn, player: c.self.owner, text: '被"不详"碰过的东西，散成了骨、血、影。' });
    },
  },
};

/** 「解离」：不详自己倒下时也散成零件。 */
const BONE_DISSOLVE: AbilityDef = {
  id: 'bone-dissolve',
  name: '解离',
  summary: '被击杀时散成两滩淤血、一个骸骨、一团暗影。',
  group: 'defense',
  hooks: {
    onDeath: (c) => {
      for (let i = 0; i < 2; i += 1) c.api.spawnNear(c.state, c.victim.owner, BLOOD_POOL, c.victim);
      c.api.spawnNear(c.state, c.victim.owner, BONE_SKELETON, c.victim);
      c.api.spawnNear(c.state, c.victim.owner, SHADE, c.victim);
      c.result.blasts += 1;
      c.state.log.push({ turn: c.state.turn, player: c.victim.owner, text: '不详散了——它本来就不该拼在一起。' });
    },
  },
};

/* ── 三个兵 ─────────────────────────────────────────────────────── */

/** 骸骨：一具被驱动的骨架。慢、近战、会吞血肉长成尸骸。 */
const BONE_SKELETON_DEF: UnitTypeDef = {
  id: BONE_SKELETON,
  name: '骸骨',
  short: '骸',
  era: 6,
  category: 'combat',
  cost: 110,
  move: 3,
  atk: 20,
  armor: 8,
  maxHp: 70,
  range: 1,
  vision: 5,
  summonedOnly: true,
  shadowRadius: 1,
  aiAutonomy: 1,
  aiProfile: 'bone-seek-flesh',
  abilities: ['blood-clot', 'shadow-possess', 'shadow-spawn', 'bone-seek-body', 'dull-wit'],
};

/** 尸骸：拼装物。中程、溅射 1、会吞暗影长成不详、死了还掉零件。 */
const BONE_CORPSE_DEF: UnitTypeDef = {
  id: BONE_CORPSE,
  name: '尸骸',
  short: '尸',
  era: 6,
  category: 'combat',
  cost: 260,
  move: 3,
  atk: 32,
  armor: 10,
  maxHp: 150,
  range: 3,
  vision: 6,
  splash: 1,
  summonedOnly: true,
  shadowRadius: 3,
  aiAutonomy: 1,
  aiProfile: 'corpse-toward-shade',
  abilities: ['blood-clot', 'blood-infect', 'blood-siphon', 'shadow-possess', 'bone-airborne', 'bone-assemble', 'bone-revive', 'dull-wit'],
};

/** 不详：残次品。会飞、会跳、杀了东西还要现场拼出一支小队。 */
const BONE_UNNAMED_DEF: UnitTypeDef = {
  id: BONE_UNNAMED,
  name: '不详',
  short: '忌',
  era: 6,
  category: 'combat',
  cost: 420,
  move: 3,
  atk: 38,
  armor: 12,
  // 140 → 160（2026-11-18 作者指出）：它是骨系的头，血不该比尸骸（150）还少
  maxHp: 160,
  range: 3,
  vision: 7,
  burst: 2,
  splash: 1,
  /*
   * 不写 `flight: true`：那条在引擎里等价于"**一直在空中层**"，
   * 而"不详"要的是"平时在地上、打完才飞起来"——那是「腾空」自己把
   * `unit.layer` 改成 'air' 的事。写了 flight 它就永远是空中单位，
   * 近战根本够不着（实测表现为"目标超出射程"）。
   */
  summonedOnly: true,
  shadowRadius: 5,
  aiAutonomy: 1,
  aiProfile: 'unnamed-toward-emperor',
  abilities: ['shadow-spawn', 'blood-infect', 'blood-siphon', 'bone-airborne', 'bone-transmute', 'bone-dissolve', 'dull-wit'],
  skills: [SHADOW_STEP_SKILL],
};

/* ══════════════════════════════════════════════════════════════════
 * 八、三个不成系的（2026-11-18）
 *
 * 黑蝗、黑茧、诡异：它们不属于影/血/骨任何一支，但都是同一个源头漏出来的东西。
 * 三者之间有一条链：**黑蝗聚成团 → 结茧 → 升华成影主或血核**。
 * 也就是说这三只是"给另外三支供料"的。
 * ══════════════════════════════════════════════════════════════════ */

export const BLACK_LOCUST = 'black-locust';
export const BLACK_COCOON = 'black-cocoon';
export const UNNAMABLE = 'unnamable';

/** 一个单位周围（8 邻域）有几只黑蝗 */
function locustsAround(state: GameState, x: number, y: number): number {
  let n = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      if (state.units.some((o) => o.hp > 0 && o.type === BLACK_LOCUST && o.x === x + dx && o.y === y + dy)) n += 1;
    }
  }
  return n;
}

/**
 * 「繁殖」：相邻的某一格满足条件，就在那一格生出一只黑蝗。
 *
 * 条件（作者原话）：那一格的 8 邻域里黑蝗正好 2 只、它的相邻格**全在暗影里**、
 * 且没有别的飞行单位占着。
 *
 * 为什么这么苛刻：黑蝗自己的暗影半径是 0（只有脚下），所以一条"全在暗影里"的
 * 相邻带意味着**必须是它们自己叠出来的影子**——它只能在同类聚成的黑团里繁殖，
 * 铺到亮处就断了。
 */
const LOCUST_BREED: AbilityDef = {
  id: 'locust-breed',
  name: '繁殖',
  summary: '回合结束时，若相邻某格的周围恰有 2 只黑蝗、且那一带全在暗影里，就在那里再生一只。',
  group: 'support',
  hooks: {
    onTurnEnd: [
      {
        stage: 0,
        apply: (c) => {
          const { state, self, api } = c;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const x = self.x + dx;
            const y = self.y + dy;
            if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
            if (locustsAround(state, x, y) !== 2) continue;
            // 那一格的周围必须全在暗影里
            let allShadow = true;
            for (let oy = -1; oy <= 1 && allShadow; oy += 1) {
              for (let ox = -1; ox <= 1; ox += 1) {
                if (ox === 0 && oy === 0) continue;
                const nx = x + ox;
                const ny = y + oy;
                if (nx < 0 || ny < 0 || nx >= state.w || ny >= state.h) continue;
                if (!inShadowCell(state, nx, ny, self.board)) {
                  allShadow = false;
                  break;
                }
              }
            }
            if (!allShadow) continue;
            // 那一格不能有别的（飞行）单位
            if (state.units.some((o) => o.hp > 0 && o.x === x && o.y === y)) continue;
            if (!api.canStandAt(state, x, y, BLACK_LOCUST)) continue;
            api.spawn(state, self.owner, BLACK_LOCUST, x, y);
            state.log.push({ turn: state.turn, player: self.owner, text: '黑暗里又爬出一只黑蝗。' });
            return; // 一回合最多一只
          }
        },
      },
    ],
  },
};

/**
 * 「结茧」：四周都是同类、脚下又是空地，就吞掉它们结成黑茧。
 *
 * "脚下是空地"这条是给玩家的破绽：它飞着，只要底下站着人就没法落地结茧。
 */
const LOCUST_COCOON: AbilityDef = {
  id: 'locust-cocoon',
  name: '结茧',
  summary: '回合结束时，若四周都是黑蝗且脚下没有地面单位，吞掉四周的黑蝗，自己结成黑茧。',
  group: 'support',
  hooks: {
    onTurnEnd: [
      {
        stage: 0,
        apply: (c) => {
          const { state, self } = c;
          const around = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
          let eaten: Unit[] = [];
          let allLocust = true;
          for (const [dx, dy] of around) {
            const x = self.x + dx;
            const y = self.y + dy;
            if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue; // 地图外不算
            const other = state.units.find((o) => o.hp > 0 && o.x === x && o.y === y && o.type === BLACK_LOCUST);
            if (!other) {
              allLocust = false;
              break;
            }
            eaten.push(other);
          }
          if (!allLocust || eaten.length < 2) return; // 至少两只，不然一只也能结茧
          // 脚下必须没有地面单位
          const grounded = state.units.some(
            (o) => o.id !== self.id && o.hp > 0 && o.x === self.x && o.y === self.y && o.layer !== 'air',
          );
          if (grounded) return;
          for (const o of eaten) c.api.killUnit(state, o, undefined, '黑蝗被同类吞下');
          self.layer = undefined; // 落地成茧，不再飞
          transform(self, BLACK_COCOON, state);
          state.log.push({ turn: state.turn, player: self.owner, text: '黑蝗挤成一团，结成了黑茧。' });
        },
      },
    ],
  },
};

/**
 * 「升华」：黑茧吞掉自己，把附近的一只暗影或血肉催成它们的头。
 *
 * 和寻躯/复苏同一套节奏——目标会被冻住一个回合，再按血量比例变成新兵种。
 * 所以这里只负责"选谁、记什么"，真正的锁与变在 `freezeForming` / `completeForming`。
 */
const COCOON_ASCEND: AbilityDef = {
  id: 'cocoon-ascend',
  name: '升华',
  summary: '回合结束时，若两格内有暗影或血肉，自己消散，把它催成影主或血核（它要原地停一回合）。',
  group: 'support',
  hooks: {
    onTurnEnd: [
      {
        stage: 0,
        apply: (c) => {
          const { state, self, api } = c;
          const pick = state.units
            .filter(
              (o) =>
                o.hp > 0 &&
                o.owner === self.owner &&
                (o.type === SHADE || o.type === FLESH) &&
                Math.abs(o.x - self.x) + Math.abs(o.y - self.y) <= 2 &&
                typeof o.custom?.formTo !== 'string',
            )
            .sort(
              (a, b) => Math.abs(a.x - self.x) + Math.abs(a.y - self.y) - (Math.abs(b.x - self.x) + Math.abs(b.y - self.y)),
            )[0];
          if (!pick) return;
          const to = pick.type === SHADE ? SHADOW_LORD : BLOOD_CORE;
          pick.custom = { ...(pick.custom ?? {}), formTo: to };
          api.killUnit(state, self, undefined, '黑茧化开了');
          state.log.push({
            turn: state.turn,
            player: self.owner,
            text: `黑茧化开，把${state.unitTypes[pick.type]?.name ?? ''}整个吞了进去。`,
          });
        },
      },
    ],
  },
};

/** 「暗影呼吸」每回合回多少血 */
export const BREATH_HEAL = 6;

/**
 * 「暗影呼吸」：每回合开始回一点血。
 *
 * 它自己就在暗影里，回血是"回到自己的介质中去"——不看地形、不要求站住不动，
 * 和核心的「休整」（要求上回合没动没打）区别就在这。
 */
const SHADOW_BREATH: AbilityDef = {
  id: 'shadow-breath',
  name: '暗影呼吸',
  summary: `每回合开始回复 ${BREATH_HEAL} 点生命。`,
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.self,
        apply: (c) => {
          if (!c.healable) return;
          const max = c.api.maxHpOf(c.state, c.self);
          if (c.self.hp >= max) return;
          c.self.hp = Math.min(max, c.self.hp + BREATH_HEAL);
        },
      },
    ],
  },
};

/**
 * 「无形」：不可言说之物，**相邻也看不见**；攻击之后才现形。
 *
 * 后半条（作者 2026-11-18 定的方案）：**被它打过的目标才打得中它**。
 * 引擎没有"谁能打谁"的钩子，所以走用户给的思路——
 *
 *   1. 它打中谁，就给谁贴一层「无形凝视」（自己的回合结束才消，正好撑过那一回合）；
 *   2. 它挨打时，如果打它的人身上没有「无形凝视」，**这一下直接打空**：
 *      伤害归零、战报写"打了个空"，就像那颗棋子本来就是空的。
 *
 * 为什么不真的"把 victim 换成假单位"：换单位要新建、删除、还要处理追击/连带伤害，
 * 一次攻击里能改的东西太多；而"这一下伤害为 0"在表现上完全一样（血没掉、人还在），
 * 却只碰一个数。以后真要做"假目标"（比如诱骗走位），再单独做。
 */
const UNNAMABLE_FORM: AbilityDef = {
  id: 'unnamable-formless',
  name: '无形',
  summary: '看不见，也无法被相邻发现；出手后现形。只有被它打过的敌人才打得中它。',
  group: 'move',
  hooks: {
    hidden: (c) => !c.self.acted,
    // 打中谁，谁就"看见"它一回合
    onHit: [
      {
        stage: HIT_STAGE.status,
        apply: (c) => {
          c.target.status = { ...(c.target.status ?? {}), [FORMLESS_GAZE]: 2 };
          c.touched.push('无形凝视');
        },
      },
    ],
    /*
     * 挨打：打它的人没有「无形凝视」→ 打空。
     * 挂在最前面（attackFlat）是为了让后面的乘法/减法都作用在这个 0 上。
     */
    damage: [
      {
        stage: DAMAGE_STAGE.attackFlat,
        apply: (c) => {
          if (c.side !== 'defender') return;
          const attacker = c.foe;
          if (!attacker) return;
          if ((attacker.status?.[FORMLESS_GAZE] ?? 0) > 0) return;
          c.damage = 0;
          c.items.push({ label: '无形：这一下打空了', delta: 0 });
          c.state.log.push({
            turn: c.state.turn,
            player: attacker.owner,
            text: `${c.state.unitTypes[attacker.type]?.name ?? ''}挥了一记，什么都没碰到。`,
          });
        },
      },
    ],
  },
};

/** 「无形凝视」：被无形之物打过之后，一回合内看得见、也打得中它 */
export const FORMLESS_GAZE = 'formless-gaze';

registerStatus({
  id: FORMLESS_GAZE,
  name: '无形凝视',
  summary: '刚被"无形"之物打过，这一回合看得见它、也打得中它。',
});

/* ── 三个兵 ─────────────────────────────────────────────────────── */

/** 黑蝗：黑暗里爬出来的蝗虫。单个几乎打不死人，成团就繁殖。 */
const BLACK_LOCUST_DEF: UnitTypeDef = {
  id: BLACK_LOCUST,
  name: '黑蝗',
  short: '蝗',
  era: 6,
  category: 'combat',
  cost: 60,
  move: 5,
  atk: 1,
  // 4 → 2、20 → 14（2026-11-19 作者：黑蝗太耐打了，它该是"一把就能捏死、但永远捏不完"）
  armor: 2,
  maxHp: 14,
  range: 1,
  vision: 4,
  burst: 3,
  // 飞着：结茧要求"脚下是空地"，所以它必须能在空中层
  flight: true,
  layer: 'air',
  summonedOnly: true,
  // 半径 0 = 只有脚下那一格算暗影领域
  shadowRadius: 0,
  aiAutonomy: 1,
  aiProfile: 'locust-swarm',
  abilities: ['shadow-erosion', 'blood-siphon', 'locust-breed', 'locust-cocoon', 'dull-wit'],
};

/** 黑茧：黑暗结晶，不会动的炮台。血厚甲高，等着升华。 */
const BLACK_COCOON_DEF: UnitTypeDef = {
  id: BLACK_COCOON,
  name: '黑茧',
  short: '茧',
  era: 6,
  category: 'building',
  cost: 300,
  move: 0,
  atk: 1,
  armor: 14,
  maxHp: 200,
  range: 5,
  vision: 6,
  burst: 3,
  summonedOnly: true,
  shadowRadius: 6,
  aiAutonomy: 1,
  aiProfile: 'cocoon-nearest',
  abilities: ['shadow-erosion', 'blood-siphon', 'cocoon-ascend', 'dull-wit'],
};

/** 诡异：不可言说之物。看不见、跳得远、打完就跑。 */
const UNNAMABLE_DEF: UnitTypeDef = {
  id: UNNAMABLE,
  name: '诡异',
  short: '诡',
  era: 6,
  category: 'combat',
  cost: 350,
  move: 5,
  atk: 12,
  armor: 6,
  maxHp: 60,
  range: 3,
  vision: 7,
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 6,
  aiAutonomy: 1,
  aiProfile: 'unnamable-stalk',
  // 2026-11-19：它自己也是"黑暗的产物"，所以自己也带「黑暗之源」
  abilities: ['shadow-erosion', 'unnamable-formless', 'shadow-breath', 'dull-wit', 'dark-source'],
  skills: [SHADOW_STEP_SKILL],
};

/* ══════════════════════════════════════════════════════════════════
 * 九、仆从（2026-11-19）
 *
 * 剧情上：**诡异**是尸骸仙帝掉下来的污染物，自己会扩散；
 * **仆从**是他的追随者——听总体指挥，也有自己的脑子。
 *
 * 这个包现在只有一个占位单位「青铜卫」，作用是**把城市相关的两条词条跑通**：
 *   · 断传承：占下一座城，那座城的时代降一级；
 *   · 痴愚（挂在所有诡异身上）：不认城市，进不了废墟、占不了城。
 * ══════════════════════════════════════════════════════════════════ */

export const BRONZE_GUARD = 'bronze-guard';

/**
 * 「断传承」：占下一座废墟，那座城的时代降一级。
 *
 * 它不会"接手"一座城，只会把城用回旧样子——所以攻下越高级的地方，
 * 掉得越明显。这条挂 `onCityCaptured`：核心的易手点只有一个，
 * 这里只是"易手之后多做一件事"，不动核心判定。
 */
const BREAK_LINEAGE: AbilityDef = {
  id: 'break-lineage',
  name: '断传承',
  summary: '把一座城的耐久打到 0（它变成废墟）时，那座城的时代等级下降 1 级（最低 1 级）。',
  group: 'support',
  hooks: {
    onCityRazed: ({ state, unit, city }) => {
      if (city.era <= 1) return;
      city.era -= 1;
      state.log.push({
        turn: state.turn,
        player: unit.owner,
        text: `城墙塌下去的时候，这座城的时代也退回了 ${city.era} 级。`,
      });
    },
  },
};

/**
 * 「痴愚」：不认城市。
 *
 * 它不是"攻城弱"，而是**根本不理解城市是什么**：废墟在它眼里就是一堆石头，
 * 走进去也不会接手。所以这条只拦"入驻废墟"这一个动作，别的都不管。
 */
const DULL_WIT: AbilityDef = {
  id: 'dull-wit',
  name: '痴愚',
  summary: '不明白城市是什么：不会进驻废墟、也不会占领城市。',
  group: 'move',
  hooks: {
    canCaptureCity: () => '痴愚：它不明白一座城是什么。',
  },
};

/** 青铜卫：最基础的仆从。占位用，数值没细调。 */
const BRONZE_GUARD_DEF: UnitTypeDef = {
  id: BRONZE_GUARD,
  name: '青铜卫',
  short: '卫',
  era: 2,
  category: 'combat',
  cost: 90,
  // 高血高甲、走得慢、攻中、暗蚀中、**视野很广**（它是钉子，不是猎手）
  move: 2,
  atk: 22,
  armor: 12,
  maxHp: 140,
  range: 1,
  vision: 9,
  // 仆从听总体指挥，但有一点自主性（0.45）：诡异才是"全凭本能"
  summonedOnly: true,
  aiAutonomy: 0.45,
  aiProfile: 'servant-advance',
  abilities: ['break-lineage', 'leave-food', 'shadow-drive'],
};

/* ── 仆从的公共词条 ─────────────────────────────────────────────── */

/** 「留食」：视野内的敌方经济单位不多时，不许对经济单位下手 */
export const LEAVE_FOOD_LIMIT = 2;

/**
 * 「留食」：仙帝要吃东西。
 *
 * 所以这些仆从不赶尽杀绝——**视野内的敌方经济单位 ≤ 2 时，干脆不打经济单位**。
 * 杀掉最后几片产线等于把仙帝的粮仓烧了，那不是忠诚。
 *
 * 做在 `canAttackTarget` 上而不是 AI 偏好里：偏好只影响 AI 怎么选，
 * 玩家手动操作、或者别的单位被命令去打，都绕不过这条——这是纪律，不是口味。
 */
const LEAVE_FOOD: AbilityDef = {
  id: 'leave-food',
  name: '留食',
  summary: `视野内的敌方经济单位不多于 ${LEAVE_FOOD_LIMIT} 个时，不会攻击经济单位——那是留给仙帝的食物。`,
  group: 'attack',
  hooks: {
    canAttackTarget: ({ state, unit, target }) => {
      if (state.unitTypes[target.type]?.category !== 'economy') return null;
      const sight = state.unitTypes[unit.type]?.vision ?? 4;
      const seen = state.units.filter(
        (o) =>
          o.hp > 0 &&
          o.owner !== unit.owner &&
          state.unitTypes[o.type]?.category === 'economy' &&
          Math.abs(o.x - unit.x) + Math.abs(o.y - unit.y) <= sight,
      ).length;
      if (seen > LEAVE_FOOD_LIMIT) return null;
      return `留食：视野里只剩 ${seen} 个经济单位，这一支不肯下口。`;
    },
  },
};

/* ── 卫系：机关傀儡 ─────────────────────────────────────────────── */

export const PUPPET_WRECK = 'puppet-wreck';

/** 残躯能吸多远的暗影 */
const DRIVE_REACH = 3;

/**
 * 「暗影驱动」：倒下之后留一具**傀儡残躯**。
 *
 * 残躯不是尸体，是"没通电的机关"（见 `WRECK_REVIVE`）：三格内有暗影就吸干它、
 * 原地半血复活。所以卫系真正的杀法是**先清掉周围的暗影，再砸碎残躯**。
 */
const SHADOW_DRIVE: AbilityDef = {
  id: 'shadow-drive',
  name: '暗影驱动',
  summary: `倒下后留下傀儡残躯；残躯 ${DRIVE_REACH} 格内有暗影时，会吸干它并在原地半血复活。`,
  group: 'defense',
  hooks: {
    onDeath: (c) => {
      const wreck =
        spawnAt(c.state, c.api, c.victim.owner, PUPPET_WRECK, c.victim.x, c.victim.y) ??
        c.api.spawnNear(c.state, c.victim.owner, PUPPET_WRECK, c.victim);
      if (!wreck) return;
      // 记下"它原来是谁"——复活时按这个兵种站起来
      wreck.custom = { ...(wreck.custom ?? {}), origin: c.victim.type };
      c.state.log.push({ turn: c.state.turn, player: c.victim.owner, text: '机关散了架，剩下一具残躯。' });
    },
  },
};

/**
 * 「重生」：残躯的回合开始，吸掉三格内的暗影，原地半血站起来。
 *
 * 挂在残躯身上而不是"暗影驱动"上：驱动是"怎么死"，这条是"怎么活回来"，
 * 两者能分开挂——以后想要"不死不活"的机关，只挂前一条就行。
 */
const WRECK_REVIVE: AbilityDef = {
  id: 'wreck-revive',
  name: '重启',
  summary: `${DRIVE_REACH} 格内有暗影时，吸干它并原地半血复活成原来的机关。`,
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.summon,
        apply: (c) => {
          const { state, self, api } = c;
          const origin = self.custom?.origin;
          if (typeof origin !== 'string' || !state.unitTypes[origin]) return;
          const shade = state.units
            .filter(
              (o) =>
                o.hp > 0 &&
                o.type === SHADE &&
                Math.abs(o.x - self.x) + Math.abs(o.y - self.y) <= DRIVE_REACH,
            )
            .sort(
              (a, b) => Math.abs(a.x - self.x) + Math.abs(a.y - self.y) - (Math.abs(b.x - self.x) + Math.abs(b.y - self.y)),
            )[0];
          if (!shade) return;
          api.killUnit(state, shade, undefined, '暗影被残躯吸干');
          const at = { x: self.x, y: self.y };
          api.killUnit(state, self, undefined, '残躯重新启动');
          api.spawn(state, self.owner, origin, at.x, at.y);
          const born = state.units.find((o) => o.type === origin && o.x === at.x && o.y === at.y);
          if (born) born.hp = Math.max(1, Math.ceil((state.unitTypes[origin]?.maxHp ?? 1) / 2));
          state.log.push({ turn: state.turn, player: self.owner, text: '残躯吸进一团暗影——机关重新站了起来。' });
        },
      },
    ],
  },
};

/**
 * 「衰鸣」：被打中的敌人陷入「虚弱」。
 *
 * 不是伤害型能力——它的价值在于**让下一次交锋更好打**（移动和攻击各降 30%）。
 */
const WEAKEN_CRY: AbilityDef = {
  id: 'weaken-cry',
  name: '衰鸣',
  summary: '被它打中的敌人陷入「虚弱」：移动与攻击各降 30%，持续到对方下一个回合结束。',
  group: 'attack',
  hooks: {
    onHit: [
      {
        stage: HIT_STAGE.status,
        apply: (c) => {
          c.target.status = { ...(c.target.status ?? {}), [WEAKNESS]: 2 };
          c.touched.push('虚弱');
        },
      },
    ],
  },
};

/** 「虚弱」：移动与攻击各降 30% */
export const WEAKNESS = 'weakness';
registerStatus({
  id: WEAKNESS,
  name: '虚弱',
  summary: '移动与攻击各降 30%。',
  modifyMove: (_s, _u, _val, move) => Math.max(1, Math.round(move * 0.7)),
  modifyAtk: (_s, _u, _val, atk) => Math.max(0, Math.round(atk * 0.7)),
});

/* ── 卫系三个兵 ─────────────────────────────────────────────────── */

/** 傀儡残躯：一具没通电的机关。不能动、不能打，等着暗影。 */
const WRECK_DEF: UnitTypeDef = {
  id: PUPPET_WRECK,
  name: '傀儡残躯',
  short: '残',
  era: 2,
  category: 'combat',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 4,
  maxHp: 30,
  range: 0,
  vision: 3,
  summonedOnly: true,
  abilities: ['wreck-revive'],
};

/** 暗影卫：烧暗影的轻甲机关，会跳会飞。 */
export const SHADOW_GUARD = 'shadow-guard';
const SHADOW_GUARD_DEF: UnitTypeDef = {
  id: SHADOW_GUARD,
  name: '暗影卫',
  short: '影卫',
  era: 3,
  category: 'combat',
  cost: 120,
  move: 4,
  atk: 16,
  armor: 14,
  maxHp: 70,
  range: 3,
  vision: 6,
  burst: 2,
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 4,
  aiAutonomy: 0.45,
  aiProfile: 'servant-advance',
  abilities: ['break-lineage', 'leave-food', 'shadow-drive'],
  skills: [SHADOW_STEP_SKILL],
};

/** 号卫：射得远、打得广，还让挨打的人虚下去。 */
export const HORN_GUARD = 'horn-guard';
const HORN_GUARD_DEF: UnitTypeDef = {
  id: HORN_GUARD,
  name: '号卫',
  short: '号',
  era: 3,
  category: 'combat',
  cost: 150,
  move: 3,
  atk: 30,
  armor: 8,
  maxHp: 110,
  range: 6,
  vision: 6,
  splash: 2,
  summonedOnly: true,
  aiAutonomy: 0.45,
  aiProfile: 'servant-advance',
  abilities: ['break-lineage', 'leave-food', 'shadow-drive', 'weaken-cry'],
};

/* ══════════════════════════════════════════════════════════════════
 * 十、仆系（2026-11-19）
 *
 * 和卫系的分工：卫系是"钉在原地的机关"，仆系是"会干活的追随者"。
 * 三只各有各的活，共同点是**听指挥 + 不往人堆里扎**：
 *   敌方成群的时候往后站；但只要有人摸到仙帝（或裔系）旁边，这一条立刻作废。
 * ══════════════════════════════════════════════════════════════════ */

export const PUPPET_MASTER = 'puppet-master';
export const SOUL_HOOKER = 'soul-hooker';
export const BLOOD_MEDIC = 'blood-medic';

/** 「傀儡制造」：每隔几个自己的回合造一个 */
const CRAFT_EVERY = 3;
/** 每种傀儡最多几个 */
const CRAFT_MAX = 2;
/** 傀儡的出场顺序——作者定的 */
const CRAFT_ORDER = [BRONZE_GUARD, SHADOW_GUARD, HORN_GUARD];
/** 「勾魂」的作用半径（"较大"） */
const SOUL_RADIUS = 6;
/** 「增生光环」的作用半径 */
const AURA_RADIUS = 3;
/** 一次最多治疗多少（"有数值上限"） */
const AURA_CAP = 12;
/** 影蚀之血超过最大生命的这个比例就死 */
const CORRUPT_RATIO = 0.3;

/** 是不是"该护着的人"：仙帝本人，或者裔系（id 前缀） */
const isWard = (u: Unit): boolean => u.type === EMPEROR || u.type.startsWith('heir-');

/**
 * 「傀儡制造」：每 3 个自己的回合，按 青铜卫 → 暗影卫 → 号卫 的顺序造一个。
 *
 * 每种最多 2 个；某一种满了就跳过它看下一种；全都满就不造。
 * 记忆点在 `custom` 上（下一个该造谁 + 还有几回合），所以它不需要额外状态。
 */
const PUPPET_CRAFT: AbilityDef = {
  id: 'puppet-craft',
  name: '傀儡制造',
  summary: `每 ${CRAFT_EVERY} 个自己的回合造一个傀儡（青铜卫 → 暗影卫 → 号卫，每种最多 ${CRAFT_MAX} 个）。`,
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.summon,
        apply: (c) => {
          const { state, self, api } = c;
          const left = Number(self.custom?.craftIn ?? CRAFT_EVERY) - 1;
          if (left > 0) {
            self.custom = { ...(self.custom ?? {}), craftIn: left };
            return;
          }
          const start = Number(self.custom?.craftNext ?? 0);
          for (let i = 0; i < CRAFT_ORDER.length; i += 1) {
            const idx = (start + i) % CRAFT_ORDER.length;
            const type = CRAFT_ORDER[idx]!;
            const alive = state.units.filter((u) => u.owner === self.owner && u.hp > 0 && u.type === type).length;
            if (alive >= CRAFT_MAX) continue;
            const spot = freeNear(state, self, type, api);
            if (!spot) break;
            api.spawn(state, self.owner, type, spot.x, spot.y);
            self.custom = {
              ...(self.custom ?? {}),
              craftNext: (idx + 1) % CRAFT_ORDER.length,
              craftIn: CRAFT_EVERY,
            };
            state.log.push({
              turn: state.turn,
              player: self.owner,
              text: `傀儡师拼出一具${state.unitTypes[type]?.name ?? '傀儡'}。`,
            });
            return;
          }
          // 全满了：过一回合再试（别把计数器归零，否则要等很久）
          self.custom = { ...(self.custom ?? {}), craftIn: 1 };
        },
      },
    ],
  },
};

/**
 * 「暗影潜行」：**只在暗影领域里**藏得住。
 *
 * 出了黑雾就现形；出手也现形。相邻会被发现是引擎的通用规矩（`isHiddenFrom`
 * 里"贴脸就能看见"那一段），不用在这里再写一遍。
 */
const SHADOW_STALK: AbilityDef = {
  id: 'shadow-stalk',
  name: '暗影潜行',
  summary: '在暗影领域内藏形：只有在出手之后、或者被贴到相邻时才会暴露。',
  group: 'move',
  hooks: {
    hidden: (c) => !c.self.acted && inShadowCell(c.state, c.self.x, c.self.y, c.self.board),
  },
};

/**
 * 「勾魂」：大半径内，任何单位在**自己的回合末**只要还有余力，就会被拽向暗影深处。
 *
 * 不分敌我——这是它最麻烦的地方：你站在它附近，自己的兵也会被拖走。
 * "还有余力"按 `moved` 算（这回合没挪过 = 还有移动力）。
 */
const SOUL_HOOK: AbilityDef = {
  id: 'soul-hook',
  name: '勾魂',
  summary: `${SOUL_RADIUS} 格内，任何单位在自己回合结束时若还没移动过，会被拉向暗影最深处。`,
  group: 'support',
};

/**
 * 「勾魂」的实际效果：把刚结束回合那一方**还没动过**的单位，往暗影最深处挪。
 *
 * 为什么写在扩展层而不是词条自己身上：它要影响**别的单位**（包括敌人），
 * 而能力钩子只会在"挂着这条能力的那个兵"身上跑。所以词条只声明存在，
 * 真正拉人由这里统一做。
 */
function pullSouls(state: GameState, player: PlayerId, api: AbilityApi): void {
  const hookers = state.units.filter((u) => u.hp > 0 && api.hasAbility(state, u, 'soul-hook'));
  if (hookers.length === 0) return;
  for (const u of state.units) {
    if (u.owner !== player || u.hp <= 0 || u.moved) continue;
    if (!hookers.some((h) => Math.abs(h.x - u.x) + Math.abs(h.y - u.y) <= SOUL_RADIUS && h.id !== u.id)) continue;
    const deep = deepestShadow(state, u);
    if (!deep) continue;
    const steps = state.unitTypes[u.type]?.move ?? 1;
    let moved = 0;
    for (let i = 0; i < steps; i += 1) {
      const here = Math.abs(u.x - deep.x) + Math.abs(u.y - deep.y);
      let best: { x: number; y: number } | null = null;
      let bestD = here;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = u.x + dx;
        const ny = u.y + dy;
        if (!api.canStandAt(state, nx, ny, u.type)) continue;
        const d = Math.abs(nx - deep.x) + Math.abs(ny - deep.y);
        if (d < bestD) {
          bestD = d;
          best = { x: nx, y: ny };
        }
      }
      if (!best) break;
      u.x = best.x;
      u.y = best.y;
      moved += 1;
    }
    if (moved > 0) {
      u.moved = true;
      state.log.push({ turn: state.turn, player: u.owner, text: `${state.unitTypes[u.type]?.name ?? '它'}被什么牵着，往黑暗里走了几步。` });
    }
  }
}

/**
 * 「影蚀之血」的阈值判定：超过上限比例就死，化成一团血肉 + 一团暗影。
 *
 * 抽成函数是因为它有两个调用点（光环治疗后、受伤净化后不会触发，但写在一处更稳）。
 */
function corruptDeath(state: GameState, unit: Unit, api: AbilityApi): boolean {
  const max = state.unitTypes[unit.type]?.maxHp ?? 1;
  const blood = Number(unit.custom?.shadowBlood ?? 0);
  if (blood <= max * CORRUPT_RATIO) return false;
  const at = { x: unit.x, y: unit.y };
  api.killUnit(state, unit, undefined, '受污染的血积满了');
  api.spawnNear(state, unit.owner, FLESH, { ...unit, x: at.x, y: at.y } as Unit);
  api.spawnNear(state, unit.owner, SHADE, { ...unit, x: at.x, y: at.y } as Unit);
  state.log.push({ turn: state.turn, player: unit.owner, text: '影蚀之血漫了出来——那个人化成了血肉和暗影。' });
  return true;
}

/**
 * 「增生光环」：范围内不分敌我，治疗"已失去血量的一半"，但一次有上限。
 *
 * 代价是**用受污染的血在治**：治多少，就在那人身上积多少「影蚀之血」；
 * 积过最大生命的三成，人就没了（化成血肉 + 暗影）。
 * 挨打会把这份污染冲淡（见扩展的 `onUnitDamaged`），所以"先打一顿再治"是能救人的。
 */
const BLOOD_AURA: AbilityDef = {
  id: 'blood-aura',
  name: '增生光环',
  summary: `${AURA_RADIUS} 格内不分敌我治疗"已失去血量的一半"（一次最多 ${AURA_CAP} 点），并在被治疗者身上积累等量「影蚀之血」。`,
  group: 'support',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.aura,
        apply: (c) => {
          const { state, self, api } = c;
          for (const u of state.units) {
            if (u.hp <= 0) continue;
            if (Math.abs(u.x - self.x) + Math.abs(u.y - self.y) > AURA_RADIUS) continue;
            const max = state.unitTypes[u.type]?.maxHp ?? 0;
            const missing = max - u.hp;
            if (missing <= 0) continue;
            const heal = Math.min(AURA_CAP, Math.floor(missing / 2));
            if (heal <= 0) continue;
            u.hp += heal;
            u.custom = { ...(u.custom ?? {}), shadowBlood: Number(u.custom?.shadowBlood ?? 0) + heal };
            if (corruptDeath(state, u, api)) continue;
          }
        },
      },
    ],
  },
};

/* ── 仆系三个兵 ─────────────────────────────────────────────────── */

/** 傀儡师：自己不弱，但活是傀儡干的。 */
const PUPPET_MASTER_DEF: UnitTypeDef = {
  id: PUPPET_MASTER,
  name: '傀儡师',
  short: '傀',
  era: 3,
  category: 'combat',
  cost: 200,
  move: 2,
  atk: 18,
  armor: 8,
  maxHp: 100,
  range: 2,
  vision: 6,
  summonedOnly: true,
  aiAutonomy: 0.35,
  aiProfile: 'servant-hang-back',
  abilities: ['break-lineage', 'leave-food', 'puppet-craft'],
};

/** 勾魂使：会飞会跳，藏在黑雾里拽人。 */
const SOUL_HOOKER_DEF: UnitTypeDef = {
  id: SOUL_HOOKER,
  name: '勾魂使',
  short: '勾',
  era: 3,
  category: 'combat',
  cost: 220,
  move: 4,
  atk: 20,
  armor: 8,
  maxHp: 80,
  range: 3,
  vision: 7,
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 5,
  aiAutonomy: 0.35,
  aiProfile: 'servant-hang-back',
  abilities: ['break-lineage', 'leave-food', 'shadow-stalk', 'soul-hook'],
  skills: [SHADOW_STEP_SKILL],
};

/** 血医：用受污染的血救人。 */
const BLOOD_MEDIC_DEF: UnitTypeDef = {
  id: BLOOD_MEDIC,
  name: '血医',
  short: '医',
  era: 3,
  category: 'combat',
  cost: 180,
  move: 3,
  atk: 10,
  armor: 6,
  maxHp: 90,
  range: 2,
  vision: 5,
  summonedOnly: true,
  aiAutonomy: 0.35,
  aiProfile: 'servant-hang-back',
  abilities: ['break-lineage', 'leave-food', 'blood-aura'],
};

/* ── 仆系行为 ───────────────────────────────────────────────────── */

/**
 * 「不往人堆里扎」：这是仆系的共同纪律。
 *
 * 但有一条例外——**有人摸到仙帝（或裔系）旁边时，这条立刻作废**：
 * 那时候它们会直接扑上去。所以"逼近仙帝"是能解掉这个龟缩的。
 */
const SERVANT_HANG_BACK: UnitAiProfile = {
  id: 'servant-hang-back',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 1;
    const eco = (u: Unit): boolean => c.state.unitTypes[u.type]?.category === 'economy';

    // 护的人被贴上了？那就没有"往后站"这回事了
    const wards = c.allies.filter((a) => a.hp > 0 && isWard(a));
    const threatened = wards.some((w) => c.foes.some((f) => dist(f, w) <= 3));

    if (!threatened) {
      // 找"最挤的那一团"：以每个敌人为中心，数 2 格内有几个敌人
      let worst: { x: number; y: number; n: number } | null = null;
      for (const f of c.foes) {
        const n = c.foes.filter((o) => dist(o, f) <= 2).length;
        if (!worst || n > worst.n) worst = { x: f.x, y: f.y, n };
      }
      if (worst && worst.n >= 3 && dist(c.unit, worst) <= 3) {
        const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
        let best: { x: number; y: number } | null = null;
        let bestD = dist(c.unit, worst);
        for (const p of tiles) if (dist(p, worst) > bestD) (bestD = dist(p, worst)), (best = p);
        if (best) add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 115 });
      }
    }

    // 常规：打射程内非经济的血少目标
    const prey = c.foes
      .filter((f) => dist(f, c.unit) <= range && !eco(f))
      .sort((a, b) => a.hp - b.hp)[0];
    if (prey) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: prey.id }, score: threatened ? 180 : 160 });

    return add.length ? { add } : {};
  },
};

/* ══════════════════════════════════════════════════════════════════
 * 十一、裔系（2026-11-19）
 *
 * 仙帝的直系血脉：眷属 → 后裔 → 子嗣，一层比一层强，也一层比一层"认家"。
 * 共同点：**看到弱小的城就撤**——它们不是来抢地盘的，是来巡视的。
 * ══════════════════════════════════════════════════════════════════ */

export const KINDRED = 'kindred';
export const DESCENDANT = 'descendant';
export const OFFSPRING = 'offspring';

/** 撤离期多长（自己的回合数） */
const WITHDRAW_TURNS = 10;
/** 看到时代 ≤ 这个数的敌城就撤 */
const WITHDRAW_ERA = 3;

/**
 * 眷属「归附」时认的名单：**只有仆系那三种**。
 *
 * 2026-11-19 作者纠正：原来我把卫系三只也算进来了，于是"场上仆从越多等得越久"
 * 会被卫系虚高的数字拖长，而且它会变成青铜卫那种机关——那不是"归附"，是"降级"。
 * 眷属是仆系的候补，只补仆系。
 */
const COURT_TYPES = [PUPPET_MASTER, SOUL_HOOKER, BLOOD_MEDIC];

/**
 * 「避城」：看到弱的城就撤，撤十回合再回来。
 *
 * 为什么这么设计（作者）：裔系不是来抢地盘的，是来**巡视**的。
 * 一座城退到 3 代以下，说明这里已经没什么可收的了——它们会退回沉眠地附近，
 * 或者干脆沉进暗影里等着。十回合后照旧出来走一圈。
 *
 * 这条也给了玩家一个反向的活路：**把城打残、让它掉级，能换来十回合的安宁**。
 */
const HEIR_WITHDRAW: AbilityDef = {
  id: 'heir-withdraw',
  name: '避城',
  summary: `看到时代 ≤ ${WITHDRAW_ERA} 的敌方城市就撤离 ${WITHDRAW_TURNS} 个回合，退回沉眠地附近或暗影深处。`,
  group: 'move',
  valueLabel: () => `见弱城撤离 ${WITHDRAW_TURNS} 回合`,
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.self,
        apply: (c) => {
          const { state, self } = c;
          const until = Number(self.custom?.retreatUntil ?? 0);
          if (until > state.turn) return; // 还在撤
          if (until > 0) self.custom = { ...(self.custom ?? {}), retreatUntil: 0 };
          const sight = state.unitTypes[self.type]?.vision ?? 5;
          const weak = state.cities.find(
            (city) =>
              !city.ruined &&
              city.owner !== self.owner &&
              city.era <= WITHDRAW_ERA &&
              Math.abs(city.x - self.x) + Math.abs(city.y - self.y) <= sight,
          );
          if (!weak) return;
          self.custom = { ...(self.custom ?? {}), retreatUntil: state.turn + WITHDRAW_TURNS };
          state.log.push({
            turn: state.turn,
            player: self.owner,
            text: `那一族的天塌了。${state.unitTypes[self.type]?.name ?? '它'}不再往这边来。`,
          });
        },
      },
    ],
  },
};

/** 「不据城」：裔系不占人类的废墟——它们不屑，也不愿意。 */
const SCORN_CITY: AbilityDef = {
  id: 'scorn-city',
  name: '不据城',
  summary: '不屑于占据人类的城市废墟：不会进驻废墟、也不会占领城市。',
  group: 'move',
  hooks: { canCaptureCity: () => '不据城：裔系不屑于占据一堆石头。' },
};

/**
 * 「归附」：眷属在场上待够了，就**变成一名仆从**。
 *
 * 待多久看"家里有多少仆从"：**仆从越多，越慢**（2 + 仆从数）。一个都没有时 2 回合就变——
 * 那时候它得赶紧去补个缺。变谁看"哪种最少"，所以它会自动补齐短板。
 */
const KINDRED_CONVERT: AbilityDef = {
  id: 'kindred-convert',
  name: '归附',
  summary: '在场上待够回合后变成一名**仆系**单位（场上仆系越多等得越久；变成三种里最少的那种）。',
  group: 'support',
  valueLabel: () => '待够就变仆从',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.summon,
        apply: (c) => {
          const { state, self } = c;
          const servants = state.units.filter((u) => u.owner === self.owner && u.hp > 0 && COURT_TYPES.includes(u.type));
          const need = 2 + servants.length;
          const waited = Number(self.custom?.waited ?? 0) + 1;
          if (waited < need) {
            self.custom = { ...(self.custom ?? {}), waited };
            return;
          }
          // 挑场上最少的那种仆从；一样多就按名单顺序
          let pick = COURT_TYPES[0]!;
          let fewest = Infinity;
          for (const t of COURT_TYPES) {
            const n = servants.filter((u) => u.type === t).length;
            if (n < fewest) {
              fewest = n;
              pick = t;
            }
          }
          transform(self, pick, state);
          self.custom = { ...(self.custom ?? {}), waited: 0 };
          state.log.push({
            turn: state.turn,
            player: self.owner,
            text: `${state.unitTypes[pick]?.name ?? '仆从'}的队伍里多了一个人——它原来是个眷属。`,
          });
        },
      },
    ],
  },
};

/**
 * 「衍嗣」/「传裔」/「黑暗之源」共用的召唤：每 N 个自己的回合召一个，封顶 M。
 *
 * `key` 是计时器存在 `custom` 里的字段名。**必须能分开**：同一个兵身上挂两条召唤时
 * （仙帝既有「黑暗之源」又有「衍脉」），共用一个键会让两条互相偷计时器。
 */
function heirSummon(o: {
  id: string;
  name: string;
  summary: string;
  every: number;
  type: string;
  max: number;
  key?: string;
}): AbilityDef {
  const key = o.key ?? 'spawnIn';
  return {
    id: o.id,
    name: o.name,
    summary: o.summary,
    group: 'support',
    valueLabel: () => `每 ${o.every} 回合一个，上限 ${o.max}`,
    hooks: {
      onTurnStart: [
        {
          stage: TURN_START.summon,
          apply: (c) => {
            const { state, self, api } = c;
            const alive = state.units.filter((u) => u.owner === self.owner && u.hp > 0 && u.type === o.type).length;
            if (alive >= o.max) return;
            const left = Number(self.custom?.[key] ?? o.every) - 1;
            if (left > 0) {
              self.custom = { ...(self.custom ?? {}), [key]: left };
              return;
            }
            const spot = freeNear(state, self, o.type, api);
            if (!spot) {
              self.custom = { ...(self.custom ?? {}), [key]: 1 };
              return;
            }
            api.spawn(state, self.owner, o.type, spot.x, spot.y);
            self.custom = { ...(self.custom ?? {}), [key]: o.every };
            state.log.push({ turn: state.turn, player: self.owner, text: `${o.name}：又添了一个。` });
          },
        },
      ],
    },
  };
}

/* ── 裔系三个兵 ─────────────────────────────────────────────────── */

/** 眷属：比后裔弱一层，和仆系基础数值相当。 */
const KINDRED_DEF: UnitTypeDef = {
  id: KINDRED,
  name: '眷属',
  short: '眷',
  era: 4,
  category: 'combat',
  cost: 120,
  move: 3,
  atk: 18,
  armor: 8,
  maxHp: 100,
  range: 2,
  vision: 6,
  summonedOnly: true,
  shadowRadius: 1,
  aiAutonomy: 0.25,
  aiProfile: 'heir-order',
  abilities: ['break-lineage', 'leave-food', 'heir-withdraw', 'scorn-city', 'kindred-convert'],
  skills: [SHADOW_STEP_SKILL],
};

/** 后裔：比子嗣弱一层，会生出眷属。 */
const DESCENDANT_DEF: UnitTypeDef = {
  id: DESCENDANT,
  name: '后裔',
  short: '裔',
  era: 4,
  category: 'combat',
  cost: 200,
  move: 3,
  atk: 26,
  armor: 10,
  maxHp: 130,
  range: 3,
  vision: 7,
  summonedOnly: true,
  shadowRadius: 1,
  aiAutonomy: 0.25,
  aiProfile: 'heir-order',
  abilities: [
    'break-lineage',
    'leave-food',
    'heir-withdraw',
    'scorn-city',
    'heir-summon-descendant',
  ],
  skills: [SHADOW_STEP_SKILL],
};

/** 子嗣：全方位的强，会飞，会生后裔。 */
const OFFSPRING_DEF: UnitTypeDef = {
  id: OFFSPRING,
  name: '子嗣',
  short: '嗣',
  era: 4,
  category: 'combat',
  cost: 320,
  move: 3,
  atk: 40,
  armor: 14,
  maxHp: 180,
  range: 4,
  vision: 8,
  /*
   * "同时拥有真元和暗蚀"（2026-11-19 作者定的落法）：
   * 真元做不了（那是修士境界系统的产物），**魔法段也不行**——那是奇想包的污染核心，
   * 这个包不该借。所以这一段直接**并进暗蚀**：它的暗蚀值是全包最高的。
   */
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 1,
  aiAutonomy: 0.25,
  aiProfile: 'heir-order',
  abilities: [
    'break-lineage',
    'leave-food',
    'heir-withdraw',
    'scorn-city',
    'heir-summon-offspring',
    'shadow-erosion',
  ],
  skills: [SHADOW_STEP_SKILL],
};

/** 「传裔」：后裔每 3 回合生一个眷属（上限 2） */
const DESCEND_KINDLE = heirSummon({
  id: 'heir-summon-descendant',
  name: '传裔',
  summary: '每 3 个自己的回合生出一个眷属（上限 2 个）。',
  every: 3,
  type: KINDRED,
  max: 2,
});

/**
 * 「黑暗之源」：每 3 回合爬出**一只黑蝗 + 一个诡异**（每种上限 3）。
 *
 * 2026-11-19 改：原来只出黑蝗，而且"诡异"（`unnamable`）在场上根本没有来源——
 * 那只怪是玩家只能从关卡里遇到的孤儿。现在它是这条词条的产物之一：
 * **黑暗在哪儿都能长出这两样东西**，仙帝、骨灰罐、以及诡异自己都带着它。
 *
 * 两种单位各自封顶（按**这一方场上**该类活着的数量算），所以一个源头最多养出
 * 3 只黑蝗 + 3 个诡异；三个源头共享这几个名额，不会叠加到 9 只。
 */
const DARK_SOURCE: AbilityDef = {
  id: 'dark-source',
  name: '黑暗之源',
  summary: '每 3 个自己的回合爬出一只黑蝗和一个诡异（每种上限 3）。',
  group: 'support',
  valueLabel: () => '每 3 回合：黑蝗 + 诡异',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.summon,
        apply: (c) => {
          const { state, self, api } = c;
          const left = Number(self.custom?.locustIn ?? 3) - 1;
          if (left > 0) {
            self.custom = { ...(self.custom ?? {}), locustIn: left };
            return;
          }
          let born = 0;
          for (const [type, max] of [
            [BLACK_LOCUST, 3],
            [UNNAMABLE, 3],
          ] as const) {
            const alive = state.units.filter((u) => u.owner === self.owner && u.hp > 0 && u.type === type).length;
            if (alive >= max) continue;
            const spot = freeNear(state, self, type, api);
            if (!spot) continue;
            api.spawn(state, self.owner, type, spot.x, spot.y);
            born += 1;
          }
          if (born > 0) {
            self.custom = { ...(self.custom ?? {}), locustIn: 3 };
            state.log.push({ turn: state.turn, player: self.owner, text: '黑暗里又爬出了东西。' });
          } else {
            // 两边都满了（或者没地方站）：过一回合再看
            self.custom = { ...(self.custom ?? {}), locustIn: 1 };
          }
        },
      },
    ],
  },
};

/** 「衍脉」：每回合生一个子嗣（上限 2）。仙帝与骨灰罐共有——这条是它们"最贵"的地方。 */
const LINEAGE_WELL = heirSummon({
  id: 'lineage-well',
  name: '衍脉',
  summary: '每个自己的回合生出一个子嗣（上限 2 个）。',
  every: 1,
  type: OFFSPRING,
  max: 2,
  key: 'heirIn',
});

/** 「衍嗣」：子嗣每 2 回合生一个后裔（上限 2） */
const OFFSPRING_BEAR = heirSummon({
  id: 'heir-summon-offspring',
  name: '衍嗣',
  summary: '每 2 个自己的回合生出一个后裔（上限 2 个）。',
  every: 2,
  type: DESCENDANT,
  max: 2,
});

/* ══════════════════════════════════════════════════════════════════
 * 十二、"不好分类"的三件（2026-11-19）
 *
 * 两座建筑 + 一个强者。它们在剧情上是仙帝这条线的前因与后果：
 *   骨灰罐 → 仙帝（腐化的来源，也是他一次次回来的地方）
 *   成帝碑 → 知识污染（谁靠近都会变成诡异，只有修士能"读"它）
 *   红尘仙 → 读过碑、或者熬到寿元将尽的那一类存在
 * ══════════════════════════════════════════════════════════════════ */

export const FUNERARY_URN = 'funerary-urn';
export const IMPERIAL_STELE = 'imperial-stele';
export const MORTAL_IMMORTAL = 'mortal-immortal';

/** 复活后生命上限低于这个数就再也回不来了 */
const TRANSCEND_FLOOR = 200;
/** 碑文的影响半径 = 该单位视野 × 这个比例（向上取整） */
const STELE_VISION_RATIO = 0.5;
/** 读过碑之后几回合死 */
const STELE_DOOM_TURNS = 3;
/** 「仙帝凝视」持续几回合 */
const STELE_BUFF_TURNS = 2;
/** 能免疫"知识污染"、也有资格去读碑的境界 */
const STELE_RANK_GATE = 6;
/** 「仙帝凝视」 */
export const IMPERIAL_GAZE = 'imperial-gaze';

registerStatus({
  id: IMPERIAL_GAZE,
  name: '仙帝凝视',
  summary: '读过碑文的人：境界 +1，但三回合后必死。',
});

/**
 * 「超脱」：仙帝倒下时，骨灰罐把他再拉回来一次——**代价是一次比一次弱**。
 *
 * 年龄清零、寿元减半、生命上限减半；下一次再死，就在这个基础上再减半。
 * 生命上限跌到 200 以下时，罐子也就空了（`TRANSCEND_FLOOR`）。
 *
 * 记在骨灰罐的 `custom.revives` 上：一次超脱 +1，所以第 n 次复活的
 * 生命上限是 `基础 / 2^n`。
 */
const TRANSCEND: AbilityDef = {
  id: 'transcend',
  name: '超脱',
  summary: '尸骸仙帝倒下时，在罐边以 0 岁、寿元减半、生命上限减半的状态复活；上限跌破底线后不再复活。',
  group: 'support',
  valueLabel: () => '仙帝倒下就拉回来（每次更弱）',
};

/**
 * 「知识污染」：靠近碑的东西会**直接变成诡异**。
 *
 * 半径按"看的那个人"算：`ceil(视野 / 2)`。所以眼睛越尖的越早中招——
 * 这是一条反直觉但说得通的规则：你看得越远，越先读懂它。
 *
 * 6 级以上的修士免疫（他们能"读"，而不是被读）。
 */
const KNOWLEDGE_POLLUTION: AbilityDef = {
  id: 'knowledge-pollution',
  name: '知识污染',
  summary: `视野一半内的敌人都变成 1 不详 + 2 黑蝗；${STELE_RANK_GATE} 级以上的修士免疫。`,
  group: 'attack',
  valueLabel: () => `视野 1/2 内污染`,
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.support,
        apply: (c) => {
          const { state, self, api } = c;
          for (const u of [...state.units]) {
            if (u.hp <= 0 || u.owner === self.owner) continue;
            if ((Number(u.custom?.rank ?? 0)) >= STELE_RANK_GATE) continue;
            const sight = state.unitTypes[u.type]?.vision ?? 4;
            const reach = Math.ceil(sight * STELE_VISION_RATIO);
            if (Math.abs(u.x - self.x) + Math.abs(u.y - self.y) > reach) continue;
            const at = { x: u.x, y: u.y };
            api.killUnit(state, u, undefined, '读了不该读的东西');
            api.spawnNear(state, self.owner, BONE_UNNAMED, { ...u, x: at.x, y: at.y } as Unit);
            for (let i = 0; i < 2; i += 1) {
              api.spawnNear(state, self.owner, BLACK_LOCUST, { ...u, x: at.x, y: at.y } as Unit);
            }
            state.log.push({ turn: state.turn, player: u.owner, text: '它读懂了碑上的字——然后就不成形状了。' });
          }
        },
      },
    ],
  },
};

/** 尘封的岁数：仙帝/红尘仙都会老，红尘仙没资格吃同伴，所以只能更频繁地出山 */
const MORTAL_LIFESPAN = 160;

/* ── 三件东西本体 ───────────────────────────────────────────────── */

/** 骨灰罐：两万血、两千甲，不会动也不会打。它只是在那里。 */
const URN_DEF: UnitTypeDef = {
  id: FUNERARY_URN,
  name: '骨灰罐',
  short: '罐',
  era: 1,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 2000,
  maxHp: 20000,
  range: 0,
  vision: 3,
  summonedOnly: true,
  shadowRadius: 10,
  // 罐子不只是遗物：它自己也在往黑暗里吐东西（黑暗之源 + 衍脉）
  abilities: ['transcend', 'dark-source', 'lineage-well'],
};

/** 成帝碑：碑文本身就是武器。 */
const STELE_DEF: UnitTypeDef = {
  id: IMPERIAL_STELE,
  name: '成帝碑',
  short: '碑',
  era: 1,
  category: 'building',
  cost: 0,
  move: 0,
  atk: 0,
  armor: 200,
  maxHp: 5000,
  range: 0,
  vision: 4,
  summonedOnly: true,
  shadowRadius: 3,
  abilities: ['knowledge-pollution'],
};

/**
 * 红尘仙：**对标八级修士**（2026-11-19 重调）。
 *
 * 八级炼气士 = 基础 + 境界加成 攻 143 / 甲 89 / 血 3928 / 真元 50 / 射 +4 / 移 +2 / 4 段 / 溅射 2
 * → **攻 153 · 甲 89 · 血 3948 · 真伤 50 · 4 段**。
 * 这里逐项照抄那组数，所以它和"练到八级的修士"是同一把尺子量出来的。
 */
const MORTAL_IMMORTAL_DEF: UnitTypeDef = {
  id: MORTAL_IMMORTAL,
  name: '红尘仙',
  short: '尘',
  era: 4,
  category: 'combat',
  cost: 0,
  move: 4,
  atk: 153,
  armor: 89,
  maxHp: 3948,
  range: 5,
  vision: 9,
  burst: 4,
  splash: 2,
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 3,
  aiAutonomy: 0.6,
  aiProfile: 'mortal-immortal-harvest',
  // 2026-11-19 作者给的一套：飞、跳、化血、暗影侵蚀、断传承、痴愚
  abilities: ['swift-aging', 'shadow-erosion', 'blood-clot', 'shadow-possess', 'break-lineage', 'dull-wit'],
  skills: [SHADOW_STEP_SKILL],
};

/** 每个兵种的老化参数：寿元上限、登场年龄 */
const AGING: Record<string, { lifespan: number; startAge: number }> = {
  [EMPEROR]: { lifespan: 200, startAge: 140 },
  [MORTAL_IMMORTAL]: { lifespan: 160, startAge: 120 },
};

/**
 * 「加速衰老」：仙帝与红尘仙都有，也是它们**为什么会死**的全部答案。
 *
 * 以前这件事写在扩展的回合钩子里（`tickEmperor` / `tickMortals`），
 * 玩家在面板上完全看不到——只看到"它好像越来越弱"，甚至以为是被谁打了。
 * 现在做成词条：面板会印出"年龄 / 寿元"，规则书里也查得到。
 *
 * 规则：
 *   · 在沉眠地附近（2 格）每回合 +1 岁，在外面 +2 岁——**出去是会折寿的**；
 *   · 年龄超过寿元就死（仙帝靠骨灰罐回来，红尘仙没有）。
 */
const SWIFT_AGING: AbilityDef = {
  id: 'swift-aging',
  name: '加速衰老',
  summary: '在沉眠地附近每回合老 1 岁，离开沉眠地加倍。年龄超过寿元就会死。',
  group: 'defense',
  valueLabel: () => '沉眠地外衰老加倍',
  hooks: {
    onTurnStart: [
      {
        stage: TURN_START.self,
        apply: (c) => {
          const { state, self, api } = c;
          const spec = AGING[self.type];
          if (!spec) return;
          // 第一回合落库：把寿元和登场年龄写进 custom（超脱/读碑造的会自己带上）
          if (self.custom?.dtInit !== 1) {
            self.custom = {
              ...(self.custom ?? {}),
              lifespan: lifespanOf(self) ?? spec.lifespan,
              dtInit: 1,
            };
            if ((self.age ?? 0) <= 1) self.age = spec.startAge;
          }
          if (!inSlumber(state, self)) self.age = (self.age ?? 0) + 1;
          if ((self.age ?? 0) > (lifespanOf(self) ?? spec.lifespan)) {
            api.killUnit(
              state,
              self,
              undefined,
              self.type === EMPEROR ? '尸骸仙帝寿元耗尽，化作一地白骨' : '红尘仙寿元耗尽，散作尘埃',
            );
          }
        },
      },
    ],
  },
};

/** 红尘仙的暗蚀 */
// （加进 EROSION_BY_TYPE 的见下面那张表）

/* ── 红尘仙的老死与出山 ─────────────────────────────────────────── */


/** 读过碑的人：三回合到了就死，尸体会站起一名红尘仙 */
function tickDoomed(state: GameState, api: AbilityApi): void {
  for (const u of [...state.units]) {
    if (u.hp <= 0) continue;
    const at = Number(u.custom?.doomAt ?? 0);
    if (!at || at > state.turn) continue;
    const owner = (u.custom?.steleOwner ?? u.owner) as PlayerId;
    api.killUnit(state, u, undefined, '读碑的人走了');
    const born = api.spawnNear(state, owner, MORTAL_IMMORTAL, u);
    if (born) born.custom = { ...(born.custom ?? {}), lifespan: MORTAL_LIFESPAN, dtInit: 1, rank: 8 };
    state.log.push({ turn: state.turn, player: owner, text: '他倒下的地方站起来一个人——红尘里又多了一位。' });
  }
}

/** 红尘仙该不该出山 */
function mortalIsOut(state: GameState, u: Unit): boolean {
  const left = (lifespanOf(u) ?? MORTAL_LIFESPAN) - (u.age ?? 0);
  if (left <= STARVE_LEFT) return true;
  const emperor = state.units.find((o) => o.owner === u.owner && o.type === EMPEROR && o.hp > 0);
  return !!emperor && !inSlumber(state, emperor);
}

/**
 * 仙帝的来去：**该回家就回家，在家就待着**。
 *
 * 这条 profile 只做两件事：
 *   · 判"该不该回"（见「出山」那两条判据），该回就给一个 240 分的走位候选——
 *     压得住总指挥给的任何进攻动作；
 *   · 在外的时候补一手"往敌人身上靠"，让它的出山不像乱走。
 *
 * 分数为什么要这么高：它的自主分只有 0.35，`240 × 0.35 = 84`，
 * 还得高过普通进攻（≈6~20），所以给足。
 */
const EMPEROR_CYCLE_AI: UnitAiProfile = {
  id: 'emperor-cycle',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const { state, unit } = c;
    const homeX = Number(unit.custom?.homeX ?? NaN);
    const homeY = Number(unit.custom?.homeY ?? NaN);
    const home = Number.isFinite(homeX) && Number.isFinite(homeY) ? { x: homeX, y: homeY } : null;
    const out = !inSlumber(state, unit);
    const left = yearsLeft(unit);
    const outTurns = Number(unit.custom?.outTurns ?? 0);

    if (home && out) {
      const shouldReturn =
        left >= HARVEST_HOME_LEFT || (outTurns > HARVEST_MAX_OUT && left > HARVEST_HUNGRY_LEFT);
      if (shouldReturn) {
        const gap = dist(unit, home);
        if (gap === 0) return {};
        /*
         * 回家也用它自己的暗影跳跃：8 格暗影铺出去之后，"跳一段再走"比纯走快得多。
         * 只在不亏的时候跳（至少省 3 格），否则老实走。
         */
        if (canStep(c) && gap > 4) {
          const jump = bestShadowJump(c, (x, y) => -dist({ x, y }, home));
          if (jump && dist({ x: jump.x, y: jump.y }, home) <= gap - 3) {
            return {
              add: [
                {
                  action: { type: 'HERO_SKILL', unitId: unit.id, skillId: 'shadow-step', targetX: jump.x, targetY: jump.y },
                  score: 245,
                },
              ],
            };
          }
        }
        const walk = steps(c, Math.max(1, c.def.move))
          .filter((p) => p.d > 0)
          .sort((a, b) => dist(a, home) - dist(b, home))[0];
        if (walk && dist(walk, home) < gap) {
          return { add: [{ action: { type: 'MOVE', unitId: unit.id, x: walk.x, y: walk.y }, score: 240 }] };
        }
        return {};
      }
    }
    if (!out) return {};

    // 在外：打得到的就打（挑血最少的收人头），打不到就往最近的人挪
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 1;
    const prey = c.foes.filter((f) => dist(f, unit) <= range).sort((a, b) => a.hp - b.hp)[0];
    if (prey) add.push({ action: { type: 'ATTACK', unitId: unit.id, targetId: prey.id }, score: 170 });
    const goal = c.foes.sort((a, b) => dist(a, unit) - dist(b, unit))[0];
    if (goal) {
      const gap = dist(unit, goal);
      // 走不够快的时候跳：暗影跳跃是它 8 格暗影之外唯一的机动手段
      if (canStep(c) && gap > range + 4) {
        const jump = bestShadowJump(c, (x, y) => -dist({ x, y }, goal));
        if (jump && dist({ x: jump.x, y: jump.y }, goal) <= gap - 3) {
          add.push({
            action: { type: 'HERO_SKILL', unitId: unit.id, skillId: 'shadow-step', targetX: jump.x, targetY: jump.y },
            score: 175,
          });
        }
      }
      const walk = steps(c, Math.max(1, c.def.move))
        .filter((p) => p.d > 0)
        .sort((a, b) => dist(a, goal) - dist(b, goal))[0];
      if (walk && dist(walk, goal) < gap) {
        add.push({ action: { type: 'MOVE', unitId: unit.id, x: walk.x, y: walk.y }, score: 150 });
      }
    }
    return add.length ? { add } : {};
  },
};

/**
 * 红尘仙：出山就收割，没出山就缩在沉眠地附近。
 *
 * 不打同族（这是仙帝的特权），所以它的目标永远是敌人。
 */
const MORTAL_IMMORTAL_AI: UnitAiProfile = {
  id: 'mortal-immortal-harvest',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 4;
    const out = mortalIsOut(c.state, c.unit);

    const prey = c.foes
      .filter((f) => dist(f, c.unit) <= range)
      .sort((a, b) => a.hp - b.hp)[0];
    if (prey && out) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: prey.id }, score: 185 });

    if (out) {
      const goal = c.foes.sort((a, b) => dist(a, c.unit) - dist(b, c.unit))[0];
      if (goal) {
        const walk = steps(c, Math.max(1, c.def.move))
          .filter((p) => p.d > 0)
          .sort((a, b) => dist(a, goal) - dist(b, goal))[0];
        if (walk && dist(walk, goal) < dist(c.unit, goal)) {
          add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: walk.x, y: walk.y }, score: 150 });
        }
      }
      return add.length ? { add } : {};
    }

    // 没出山：缩回沉眠地附近
    const slumber = c.allies.find((a) => a.type === SLUMBER && a.hp > 0);
    if (!slumber) return add.length ? { add } : {};
    const walk = steps(c, Math.max(1, c.def.move))
      .filter((p) => p.d > 0)
      .sort((a, b) => dist(a, slumber) - dist(b, slumber))[0];
    if (walk && dist(walk, slumber) < dist(c.unit, slumber)) {
      add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: walk.x, y: walk.y }, score: 140 });
    }
    return add.length ? { add } : {};
  },
};

/* ── 裔系行为 ───────────────────────────────────────────────────── */

/**
 * 裔系：**平时听指挥往前走，撤离期往家里退**。
 *
 * "听指挥"靠 `aiAutonomy` 只有 0.25——大部分行动由总体 AI 决定；
 * 这条 profile 只在撤离期说话（分数 220，压得住其它走位）。
 */
const HEIR_ORDER: UnitAiProfile = {
  id: 'heir-order',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const { state } = c;
    const until = Number(c.unit.custom?.retreatUntil ?? 0);
    if (until <= state.turn) return {};

    /*
     * 撤离目标按优先级挑：
     *   1. 沉眠地（"回到仙帝身边待命"——最符合剧情）；
     *   2. 暗影最深处（没有沉眠地就沉进黑暗）；
     *   3. 都不是自己站着的地方时才会用；否则退而求其次——**离那座弱城远一点**。
     *
     * 第三条是必要的兜底：裔系自己只投下 1 格暗影，站在空地上时"最深处"就是脚下，
     * 不给兜底的话它会站在原地"撤离"，看起来像卡住了。
     */
    const slumber = c.allies.find((a) => a.type === SLUMBER && a.hp > 0);
    const deep = deepestShadow(state, c.unit);
    const weakCity = state.cities.find((city) => !city.ruined && city.owner !== c.unit.owner && city.era <= WITHDRAW_ERA);
    let goal: { x: number; y: number } | null = slumber ?? null;
    if (!goal && deep && (deep.x !== c.unit.x || deep.y !== c.unit.y)) goal = deep;

    const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
    if (goal) {
      const gap = dist(c.unit, goal);
      const walk = tiles.sort((a, b) => dist(a, goal!) - dist(b, goal!))[0];
      if (walk && dist(walk, goal) < gap) {
        return { add: [{ action: { type: 'MOVE', unitId: c.unit.id, x: walk.x, y: walk.y }, score: 220 }] };
      }
      return {};
    }
    if (weakCity) {
      let best: { x: number; y: number } | null = null;
      let bestD = dist(c.unit, weakCity);
      for (const p of tiles) if (dist(p, weakCity) > bestD) (bestD = dist(p, weakCity)), (best = p);
      if (best) return { add: [{ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 220 }] };
    }
    return {};
  },
};

/* ── 仆从行为 ───────────────────────────────────────────────────── */

/**
 * 仆从的"自主性"：**推着走，但不乱吃**。
 *
 * 他们的主要行动仍然归总指挥（自主分只有 0.45），这条 profile 只做三件小事：
 *   · 优先打射程内**非经济**的血少目标（留着产线给仙帝）；
 *   · 朝最近的**非经济**敌人挪；
 *   · 不和同类挤在同一格（机关是组装出来的，挤在一起吃一发溅射就全废）。
 */
const SERVANT_AI: UnitAiProfile = {
  id: 'servant-advance',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 1;
    const eco = (u: Unit): boolean => c.state.unitTypes[u.type]?.category === 'economy';

    const prey = c.foes
      .filter((f) => dist(f, c.unit) <= range && !eco(f))
      .sort((a, b) => a.hp - b.hp)[0];
    if (prey) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: prey.id }, score: 165 });

    const goal = c.foes.filter((f) => !eco(f)).sort((a, b) => dist(a, c.unit) - dist(b, c.unit))[0];
    if (!goal) return add.length ? { add } : {};
    const kin = c.allies.filter((a) => a.id !== c.unit.id && a.hp > 0 && a.type === c.unit.type);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (const p of steps(c, Math.max(1, c.def.move)).filter((q) => q.d > 0)) {
      const crowd = Math.min(...kin.map((k) => dist(k, p)), 3);
      const score = -dist(p, goal) + crowd * 1.2;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best && dist(best, goal) < dist(c.unit, goal)) {
      add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 110 });
    }
    return add.length ? { add } : {};
  },
};

/* ── 三个 profile ───────────────────────────────────────────────── */

/**
 * 黑蝗：**往暗影里钻、离硬手远一点**，专咬甲厚的。
 *
 * 甲厚的单位通常慢、近战——对一只 5 速的飞虫来说是最安全的猎物；
 * 反过来"离攻击力强的远一点"是它唯一的保命本能。
 */
const LOCUST_AI: UnitAiProfile = {
  id: 'locust-swarm',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 1;

    const hard = c.foes
      .filter((f) => dist(f, c.unit) <= range)
      .sort((a, b) => (c.state.unitTypes[b.type]?.armor ?? 0) - (c.state.unitTypes[a.type]?.armor ?? 0))[0];
    if (hard) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: hard.id }, score: 150 });

    /*
     * 走位：偏好暗影格、离"打人疼的"远一点，**并且离黑茧远一点**
     * （2026-11-19 作者加的）。理由很实：黑茧旁边是"该结茧的地方"，
     * 一群黑蝗围着一颗茧只会被玩家一发溅射一起清掉——散开才铺得开。
     */
    const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
    const cocoons = c.allies.filter((a) => a.type === BLACK_COCOON && a.hp > 0);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (const p of tiles) {
      const inShadow = inShadowCell(c.state, p.x, p.y, c.unit.board) ? 6 : 0;
      const strong = c.foes.filter((f) => (c.state.unitTypes[f.type]?.atk ?? 0) >= 30);
      const safe = Math.min(...strong.map((f) => dist(f, p)), 8);
      const awayCocoon = Math.min(...cocoons.map((k) => dist(k, p)), 6);
      const score = inShadow + safe * 0.8 + awayCocoon * 0.9;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 110 });
    return add.length ? { add } : {};
  },
};

/** 黑茧：不会动，打射程内**最近**的。 */
const COCOON_AI: UnitAiProfile = {
  id: 'cocoon-nearest',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const range = c.def.range ?? 5;
    const near = c.foes
      .filter((f) => dist(f, c.unit) <= range)
      .sort((a, b) => dist(a, c.unit) - dist(b, c.unit))[0];
    if (!near) return {};
    return { add: [{ action: { type: 'ATTACK', unitId: c.unit.id, targetId: near.id }, score: 170 }] };
  },
};

/**
 * 诡异：**补刀最虚的，然后沉回暗影里**。
 *
 * 作者没给它的倾向，这里是补的：它是"打完就消失"的东西，
 * 所以挑血最少的收人头，没有目标就回暗影最深处等着。
 */
const UNNAMABLE_AI: UnitAiProfile = {
  id: 'unnamable-stalk',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 3;

    /*
     * 血量越低越"往暗影里躲"，而且会**放弃攻击**（2026-11-19 作者）。
     *
     * 分界点定在一半血：过线之后它只做一件事——找最深的暗影钻进去，
     * 而且越虚越急（`pull` 从 150 涨到 230，压得住大部分走位候选）。
     * 配合「暗影呼吸」，它躲进去几回合就能回上来，再出来收人头——
     * 这一整段就是它"打不死"的来源，也是玩家该追进去的理由。
     */
    const maxHp = c.def.maxHp || 1;
    const ratio = Math.max(0, Math.min(1, c.unit.hp / maxHp));
    const wounded = ratio <= 0.5;

    if (!wounded) {
      const prey = c.foes.filter((f) => dist(f, c.unit) <= range).sort((a, b) => a.hp - b.hp)[0];
      if (prey) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: prey.id }, score: 175 });
    }

    const deep = deepestShadow(c.state, c.unit);
    if (deep && (deep.x !== c.unit.x || deep.y !== c.unit.y)) {
      const gap = dist(c.unit, deep);
      const pull = wounded ? 150 + Math.round((1 - ratio) * 80) : 120;
      if (canStep(c) && gap > Math.max(1, c.def.move) + 2) {
        add.push({
          action: { type: 'HERO_SKILL', unitId: c.unit.id, skillId: 'shadow-step', targetX: deep.x, targetY: deep.y },
          score: pull + 20,
        });
      } else {
        const walk = steps(c, Math.max(1, c.def.move))
          .filter((p) => p.d > 0)
          .sort((a, b) => dist(a, deep) - dist(b, deep))[0];
        if (walk && dist(walk, deep) < gap) {
          add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: walk.x, y: walk.y }, score: pull });
        }
      }
    }
    return add.length ? { add } : {};
  },
};

/* ── 骨系行为 ───────────────────────────────────────────────────── */

/**
 * 骸骨：**去找血肉**，找不到就去找最虚的敌人。
 *
 * 它自己不会变强——它只是在找一副能装下自己的躯壳。所以"吞血肉变尸骸"
 * 是它的全部目标，打人只是顺手。
 */
const BONE_SKELETON_AI: UnitAiProfile = {
  id: 'bone-seek-flesh',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 1;

    // 正在凝结（寻躯的第二段）：站着别动，动来动去永远变不成尸骸
    if (typeof c.unit.custom?.formTo === 'string') return {};

    const prey = c.foes.filter((f) => dist(f, c.unit) <= range).sort((a, b) => a.hp - b.hp)[0];
    if (prey) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: prey.id }, score: 170 });

    const flesh = c.allies.filter((a) => a.type === FLESH && a.hp > 0);
    const targets = flesh.length > 0 ? flesh : c.foes.filter((f) => f.hp > 0);
    if (targets.length === 0) return add.length ? { add } : {};
    // 血肉优先；没有血肉就朝血最少的敌人爬
    const goal = targets.sort(
      (a, b) => dist(a, c.unit) - dist(b, c.unit) || a.hp - b.hp,
    )[0]!;
    const walk = steps(c, Math.max(1, c.def.move))
      .filter((p) => p.d > 0)
      .sort((a, b) => dist(a, goal) - dist(b, goal))[0];
    if (walk && dist(walk, goal) < dist(c.unit, goal)) {
      add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: walk.x, y: walk.y }, score: 110 });
    }
    return add.length ? { add } : {};
  },
};

/**
 * 尸骸：**朝暗影去**，够不着就不动。
 *
 * 它只在有暗影可吞的时候才有目标（吞了变不详）；没有暗影就原地待着——
 * 一具拼起来的东西没有"巡逻"这种想法。
 */
const BONE_CORPSE_AI: UnitAiProfile = {
  id: 'corpse-toward-shade',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 3;

    const scary = c.foes
      .filter((f) => dist(f, c.unit) <= range)
      .sort((a, b) => (c.state.unitTypes[b.type]?.atk ?? 0) - (c.state.unitTypes[a.type]?.atk ?? 0))[0];
    if (scary) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: scary.id }, score: 175 });

    const shades = c.allies.filter((a) => a.type === SHADE && a.hp > 0);
    if (shades.length === 0) return add.length ? { add } : {};
    const goal = shades.sort((a, b) => dist(a, c.unit) - dist(b, c.unit))[0]!;
    const walk = steps(c, Math.max(1, c.def.move))
      .filter((p) => p.d > 0)
      .sort((a, b) => dist(a, goal) - dist(b, goal))[0];
    if (walk && dist(walk, goal) < dist(c.unit, goal)) {
      add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: walk.x, y: walk.y }, score: 115 });
    }
    return add.length ? { add } : {};
  },
};

/**
 * 不详：**朝尸骸仙帝去，但不贴上去**；看不见仙帝就沉进暗影最深处。
 *
 * "不贴上去"是它的性格：那些碎块想合回仙帝身上，又不敢真的回去。
 * 所以到 4 格就停手，只在射程里挑护甲最厚的打——它想找一副最硬的壳。
 */
const BONE_UNNAMED_AI: UnitAiProfile = {
  id: 'unnamed-toward-emperor',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const add: UnitAiCandidate[] = [];
    const range = c.def.range ?? 3;

    const hard = c.foes
      .filter((f) => dist(f, c.unit) <= range)
      .sort(
        (a, b) =>
          (c.state.unitTypes[b.type]?.armor ?? 0) - (c.state.unitTypes[a.type]?.armor ?? 0) || a.hp - b.hp,
      )[0];
    if (hard) add.push({ action: { type: 'ATTACK', unitId: c.unit.id, targetId: hard.id }, score: 190 });

    const emperor = c.allies.find((a) => a.type === EMPEROR && a.hp > 0);
    let goal: { x: number; y: number } | null = null;
    if (emperor) {
      if (dist(emperor, c.unit) > 4) goal = emperor; // 太远才靠近，4 格内就停
    } else {
      goal = deepestShadow(c.state, c.unit); // 看不见仙帝：沉进最深的地方
    }
    if (!goal || (goal.x === c.unit.x && goal.y === c.unit.y)) return add.length ? { add } : {};
    const walk = steps(c, Math.max(1, c.def.move))
      .filter((p) => p.d > 0)
      .sort((a, b) => dist(a, goal) - dist(b, goal))[0];
    if (walk && dist(walk, goal!) < dist(c.unit, goal)) {
      add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: walk.x, y: walk.y }, score: 120 });
    }
    return add.length ? { add } : {};
  },
};

/* ══════════════════════════════════════════════════════════════════
 * 五、扩展本体
 * ══════════════════════════════════════════════════════════════════ */

/*
 * 把本包的词条登记进本地表。
 *
 * 为什么不查全局注册表（`abilityById`）：那是 `ability-registry.ts`，它在初始化时
 * 要遍历 EXPANSIONS，而 EXPANSIONS 正在导入这个文件——同一个循环依赖坑（见 unit-ai）。
 * 本包的面板只印自己的词条，本地表够用。
 */
for (const a of [
  EROSION_ABILITY,
  SHADOW_POSSESS,
  SHADOW_SPAWN,
  BLOOD_CLOT,
  BLOOD_SIPHON,
  BLOOD_INFECT,
  BLOOD_GROW,
  BONE_SEEK,
  BONE_REVIVE,
  BONE_AIRBORNE,
  BONE_ASSEMBLE,
  BONE_TRANSMUTE,
  BONE_DISSOLVE,
  LOCUST_BREED,
  LOCUST_COCOON,
  COCOON_ASCEND,
  UNNAMABLE_FORM,
  SHADOW_BREATH,
  BREAK_LINEAGE,
  DULL_WIT,
  LEAVE_FOOD,
  SHADOW_DRIVE,
  WRECK_REVIVE,
  WEAKEN_CRY,
  PUPPET_CRAFT,
  SHADOW_STALK,
  SOUL_HOOK,
  BLOOD_AURA,
  HEIR_WITHDRAW,
  SCORN_CITY,
  KINDRED_CONVERT,
  DESCEND_KINDLE,
  OFFSPRING_BEAR,
  TRANSCEND,
  KNOWLEDGE_POLLUTION,
  DARK_SOURCE,
  LINEAGE_WELL,
  SWIFT_AGING,
  EMPEROR_CYCLE,
]) {
  PACK_ABILITIES.set(a.id, a);
}

/**
 * 规则书里那张关系图（2026-11-19）。
 *
 * 为什么要有它：试玩的时候没人搞明白这十二只谁把谁变出来——
 * 光读文字要来回翻三节。这里四条横链（影 / 血 / 骨 / 零散），
 * **箭头就是"变成"**，交叉的地方用虚线框标出来。
 *
 * 用内联 SVG 而不是图片文件：规则书要能单文件分发、能打印、能跟着主题走。
 */
const TURMOIL_DIAGRAM = '<svg viewBox="0 0 760 500" xmlns="http://www.w3.org/2000/svg" ' +
  'font-family="ui-sans-serif, system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif">' +
  '<defs>' +
  '<marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
  '<path d="M0,0 L10,5 L0,10 z" fill="#8a8278"/></marker>' +
  '<marker id="arw2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
  '<path d="M0,0 L10,5 L0,10 z" fill="#b9b1a0"/></marker>' +
  '</defs>' +

  '<text x="8" y="16" font-size="12" fill="#6b6459">箭头 = “变成” · 虚线 = 跨系列 / 不是同类</text>' +

  // ── 影 lane ──
  '<text x="8" y="66" font-size="15" font-weight="600" fill="#3f5878">影</text>' +
  '<text x="8" y="84" font-size="11" fill="#9a9287">暗影领域</text>' +
  box(96, 34, '影主', '化影：每 4 回合两团') +
  box(316, 34, '暗影', '看不见的猎手') +
  box(536, 34, '蚀影', '影子里的伏击者') +
  arrow(246, 62, 316, '化影') +
  arrow(466, 62, 536, '击杀') +

  // ── 血 lane ──
  '<text x="8" y="162" font-size="15" font-weight="600" fill="#b8433a">血</text>' +
  '<text x="8" y="180" font-size="11" fill="#9a9287">越打越多</text>' +
  box(96, 130, '血核', '增生：满血剥血肉') +
  box(316, 130, '血肉', '汲取 · 侵染') +
  box(536, 130, '淤血', '化血：伤害攒够') +
  arrow(246, 158, 316, '增生') +
  arrow(466, 158, 536, '化血·长出') +

  // ── 骨 lane ──
  '<text x="8" y="258" font-size="15" font-weight="600" fill="#8a7b5a">骨</text>' +
  '<text x="8" y="276" font-size="11" fill="#9a9287">会拼装</text>' +
  box(96, 226, '骸骨', '找血肉') +
  box(316, 226, '尸骸', '找暗影') +
  box(536, 226, '不详', '朝仙帝走，4 格停') +
  arrow(246, 254, 316, '寻躯·吞血肉') +
  arrow(466, 254, 536, '复苏·吞暗影') +

  // ── 零散 lane ──
  '<text x="8" y="354" font-size="15" font-weight="600" fill="#6b6459">零散</text>' +
  '<text x="8" y="372" font-size="11" fill="#9a9287">不成一支</text>' +
  box(96, 322, '黑蝗', '繁殖：一回合翻一倍') +
  box(316, 322, '黑茧', '不会动的炮台') +
  '<rect x="536" y="322" width="150" height="56" rx="7" fill="#faf8f4" stroke="#b9b1a0" stroke-dasharray="5 4"/>' +
  '<text x="611" y="347" font-size="14" text-anchor="middle" fill="#6b6459">影主 / 血核</text>' +
  '<text x="611" y="364" font-size="11" text-anchor="middle" fill="#9a9287">（变成它们的头）</text>' +
  arrow(246, 350, 316, '结茧') +
  '<line x1="466" y1="350" x2="536" y2="350" stroke="#b9b1a0" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#arw2)"/>' +
  '<text x="501" y="342" font-size="10" text-anchor="middle" fill="#9a9287">升华</text>' +

  // ── 诡异：独立 ──
  '<rect x="96" y="402" width="590" height="42" rx="7" fill="#faf8f4" stroke="#b9b1a0" stroke-dasharray="5 4"/>' +
  '<text x="110" y="428" font-size="14" fill="#6b6459">诡异</text>' +
  '<text x="158" y="428" font-size="12" fill="#6b6459">不属于任何一支：看不见、跳得远，只有被它打过的人才打得中它</text>' +

  // ── 两条容易搞混的规则 ──
  '<text x="96" y="470" font-size="12" fill="#2b2823">' +
  '<tspan font-weight="600">尸体归谁：</tspan>暗影杀 → 蚀影 · 血系杀 → 血肉 · 骨系「拼装 / 解离」→ 骸骨 + 淤血 + 暗影</text>' +
  '<text x="96" y="490" font-size="12" fill="#2b2823">' +
  '<tspan font-weight="600">变形要停一回合：</tspan>寻躯 / 复苏 / 升华都会让对方原地一回合不动——那一回合是下手的机会</text>' +
  '</svg>';

/** 图里的一格：白底圆角框 + 名字 + 一行小注 */
function box(x: number, y: number, name: string, note: string): string {
  return (
    `<rect x="${x}" y="${y}" width="150" height="56" rx="7" fill="#ffffff" stroke="#ddd6c8"/>` +
    `<text x="${x + 75}" y="${y + 25}" font-size="14" text-anchor="middle" fill="#2b2823">${name}</text>` +
    `<text x="${x + 75}" y="${y + 43}" font-size="11" text-anchor="middle" fill="#9a9287">${note}</text>`
  );
}

/** 两个框之间的一支箭头（带标签） */
function arrow(fromX: number, y: number, toX: number, label: string): string {
  const mid = (fromX + toX) / 2;
  return (
    `<line x1="${fromX}" y1="${y}" x2="${toX}" y2="${y}" stroke="#8a8278" stroke-width="2" marker-end="url(#arw)"/>` +
    `<text x="${mid}" y="${y - 6}" font-size="11" text-anchor="middle" fill="#6b6459">${label}</text>`
  );
}

export const DARK_TURMOIL: Expansion = {
  id: 'dark-turmoil',
  name: '黑暗动乱',
  // 规则书归册：进「修真」那本合册，不塞进"小型扩展合订本"
  // （它一个兵种表 + 一个暗影领域 + 吞噬/召唤/衰老，塞合订本里会被淹掉）
  scale: 'large',
  /*
   * 规则书「特殊规则」里的补充条目。
   *
   * 为什么需要它：诡异**不听指挥**（自主分 1），它们的走位和选目标是各自的 profile
   * 决定的。玩家在战场上只能看到"它往那边走了"，看不到"它为什么往那边走"——
   * 不给一份书面说明，这套东西就是不可学习的。
   */

  manualNotes: [
    /*
     * 以 `## ` 开关的一条是**小节标题**（规则书会拿它做锚点和导航），
     * 其余是这一节下面的条目。这么写是因为它有一二十条，
     * 一坨列表摊在页面上没法查"不详到底往哪走"。
     */
    '## 总则',
    '这个包里所有诡异都**不听玩家指挥**：走位与选目标是写死的倾向（见下），同族之间还会互相配合。',
    '## 影系',
    '**蚀影**：扑向**落单**的敌人（两格内没有同伴的），平时守在暗影领域的边界上；够不到就跳进影子扑过去。',
    '**暗影**：射程内**补刀血最少**的目标；和同类会自动散开，不挤在一格。',
    '**影主**：打射程内**威胁最大**（攻击力最高）的目标；被贴到 3 格内就后撤；没有敌人时躲进**暗影最深处**，同类之间保持约 2 格。',
    '## 血系',
    '**淤血**：优先咬**经济单位**，没得咬就往血肉和敌人的产线方向凑。',
    '**血肉**：挑**护甲最薄**的打；会主动离血核远一点，也和同类散开。',
    '**血核**：打**威胁最大**的目标；没有敌人时待在暗影最深处，同类之间保持约 2 格。',
    '## 骨系',
    '**骸骨**：一心找**血肉**（吞了能变成尸骸）；没有血肉就朝血最少的敌人爬。',
    '**尸骸**：朝**暗影**走（吞了能变成不详）；周围没有暗影就原地不动。',
    '**不详**：朝**尸骸仙帝**走，但到 4 格就停下不再靠近；看不见仙帝时沉进暗影最深处。',
    '## 尸骸仙帝',
    '**加速衰老**（他和红尘仙都有）：在**沉眠地附近每回合老 1 岁，离开则老 2 岁**；' +
      '年龄超过寿元就会死。所以"他为什么突然倒下了"的答案是——他老了。面板上有年龄和寿元。',
    '**尸骸仙帝**：140 / 200 岁登场，只剩六十来年。缺"食物"时先吞自己人续命' +
      '（吞不得骨灰罐、成帝碑、沉眠地——那是他的来历）。',
    '**出山**：寿元快见底才出山收割；**寿元吃回 60 就回沉眠地**。在外超过 40 个回合、' +
      '而且寿元还在 30 以上，也会提前回去——他不是一直往前推的东西，是会回去歇的。',
    '他倒下之后，**骨灰罐**会把他拉回来：0 岁、寿元减半、生命上限减半，一次比一次薄。',
    '## 仆从',
    '仆从是**追随者**，不是污染物：他们听总体指挥，也有一点自己的判断（会绕开经济单位那种"纪律"）。',
    '所以和诡异正好相反——**仆从会占城，诡异不会**（见「痴愚」）。',
    '**断传承**（所有仆从都有）：把一座城的耐久打到 0（它变成废墟）时，那座城的时代降一级。' +
      '他们不会接手一座城，只会把它用回旧样子。',
    '**留食**（所有仆从都有）：视野内的敌方经济单位不多于 2 个时，他们不肯打经济单位——那是留给仙帝的食物。',
    '### 卫系（机关傀儡）',
    '三只都带「**暗影驱动**」：倒下后留下**傀儡残躯**，残躯三格内有暗影就会吸干它、原地半血复活。' +
      '所以对付卫系要**先清掉身边的暗影，再砸碎残躯**——只打倒本体是不够的。',
    '**青铜卫**：高血高甲、走得慢、视野很广。它是钉子，负责堵路和看着你。',
    '**暗影卫**：血薄甲厚、跑得快、会飞、会暗影跳跃，自带一片暗影领域。它是追人的那个。',
    '**号卫**：射程极远、溅射很大，被打中的敌人会陷入「**虚弱**」——移动与攻击各降 30%。' +
      '它不追你，它只是让你走不动、打不疼。',
    '### 仆系（干活的追随者）',
    '三只都不往人堆里扎：**敌人成群时会往后站**。但只要有人摸到仙帝（或裔系）旁边，' +
      '这条纪律立刻作废——它们会直接扑上来。所以"贴近仙帝"是解掉它们龟缩的办法。',
    '**傀儡师**：每 3 个自己的回合造一具傀儡（青铜卫 → 暗影卫 → 号卫，每种最多 2 具，满了跳过）。' +
      '它自己不算弱，但真正的价值在那些傀儡上——**先杀它，还是先清傀儡**是个选择。',
    '**勾魂使**：会飞、会跳；「**暗影潜行**」让它只在暗影里藏形（出手或贴身才暴露）；' +
      '「**勾魂**」会让 6 格内**任何单位**（不分敌我）在自己回合结束时被拽向暗影深处——' +
      '你站在它附近，自己的兵也会被拖走。',
    '**血医**：「**增生光环**」治疗 3 格内不分敌我的单位（已失去血量的一半，一次最多 12 点），' +
      '但治多少就在那人身上积多少「**影蚀之血**」；积过最大生命的三成，人就化成血肉与暗影。' +
      '挨打会把这份污染冲淡——所以"先打一顿再治"才是救人。',
    '### 裔系（仙帝的直系）',
    '**避城**（三只都有）：看到**时代 ≤ 3 的敌方城市**就撤离 10 个回合——退回沉眠地附近、' +
      '或者沉进暗影最深处。十回合后照旧出来巡视。所以**把城打残**能换来一阵安宁。',
    '**不据城**（三只都有）：不屑于占据人类的废墟。',
    '三只都带暗影跳跃、都投下 1 格暗影。',
    '**眷属**：「**归附**」——在场上待够就变成一名仆从。仆从越多等得越久（2 + 仆从数），' +
      '一个都没有时两回合就变；变成场上**最少**的那一种。',
    '**后裔**：「**传裔**」——每 3 回合生一个眷属（上限 2）。',
    '**子嗣**：「**衍嗣**」——每 2 回合生一个后裔（上限 2）。它会飞，暗蚀极重（全包最高）。',
    '### 不好分类的三件',
    '**骨灰罐**：两万血、两千甲的罐子，不会动也不会打。它只有一个作用——「**超脱**」：' +
      '尸骸仙帝倒下时，在罐边以 0 岁、寿元减半、生命上限减半的状态复活。' +
      '每死一次就更薄一层，生命上限跌到 200 以下就再也回不来了。',
    '**成帝碑**：碑上的字会传染。「**知识污染**」：视野一半以内（`ceil(视野/2)`）的敌人' +
      '立刻变成 1 个不详 + 2 只黑蝗；6 级以上的修士免疫。',
    '6 级以上的修士可以**主动**贴着碑「**阅读碑文**」：境界 +1、获得两回合「仙帝凝视」，' +
      '但三回合后必死，尸体会原地站起一名**红尘仙**。所以这是一条用命换时间的路。',
    '**红尘仙**：八级修士的水准，和仙帝一样会老。它不像仙帝那样能吃同伴，所以出山更频繁；' +
      '平时缩在沉眠地附近，寿元将尽或者仙帝出山时，它也跟着出来收割。',
    '## 不成系的三个',
    '**黑蝗**：往**暗影里钻**、躲开攻击力高的敌人、也**离黑茧远一点**；咬**护甲最厚**的。' +
      '它自己的暗影只有脚下那一格，所以只能靠同类挤成一片才铺得开——聚够两只就会繁殖，四周全是同类时干脆结茧。',
    '**黑茧**：不会动，打**射程内最近**的。两格内出现暗影或血肉，它会化开把自己烧掉，' +
      '把那只催成影主或血核。',
    '**诡异**：看不见、也发现不了，只在出手之后现形；射程内**补刀血最少**的。' +
      '每回合自己回一点血；**血掉到一半以下就会放弃攻击**，一头钻回暗影最深处——越虚躲得越急。',
  ],
  manualDiagram: TURMOIL_DIAGRAM,
  blurb: '一位会老死的仙帝，和它为了续命掀起的浩劫。',
  summary:
    '剧情向扩展：尸骸仙帝（远超九级修士，但**有寿元**）会定期出山清洗天地换取寿元，' +
    '寿元将尽而周围无物可食时，它会吞下自己人。全部兵种只能由关卡生成，不进货架。',
  // 它借的是修真那套"境界 / 寿元"的语义，单独开没有意义
  requires: ['cultivation'],
  units: [
    EMPEROR_DEF,
    SLUMBER_DEF,
    SHADOW_BEAST_DEF,
    SHADE_DEF,
    SHADOW_LORD_DEF,
    BLOOD_POOL_DEF,
    FLESH_DEF,
    BLOOD_CORE_DEF,
    BONE_SKELETON_DEF,
    BONE_CORPSE_DEF,
    BONE_UNNAMED_DEF,
    BLACK_LOCUST_DEF,
    BLACK_COCOON_DEF,
    UNNAMABLE_DEF,
    BRONZE_GUARD_DEF,
    SHADOW_GUARD_DEF,
    HORN_GUARD_DEF,
    WRECK_DEF,
    PUPPET_MASTER_DEF,
    SOUL_HOOKER_DEF,
    BLOOD_MEDIC_DEF,
    KINDRED_DEF,
    DESCENDANT_DEF,
    OFFSPRING_DEF,
    URN_DEF,
    STELE_DEF,
    MORTAL_IMMORTAL_DEF,
  ],
  abilities: [
    EROSION_ABILITY,
    SHADOW_POSSESS,
    SHADOW_SPAWN,
    BLOOD_CLOT,
    BLOOD_SIPHON,
    BLOOD_INFECT,
    BLOOD_GROW,
    BONE_SEEK,
    BONE_REVIVE,
    BONE_AIRBORNE,
    BONE_ASSEMBLE,
    BONE_TRANSMUTE,
    BONE_DISSOLVE,
    LOCUST_BREED,
    LOCUST_COCOON,
    COCOON_ASCEND,
    UNNAMABLE_FORM,
    SHADOW_BREATH,
    BREAK_LINEAGE,
    DULL_WIT,
    LEAVE_FOOD,
    SHADOW_DRIVE,
    WRECK_REVIVE,
    WEAKEN_CRY,
    PUPPET_CRAFT,
    SHADOW_STALK,
    SOUL_HOOK,
    BLOOD_AURA,
    HEIR_WITHDRAW,
    SCORN_CITY,
    KINDRED_CONVERT,
    DESCEND_KINDLE,
    OFFSPRING_BEAR,
    TRANSCEND,
    KNOWLEDGE_POLLUTION,
    DARK_SOURCE,
    LINEAGE_WELL,
    SWIFT_AGING,
    EMPEROR_CYCLE,
  ],
  // 三个兵的"本能"。走 Expansion.unitAi 而不是在包里自己注册：
  // unit-ai.ts 在模块初始化时要读 EXPANSIONS，包再去 import 它就是循环。
  unitAi: [
    SHADOW_BEAST_AI,
    SHADE_AI,
    SHADOW_LORD_AI,
    BLOOD_POOL_AI,
    FLESH_AI,
    BLOOD_CORE_AI,
    BONE_SKELETON_AI,
    BONE_CORPSE_AI,
    BONE_UNNAMED_AI,
    LOCUST_AI,
    COCOON_AI,
    UNNAMABLE_AI,
    SERVANT_AI,
    SERVANT_HANG_BACK,
    HEIR_ORDER,
    MORTAL_IMMORTAL_AI,
    EMPEROR_CYCLE_AI,
  ],
  hooks: {
    onTurnStart: ({ state, player, api }) => {
      // 寿元那一套已经搬进「加速衰老」词条（面板上看得见）；这里只剩读碑到期的清算
      tickDoomed(state, api);
      freezeForming(state, player);
    },
    /*
     * 暗影：站在里面视野和射程减半。
     *
     * **这里绝对不能回头调 `visionOf` / `playerView`**：`playerView` 算迷雾时
     * 正在逐个单位调 `visionOf`，回头一查就是死循环。只能用钩子给的 `base`。
     */
    /*
     * `unit` 可能为空（那次问的是"这一方的整体视野"，没有具体单位），
     * 没有具体位置就没有"站在暗影里"这回事，原样返回。
     *
     * **投下暗影的单位自己不受影响**（`shadowRadius > 0` 就跳过）：
     * 否则影主站在自己那片半径 7 的黑雾正中间，视野 8 → 4、射程 4 → 2，
     * 等于自己把自己废了。语义上也说得通：影子是它们的介质，不是它们的雾。
     */
    modifyVision: ({ state, unit, base }) =>
      unit && state.unitTypes[unit.type]?.shadowRadius === undefined && inShadow(state, unit, base)
        ? Math.max(1, Math.ceil(base / 2))
        : base,
    modifyRange: ({ state, unit, range }) =>
      state.unitTypes[unit.type]?.shadowRadius === undefined && inShadow(state, unit, range)
        ? Math.max(1, Math.ceil(range / 2))
        : range,
    // 开局铺一次，之后每回合末重铺（诡异是这回合才走过去的，下一回合才生效）
    onMatchStart: ({ state }) => refreshShadow(state),
    /**
     * 「超脱」：仙帝倒下时，骨灰罐把他再拉回来一次——一次比一次弱。
     *
     * 写在扩展的 onUnitKilled 里而不是能力上：能力钩子只会在"挂载者"身上跑，
     * 而这里要等的是**另一个单位**（仙帝）的死讯。
     */
    onUnitKilled: ({ state, api, victim }) => {
      if (victim.type !== EMPEROR) return;
      const urn = state.units.find((u) => u.owner === victim.owner && u.type === FUNERARY_URN && u.hp > 0);
      if (!urn) return;
      const revives = Number(urn.custom?.revives ?? 0);
      const baseMax = state.unitTypes[EMPEROR]?.maxHp ?? 1;
      const newMax = Math.floor(baseMax / 2 ** (revives + 1));
      if (newMax < TRANSCEND_FLOOR) return;
      const born = api.spawnNear(state, victim.owner, EMPEROR, urn);
      if (!born) return;
      const life = Math.max(1, Math.floor((lifespanOf(victim) ?? LIFESPAN) / 2));
      born.age = 0;
      born.custom = { ...(born.custom ?? {}), lifespan: life, dtInit: 1 };
      born.maxHpBonus = newMax - baseMax;
      born.hp = newMax;
      urn.custom = { ...(urn.custom ?? {}), revives: revives + 1 };
      state.log.push({
        turn: state.turn,
        player: victim.owner,
        text: '罐子里有什么东西动了一下——他又站起来了，比上一次更薄。',
      });
    },
    onTurnEnd: ({ state, player, api }) => {
      /*
       * 先完成上一回合的凝结，再重铺暗影。
       *
       * 顺序有讲究：这一步跑在**能力**的 onTurnEnd 之前（见 doEndTurn），
       * 所以"这一回合刚标记的 formTo"不会被当场完成——它得等下一回合。
       */
      completeForming(state, player);
      pullSouls(state, player, api);
      refreshShadow(state);
    },
    /**
     * 「阅读碑文」：**只有 6 级以上的修士**才会看到这个按钮。
     *
     * 这不是"看一眼就变强"的免费午餐：境界 +1、拿两回合「仙帝凝视」，
     * 代价是三回合后必死，而且尸体会站起一名红尘仙。所以它是一条"用命换时间"的路。
     */
    unitActions: ({ state, unit }) => {
      if (Number(unit.custom?.rank ?? 0) < STELE_RANK_GATE) return [];
      if (unit.custom?.doomAt) return [];
      const stele = state.units.find(
        (u) => u.type === IMPERIAL_STELE && u.hp > 0 && Math.abs(u.x - unit.x) + Math.abs(u.y - unit.y) <= 1,
      );
      if (!stele) return [];
      return [
        {
          id: 'read-stele',
          label: '阅读碑文',
          group: '碑文',
          detail: '境界 +1、获得「仙帝凝视」；三回合后必死，尸体会站起一名红尘仙。',
        },
      ];
    },
    onUnitAction: ({ state, unit, actionId }) => {
      if (actionId !== 'read-stele') return null;
      const stele = state.units.find(
        (u) => u.type === IMPERIAL_STELE && u.hp > 0 && Math.abs(u.x - unit.x) + Math.abs(u.y - unit.y) <= 1,
      );
      if (!stele) return '碑不在旁边了';
      if (Number(unit.custom?.rank ?? 0) < STELE_RANK_GATE) return '境界不够，读了只会变成那些东西';
      unit.custom = {
        ...(unit.custom ?? {}),
        rank: Number(unit.custom?.rank ?? 0) + 1,
        doomAt: state.turn + STELE_DOOM_TURNS,
        steleOwner: stele.owner,
      };
      unit.status = { ...(unit.status ?? {}), [IMPERIAL_GAZE]: STELE_BUFF_TURNS };
      state.log.push({ turn: state.turn, player: unit.owner, text: '它读完了碑上的最后一行。' });
      return null;
    },
    /**
     * 棋盘上的「暗影」视图。
     *
     * 核心会按迷雾过滤（`onlyVisibleCells`），所以雾里的黑斑画不出来——
     * 玩家只能看见自己视野内那片黑，不会借此反推出雾里站着几个诡异。
     */
    boardViews: () => [
      {
        id: SHADOW_KEY,
        label: '暗影',
        hint: '诡异笼罩的格子。站在里面的单位视野与射程减半。',
        cells: ({ state, board }) => {
          if (board && board !== 'earth') return [];
          const cells = state.overlays?.[SHADOW_KEY] ?? [];
          return cells.map((i) => ({
            x: i % state.w,
            y: Math.floor(i / state.w),
            color: 'rgba(78, 26, 96, 0.38)',
          }));
        },
      },
    ],
    /**
     * 面板：只说模糊的话。
     *
     * 不给数字是刻意的——寿元是这一关的节奏，玩家该靠"它越来越虚弱/越来越急"
     * 感觉出来，而不是盯着一个倒计时算回合数。
     */
    /**
     * 面板：玩家必须能看见"这东西为什么打我这么疼""它为什么会变多"。
     *
     * 仿修真那册写「真元 ×1.5（33 点）」的口径：**数字写出来，别只写能力名**。
     * 暗蚀是这里的"真元"，只写"有暗蚀"玩家根本算不出伤害。
     */
    getUnitPanelLines: ({ state, unit }) => {
      const def = state.unitTypes[unit.type];
      const lines: string[] = [];

      const radius = def?.shadowRadius ?? 0;
      if (radius > 0) lines.push(`暗影领域：半径 ${radius} 格（里面的单位视野与射程减半）`);

      /*
       * 会老的单位：把年龄和寿元印出来。
       *
       * 这一行是"玩家为什么看不懂它在掉血/倒下"的答案——以前这件事只写在后端的
       * 回合钩子里，面板上一个字都没有，看的人以为它是被谁打死的。
       */
      const aging = AGING[unit.type];
      if (aging) {
        const life = lifespanOf(unit) ?? aging.lifespan;
        const age = unit.age ?? aging.startAge;
        lines.push(`寿元：${Math.round(age)} / ${Math.round(life)}（在沉眠地附近每回合 +1，离开则 +2）`);
      }

      /*
       * 能力行：**遍历这个兵挂的词条**，数值问词条自己（`valueLabel`）。
       *
       * 以前这里是按兵种手写的一串 if：加一个能力要改两处（面板 + 规则书），
       * 改漏一处就是血肉/血核的暗蚀"只在面板上有"。现在只有一个来源——
       * 能力挂在谁身上，面板和规则书就都印谁，数值也从同一个函数来。
       */
      for (const id of [...(def?.abilities ?? []), ...(unit.extraAbilities ?? [])]) {
        const a = PACK_ABILITIES.get(id);
        if (!a) continue; // 不是本包的能力，交给别人印
        const value = def ? a.valueLabel?.(def) : null;
        lines.push(value ? `${a.name}：${value}` : a.name);
      }

      // 化血当前攒了多少（只在真的攒过时印，免得每行都挂个 0/80）
      const blood = Number(unit.custom?.blood ?? 0);
      if (blood > 0) lines.push(`已累计的血：${Math.round(blood)} / ${CLOT_DAMAGE}`);

      // 影蚀之血：任何单位都可能被血医治出这个计数，所以不看兵种
      const corrupt = Number(unit.custom?.shadowBlood ?? 0);
      if (corrupt > 0) {
        const max = def?.maxHp ?? 1;
        lines.push(`影蚀之血：${Math.round(corrupt)} / ${Math.round(max * CORRUPT_RATIO)}（满了就死）`);
      }

      if (isEmperor(unit)) {
        lines.push(`寿元：${lifespanWords(yearsLeft(unit))}`);
        lines.push(inSlumber(state, unit) ? '正在沉眠地休整（衰老减半）' : '在外行走（衰老加快）');
      }
      return lines;
    },
  },
};

/* ══════════════════════════════════════════════════════════════════
 * 六、暗影领域（2026-11-18）
 *
 * 诡异投下的黑雾。规则只有两条，但两条都得说清楚：
 *
 *   1. **每回合末重铺一次**，不跟着走。
 *      为什么：诡异一边动一边刷，一次移动就要重铺整片菱形；而 `visionOf` /
 *      `effectiveRange` 是每个兵、每个候选、每一帧都要问的热路径。
 *      代价是"当回合它走了，黑雾还留在原地"——这是**故意的**，玩家因此能
 *      看见"它挪开之后哪里露出来了"，比实时跟着走更好读。
 *
 *   2. **按客观存在算**，不看谁看得见谁。
 *      三方（规则、AI、界面）读的是局面里同一份 `overlays.shadow`，所以不会出现
 *      "高亮显示能打、点下去说射程不够"。界面上那层染色由 `boardViews` 提供，
 *      核心会按迷雾过滤，雾里的黑斑画不出来，也不泄露位置。
 *
 * 判定口径（写死在这里，别改着玩）：
 *   · 范围是**曼哈顿距离**的菱形（和视野、射程同一套度量）；
 *   · 分母只数**地图内**的格子（贴着地图边缘时不把界外算成"没被覆盖"）；
 *   · 严格**超过一半**才触发（正好一半不触发）；
 *   · 视野 / 射程减半后**向上取整**，且不低于 1；
 *   · 多个诡异不叠乘——只判"是/否"一次。
 * ══════════════════════════════════════════════════════════════════ */

export const SHADOW_KEY = 'shadow';

/** 把数组转成集合，按数组对象缓存（同一回合里数组不会变） */
const shadowSetCache = new WeakMap<number[], Set<number>>();

function shadowSetOf(state: GameState): Set<number> | null {
  const cells = state.overlays?.[SHADOW_KEY];
  if (!cells || cells.length === 0) return null;
  let set = shadowSetCache.get(cells);
  if (!set) {
    set = new Set(cells);
    shadowSetCache.set(cells, set);
  }
  return set;
}

/**
 * 这个单位脚下这一圈里，暗影占了多大比例。
 *
 * 返回 `{ covered, total }`，`total` 只数地图内的格子。没开这个包、
 * 场上没有诡异时 `overlays.shadow` 是空的，这里直接返回 null——
 * **没人用的局一次乘法都不做**。
 */
export function shadowCoverage(
  state: GameState,
  u: { x: number; y: number; board?: string },
  radius: number,
): { covered: number; total: number } | null {
  const set = shadowSetOf(state);
  if (!set) return null;
  if (u.board && u.board !== 'earth') return null; // 最小版只处理地球
  let covered = 0;
  let total = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    const span = radius - Math.abs(dy);
    for (let dx = -span; dx <= span; dx += 1) {
      const x = u.x + dx;
      const y = u.y + dy;
      if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
      total += 1;
      if (set.has(y * state.w + x)) covered += 1;
    }
  }
  return { covered, total };
}

/** 站在暗影里吗（覆盖超过一半） */
export function inShadow(state: GameState, u: Unit, radius: number): boolean {
  const cov = shadowCoverage(state, u, radius);
  return !!cov && cov.total > 0 && cov.covered * 2 > cov.total;
}

/** 重铺暗影：场上所有带 `shadowRadius` 的单位，各铺一片菱形 */
export function refreshShadow(state: GameState): void {
  const cells = new Set<number>();
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    /*
     * `undefined` = 不投下暗影；**0 = 只有脚下那一格**（黑蝗）。
     * 这两种必须分开：以前一律 `?? 0` 然后 `<= 0 continue`，
     * 于是"半径 0"和"没有暗影"变成了同一件事。
     */
    const r = state.unitTypes[u.type]?.shadowRadius;
    if (r === undefined) continue;
    if (u.board && u.board !== 'earth') continue;
    for (let dy = -r; dy <= r; dy += 1) {
      const span = r - Math.abs(dy);
      for (let dx = -span; dx <= span; dx += 1) {
        const x = u.x + dx;
        const y = u.y + dy;
        if (x < 0 || y < 0 || x >= state.w || y >= state.h) continue;
        cells.add(y * state.w + x);
      }
    }
  }
  state.overlays = { ...(state.overlays ?? {}), [SHADOW_KEY]: [...cells].sort((a, b) => a - b) };
}
