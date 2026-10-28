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
import { buildProgress, cityName, footprintOf, isAirborne, underConstruction, utype } from '../core/rules.ts';
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
  /**
   * 这一步实际走的路线（单位 id → 格子串），只用来画移动动画。
   *
   * 不给也能用：退化成"起点直线滑到终点"。给了就沿路线拐弯，
   * 绕着河走、绕过友军的时候，观众看得出来它是怎么绕的——观战能不能看懂，
   * 差的就是这一口气。
   */
  movePath?: Map<string, Array<{ x: number; y: number }>>;
  /**
   * 经济单位的移动产出预览：格索引 → 站上那格后的每回合收入。
   *
   * 只在"选中带收入的经济单位、且它还能动"时有值。数字印在可达格的
   * 角上，玩家挪农民之前就能看到"去平原收 7、蹲河边多 3"——
   * 收入本来就是按格子算的，不把数字放回格子上，这个机制就只活在说明书里。
   */
  incomeHints?: Map<number, number>;
}

const TERRAIN_CLASS: Record<string, string> = {
  plain: 't-plain',
  forest: 't-forest',
  hill: 't-hill',
  water: 't-water',
  mountain: 't-mountain',
  bridge: 't-bridge',
  city: 't-city',
  plateau: 't-plateau',
  valley: 't-valley',
  marsh: 't-marsh',
  dune: 't-dune',
  shallow: 't-shallow',
  lava: 't-lava',
  volcano: 't-volcano',
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
  // 浓雾下"去过、此刻看不见"的格：按记忆里的样子画，压暗一档
  const rememberedTiles = view.rememberedTiles;
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

      // 三档：眼前亮着 / 去过（浓雾下按记忆画）/ 从没去过（浓雾下全黑）
      const lit = !blackout || visibleSet.has(i);
      const memo = lit ? undefined : rememberedTiles.get(i);
      const seen = lit || memo !== undefined;
      const cls = seen ? ['tile', TERRAIN_CLASS[memo ?? tile.terrain] ?? 't-plain'] : ['tile', 'unknown'];
      if (memo !== undefined) cls.push('remembered');
      if (lit && tile.cityId) {
        const city = s.cities.find((c) => c.id === tile.cityId);
        if (city) cls.push(`own-${city.owner}`);
      }
      if (targetPositions.has(i)) cls.push('attackable');
      else if (reachSet.has(i)) cls.push('reach');
      if (threatSet.has(i) && !reachSet.has(i)) cls.push('threat');
      if (placeSet.has(i)) cls.push('placeable');
      if (s.fog && !visibleSet.has(i)) cls.push('out');

      // 产出徽标只跟着可达格走：站不上去的地形（水、山）没有讨论价值
      const hint = ui.incomeHints?.get(i);
      const badge = hint !== undefined ? `<span class="tile-income">+${hint}</span>` : '';
      tileParts.push(`<div class="${cls.join(' ')}" data-x="${x}" data-y="${y}">${badge}</div>`);
    }
  }
  tilesEl.innerHTML = tileParts.join('');

  // ---- 城市 ----
  // 浓雾下城市也分三档：眼前看得见就照实画；以前去过就画记忆里的那一份
  // （虚线框 + "旧情报"）；从没去过连边框都不给——敌城的位置本身就是情报。
  const cityInSight = (city: { x: number; y: number; size: number }): boolean => {
    for (let dy = 0; dy < city.size; dy++) {
      for (let dx = 0; dx < city.size; dx++) {
        if (visibleSet.has((city.y + dy) * s.w + (city.x + dx))) return true;
      }
    }
    return false;
  };
  const cityParts: string[] = [];
  for (const city of s.cities) {
    const lit = !blackout || cityInSight(city);
    const memo = lit ? undefined : view.rememberedCities.get(city.id);
    if (!lit && !memo) continue;

    // 记忆只能代表当时：城会易手、会升级，所以这三项一律以快照为准
    const owner = memo ? memo.owner : city.owner;
    const era = memo ? memo.era : city.era;
    const ruined = memo ? memo.ruined : city.ruined === true;
    const ago = memo ? Math.max(0, s.turn - memo.seenAt) : 0;

    const cls = ['city-block', `owner-${owner}`, `era-${era}`];
    if (ruined) cls.push('ruined');
    if (memo) cls.push('stale');
    if (ui.siegeTargets.includes(city.id)) cls.push('siege-target');
    if (ui.selectedCityId === city.id) cls.push('selected');

    const ratio = city.hp / city.maxHp;
    const style = [
      `left:${(city.x / s.w) * 100}%`,
      `top:${(city.y / s.h) * 100}%`,
      `width:${(city.size / s.w) * 100}%`,
      `height:${(city.size / s.h) * 100}%`,
    ].join(';');

    // 旧情报不画血条：上次看到的耐久早就不是现在这条了，画出来是假消息
    const when = ago === 0 ? '刚刚' : `${ago} 个行动前`;
    const plate = memo
      ? `<div class="city-stale">旧情报 · ${when}</div>`
      : ruined
        ? '<div class="city-ruin">废墟 · 待接管</div>'
        : `<div class="city-hp"><i class="${hpClass(ratio)}" style="width:${Math.max(3, ratio * 100)}%"></i></div>
               <div class="city-armor">甲 ${city.armor}</div>`;
    const note = memo
      ? `${when}看到的：时代 ${romanEra(era)}${ruined ? '，当时是废墟' : ''}`
      : ruined
        ? '已成废墟：派兵入驻并支付重建费才能接管'
        : `耐久 ${city.hp}/${city.maxHp} · 护甲 ${city.armor}`;

    cityParts.push(`<div class="${cls.join(' ')}" data-city-id="${city.id}" style="${style}" title="${cityName(city)} · ${note}">
      <div class="city-plate">
        <div class="city-era">${romanEra(era)}</div>
        <div class="city-name">${cityName(city)}</div>
        ${plate}
      </div>
    </div>`);
  }
  citiesEl.innerHTML = cityParts.join('');

  // ---- 棋子 ----
  // 建筑先画、部队后画：同一格上"站着的兵"必须压在"设施"上面。
  // 反过来的话，兵被自己的塔盖住，点下去选中的是塔——那个兵就再也选不中、
  // 也就再也走不开了。z-index 不管这件事，DOM 顺序管。
  // 空中单位最后画：它和地面单位可以叠在一格，画在上面才叫"在你头顶"。
  const ordered = [...s.units].sort((a, b) => {
    const rank = (u: Unit) =>
      utype(s, u.type).category === 'building' ? 0 : isAirborne(s, u) ? 2 : 1;
    return rank(a) - rank(b);
  });
  const unitParts: string[] = [];
  for (const u of ordered) {
    unitParts.push(unitHtml(s, u, ui));
  }
  for (const ghost of view.ghosts) {
    unitParts.push(ghostHtml(s, ghost.x, ghost.y, ghost.type, ghost.seenAt, s.turn));
  }

  unitsEl.innerHTML = unitParts.join('');

  // ---- FLIP 补间 ----
  //
  // 有路线就沿路线走（拐弯、绕过河），没路线就直线滑过去。
  // 拐弯这件事只在"走了两格以上"时才看得出来，一格的距离两种画法一样。
  const boardBox = unitsEl.getBoundingClientRect();
  const cellW = boardBox.width / Math.max(1, s.w);
  const cellH = boardBox.height / Math.max(1, s.h);
  unitsEl.querySelectorAll<HTMLElement>('.unit').forEach((node) => {
    const id = node.dataset.id;
    if (!id) return;
    const old = prevRects.get(id);
    if (!old) return;
    const now = node.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

    const path = ui.movePath?.get(id);
    if (path && path.length > 2) {
      const destX = Number(node.dataset.x);
      const destY = Number(node.dataset.y);
      const frames = path
        .slice(0, -1)
        .reverse()
        .map((c) => ({
          transform: `translate(${(c.x - destX) * cellW}px, ${(c.y - destY) * cellH}px)`,
        }));
      frames.push({ transform: 'translate(0, 0)' });
      node.animate(frames, {
        // 一格 70ms，封顶 560ms：32×32 上的长距离行军不会让人等到烦
        duration: Math.min(560, 70 * (path.length - 1)),
        easing: 'linear',
      });
      return;
    }

    node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
      duration: 170,
      easing: 'ease-out',
    });
  });
}

function tileRect(s: GameState, x: number, y: number, n = 1): string {
  return [
    `left:${(x / s.w) * 100}%`,
    `top:${(y / s.h) * 100}%`,
    `width:${(n * 100) / s.w}%`,
    `height:${(n * 100) / s.h}%`,
  ].join(';');
}

function unitHtml(s: GameState, u: Unit, ui: BoardUi): string {
  const def = utype(s, u.type);
  const ratio = u.hp / def.maxHp;
  const isSpent = u.owner === s.current && u.moved && u.acted;
  const isSelected = ui.selectedId === u.id;
  const isTarget = ui.targets.includes(u.id);
  const fp = footprintOf(s, u);

  const cls = ['unit', `owner-${u.owner}`, `cat-${def.category}`];
  // 空中层：缩一号 + 往左上挪一点，和脚底下那个兵能同时看见
  if (isAirborne(s, u)) cls.push('air');
  if (fp > 1) cls.push('wide');
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

  // 工地：进度条压在血条上面。没有它，玩家只看到一座"残血"的建筑，
  // 却不知道自己投了多少、还差多少——施工这件事就只活在日志里。
  const site = underConstruction(u);
  const prog = site ? buildProgress(s, u) : null;
  const siteCls = site ? ' site' : '';
  const buildBar = prog
    ? `<div class="unit-build" title="施工 ${prog.done}/${prog.need} · 每回合 +${prog.rate} · 还要 ${prog.turnsLeft} 回合"><i style="width:${Math.max(
        3,
        prog.ratio * 100,
      )}%"></i></div>`
    : '';
  const siteNote = prog ? ` · 工地 ${prog.done}/${prog.need}（+${prog.rate}/回合）` : '';

  return `<div class="${cls.join(' ')}${siteCls}" data-id="${u.id}" data-x="${u.x}" data-y="${u.y}" data-fp="${fp}" style="${tileRect(
    s,
    u.x,
    u.y,
    fp,
  )}" title="${title}${siteNote}${cargo > 0 ? ` · 载 ${cargo} 个单位` : ''}">
    <div class="unit-inner">${def.short}${cargoBadge}
      ${buildBar}
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
