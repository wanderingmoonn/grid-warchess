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
import { DAMAGE_STAGE } from './ability-hooks.ts';
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

export const SHADOW_BEAST = 'shadow-beast';
export const SHADE = 'shade';
export const SHADOW_LORD = 'shadow-lord';

/** 暗蚀：每次攻击附带的、无视护甲的伤害。占位值 */
const EROSION_BY_TYPE: Record<string, number> = {
  [SHADOW_BEAST]: 8,
  [SHADE]: 4,
  [SHADOW_LORD]: 15,
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
  element: 'dark',
  summonedOnly: true,
  shadowRadius: 3,
  aiAutonomy: 1,
  aiProfile: 'shadow-beast-edge',
  abilities: ['shadow-erosion'],
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
  armor: 18,
  maxHp: 40,
  range: 2,
  vision: 6,
  burst: 3,
  element: 'dark',
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 1,
  aiAutonomy: 1,
  aiProfile: 'shade-spread',
  abilities: ['shadow-erosion'],
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
  armor: 15,
  maxHp: 220,
  range: 4,
  vision: 8,
  burst: 2,
  element: 'dark',
  flight: true,
  layer: 'air',
  summonedOnly: true,
  shadowRadius: 7,
  aiAutonomy: 1,
  aiProfile: 'shadow-lord-kite',
  abilities: ['shadow-erosion'],
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
    if (deep.x === c.unit.x && deep.y === c.unit.y) return {};
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
    } else {
      const walk = steps(c, Math.max(1, c.def.move))
        .filter((p) => p.d > 0)
        .sort((a, b) => dist(a, deep) - dist(b, deep))[0];
      if (walk && dist(walk, deep) < gap) {
        add.push({ action: { type: 'MOVE', unitId: c.unit.id, x: walk.x, y: walk.y }, score: 120 });
      }
    }
    return add.length ? { add } : {};
  },
};

/* ── 影主的召唤计时器 ───────────────────────────────────────────── */

/** 正常情况下几个自己的回合召唤一个暗影 */
const SUMMON_EVERY = 4;

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

/**
 * 影主的召唤计时器。**在它自己的回合开始时走一格**，攻击过则多走一格。
 *
 * 为什么不用"本回合攻击过就当场加速"：回合开始的钩子跑在它出手之前，
 * 那时还不知道这回合会不会打。所以拆成两步——
 *   · 回合末（`markShadowLordAttack`）记下"这回合打没打"；
 *   · 下回合开始（这里）按这个标记走计时器。
 * 说人话：它越凶，暗影来得越勤，但节奏差半拍——玩家有机会在它召唤前打断。
 */
function tickShadowLords(state: GameState, player: PlayerId, api: AbilityApi): void {
  for (const u of state.units) {
    if (u.owner !== player || u.type !== SHADOW_LORD || u.hp <= 0) continue;
    let left = Number(u.custom?.summonIn ?? SUMMON_EVERY);
    left -= Number(u.custom?.hitLastTurn ?? 0) === 1 ? 2 : 1;
    if (left <= 0) {
      const spot = freeNear(state, u, SHADE, api);
      if (spot) {
        api.spawn(state, u.owner, SHADE, spot.x, spot.y);
        left = SUMMON_EVERY;
        state.log.push({
          turn: state.turn,
          player: u.owner,
          text: '影主分裂出一团暗影。',
        });
      } else {
        left = 1; // 没地方站，下回合再试
      }
    }
    u.custom = { ...(u.custom ?? {}), summonIn: left };
  }
}

/** 回合末记下"这回合打没打"（回合开始时要读，那时 acted 已经被重置了） */
function markShadowLordAttack(state: GameState, player: PlayerId): void {
  for (const u of state.units) {
    if (u.owner !== player || u.type !== SHADOW_LORD || u.hp <= 0) continue;
    u.custom = { ...(u.custom ?? {}), hitLastTurn: u.acted ? 1 : 0 };
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
  units: [EMPEROR_DEF, SLUMBER_DEF, SHADOW_BEAST_DEF, SHADE_DEF, SHADOW_LORD_DEF],
  abilities: [EROSION_ABILITY],
  // 三个兵的"本能"。走 Expansion.unitAi 而不是在包里自己注册：
  // unit-ai.ts 在模块初始化时要读 EXPANSIONS，包再去 import 它就是循环。
  unitAi: [SHADOW_BEAST_AI, SHADE_AI, SHADOW_LORD_AI],
  hooks: {
    onTurnStart: ({ state, player, api }) => {
      tickEmperor(state, player, api);
      tickShadowLords(state, player, api);
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
     */
    modifyVision: ({ state, unit, base }) =>
      unit && inShadow(state, unit, base) ? Math.max(1, Math.ceil(base / 2)) : base,
    modifyRange: ({ state, unit, range }) =>
      inShadow(state, unit, range) ? Math.max(1, Math.ceil(range / 2)) : range,
    // 开局铺一次，之后每回合末重铺（诡异是这回合才走过去的，下一回合才生效）
    onMatchStart: ({ state }) => refreshShadow(state),
    onTurnEnd: ({ state, player }) => {
      markShadowLordAttack(state, player);
      refreshShadow(state);
    },
    /**
     * 暗影杀人：在被杀的位置原地长出一个蚀影。
     *
     * 这是影系"越打越多"的来源，也是玩家必须改清场顺序的原因——
     * 先清暗影，不然每杀一个杂兵就多一具会走路的尸体。
     *
     * 只对**非建筑**生效：影子从石头里长出来太出戏了。
     */
    onUnitKilled: ({ state, victim, killer, api }) => {
      if (!killer || killer.type !== SHADE) return;
      if (victim.owner === killer.owner) return;
      if (api.utype(state, victim.type)?.category === 'building') return;
      const spot = api.canStandAt(state, victim.x, victim.y, SHADOW_BEAST)
        ? { x: victim.x, y: victim.y }
        : freeNear(state, victim, SHADOW_BEAST, api);
      if (!spot) return;
      api.spawn(state, killer.owner, SHADOW_BEAST, spot.x, spot.y);
      state.log.push({
        turn: state.turn,
        player: killer.owner,
        text: '被暗影吞噬的尸体爬了起来——蚀影。',
      });
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
