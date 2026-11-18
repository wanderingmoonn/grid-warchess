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
import { DAMAGE_STAGE, STRIKE_STAGE, TURN_START } from './ability-hooks.ts';
import type { AbilityApi } from './ability-hooks.ts';
import type { AbilityDef } from './abilities.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';
import { registerSkillAi, registerSkillEffect } from './skill-hooks.ts';
import type { UnitAiCtx, UnitAiProfile, UnitAiResult, UnitAiCandidate } from './expansions.ts';

export const EMPEROR = 'corpse-emperor';
export const SLUMBER = 'slumber-site';
/** 吞噬的寿元 */
const DEVOUR_LIFESPAN = 10;
/** 出生时的寿元（占位值，调的时候改这里） */
const LIFESPAN = 200;
/** 出生时的年龄：一上来就快死了，否则"黑暗动乱"没有紧迫感 */
const START_AGE = 178;
/** 在沉眠地几格内算"在休整" */
const SLUMBER_RADIUS = 2;
/** 剩余寿元低于这个数才考虑吃同伴 */
const STARVE_LEFT = 8;
/** 周围（这个格数内）敌人少于这个数，就算"不够吃" */
const STARVE_FOES = 2;

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
 * 数值是"九级修士之上"的量级：九级修士的境界加成大约是攻 +257、甲 +119、
 * 真伤 66、每回合 5 段攻击。这里不去复刻那套公式（它不是修士兵种，
 * 复刻了也会随修真包改数值漂移），直接给一组更高的固定值。
 *
 * 造价写这么高不是让它能造（`summonedOnly` 挡死产线），是给 AI 估值用的：
 * AI 会据此认为"这东西极贵、不能随便送"。
 */
const EMPEROR_DEF: UnitTypeDef = {
  id: EMPEROR,
  name: '尸骸仙帝',
  short: '帝',
  era: 6,
  category: 'combat',
  cost: 2400,
  move: 3,
  atk: 300,
  armor: 130,
  maxHp: 1600,
  range: 5,
  vision: 9,
  magicAtk: 120,
  magicRes: 25,
  summonedOnly: true,
  skills: [
    {
      id: 'devour',
      name: '吞噬',
      summary:
        '吞下一个**自己人**，用它的生机换自己的寿元。不耗灵力、没有冷却，' +
        '因为这是它续命的本能，不是战术选择。',
      effect: 'soul-devour',
      // 选点式：玩家（或者 AI）点一个同伴所在的格子
      targeting: 'point',
      radius: 2,
      power: 1,
      // 一回合可以吃好几个：它饿起来是没有节制的（每个仍算一个动作）
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
  magicRes: 20,
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
    .filter((a) => a.id !== c.unit.id && a.hp > 0 && dist(a, c.unit) <= reach)
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

/**
 * 每回合（它的回合）：
 *   1. 第一次见到它时，把寿元和年龄落库；
 *   2. 不在沉眠地 → 年龄再 +1（核心已经 +1，所以一共 +2）；
 *   3. 年龄超过寿元 → 老死。
 *
 * 为什么老死用 `api.killUnit` 而不是把 hp 设 0：走完整死亡流程，
 * 战报会留下"寿元耗尽"这句话，而且席位出局/胜负判定都按正常死亡算。
 */
function tickEmperor(state: GameState, player: PlayerId, api: AbilityApi): void {
  for (const u of state.units) {
    if (u.owner !== player || !isEmperor(u) || u.hp <= 0) continue;

    // 1）落库：顺手把"一上来就快死了"这件事写进年龄
    if (u.custom?.dtInit !== 1) {
      u.custom = { ...(u.custom ?? {}), lifespan: lifespanOf(u) ?? LIFESPAN, dtInit: 1 };
      if ((u.age ?? 0) <= 1) u.age = START_AGE;
    }

    // 2）不在沉眠地：比平时老得快一倍
    if (!inSlumber(state, u)) u.age = (u.age ?? 0) + 1;

    // 3）寿元耗尽
    if ((u.age ?? 0) > (lifespanOf(u) ?? LIFESPAN)) {
      api.killUnit(state, u, undefined, '尸骸仙帝寿元耗尽，化作一地白骨');
    }
  }
}

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
  valueLabel: () => `每 ${SUMMON_EVERY} 回合两团`,
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
  abilities: ['shadow-erosion', 'shadow-possess'],
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
  abilities: ['shadow-erosion', 'shadow-possess'],
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
  abilities: ['shadow-erosion', 'shadow-spawn', 'shadow-possess'],
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
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
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
  valueLabel: () => `每 ${CLOT_DAMAGE} 点伤害长一滩`,
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
  valueLabel: () => `满血 ${GROW_TURNS} 回合长一团血肉`,
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
  abilities: ['blood-clot', 'blood-infect'],
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
  abilities: ['blood-clot', 'blood-infect', 'blood-siphon', 'shadow-erosion'],
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
  abilities: ['blood-clot', 'blood-infect', 'blood-siphon', 'blood-grow', 'shadow-erosion'],
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
  doneText: string;
}): AbilityDef {
  return {
    id: o.id,
    name: o.name,
    summary: o.summary,
    group: 'support',
    hooks: {
        /*
         * 凝结期间**锁住移动**：回合开始就把 `moved` 置真。
         *
         * 为什么用这个办法：引擎没有"禁止移动"的开关，`canMove` 只看 `moved`。
         * 而 `grantTurnTo`（重置 moved）跑在 `turnStartSkills` **之前**，
         * 所以这里写下的 true 会保留整整一回合——AI 也提不出走位候选。
         * 攻击不受影响：它只是"原地不动"，不是"不能动"。
         */
        onTurnStart: [
          {
            stage: TURN_START.self,
            apply: (c) => {
              if (typeof c.self.custom?.formTo === 'string') c.self.moved = true;
            },
          },
        ],
      onTurnEnd: [
        {
          stage: 0,
          apply: (c) => {
            const pending = c.self.custom?.formTo;
            if (typeof pending === 'string') {
              // 这一回合被锁住了移动，直接完成变形
              transform(c.self, pending, c.state);
              c.self.custom = { ...(c.self.custom ?? {}), formTo: undefined };
              c.state.log.push({ turn: c.state.turn, player: c.self.owner, text: o.doneText });
              return;
            }
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
  doneText: '骸骨撑开骨架，拼成了一具尸骸。',
});

/** 「复苏」：尸骸吞暗影 → 凝结一回合 → 不详 */
const BONE_REVIVE = devourFormAbility({
  id: 'bone-revive',
  name: '复苏',
  summary: '回合结束若相邻有暗影，吞掉它；下一个回合原地不动，就会变成不详。',
  eat: SHADE,
  become: BONE_UNNAMED,
  eatText: () => `暗影被尸骸吞下`,
  doneText: '尸骸重新拼合，站了起来——"不详"。',
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
  abilities: ['blood-clot', 'shadow-possess', 'shadow-spawn', 'bone-seek-body'],
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
  abilities: ['blood-clot', 'blood-infect', 'blood-siphon', 'shadow-possess', 'bone-airborne', 'bone-assemble', 'bone-revive'],
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
  abilities: ['shadow-spawn', 'blood-infect', 'blood-siphon', 'bone-airborne', 'bone-transmute', 'bone-dissolve'],
  skills: [SHADOW_STEP_SKILL],
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
]) {
  PACK_ABILITIES.set(a.id, a);
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
    '**尸骸仙帝**：寿元将尽才会出山；缺"食物"时先吞自己人续命。',
  ],
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
  ],
  hooks: {
    onTurnStart: ({ state, player, api }) => {
      tickEmperor(state, player, api);
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
      unit && (state.unitTypes[unit.type]?.shadowRadius ?? 0) <= 0 && inShadow(state, unit, base)
        ? Math.max(1, Math.ceil(base / 2))
        : base,
    modifyRange: ({ state, unit, range }) =>
      (state.unitTypes[unit.type]?.shadowRadius ?? 0) <= 0 && inShadow(state, unit, range)
        ? Math.max(1, Math.ceil(range / 2))
        : range,
    // 开局铺一次，之后每回合末重铺（诡异是这回合才走过去的，下一回合才生效）
    onMatchStart: ({ state }) => refreshShadow(state),
    onTurnEnd: ({ state }) => {
      refreshShadow(state);
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
    const r = state.unitTypes[u.type]?.shadowRadius ?? 0;
    if (r <= 0) continue;
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
