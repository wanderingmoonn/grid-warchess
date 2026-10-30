/**
 * 兵种列表的两个筛选维度：**扩展包**与**时代**。
 *
 * 抽成独立小模块，是因为好几个地方都要用同一套口径：侧栏的产兵面板（城市 /
 * 军营）和上帝模式的兵种货架。三处的分组规则一旦各写一遍，就会出现
 * "侧栏说这个兵是奇想·骑士的，货架把它算进原版"这种事——排查起来很贵，
 * 因为它不报错，只是偶尔少一个按钮。
 *
 * 两个维度共用一套规矩，界面才敢说"所有模式手感一样"：
 *   · 空值（`PACK_ALL` / `ERA_ALL`）= 不筛；
 *   · 两者之间是 **与**，单独用或叠着用都行；
 *   · 再点一次当前那一档 = 回到全部；
 *   · 这一屏只有一个包 / 只有一个时代时，整条行返回空串——
 *     一颗按下去筛不掉任何东西的按钮，比没有这颗按钮更让人困惑。
 */

import { eraDef, isPseudoUnit } from '../core/config.ts';
import { EXPANSIONS, expansionById, unitSourceIdOf } from '../core/expansions.ts';
import type { UnitTypeDef } from '../core/types.ts';

/** 空串 = 全部 */
export const PACK_ALL = '';
/** 不属于任何扩展的兵种（原版那 49 个）统一记成这个 key */
export const PACK_CORE = 'core';

/** 这个兵种属于哪个"包" */
export function packOf(def: UnitTypeDef): string {
  return unitSourceIdOf(def.id) ?? PACK_CORE;
}

export function packOk(def: UnitTypeDef, pack: string): boolean {
  return !pack || packOf(def) === pack;
}

export function packLabel(pack: string): string {
  return pack === PACK_CORE ? '原版' : (expansionById(pack)?.name ?? pack);
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 扩展包筛选栏。
 *
 * 只列**这一屏真的出现了的包**：一个按下去筛掉零个按钮的开关，比没有这个
 * 开关更让人困惑。整屏只有一个包时返回空串（不占地方）。
 *
 * @param act 点击时用的 data-act，两个界面的处理器是分开的
 */
export function packRow(defs: UnitTypeDef[], current: string, act = 'recruit-pack'): string {
  // 伪单位（攻城结算用的「城市」壳）不数：它不属于任何包，混进来只会让
  // "全部 N" 比玩家真能看见的按钮多一个——这种账对不上是最难查的那种
  const real = defs.filter((d) => !isPseudoUnit(d.id));
  const counts = new Map<string, number>();
  for (const d of real) {
    const p = packOf(d);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  // 顺序固定：原版 → 开局勾选的扩展顺序 → 剩下的（理论上进不了这里）
  const order: string[] = [];
  if (counts.has(PACK_CORE)) order.push(PACK_CORE);
  for (const e of EXPANSIONS) if (counts.has(e.id)) order.push(e.id);
  for (const p of counts.keys()) if (!order.includes(p)) order.push(p);
  if (order.length < 2) return '';

  const one = (id: string, text: string) =>
    `<button class="chip ${current === id ? 'active' : ''}" data-act="${act}" data-pack="${id}">${escapeHtml(text)}</button>`;

  return `<div class="chip-row pack-row">
    ${one(PACK_ALL, `全部 ${real.length}`)}
    ${order.map((p) => one(p, `${packLabel(p)} ${counts.get(p) ?? 0}`)).join('')}
  </div>`;
}

/* ===========================================================================
 * 时代
 * ======================================================================== */

/** 0 = 全部时代。不用"最高时代+1"之类的哨兵值：0 是兵种表里真不会出现的等级 */
export const ERA_ALL = 0;

export function eraOk(def: UnitTypeDef, era: number): boolean {
  if (era === ERA_ALL) return true;
  // 没写时代的东西（玩家自建兵种漏了字段）不该因为筛了个时代就消失：
  // 筛的是"我看哪一代"，不是"偷偷藏掉不认识的"
  if (!Number.isFinite(def.era)) return true;
  return def.era === era;
}

export function eraLabel(era: number): string {
  return era === ERA_ALL ? '全部时代' : `${eraDef(era).name}时代`;
}

/**
 * 时代筛选栏。
 *
 * 和 `packRow` 同一套规矩：只列**这一屏真的出现了的时代**，只有一个时代时
 * 整条行不出现。为什么不用 `ERAS` 全表：没开「现代战争」的局里没有六代兵，
 * 摆一个"现代 0"出来等于给玩家一个点了必然空的按钮。
 *
 * @param act 点击时用的 data-act，各界面自己的处理器
 */
export function eraChipRow(defs: UnitTypeDef[], current: number, act = 'recruit-era'): string {
  const real = defs.filter((d) => !isPseudoUnit(d.id) && Number.isFinite(d.era));
  const counts = new Map<number, number>();
  for (const d of real) counts.set(d.era, (counts.get(d.era) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  if (levels.length < 2) return '';

  const one = (level: number, text: string) =>
    `<button class="chip ${current === level ? 'active' : ''}" data-act="${act}" data-era="${level}"${
      level === ERA_ALL ? '' : ` title="只看「${eraDef(level).name}」时代的兵种"`
    }>${escapeHtml(text)}</button>`;

  // 「全部时代」的计数写全量：它和包筛选那一行的「全部 N」是同一份分母
  // （只有"没写时代"的自建兵会让两个数字差一个，那种东西本来也进不了货架），
  // 两行并排时数字对得上，玩家才不会怀疑某一档算漏了
  return `<div class="chip-row pack-row era-row">
    ${one(ERA_ALL, `${eraLabel(ERA_ALL)} ${real.length}`)}
    ${levels.map((l) => one(l, `${eraDef(l).name} ${counts.get(l) ?? 0}`)).join('')}
  </div>`;
}
