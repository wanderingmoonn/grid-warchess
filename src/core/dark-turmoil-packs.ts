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
import type { AbilityApi } from './ability-hooks.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from './types.ts';
import { registerSkillAi, registerSkillEffect } from './skill-hooks.ts';

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
  element: 'dark',
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
  element: 'dark',
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
 * 五、扩展本体
 * ══════════════════════════════════════════════════════════════════ */

export const DARK_TURMOIL: Expansion = {
  id: 'dark-turmoil',
  name: '黑暗动乱',
  blurb: '一位会老死的仙帝，和它为了续命掀起的浩劫。',
  summary:
    '剧情向扩展：尸骸仙帝（远超九级修士，但**有寿元**）会定期出山清洗天地换取寿元，' +
    '寿元将尽而周围无物可食时，它会吞下自己人。全部兵种只能由关卡生成，不进货架。',
  // 它借的是修真那套"境界 / 寿元"的语义，单独开没有意义
  requires: ['cultivation'],
  units: [EMPEROR_DEF, SLUMBER_DEF],
  hooks: {
    onTurnStart: ({ state, player, api }) => {
      tickEmperor(state, player, api);
    },
    /**
     * 面板：只说模糊的话。
     *
     * 不给数字是刻意的——寿元是这一关的节奏，玩家该靠"它越来越虚弱/越来越急"
     * 感觉出来，而不是盯着一个倒计时算回合数。
     */
    getUnitPanelLines: ({ state, unit }) => {
      if (!isEmperor(unit)) return [];
      const left = yearsLeft(unit);
      return [
        `寿元：${lifespanWords(left)}`,
        inSlumber(state, unit) ? '正在沉眠地休整（衰老减半）' : '在外行走（衰老加快）',
      ];
    },
  },
};
