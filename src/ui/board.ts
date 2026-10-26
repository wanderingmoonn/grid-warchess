/**
 * 棋盘渲染。
 *
 * 三层结构：格子 → 城市方块 → 棋子。
 * 城市是 2×2 的独立实体，单独占一层，这样血条能横跨四格而不被格子边界切断。
 *
 * 全量重绘：144 个格子 + 二十来个棋子，这个规模下重建比 diff 更快也更不容易出 bug。
 * 唯一的例外是棋子移动：用 FLIP（先量旧位置，重绘后补一段反向位移动画）
 * 让位移看起来是滑过去的，而不是瞬间跳。
 */

import type { PlayerView } from '../core/fog.ts';
import { cityName, utype } from '../core/rules.ts';
import type { GameState, Unit } from '../core/types.ts';

export interface BoardUi {
  selectedId: string | null;
  /** 可达格索引 */
  reach: number[];
  /** 可攻击的敌方单位 id */
  targets: string[];
  /** 可攻城的城市 id */
  siegeTargets: string[];
  /** 当前选中的城市 id */
  selectedCityId: string | null;
  /** 处于野外建造模式时，可以放置建筑的空格 */
  placeable: number[];
  /** 威胁范围：移动之后能打到哪些格 */
  threat: number[];
}

const TERRAIN_CLASS: Record<string, string> = {
  plain: 't-plain',
  forest: 't-forest',
  hill: 't-hill',
  water: 't-water',
  mountain: 't-mountain',
  bridge: 't-bridge',
  city: 't-city',
};

function ensureStructure(el: HTMLElement): void {
  if (el.querySelector('.tiles')) return;
  // 城市层放在棋子之后：背景透明，所以只在视觉上叠一层边框和血条，
  // 不会挡住棋子，pointer-events 也穿过去，点格子照常生效。
  el.innerHTML = '<div class="tiles"></div><div class="units"></div><div class="cities"></div>';
}

function hpClass(ratio: number): string {
  if (ratio <= 0.3) return 'low';
  if (ratio <= 0.6) return 'mid';
  return '';
}

/** 时代用罗马数字表示，比阿拉伯数字更像"时代" */
function romanEra(era: number): string {
  return ['I', 'II', 'III', 'IV', 'V'][era - 1] ?? String(era);
}

export function renderBoard(el: HTMLElement, view: PlayerView, ui: BoardUi): void {
  ensureStructure(el);
  const s = view.state;
  const tilesEl = el.querySelector<HTMLElement>('.tiles');
  const citiesEl = el.querySelector<HTMLElement>('.cities');
  const unitsEl = el.querySelector<HTMLElement>('.units');
  if (!tilesEl || !citiesEl || !unitsEl) return;

  // 先记录棋子旧位置，供 FLIP 用
  const prevRects = new Map<string, DOMRect>();
  unitsEl.querySelectorAll<HTMLElement>('.unit').forEach((node) => {
    const id = node.dataset.id;
    if (id) prevRects.set(id, node.getBoundingClientRect());
  });

  const cellSize = Math.max(18, (el.clientWidth - 12) / s.w);
  el.style.setProperty('--cell', `${cellSize}px`);
  el.style.setProperty('--cols', String(s.w));
  el.style.setProperty('--rows', String(s.h));

  el.classList.toggle('fog', s.fog);

  // 浓雾（blackout 扩展）：连地形都不给看。
  // 基础规则的雾只遮单位，地图本身永远可见；这个扩展把"地图"也遮掉——
  // 视野外只剩一片黑，城市要侦察到才画得出来。
  const blackout = s.fog && s.config.expansionIds.includes('blackout');
  el.classList.toggle('blackout', blackout);

  const visibleSet = new Set(view.visible);
  const reachSet = new Set(ui.reach);
  const placeSet = new Set(ui.placeable);
  const threatSet = new Set(ui.threat);
  const targetPositions = new Set<number>();
  for (const id of ui.targets) {
    const u = s.units.find((x) => x.id === id);
    if (u) targetPositions.add(u.y * s.w + u.x);
  }

  // ---- 格子 ----
  const tileParts: string[] = [];
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const tile = s.tiles[i];
      if (!tile) continue;

      const seen = !blackout || visibleSet.has(i);
      const cls = seen ? ['tile', TERRAIN_CLASS[tile.terrain] ?? 't-plain'] : ['tile', 'unknown'];
      if (seen && tile.cityId) {
        const city = s.cities.find((c) => c.id === tile.cityId);
        if (city) cls.push(`own-${city.owner}`);
      }
      if (targetPositions.has(i)) cls.push('attackable');
      else if (reachSet.has(i)) cls.push('reach');
      if (threatSet.has(i) && !reachSet.has(i)) cls.push('threat');
      if (placeSet.has(i)) cls.push('placeable');
      if (s.fog && !visibleSet.has(i)) cls.push('out');

      tileParts.push(`<div class="${cls.join(' ')}" data-x="${x}" data-y="${y}"></div>`);
    }
  }
  tilesEl.innerHTML = tileParts.join('');

  // ---- 城市 ----
  // 浓雾下，四格都看不见的城市直接不画：敌城的位置本身就是情报
  const cityVisible = (city: { x: number; y: number; size: number }): boolean => {
    if (!blackout) return true;
    for (let dy = 0; dy < city.size; dy++) {
      for (let dx = 0; dx < city.size; dx++) {
        if (visibleSet.has((city.y + dy) * s.w + (city.x + dx))) return true;
      }
    }
    return false;
  };
  const cityParts = s.cities.filter(cityVisible).map((city) => {
    const cls = ['city-block', `owner-${city.owner}`, `era-${city.era}`];
    if (ui.siegeTargets.includes(city.id)) cls.push('siege-target');
    if (ui.selectedCityId === city.id) cls.push('selected');

    const ratio = city.hp / city.maxHp;
    const style = [
      `left:${(city.x / s.w) * 100}%`,
      `top:${(city.y / s.h) * 100}%`,
      `width:${(city.size / s.w) * 100}%`,
      `height:${(city.size / s.h) * 100}%`,
    ].join(';');

    return `<div class="${cls.join(' ')}" data-city-id="${city.id}" style="${style}" title="${cityName(city)} · 时代 ${romanEra(city.era)} · 耐久 ${city.hp}/${city.maxHp} · 护甲 ${city.armor}">
      <div class="city-plate">
        <div class="city-era">${romanEra(city.era)}</div>
        <div class="city-name">${cityName(city)}</div>
        <div class="city-hp"><i class="${hpClass(ratio)}" style="width:${Math.max(3, ratio * 100)}%"></i></div>
        <div class="city-armor">甲 ${city.armor}</div>
      </div>
    </div>`;
  });
  citiesEl.innerHTML = cityParts.join('');

  // ---- 棋子 ----
  const unitParts: string[] = [];
  for (const u of s.units) {
    unitParts.push(unitHtml(s, u, ui));
  }
  for (const ghost of view.ghosts) {
    unitParts.push(ghostHtml(s, ghost.x, ghost.y, ghost.type, ghost.seenAt, s.turn));
  }

  unitsEl.innerHTML = unitParts.join('');

  // ---- FLIP 补间 ----
  unitsEl.querySelectorAll<HTMLElement>('.unit').forEach((node) => {
    const id = node.dataset.id;
    if (!id) return;
    const old = prevRects.get(id);
    if (!old) return;
    const now = node.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
      duration: 170,
      easing: 'ease-out',
    });
  });
}

function tileRect(s: GameState, x: number, y: number): string {
  return [
    `left:${(x / s.w) * 100}%`,
    `top:${(y / s.h) * 100}%`,
    `width:${100 / s.w}%`,
    `height:${100 / s.h}%`,
  ].join(';');
}

function unitHtml(s: GameState, u: Unit, ui: BoardUi): string {
  const def = utype(s, u.type);
  const ratio = u.hp / def.maxHp;
  const isSpent = u.owner === s.current && u.moved && u.acted;
  const isSelected = ui.selectedId === u.id;
  const isTarget = ui.targets.includes(u.id);

  const cls = ['unit', `owner-${u.owner}`, `cat-${def.category}`];
  if (isSpent) cls.push('spent');
  if (isSelected) cls.push('selected');
  if (isTarget) cls.push('targeted');

  const playerName = s.players[u.owner].name;
  const kindText =
    def.category === 'building' ? '建筑' : def.category === 'economy' ? '经济单位' : '部队';
  const title = `${playerName} · ${def.name}（${kindText}）· ${u.hp}/${def.maxHp} · 甲 ${def.armor}`;

  const cargo = u.cargo?.length ?? 0;
  const cargoBadge =
    cargo > 0
      ? `<span style="font-size:9px;vertical-align:top;opacity:.85">${cargo}</span>`
      : '';

  return `<div class="${cls.join(' ')}" data-id="${u.id}" data-x="${u.x}" data-y="${u.y}" style="${tileRect(
    s,
    u.x,
    u.y,
  )}" title="${title}${cargo > 0 ? ` · 载 ${cargo} 个单位` : ''}">
    <div class="unit-inner">${def.short}${cargoBadge}
      <div class="unit-hp"><i class="${hpClass(ratio)}" style="width:${Math.max(2, ratio * 100)}%"></i></div>
    </div>
  </div>`;
}

function ghostHtml(
  s: GameState,
  x: number,
  y: number,
  type: string,
  seenAt: number,
  currentTurn: number,
): string {
  const def = utype(s, type);
  const title = `最后已知位置：${def.name}（${currentTurn - seenAt} 个行动前）`;
  return `<div class="unit ghost" data-ghost="1" data-x="${x}" data-y="${y}" style="${tileRect(
    s,
    x,
    y,
  )}" title="${title}">
    <div class="unit-inner">${def.short}</div>
  </div>`;
}

/** 从事件目标反推棋盘坐标 */
export function coordsFromEvent(e: Event): { x: number; y: number } | null {
  const target = e.target as HTMLElement | null;
  if (!target) return null;
  const node = target.closest<HTMLElement>('[data-x]');
  if (!node) return null;
  const x = Number(node.dataset.x);
  const y = Number(node.dataset.y);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return { x, y };
}

/** 推断点到的是哪个棋子 */
export function unitIdFromEvent(e: Event): string | null {
  const target = e.target as HTMLElement | null;
  if (!target) return null;
  const node = target.closest<HTMLElement>('[data-id]');
  return node?.dataset.id ?? null;
}

/** 推断点到的是哪座城市 */
export function cityIdFromEvent(e: Event): string | null {
  const target = e.target as HTMLElement | null;
  if (!target) return null;
  const node = target.closest<HTMLElement>('[data-city-id]');
  return node?.dataset.cityId ?? null;
}
