/**
 * 法术骨架：所有法术共用的"选目标 → 校验 → 扣灵力 → 结算"那一层。
 *
 * ── 它解决的是什么问题 ─────────────────────────────────────────────
 *
 * 在它之前，每写一门法术都要把这几段抄一遍：目标在不在、那一格有没有单位、
 * 是不是自己人、够不够得着、灵力够不够、射程圈怎么高亮、命中后怎么写战报。
 * 掌心雷 145 行里真正属于"掌心雷"的只有十来行，其余全是这套东西。
 * 100 门法术照抄一遍，就是同一段逻辑散在 100 个文件里，改一条要改 100 处。
 *
 * ── 它不是什么（别把它做成被禁止的那种"集中注册表"）────────────────
 *
 * 这里**没有一条法术的内容**：没有数值、没有文案、没有 `registerSkillEffect`。
 * 它只有机制。族（bolt / blast / field……）各自在自己的文件里注册实现，
 * 用这里提供的零件拼；数据行（`SpellRow`）只存数。这条分界是为了不回到
 * "一个 effects.ts 装所有技能"的老结构——那个结构的病根是**内容堆在一起**，
 * 不是"有公共代码"。
 *
 * ── 怎么加一门新法术（P0 之后的写法）────────────────────────────────
 *
 *   const ROW: SpellRow = {
 *     id: 'palm-thunder', name: '掌心雷', summary: '...',
 *     effect: 'bolt',            // 走哪个族的实现
 *     cost: 50, range: 3,
 *     preview: 'ring',           // 亮"我够得着哪一圈"
 *   };
 *   export const SKILL = defineSpellSkill(ROW);
 *   registerManaReady([ROW]);    // 灵力就绪检查，不用自己写
 *   registerPreview([ROW]);      // 瞄准高亮，不用自己写
 *
 * 剩下要自己写的只有"打中了发生什么"（`resolveCast` + `strike`），
 * 而那部分正是这个族和别的族不一样的地方。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`（理由见 skills/sky-step.ts 顶部）。
 */
import type { GameState, SkillDef, Unit } from '../types.ts';
import type { SkillCtx } from '../skill-hooks.ts';
import { registerSkillPreview, registerSkillReadyCheck } from '../skill-hooks.ts';
import { coversTile, distBetweenUnits, distToUnit } from '../query.ts';
import { canSpendMana, manaOf, spendMana } from './mana.ts';

// ── 数据行 ────────────────────────────────────────────────────────

/** 瞄准高亮的两种画法 */
export type PreviewShape =
  /** 以自己为中心画一圈：回答"我够得着哪"（单体法术用） */
  | 'ring'
  /** 以落点为中心画一片：回答"这一下会罩住谁"（范围法术用） */
  | 'blast';

/**
 * 一条法术的数据行。
 *
 * 这里只放"数"和"选哪个实现"，不放"发生什么"。加一门法术 = 加一行，
 * 前提是它属于已有的族；不属于就得先写那个族（那是另一件事）。
 */
export interface SpellRow {
  /** 技能 id，也是存档里认的那个名字，定了就别改 */
  id: string;
  name: string;
  /** 一句话说明，直接印在按钮上——玩家点之前要能看懂会发生什么 */
  summary: string;
  /** 族的 id（`SKILL_EFFECTS` 的 key）。同一族的多条法术共用它 */
  effect: string;
  /** 施放一次要多少灵力 */
  cost: number;
  /** 射程（格）。`SkillDef.radius` 也取这个值（面板靠它画瞄准圈） */
  range: number;
  preview: PreviewShape;
  /** 爆发半径（`preview: 'blast'` 用） */
  radius?: number;
  /** 一回合能否放多次（不写 = 能，节拍交给灵力池） */
  multiCast?: boolean;
  cooldown?: number;
  /** 目标类型（不写 = 选点） */
  targeting?: 'none' | 'point' | 'direction';
  /** 族的私有参数。引擎不读，族的实现自己读 */
  custom?: Record<string, unknown>;
}

/**
 * 把数据行变成 `SkillDef`。
 *
 * 字段顺序刻意和原来手写的一致：这样改造前后的 `SkillDef` 深比较是相等的，
 * 存档里的技能快照不会因为"换了个写法"就变得不一样。
 */
export function defineSpellSkill(row: SpellRow): SkillDef {
  const def: SkillDef = {
    id: row.id,
    name: row.name,
    summary: row.summary,
    effect: row.effect,
    cooldown: row.cooldown ?? 0,
    multiCast: row.multiCast ?? true,
    targeting: row.targeting ?? 'point',
    radius: row.range,
  };
  /*
   * 把"数"镜像进 `custom`，族的实现才能读到它们。
   *
   * 为什么不另开一张 `PARAMS[id]` 表：那样一门法术的数值会散在两个地方
   * （行进数据表、参进参数表），改一个忘一个，而这正是这批法术要消灭的病。
   * 族的实现统一从 `c.skill.custom` 取，`spellCost` / `spellRange`
   * （有爆发半径时还有 `spellRadius`）是骨架保证一定有的键，其余由族自己约定。
   */
  def.custom = { ...row.custom, spellCost: row.cost, spellRange: row.range };
  if (row.radius !== undefined) def.custom.spellRadius = row.radius;
  return def;
}

/** 族的实现读参数用的窄接口：`c.skill` 在核心那边是 any，这里收一刀 */
export function spellCustom<T extends Record<string, unknown>>(c: SkillCtx): T {
  return ((c.skill as SkillDef | undefined)?.custom ?? {}) as T;
}

// ── 就绪检查（批量）──────────────────────────────────────────────

/**
 * 灵力够不够。返回字符串 = 不够，字符串是给玩家看的理由。
 *
 * 面板（按钮灰不灰）和规则层（放不放行）共用这一份：两处各写一遍，
 * 迟早出现"按钮亮着，点下去被拒"。
 */
export function manaReadyCheck(cost: number) {
  return (_s: GameState, u: Unit): boolean | string => {
    if (!canSpendMana(u, cost)) return `灵力不足（${manaOf(u)} / ${cost}）`;
    return true;
  };
}

/**
 * 给一批法术统一挂上灵力检查。
 *
 * 为什么要批量：就绪检查是按 **skill.id** 注册的（`SKILL_READY_CHECKS[k.id]`），
 * 不是按族。100 门法术如果手写 100 段一模一样的闭包，改一次文案要改 100 处，
 * 而且漏一个都不报错——只有那一门法术的按钮永远是亮的。
 */
export function registerManaReady(rows: readonly SpellRow[]): void {
  for (const row of rows) registerSkillReadyCheck(row.id, manaReadyCheck(row.cost));
}

// ── 瞄准高亮（批量）──────────────────────────────────────────────

/**
 * 一批法术的高亮：按行里的 `preview` 自动挑画法。
 *
 * 这一层以前是每门法术 20 来行手写的双重循环，内容完全一样。
 */
export function registerPreview(rows: readonly SpellRow[]): void {
  for (const row of rows) {
    if (row.preview === 'ring') {
      // 以自己为中心的圈永远"够得着"，不需要再判射程
      registerSkillPreview(row.id, (c) => ringCells(c.view, c.self, row.range));
    } else {
      const radius = row.radius ?? 0;
      registerSkillPreview(row.id, (c) => {
        // 够不着的落点不要亮：亮出一片打不到的范围，比什么都不亮更误导
        if (manhattan(c.self, c.target) > row.range) return [];
        return blastCells(c.view, c.target, radius);
      });
    }
  }
}

/** 以 `at` 为中心的一圈（菱形，不含中心），越界的格子直接丢掉 */
export function ringCells(view: GameState, at: { x: number; y: number }, range: number): number[] {
  const cells: number[] = [];
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > range) continue;
      if (dx === 0 && dy === 0) continue;
      const x = at.x + dx;
      const y = at.y + dy;
      if (x < 0 || y < 0 || x >= view.w || y >= view.h) continue;
      cells.push(y * view.w + x);
    }
  }
  return cells;
}

/**
 * 以 `at` 为中心的一片爆发范围（坐标形式），越界的格子直接丢掉。
 *
 * **只按曼哈顿距离取格子**：能打到的才画。这个游戏里没有斜线距离，
 * 画方框会把四个斜角点亮却打不到——玩家照它数人头会多算两个人。
 */
export function blastCoords(
  view: GameState,
  at: { x: number; y: number },
  radius: number,
): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > radius) continue;
      const x = at.x + dx;
      const y = at.y + dy;
      if (x < 0 || y < 0 || x >= view.w || y >= view.h) continue;
      cells.push({ x, y });
    }
  }
  return cells;
}

/** 同上，但返回格子索引（瞄准高亮要这个格式） */
export function blastCells(
  view: GameState,
  at: { x: number; y: number },
  radius: number,
): number[] {
  return blastCoords(view, at, radius).map((p) => p.y * view.w + p.x);
}

/**
 * 一条射线：从 `from` 朝点击方向伸出 `reach` 格。
 *
 * **四方向吸附**，斜着点也归到最近的正方向（|dx| > |dy| 走横，反之走竖）。
 * 这是这个游戏里"直线"的唯一口径——移动本身不走斜线，所以斜着的射线不存在。
 * 剑气纵横原本自己写了一份，2026-11-14 搬到这里：直线攻击只该有一种画法，
 * 两处各写一份迟早出现"剑气打得到、枪打不到"。
 *
 * 注意它**不看点击距离**：点了 2 格远也是整条 reach 长的射线。
 * 想打多远由 `reach` 决定，不由鼠标位置决定。
 */
export function rayCells(
  view: GameState,
  from: { x: number; y: number },
  target: { x: number; y: number },
  reach: number,
): Array<{ x: number; y: number }> {
  const distX = target.x - from.x;
  const distY = target.y - from.y;
  let dx = Math.sign(distX);
  let dy = Math.sign(distY);
  if (Math.abs(distX) > Math.abs(distY)) dy = 0;
  else if (Math.abs(distY) > Math.abs(distX)) dx = 0;
  if (dx === 0 && dy === 0) dx = 1;

  const cells: Array<{ x: number; y: number }> = [];
  for (let i = 1; i <= reach; i++) {
    const x = from.x + dx * i;
    const y = from.y + dy * i;
    if (x >= 0 && y >= 0 && x < view.w && y < view.h) cells.push({ x, y });
  }
  return cells;
}

// ── 选目标 + 校验 + 扣灵力 ────────────────────────────────────────

/** 一句给玩家看的理由。写成函数是因为有些理由要带兵种名、要带射程数 */
export type Msg = (c: SkillCtx) => string;

export interface CastSpec {
  /** 灵力 */
  cost: number;
  /** 射程 */
  range: number;
  /**
   * `single` = 只打落点上那一个单位（掌心雷）；
   * `area` = 圈落点周围一片敌人（罡风）。
   */
  mode: 'single' | 'area';
  /**
   * 距离按谁算：
   *   · `victim`（单体默认）= 到**目标单位**的距离。2×2 的大家伙站在 3 格外，
   *     锚点可能在 4 格，但它的边其实已经够得着了；
   *   · `point`（范围默认）= 到**落点**的距离。
   *
   * 这两种口径在实战里会给出不同答案，所以不能替作者猜，必须显式写。
   */
  rangeFrom?: 'victim' | 'point';
  /** 爆发半径（`area` 用） */
  radius?: number;
  /** 没点到目标格 */
  noTargetReason: Msg;
  /** `single`：那一格上没有单位 */
  noUnitReason?: Msg;
  /** `single`：那一格上是自己人 */
  allyReason?: (c: SkillCtx, victim: Unit) => string;
  /** `area`：圈里一个敌人都没有 */
  emptyReason?: Msg;
  /** 超出射程 */
  tooFarReason: Msg;
}

export type CastResult =
  | { ok: true; victims: Unit[]; point: { x: number; y: number } }
  | { ok: false; reason: string };

/**
 * 校验并扣灵力。**这一发真的放得出去**才返回 ok，才会扣灵力。
 *
 * 顺序是刻意的，且必须和玩家的直觉一致：
 *   点目标 → 格子上有没有人 → 是不是自己人 → 够不够得着 → 灵力够不够。
 *
 * "灵力不足"放最后，是因为它最不根本：一个站错位置的玩家应该先被告知
 * "太远了"，而不是"你灵力不够"——后者会让他以为攒灵力就能解决。
 *
 * 空放不扣灵力：`area` 里一个敌人都没有时提前返回，和罡风原来的行为一致
 * （花 80 点放一发打空气，是最让人想摔鼠标的事）。
 */
export function resolveCast(c: SkillCtx, spec: CastSpec): CastResult {
  const { state: s, view, self, target } = c;
  if (!target) return { ok: false, reason: spec.noTargetReason(c) };

  const from = spec.rangeFrom ?? (spec.mode === 'single' ? 'victim' : 'point');

  if (spec.mode === 'single') {
    // 按落点算距离时，先拦掉"点太远"，省得后面白找目标
    if (from === 'point' && manhattan(self, target) > spec.range) {
      return { ok: false, reason: spec.tooFarReason(c) };
    }
    // 用 coversTile 而不是"锚点坐标相等"：2×2 的单位占四格，
    // 点在它的右下角也该算命中（query.ts 里那是同一份几何）。
    const victim = view.units.find((u) => u.hp > 0 && coversTile(view, u, target.x, target.y));
    if (!victim) {
      return { ok: false, reason: (spec.noUnitReason ?? spec.noTargetReason)(c) };
    }
    if (victim.owner === self.owner) {
      return {
        ok: false,
        reason: spec.allyReason ? spec.allyReason(c, victim) : '不能对自己人放法术',
      };
    }
    if (from === 'victim' && distBetweenUnits(view, self, victim) > spec.range) {
      return { ok: false, reason: spec.tooFarReason(c) };
    }
    if (!spendMana(self, spec.cost)) {
      return { ok: false, reason: `灵力不足（需要 ${spec.cost} 点）` };
    }
    return { ok: true, victims: [victim], point: { x: victim.x, y: victim.y } };
  }

  // area
  if (manhattan(self, target) > spec.range) {
    return { ok: false, reason: spec.tooFarReason(c) };
  }
  const radius = spec.radius ?? 0;
  // 圈人的口径是 `distToUnit`（点到矩形的最短距离），不是"锚点坐标相等"——
  // 2×2 的建筑只要有一角在圈里就算被扫到，这和玩家看到的范围一致。
  const victims = s.units.filter(
    (u) => u.hp > 0 && u.owner !== self.owner && distToUnit(s, target, u) <= radius,
  );
  if (victims.length === 0) {
    return { ok: false, reason: (spec.emptyReason ?? spec.noTargetReason)(c) };
  }
  if (!spendMana(self, spec.cost)) {
    return { ok: false, reason: `灵力不足（需要 ${spec.cost} 点）` };
  }
  return { ok: true, victims, point: { x: target.x, y: target.y } };
}

/** 曼哈顿距离。法术的射程一直是这个口径（修士 1×1，斜着走两格算两格） */
function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// ── 结算 ──────────────────────────────────────────────────────────

export interface StrikeText {
  /** 扣血那条战报 */
  hurt: (victim: Unit) => string;
  /** 打死那条战报（世界消息） */
  kill: (victim: Unit) => string;
}

/**
 * 打一下：走唯一扣血出口，打死了再走 `api.killUnit`。
 *
 * 为什么不自己 `victim.hp -= dmg`：那样会绕开守御阵的伤害转移、
 * 受伤钩子、转移致死时的清场，表现是"普攻打得到阵、法术打不到"，
 * 而且不报错、很难发现（`test-rules.ts` 里有守卫会当场抓）。
 *
 * `physical` 决定走哪个出口，口径和 `AbilityApi` 那两条一致：
 *   · 法术（"无视护甲"是卖点）→ 默认 `hurt`；
 *   · 兵刃/拳脚那种"数值是攻击力"的 → `physical: true` 走 `hurtPhysical`，
 *     先减甲再扣血（五雷正法这类"高普攻"的法术属于这一档）。
 */
export function strike(
  c: SkillCtx,
  victim: Unit,
  dmg: number,
  text: StrikeText,
  opts?: { physical?: boolean },
): { dealt: number; killed: boolean } {
  const s = c.state;
  const before = victim.hp;
  const logText = text.hurt(victim);
  if (opts?.physical) {
    c.api.hurtPhysical(s, victim, dmg, { source: c.self, logText });
  } else {
    c.api.hurt(s, victim, dmg, { source: c.self, logText });
  }
  const dealt = Math.max(0, before - victim.hp);
  if (victim.hp <= 0) {
    c.api.killUnit(s, victim, c.self, text.kill(victim));
    return { dealt, killed: true };
  }
  return { dealt, killed: false };
}

/** 挨个打一遍，返回总伤害和击杀数（面板与战报要用） */
export function strikeAll(
  c: SkillCtx,
  victims: readonly Unit[],
  dmg: number,
  text: StrikeText,
  opts?: { physical?: boolean },
): { total: number; killed: number } {
  let total = 0;
  let killed = 0;
  for (const victim of victims) {
    const r = strike(c, victim, dmg, text, opts);
    total += r.dealt;
    if (r.killed) killed += 1;
  }
  return { total, killed };
}
