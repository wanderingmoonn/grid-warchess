/**
 * 按扩展包筛选兵种。
 *
 * 抽成独立小模块，是因为两个地方都要用同一套口径：侧栏的产兵面板（城市 /
 * 军营）和上帝模式的兵种货架。三处的分组规则一旦各写一遍，就会出现
 * "侧栏说这个兵是奇想·骑士的，货架把它算进原版"这种事——排查起来很贵，
 * 因为它不报错，只是偶尔少一个按钮。
 */

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
  const counts = new Map<string, number>();
  for (const d of defs) {
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
    ${one(PACK_ALL, `全部 ${defs.length}`)}
    ${order.map((p) => one(p, `${packLabel(p)} ${counts.get(p) ?? 0}`)).join('')}
  </div>`;
}
