/**
 * 法术专用的状态：目前只有「麻痹」。
 *
 * ── 为什么单开一个文件 ────────────────────────────────────────────
 *
 * 状态注册表已经下沉到 `src/core/statuses.ts`，扩展能自己注册了（2026-11-13），
 * 所以修真包的状态就该住在修真包里，而不是塞回核心的 `CORE_STATUS_DEFS`。
 * 核心那份只留 slow/chill/sunder/curse/curse-deep 这些**别的包也在用**的。
 *
 * ── 为什么是"麻痹"而不是"眩晕" ────────────────────────────────────
 *
 * 这个名字是给玩家看的：一门雷法打上去，屏幕上写"麻痹 1 回合"比"眩晕"
 * 更贴合修士的手感，而且它和兵种自带的「定身」在文案上不会混。
 *
 * ⚠️ 本文件只能 import `../statuses.ts` 和 `../types.ts`，
 * 不许 import rules（会把扩展→rules→扩展绕成运行时环）。
 */
import { registerStatus } from '../statuses.ts';
import type { Unit } from '../types.ts';

/** 状态键。带 `spell-` 前缀是为了不和兵种、别的扩展撞名 */
export const STUN_STATUS = 'spell-stun';

registerStatus({
  id: STUN_STATUS,
  name: '麻痹',
  summary: '无法行动',
});

/**
 * 让一个单位麻痹 `turns` 个自己的回合。
 *
 * ── 为什么存的是 `turns + 1` ─────────────────────────────────────
 *
 * 状态是在**回合切换时**结算的：轮到谁，先 tick 一遍他的状态、把剩余回合
 * 减 1，然后才允许他行动（`rules.ts` 的 `tickStatuses(s, nextPlayer)`）。
 *
 * 所以"存 1"会在对方刚接手回合时就被减成 0，等于什么都没发生。
 * 想拦住对方**下一次**行动，必须存 2：接手时减成 1（还在），这一整回合都动不了；
 * 再下一回合才减到 0。
 *
 * 这个 +1 不是补丁，是「状态的剩余回合按谁的时间轴数」这件事的具体表现；
 * 中毒 3 回合会真的掉 3 次血，用的是同一套口径。
 *
 * 取 max 而不是覆盖：两发雷打在同一个单位上不该变成"麻痹 1 回合"
 * （那是"后一发把前一发顶掉了"），该按更长的那个算。
 */
export function stunFor(u: Unit, turns: number): void {
  if (turns <= 0) return;
  u.status ??= {};
  u.status[STUN_STATUS] = Math.max(u.status[STUN_STATUS] ?? 0, turns + 1);
}

/** 这个单位现在是不是被麻痹着（`canCommand` 用它） */
export function isStunned(u: Unit): boolean {
  return (u.status?.[STUN_STATUS] ?? 0) > 0;
}

// ── 定身（无法移动）────────────────────────────────

/**
 * 状态键：**只禁移动，不禁攻击**。
 *
 * 和「麻痹」是两件事，别合并：
 *   · 麻痹 = 这一回合什么都不做（移动、攻击、施法全禁），走 `canCommand` 整条封死；
 *   · 定身 = 走不动，但站着还能打（厚土镇岳、垚压住的人）。
 *
 * 实现方式是把移动力改成 0。**不会误伤攻击**：封印判据（`sealedReasonOf`）
 * 只认封印阵，不按移动力判，所以 0 移不会让单位连攻击都被禁。
 */
export const ROOT_STATUS = 'spell-root';

registerStatus({
  id: ROOT_STATUS,
  name: '定身',
  summary: '无法移动',
  modifyMove: (_s, _u, val, move) => (val > 0 ? 0 : move),
});

/**
 * 定身 `turns` 个自己的回合。
 *
 * 和 `stunFor` 一样要 `+ 1`：状态在回合切换时先 tick 再减 1，
 * 存 1 会在对方接手回合的瞬间失效。理由见 `stunFor` 上面那段。
 */
export function rootFor(u: Unit, turns: number): void {
  if (turns <= 0) return;
  u.status ??= {};
  u.status[ROOT_STATUS] = Math.max(u.status[ROOT_STATUS] ?? 0, turns + 1);
}

/** 这个单位现在是不是被定身 */
export function isRooted(u: Unit): boolean {
  return (u.status?.[ROOT_STATUS] ?? 0) > 0;
}

// ── 术法加持（族 6 的临时属性）──────────────────────

/**
 * 状态键：一个**只用来数回合**的状态，本身不带任何效果。
 *
 * 为什么数值不写在 `StatusDef` 里：`StatusDef` 的 `modifyAtk` 引擎还没接上
 * （只有 `modifyMove/Armor/Vision` 会被调用），所以"攻击 ×3"没法从状态里生效。
 * 于是数值放进 `Unit.custom.spellBuff`，由 `hooks.ts` 的几个属性钩子去读；
 * 这个状态只负责"还剩几回合"，到期后钩子读不到它，加成就自动失效。
 *
 * 这也顺手解决了"多种加成一起来了怎么办"：一个单位同时只保留一份 buff 数值
 * （后放的覆盖前一份），但回合数取较长的那次。
 */
export const BUFF_STATUS = 'spell-buff';

registerStatus({
  id: BUFF_STATUS,
  name: '术法加持',
  summary: '身上挂着一门临时法术加成',
});

/** 族 6 的加成数值。全是增量，除了 `atkMul` 是倍率 */
export interface SpellBuffs {
  /** 攻击伤害倍率（体术 ×3） */
  atkMul?: number;
  /** 移动力 +N */
  move?: number;
  /** 视野 +N */
  vision?: number;
  /** 射程 +N */
  range?: number;
  /** 攻击次数 +N */
  attacks?: number;
  /** 溅射半径 +N */
  splash?: number;
  /** 御风：攻击伤害再加上"本回合移动格数" */
  wind?: boolean;
}

/**
 * 此刻生效的加成。状态没挂上就一律当 0——**不要**在到期时回头清理
 * `Unit.custom`：清理点会分散在三四处（被打死、被驱散、回合切换），
 * 漏一处就变成"buff 没了但加成还在"。以状态为准，custom 只当值仓库。
 */
export function spellBuffsOf(u: Unit): SpellBuffs {
  if (((u.status?.[BUFF_STATUS] ?? 0) as number) <= 0) return {};
  return ((u.custom?.['spellBuff'] as SpellBuffs | undefined) ?? {});
}

/**
 * 挂上加成，持续 `turns` 个自己的回合。
 *
 * ── 为什么这里**不**像 `stunFor` 那样 `+1` ────────────────────────
 *
 * `stunFor` 的 +1 是为了让效果活过**对方**接手回合时的那次 tick——不 +1
 * 就等于什么都没发生。加持不一样：它是在**自己回合**挂上去的，当场就生效，
 * 不需要活过任何一次 tick 才算数。存 `turns` 的意思是"这一回合 + 之后
 * turns−1 个自己的回合"，正好等于玩家说的"持续 N 回合"。
 *
 * 这两条口径混用会差一整回合，而差的那回合玩家几乎看不出来（"我明明写着 2 回合"）。
 *
 * 后放的覆盖先放的：两个加成叠乘会让"体术 × 天魔解体"这种组合失控，
 * 而玩家看不出是哪一条导致的。回合数取较长的那个，免得短的那次把长的顶掉。
 */
export function applySpellBuffs(u: Unit, turns: number, buffs: SpellBuffs): void {
  u.status ??= {};
  u.status[BUFF_STATUS] = Math.max(u.status[BUFF_STATUS] ?? 0, turns);
  u.custom = { ...(u.custom ?? {}), spellBuff: buffs };
}

/**
 * 给单位挂一个"持续 `turns` 个自己的回合"的状态（核心已有的状态也用它，例如熔甲）。
 *
 * `+ 1` 只该写在这一处。把 `turns` 直接交给 `c.api.putStatus` 会少一回合——
 * 状态在回合切换时先 tick 再减 1，存 1 等于没有。这个坑踩过一次
 * （麻痹第一版就是这么写成 1 的），所以统一收进这个函数。
 */
export function timedStatusFor(
  put: (u: Unit, key: string, turns: number) => boolean,
  u: Unit,
  key: string,
  turns: number,
): void {
  if (turns > 0) put(u, key, turns + 1);
}
