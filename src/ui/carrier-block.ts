/**
 * 侧栏里的「甲板」一块：起飞与**手动回收**。
 *
 * 为什么单独一个文件：这段 UI 在 2026-11-08 之前根本不存在——
 * 当时"回收"是航母回合开始自动做的，结果和"自动放飞"撞成一个死循环
 * （飞机被收进甲板、同一回合又被扔回母舰旁边那一格、还被设成当回合不能动，
 * 于是永远出不了第一格）。现在回收改成玩家动作，就必须有地方按这个按钮。
 *
 * 判定一律走规则层的 `LAUNCH` / `RECOVER` 动作，这里只负责画。
 */

import type { GameState, Unit } from '../core/types.ts';
import { deckFree, deckOf, deckSpecOf } from '../core/naval-carrier.ts';

/** 贴着母舰、可以尝试回收的己方飞机（距离与规则层 recover 的 2 格对齐） */
function nearbyPlanes(s: GameState, carrier: Unit): Unit[] {
  return s.units.filter(
    (u) =>
      u.owner === carrier.owner &&
      u.id !== carrier.id &&
      u.hp > 0 &&
      s.unitTypes[u.type]?.layer === 'air' &&
      Math.abs(u.x - carrier.x) + Math.abs(u.y - carrier.y) <= 2,
  );
}

export function carrierBlock(s: GameState, u: Unit, canAct: boolean): string {
  const spec = deckSpecOf(s.unitTypes[u.type]);
  if (!spec) return '';

  const deck = deckOf(u);
  const free = deckFree(s.unitTypes[u.type], u);
  const planes = nearbyPlanes(s, u);

  const deckRows = deck.map((p, i) => {
    const def = s.unitTypes[p.type];
    const label = def?.name ?? p.type;
    // 整备量与规则层同一个口径：上限的一半，向上取整
    const heal = Math.ceil((def?.maxHp ?? p.hp) / 2);
    // 只有第一架能一键放飞（规则层的 LAUNCH 取甲板表头，两处必须是同一个口径）
    const btn =
      i === 0
        ? `<button class="recruit-btn" data-act="launch" ${canAct ? '' : 'disabled'}>
             <span class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:var(--fs-sm)">放</span>
             <span class="meta"><b>放飞 ${label}</b><span>放到母舰周围的空域，当回合不能再移动</span></span>
             <span class="price">起飞</span>
           </button>`
        : '';
    return `<div class="hint">甲板 ${i + 1}：${label} · ${p.hp} / ${def?.maxHp ?? p.hp} 血 · 整备中（每回合 +${heal}）</div>${btn}`;
  });

  const recoverRows = planes.map((p) => {
    const def = s.unitTypes[p.type];
    const name = def?.name ?? p.type;
    const disabled = !canAct || free <= 0;
    return `<button class="recruit-btn" data-act="recover" data-plane="${p.id}" ${disabled ? 'disabled' : ''}>
      <span class="unit-chip ${u.owner === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:var(--fs-sm)">收</span>
      <span class="meta"><b>回收 ${name}</b><span>${p.hp} 血 · 离母舰 ${Math.abs(p.x - u.x) + Math.abs(p.y - u.y)} 格</span></span>
      <span class="price">${free <= 0 ? '甲板满' : '进甲板'}</span>
    </button>`;
  });

  return `<div class="card-title" style="margin-top:14px">甲板 ${deck.length} / ${spec.capacity}</div>
  <div class="hint">收和放都是手动动作：飞机贴到母舰 2 格内点「回收」才进甲板，甲板上的飞机每回合整备回一半血，停多久由你决定；点「放飞」才回到棋盘。</div>
  ${deckRows.length > 0 ? `<div class="recruit-list" style="margin-top:8px">${deckRows.join('')}</div>` : ''}
  ${
    recoverRows.length > 0
      ? `<div class="recruit-list" style="margin-top:8px">${recoverRows.join('')}</div>`
      : `<div class="hint">附近没有可以回收的飞机。</div>`
  }`;
}
