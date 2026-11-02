/**
 * 格子上留下的东西（Mark）：地雷、水雷、火场、遗迹……
 *
 * ── 为什么要单开一层 ─────────────────────────────────────────────────
 *
 * 在此之前，棋盘上只有三种东西：地形（`Tile`）、单位（`Unit`）、城市（`City`）。
 * "这一格被布了雷"这件事只能硬凑：要么做成一个站着不动的隐形单位（会占位、
 * 会挡路、会被攻击、会被 AI 当成敌人），要么做成盯着一条船的光环
 * （船一走就没了，等于没有雷）。
 *
 * 这一层补的就是"原来靠单位假装"的那一类东西：**不占地、不行动、没有回合**，
 * 只是"这一格上有一件东西"，有人走进来就按种类结算。
 *
 * ── 和 Tile 分开的理由 ───────────────────────────────────────────────
 *
 *   · `Tile` 每格都有、整局基本不变，是**地图**；Mark 可以有可以没有、会消失，
 *     是**战场上被放上去的**；
 *   · 可见性不同：地形是公开信息，Mark 默认对敌人隐藏（地雷踩上才知道）；
 *   · 存档体积：往 43×43 的 tiles 数组上挂一个空字段，等于给每格加一份开销。
 *
 * ── 怎么加一种新的 ──────────────────────────────────────────────────
 *
 * 写一个 `MarkKindDef`（onEnter / onTurnStart 两个钩子挑着用），挂到某个扩展的
 * `marks` 数组里，由 mark-registry 合并进全局表。规则层一行都不用改。
 *
 * ── 引擎负责什么、kind 负责什么 ──────────────────────────────────────
 *
 * 引擎：什么时候触发（走上来 / 回合开始）、能不能触发（敌我、地形）、
 *       扣次数、删掉用尽的、可见性过滤。
 * kind：触发之后发生什么（伤害多少、写什么战报、要不要顺带减速）。
 *
 * 这条分界是刻意的：`charges` 的增减、`marks[]` 的增删如果交给每个 kind 自己
 * 做，迟早出现"某一种雷用完不消失"这种只在一个种类上复现的 bug。
 */

import type { GameState, Mark, PlayerId, Terrain, Unit, UnitTypeDef } from './types.ts';

/** kind 实现能用的那几件东西（规则层的函数不能直接 import，会绕成环） */
export interface MarkApi {
  /** 兵种定义（写战报要名字） */
  utype(typeId: string): UnitTypeDef;
  /** 写一条战报。`open` = 双方都看得见，默认 true（雷炸了不该只有布的人知道） */
  log(owner: PlayerId, text: string, open?: boolean): void;
  /** 直接扣血（不走进攻公式）。扣到 0 以下不用管，清场由引擎统一做 */
  hurt(unit: Unit, amount: number, text: string): void;
}

export interface MarkCtx {
  state: GameState;
  mark: Mark;
  /** 触发它的单位（onEnter 时才有） */
  unit?: Unit;
  /** 现在轮到谁（onTurnStart 时才有） */
  player?: PlayerId;
  api: MarkApi;
}

export interface MarkKindDef {
  id: string;
  name: string;
  summary: string;
  /**
   * 对敌人隐藏。不填 = **隐藏**（这是最安全的默认：忘了写不会把雷的位置
   * 直接白送给对面）。
   */
  hidden?: boolean;
  /**
   * 只在这些地形上成立。不填 = 到处都行。
   *
   * 布雷舰的水雷只认水面，写 ['water','deep','shallow','bridge']；
   * 以后做地雷写陆地那几种。地形对不上就**不触发、也不消耗**。
   */
  on?: Terrain[];
  /**
   * 谁踩得动：`'any'`（默认，连自己人都踩）还是 `'enemy'`（只认敌人）。
   *
   * 地雷/水雷一般是 `'enemy'`——自己的雷区自己人 traversing 是天经地义的。
   */
  trigger?: 'any' | 'enemy';
  /**
   * 敌方单位离多近就算"发现了"它。不填 = 1（贴脸才发现）；0 = 必须踩上去。
   *
   * 这是雷唯一的破法：先派快船/侦察去趟一遍，把雷点亮，然后绕开。
   */
  detect?: number;
  /** 单位落到这一格时。返回 false = 不消耗次数（默认消耗） */
  onEnter?(c: MarkCtx): boolean | void;
  /** 每个玩家回合开始时。返回 false = 不消耗次数（默认消耗，适合"只响一次"的东西） */
  onTurnStart?(c: MarkCtx): boolean | void;
}

const kinds = new Map<string, MarkKindDef>();

export function registerMarkKind(def: MarkKindDef): void {
  kinds.set(def.id, def);
}

export function markKindOf(id: string): MarkKindDef | null {
  return kinds.get(id) ?? null;
}

export function allMarkKinds(): MarkKindDef[] {
  return Array.from(kinds.values());
}

/**
 * 棋盘上所有留痕。
 *
 * 只读、且**不改状态**：旧存档没有这个字段（undefined），被改坏的存档可能是
 * 别的东西——统一在这里兜住，调用方永远拿到一个数组。
 * 补齐字段那件事交给 `addMark`（写的时候才需要真的建数组）。
 */
export function marksOf(s: GameState): Mark[] {
  return Array.isArray(s.marks) ? s.marks : [];
}

export function marksAt(s: GameState, x: number, y: number): Mark[] {
  const list = s.marks;
  if (!list || list.length === 0) return [];
  return list.filter((m) => m.x === x && m.y === y);
}

export function markCountOf(s: GameState, kind: string, owner?: PlayerId): number {
  return marksOf(s).filter((m) => m.kind === kind && (owner === undefined || m.owner === owner)).length;
}

/** 放一件东西。序号自己发，别在调用方拼 id（拼重了就删错东西） */
export function addMark(
  s: GameState,
  input: Omit<Mark, 'id'> & { id?: string },
): Mark {
  if (!Array.isArray(s.marks)) s.marks = [];
  s.nextMarkSeq = Math.max(s.nextMarkSeq ?? 1, s.marks.length + 1);
  const mark: Mark = { ...input, id: input.id ?? `k${s.nextMarkSeq}` };
  if (!input.id) s.nextMarkSeq += 1;
  s.marks.push(mark);
  return mark;
}

export function removeMark(s: GameState, id: string): void {
  if (!Array.isArray(s.marks)) return;
  s.marks = s.marks.filter((m) => m.id !== id);
}

/** 扣一次次数；用尽就删。返回是否删掉 */
function spend(s: GameState, mark: Mark): boolean {
  if (mark.charges === undefined) return false; // 不限次数：火场、遗迹
  mark.charges -= 1;
  if (mark.charges > 0) return false;
  removeMark(s, mark.id);
  return true;
}

function terrainOk(kind: MarkKindDef, s: GameState, mark: Mark): boolean {
  if (!kind.on) return true;
  const tile = s.tiles[mark.y * s.w + mark.x];
  if (!tile) return false;
  return kind.on.includes(tile.terrain);
}

/**
 * 单位落到一格之后的结算。
 *
 * 只处理"站上来"这一种进入方式：这游戏里的移动是一次跳跃（不是逐格推进），
 * 所以"路过"和"落脚"是同一件事。以后真做了逐格移动，就在每一步调用它。
 *
 * 反复触发直到这一格上没有能再触发的东西：一种雷把船炸到 0 血，剩下的雷
 * 不该继续炸一条已经沉了的船（`unit.hp <= 0` 时直接收手）。
 */
export function enterTile(s: GameState, unit: Unit, api: MarkApi): void {
  const here = marksAt(s, unit.x, unit.y);
  if (here.length === 0) return;
  for (const mark of [...here]) {
    if (unit.hp <= 0) break;
    const kind = markKindOf(mark.kind);
    if (!kind?.onEnter) continue;
    if (kind.trigger === 'enemy' && mark.owner === unit.owner) continue;
    if (!terrainOk(kind, s, mark)) continue;
    const consume = kind.onEnter({ state: s, mark, unit, api });
    if (consume !== false) spend(s, mark);
  }
}

/**
 * 回合开始时的结算。
 *
 * 对**所有**留痕跑一遍、把"轮到谁"交给 kind 自己判断，而不是只跑
 * "轮到谁就只跑谁的"。理由：火场、毒雾这类东西不管谁走过来都烧，
 * 而"只烧布设者以外的人"这种规则，写在 kind 里一行就够，
 * 塞进引擎就会变成"每加一种阵营相关的效果都要改一次引擎"。
 */
export function tickMarks(s: GameState, player: PlayerId, api: MarkApi): void {
  const list = s.marks;
  if (!list || list.length === 0) return;
  for (const mark of [...list]) {
    const kind = markKindOf(mark.kind);
    if (!kind?.onTurnStart) continue;
    if (!terrainOk(kind, s, mark)) continue;
    const consume = kind.onTurnStart({ state: s, mark, player, api });
    if (consume !== false) spend(s, mark);
  }
}

/**
 * 某个玩家此刻看得见哪些留痕。
 *
 * 三条规则，缺一条都会把游戏弄坏：
 *   1. 自己的永远看得见（不然自己布的雷自己都记不住位置）；
 *   2. 不隐藏的按视野走（和单位一个口径）；
 *   3. 隐藏的，得有自己的单位贴到 `detect` 格以内**并且那一格在视野里**——
 *      地图都看不见却知道那儿有雷，等于开了透视。
 *
 * @param inSight 格索引是否在当前视野里（观战/无雾时一律 true）
 */
export function visibleMarks(
  s: GameState,
  p: PlayerId,
  inSight: (i: number) => boolean,
): Mark[] {
  const out: Mark[] = [];
  for (const m of marksOf(s)) {
    const i = m.y * s.w + m.x;
    if (m.owner === p) {
      out.push(m);
      continue;
    }
    const kind = markKindOf(m.kind);
    const hidden = m.hidden ?? kind?.hidden ?? true;
    if (!inSight(i)) continue;
    if (!hidden) {
      out.push(m);
      continue;
    }
    const r = kind?.detect ?? 1;
    const found = s.units.some(
      (u) =>
        u.owner === p &&
        u.hp > 0 &&
        Math.max(Math.abs(u.x - m.x), Math.abs(u.y - m.y)) <= r,
    );
    if (found) out.push(m);
  }
  return out;
}
