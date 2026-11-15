/**
 * 冥天大梦（簇 A）——把一片区域拖进梦里，然后把这一批人的状态**回滚**。
 *
 * ── 它到底是个什么机制（作者 2026-11-14 口述）──────────────────
 *
 * 施术者半径内的单位**全部被困住**：不能移动到半径外，但半径外的可以走进来。
 * 脱离只有两条路：
 *   · **自己死**——真死，不复活；
 *   · **打死施术者**——所有还在梦里的活人 **+ 刚死的施术者**，
 *     状态回到**入梦那一刻**。
 *
 * 第二条不是"复活"，是**回滚一群人**。所以这里存的不是 `state`（那是天衍四九），
 * 而是"入梦那一拍，这些人各自的快照"：血、坐标、状态、`custom`。
 * 死掉的人不在回滚名单里——梦醒也换不回已经死透的人。
 *
 * ── 边界怎么实现的 ──────────────────────────────────────────────
 *
 * 走核心的 `canEnterTile` 钩子（`blockedFor` 里调用）。选它是因为寻路高亮、
 * 实际移动、上船下船**共用**这一处——只改它才不会出现"看着能走、点了走不过去"。
 *
 * ⚠️ 红线：本文件不许 import `../units.ts`。
 */
import { registerSkillEffect } from '../../skill-hooks.ts';
import { distToUnit } from '../../query.ts';
import { registerStatus } from '../../statuses.ts';
import type { BoardId, PlayerId, Unit } from '../../types.ts';
import {
  defineSpellSkill,
  paySpellCost,
  registerManaReady,
  registerPreview,
  spellCustom,
  type SpellRow,
} from '../spell-kernel.ts';

export const DREAM_STATUS = 'spell-dream';
registerStatus({ id: DREAM_STATUS, name: '冥天大梦', summary: '被困在梦里，走不出边界' });

/** 入梦那一刻的快照。够用就好：多存的字段都是以后会忘的债 */
export interface DreamSnap {
  x: number;
  y: number;
  hp: number;
  board?: BoardId;
  moved: boolean;
  acted: boolean;
  status: Record<string, number | undefined>;
  custom: Record<string, unknown>;
}

/** 记在施术者身上的整场梦 */
export interface DreamRecord {
  cx: number;
  cy: number;
  radius: number;
  owner: PlayerId;
  snap: Record<string, DreamSnap>;
}

/** 记在**每个被困者**身上：边界在哪、是谁做的梦 */
export interface DreamRing {
  cx: number;
  cy: number;
  radius: number;
  by: string;
}

export const DREAM_KEY = 'dream';
export const DREAM_RING_KEY = 'dreamRing';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T;
}

// ── 数据行 ────────────────────────────────────────
export const MING_TIAN_DA_MENG_COST = 120;
export const MING_TIAN_DA_MENG_MIN_RANK = 7;
export const MING_TIAN_DA_MENG_RADIUS = 3;
const MING_TIAN_DA_MENG: SpellRow = {
  id: 'ming-tian-da-meng',
  name: '冥天大梦',
  summary:
    `把半径 ${MING_TIAN_DA_MENG_RADIUS} 格内所有单位拖进梦境：他们**走不出这个圈**（外面的人可以进来）；` +
    '他们要脱身只能自己死（真死），或者打死你——后者会让梦里还活着的人和**刚死的你**，' +
    `一起回到入梦那一刻的状态；耗 ${MING_TIAN_DA_MENG_COST} 灵力。`,
  effect: 'dream',
  cost: MING_TIAN_DA_MENG_COST,
  range: 0,
  preview: 'ring',
  targeting: 'none',
  custom: {} satisfies Record<string, unknown>,
};

export const DREAM_ROWS: readonly SpellRow[] = [MING_TIAN_DA_MENG];
export const MING_TIAN_DA_MENG_SKILL = defineSpellSkill(MING_TIAN_DA_MENG);

registerManaReady(DREAM_ROWS);
registerPreview(DREAM_ROWS);

// ── 实现 ──────────────────────────────────────────
registerSkillEffect('dream', (c) => {
  const p = spellCustom<Record<string, unknown>>(c);
  const s = c.state;
  const self = c.self;
  const cost = Number(p.spellCost);
  const skillName = (c.skill as { name?: string } | undefined)?.name ?? '法术';
  const name = c.api.utype(s, self.type).name;
  const radius = MING_TIAN_DA_MENG_RADIUS;

  const caught = s.units.filter(
    (u) => u.hp > 0 && (u.board ?? 'earth') === (self.board ?? 'earth') && distToUnit(c.view, self, u) <= radius,
  );
  if (caught.length <= 1) {
    c.result.ok = false;
    c.result.reason = '半径内没有别人，困不住谁';
    return;
  }

  if (!paySpellCost(c, cost)) {
    c.result.ok = false;
    c.result.reason = `灵力不足（需要 ${cost} 点）`;
    return;
  }

  /*
   * 先全部拍快照，再统一挂状态。
   *
   * 快照要**拷贝**（`clone`）：存引用的话，梦里掉的血会把"入梦那一刻"也一起改掉——
   * 醒来发现所有人都回到"只剩一滴血"的样子。这是个很容易写错又很难查的坑。
   */
  const snap: Record<string, DreamSnap> = {};
  for (const u of caught) {
    snap[u.id] = clone({
      x: u.x,
      y: u.y,
      hp: u.hp,
      board: u.board,
      moved: u.moved,
      acted: u.acted,
      status: u.status ?? {},
      custom: u.custom ?? {},
    });
  }

  for (const u of caught) {
    u.status = { ...(u.status ?? {}), [DREAM_STATUS]: 99 };
    u.custom = {
      ...(u.custom ?? {}),
      [DREAM_RING_KEY]: { cx: self.x, cy: self.y, radius, by: self.id } satisfies DreamRing,
    };
  }
  self.custom = {
    ...(self.custom ?? {}),
    [DREAM_KEY]: { cx: self.x, cy: self.y, radius, owner: self.owner, snap } satisfies DreamRecord,
  };

  c.result.log = `${name}施放${skillName}：${caught.length} 人被拖进梦里，半径 ${radius} 格内走不出去`;
});

/** 这个单位身上的梦境边界（没被困就是 undefined） */
export function dreamRingOf(u: Unit): DreamRing | undefined {
  return u.custom?.[DREAM_RING_KEY] as DreamRing | undefined;
}

/** 施术者身上的整场梦 */
export function dreamRecordOf(u: Unit): DreamRecord | undefined {
  return u.custom?.[DREAM_KEY] as DreamRecord | undefined;
}
