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
 * 三条规矩：
 *   · 落点必须在暗影领域里——这是它唯一的交通方式，也是这个系列的性格；
 *   · 落点站得下（不能叠在别人身上）；
 *   · 用掉之后 `moved = true`：它是"这一回合的移动"，不能跳完再走。
 */
registerSkillEffect('shadow-step', (c) => {
  const t = c.target;
  if (!t) {
    c.result.ok = false;
    c.result.reason = '要先选一个暗影格子';
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
  c.self.moved = true;
  c.result.log = `暗影跳跃：${from} → ${t.x},${t.y}`;
});

const SHADOW_STEP_SKILL = {
  id: 'shadow-step',
  name: '暗影跳跃',
  summary: '瞬间移动到任意一个暗影格子。这一回合就不能再走了。',
  effect: 'shadow-step',
  targeting: 'point' as const,
  radius: 40,
  multiCast: false,
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

/**
 * 蚀影：喜欢待在暗影的边缘。
 *
 * 为什么是边缘而不是深处：它是从黑影里伸出来的东西——站在边界上，
 * 下一步就能扑到亮处的人身上；站深处则看不见外面。玩家因此能从"黑雾边上"
 * 读出它的进攻方向。
 *
 * 已经站在边界上就不动，让全局 AI 去决定打谁（它的本职是近战）。
 */
const SHADOW_BEAST_AI: UnitAiProfile = {
  id: 'shadow-beast-edge',
  handler: (c: UnitAiCtx): UnitAiResult => {
    if (onShadowEdge(c, c.unit.x, c.unit.y)) return {};
    const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (const p of tiles) {
      if (!onShadowEdge(c, p.x, p.y)) continue;
      const near = Math.min(...c.foes.map((f) => dist(p, f)), Infinity);
      // 边界格里挑离敌人最近的（下一步就能扑上去）
      const score = -near;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best) return {};
    const add: UnitAiCandidate[] = [
      { action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 120 },
    ];
    return { add };
  },
};

/**
 * 暗影：同类之间会自动散开。
 *
 * 为什么：一团影子挤在一起没有意义——它们的暗影半径只有 1，叠着等于浪费；
 * 散开才铺得满场。这也是玩家能看出"它们不是人"的第一眼。
 *
 * 只有"另一个暗影太近"时才提意见，别的时候交给全局 AI（它自己会去打人）。
 */
const SHADE_AI: UnitAiProfile = {
  id: 'shade-spread',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const kin = c.allies.filter((a) => a.type === SHADE && a.id !== c.unit.id && a.hp > 0);
    if (kin.length === 0) return {};
    const nearestKin = Math.min(...kin.map((k) => dist(k, c.unit)));
    if (nearestKin > 3) return {}; // 已经散开了
    const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (const p of tiles) {
      // 离同类越远越好；同时别离敌人太远（它还得打人）
      const away = Math.min(...kin.map((k) => dist(k, p)), Infinity);
      const near = Math.min(...c.foes.map((f) => dist(f, p)), Infinity);
      const score = away * 2 - near * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best) return {};
    return { add: [{ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 120 }] };
  },
};

/**
 * 影主：不贴身。
 *
 * 它射程 4、走 2、血厚但慢——被贴住就只剩肉盾价值。所以有敌人进了 3 格
 * 就往后退，其余时间交给全局 AI（它会自己找目标开火）。
 * 真正让它有威胁的是召唤（见 `tickShadowLords`），不是它的走位。
 */
const SHADOW_LORD_AI: UnitAiProfile = {
  id: 'shadow-lord-kite',
  handler: (c: UnitAiCtx): UnitAiResult => {
    const nearest = Math.min(...c.foes.map((f) => dist(f, c.unit)), Infinity);
    if (!(nearest <= 3)) return {};
    const tiles = steps(c, Math.max(1, c.def.move)).filter((p) => p.d > 0);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (const p of tiles) {
      const near = Math.min(...c.foes.map((f) => dist(f, p)), Infinity);
      if (near <= nearest) continue; // 只往更安全的地方退
      if (near > bestScore) {
        bestScore = near;
        best = p;
      }
    }
    if (!best) return {};
    return { add: [{ action: { type: 'MOVE', unitId: c.unit.id, x: best.x, y: best.y }, score: 150 }] };
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
