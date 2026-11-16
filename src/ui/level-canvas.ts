/**
 * 关卡编辑器的地图画布（E2）。
 *
 * 为什么值得单独写一块，而不是"接着用上帝模式刷"：
 *   1. 上帝模式是**对局内**的界面——要先开一局、刷完、打开地图面板、复制文本、
 *      再粘进关卡对象。四步里任何一步错，作者都会以为是刷子坏了；
 *   2. 上帝模式刷的是"这一局的地形"，关卡要的是"这张图的地形 + 城位"，
 *      后者是地图数据的一部分，得一起编辑；
 *   3. 画布要能**撤销**。刷子刷错一格就回不了头，是新手最先撞上的墙。
 *
 * 两条设计约束：
 *   · **格子恒为正方形**：容器 `aspect-ratio: w / h`，格子按 `1fr` 均分。
 *     这和对局棋盘是同一条道理（`fitBoardBox`），别再拿一个边长当尺寸。
 *   · **不自己画外观**：格子直接套 `.tile.t-<地形>`，和棋盘用的是同一份样式。
 *     自己配一套颜色，迟早会出现"画布上是沼泽、进局变沙漠"。
 */

import { CONFIG } from '../core/config.ts';
import { TERRAIN_CHARS, validateFixedMap } from '../core/fixed-maps.ts';
import { LEVEL_TERRAINS, type LevelDef } from '../core/level.ts';
import { terrainFromChar } from '../core/mapgen.ts';
import type { MapPoint } from '../core/fixed-maps.ts';
import type { PlayerId } from '../core/types.ts';
import { toast } from './toast.ts';

const MIN_SIZE = 8;
const MAX_SIZE = 40;
/** 城的边长。开了「城郭」会变 3，但那是开局设置，地图数据里没这个字段。 */
const CITY_SIZE = 2;

const SEATS: PlayerId[] = ['A', 'B', 'C', 'D'];
const SEAT_NAME: Record<string, string> = { A: '红方', B: '蓝方', C: '绿方', D: '黄方' };

/**
 * 调色板顺序按"画一张地表图最常用的"排，不是按字符表顺序。
 * 空间站那三个字符（虚空 / 甲板 / 破口）不放进调色板：地表图用不上，
 * 放进来只会让人手滑画出一格虚空，然后整张图的通行判定变得莫名其妙。
 */
const PALETTE_CHARS: string[] = ['.', 'f', 'h', '~', 's', 'D', '^', '=', 'P', 'v', 'w', 'd', 'r', 'c'];

type Brush = { kind: 'terrain'; ch: string } | { kind: 'city'; seat: PlayerId };

interface Snapshot {
  grid: string[][];
  cities: Record<string, MapPoint[]>;
}

export interface LevelCanvasOptions {
  level: LevelDef;
  /** 点「用这张图」时回传一份**新的** LevelDef（不改入参） */
  onApply: (level: LevelDef) => void;
  onClose?: () => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

function toGrid(rows: string[], w: number, h: number): string[][] {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => rows[y]?.[x] ?? '.'));
}

function cloneCities(src: Record<string, MapPoint[]>): Record<string, MapPoint[]> {
  const out: Record<string, MapPoint[]> = {};
  for (const [k, v] of Object.entries(src)) out[k] = v.map((p) => ({ x: p.x, y: p.y }));
  return out;
}

export function openLevelCanvas(opts: LevelCanvasOptions): void {
  const level = opts.level;
  const seatCount = level.seats?.count ?? 2;
  const seats = SEATS.slice(0, seatCount);

  let w = level.map.w;
  let h = level.map.h;
  let grid = toGrid(level.map.rows, w, h);
  let cities: Record<string, MapPoint[]> = {
    A: level.map.citiesA.map((p) => ({ ...p })),
    B: level.map.citiesB.map((p) => ({ ...p })),
    ...(level.seats?.cities?.C ? { C: level.seats.cities.C.map((p) => ({ ...p })) } : {}),
    ...(level.seats?.cities?.D ? { D: level.seats.cities.D.map((p) => ({ ...p })) } : {}),
  };

  let brush: Brush = { kind: 'terrain', ch: '.' };
  let rectMode = false;
  let stroking = false;
  let strokeDirty = false;
  let rectAnchor: { x: number; y: number } | null = null;
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-head">
        <h2>画地图</h2>
        <p>
          左边挑笔刷，右边直接在格子上涂。城是<b>整块占位</b>的，用「红方城」这类笔刷点一下左上角就摆一座，
          再点一次同一座城就撤掉。
        </p>
      </div>
      <div class="modal-body">
        <div class="level-canvas-wrap">
          <div class="level-palette">
            <div class="editor-group-title">地形</div>
            <div class="level-brushes" data-brushes></div>
            <div class="editor-group-title">城位</div>
            <div class="level-brushes" data-city-brushes></div>
            <label class="editor-check"><input type="checkbox" data-rect> 矩形框选（拖一个矩形一次刷满）</label>
          </div>
          <div class="level-canvas-box">
            <div class="level-canvas" data-canvas></div>
            <div class="level-canvas-foot">
              <span data-coord>第 -, - 格</span>
              <span data-size-line></span>
            </div>
          </div>
        </div>
        <div class="editor-grid level-canvas-size">
          <label class="editor-field"><span>宽（${MIN_SIZE}~${MAX_SIZE}）</span><input type="number" data-w min="${MIN_SIZE}" max="${MAX_SIZE}"></label>
          <label class="editor-field"><span>高（${MIN_SIZE}~${MAX_SIZE}）</span><input type="number" data-h min="${MIN_SIZE}" max="${MAX_SIZE}"></label>
        </div>
        <div class="level-issues" data-issues></div>
        <div class="field-hint" data-foot>画完点「用这张图」，编辑器里那份数据会跟着变（还要再点一次「保存」才算存下来）。</div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-sm" data-act="undo">撤销</button>
        <button class="btn btn-sm" data-act="redo">重做</button>
        <button class="btn btn-primary btn-sm" data-act="apply">用这张图</button>
        <button class="btn" data-act="cancel">取消</button>
      </div>
    </div>`;

  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;
  const canvasEl = q<HTMLDivElement>('[data-canvas]');
  const brushesEl = q<HTMLDivElement>('[data-brushes]');
  const cityBrushesEl = q<HTMLDivElement>('[data-city-brushes]');
  const issuesEl = q<HTMLDivElement>('[data-issues]');
  const footEl = q<HTMLDivElement>('[data-foot]');
  const coordEl = q<HTMLSpanElement>('[data-coord]');
  const sizeLineEl = q<HTMLSpanElement>('[data-size-line]');
  const wInput = q<HTMLInputElement>('[data-w]');
  const hInput = q<HTMLInputElement>('[data-h]');

  /* ---------- 状态与快照 ---------- */

  const snapshot = (): Snapshot => ({ grid: grid.map((r) => [...r]), cities: cloneCities(cities) });

  const pushUndo = (): void => {
    undoStack.push(snapshot());
    if (undoStack.length > 40) undoStack.shift();
    redoStack.length = 0;
  };

  const restore = (snap: Snapshot): void => {
    grid = snap.grid.map((r) => [...r]);
    cities = cloneCities(snap.cities);
    h = grid.length;
    w = grid[0]?.length ?? w;
  };

  /* ---------- 查询 ---------- */

  /** 这一格被哪座城占着（含城的占地范围） */
  const cityAt = (x: number, y: number): { seat: PlayerId; origin: MapPoint } | null => {
    for (const seat of seats) {
      for (const c of cities[seat] ?? []) {
        if (x >= c.x && x < c.x + CITY_SIZE && y >= c.y && y < c.y + CITY_SIZE) {
          return { seat, origin: c };
        }
      }
    }
    return null;
  };

  const canPlaceCity = (seat: PlayerId, x: number, y: number): string | null => {
    if (x < 0 || y < 0 || x + CITY_SIZE > w || y + CITY_SIZE > h) return '放不下：城的 2×2 会伸出边界';
    for (let dy = 0; dy < CITY_SIZE; dy += 1) {
      for (let dx = 0; dx < CITY_SIZE; dx += 1) {
        const other = cityAt(x + dx, y + dy);
        if (other) {
          return other.seat === seat ? '这一格已经有你的城了' : `这一格已经有${SEAT_NAME[other.seat] ?? other.seat}的城了`;
        }
        const t = terrainFromChar(grid[y + dy]?.[x + dx] ?? '.');
        if (t === 'water' || t === 'deep' || t === 'mountain') {
          return `城的范围里有一格是${CONFIG.terrainName[t]}，城不能压在上面`;
        }
      }
    }
    return null;
  };

  /* ---------- 涂 ---------- */

  const paintCell = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    if (brush.kind === 'terrain') {
      if (cityAt(x, y)) {
        // 城格的地形改不了：城压在格子上，把地貌改掉只会得到一座"站在水里"的城
        footEl.textContent = '城占着这一格，地形改不了。先把城撤掉再刷。';
        return;
      }
      const row = grid[y];
      if (!row || row[x] === brush.ch) return;
      row[x] = brush.ch;
      strokeDirty = true;
      paintCellDom(x, y);
      return;
    }
    // 城位笔刷：点在已有的城上 = 撤掉；点空处 = 摆一座
    const hit = cityAt(x, y);
    if (hit) {
      cities[hit.seat] = (cities[hit.seat] ?? []).filter((c) => c !== hit.origin);
      strokeDirty = true;
      renderGrid();
      return;
    }
    const why = canPlaceCity(brush.seat, x, y);
    if (why) {
      footEl.textContent = why;
      return;
    }
    cities[brush.seat] = [...(cities[brush.seat] ?? []), { x, y }];
    strokeDirty = true;
    renderGrid();
  };

  const paintRect = (ax: number, ay: number, bx: number, by: number): void => {
    if (brush.kind !== 'terrain') {
      footEl.textContent = '矩形框选只对地形有效。';
      return;
    }
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    let blocked = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (cityAt(x, y)) {
          blocked += 1;
          continue;
        }
        const row = grid[y];
        if (row) row[x] = brush.ch;
      }
    }
    strokeDirty = true;
    renderGrid();
    if (blocked > 0) footEl.textContent = `${blocked} 格是城，跳过了。`;
  };

  /* ---------- 渲染 ---------- */

  function cellClass(x: number, y: number): string {
    const hit = cityAt(x, y);
    const terrain = hit ? 'city' : terrainFromChar(grid[y]?.[x] ?? '.');
    return `tile t-${terrain}`;
  }

  function paintCellDom(x: number, y: number): void {
    const el = canvasEl.querySelector<HTMLElement>(`[data-x="${x}"][data-y="${y}"]`);
    if (!el) return;
    el.className = cellClass(x, y);
    // 城标：只在城的左上角那一格写字，否则一座 2×2 的城会重复四个字母
    const hit = cityAt(x, y);
    el.textContent = hit && hit.origin.x === x && hit.origin.y === y ? hit.seat : '';
  }

  function renderGrid(): void {
    canvasEl.style.aspectRatio = `${w} / ${h}`;
    canvasEl.style.gridTemplateColumns = `repeat(${w}, 1fr)`;
    canvasEl.style.gridTemplateRows = `repeat(${h}, 1fr)`;
    const parts: string[] = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const hit = cityAt(x, y);
        const label = hit && hit.origin.x === x && hit.origin.y === y ? hit.seat : '';
        parts.push(
          `<div class="${cellClass(x, y)}" data-x="${x}" data-y="${y}" title="${x}, ${y}">${label}</div>`,
        );
      }
    }
    canvasEl.innerHTML = parts.join('');
    // 格子太小的话城标会糊成一团，这里只控制字号不控制显隐
    canvasEl.style.setProperty('font-size', `${Math.max(9, Math.min(16, Math.round(360 / Math.max(w, h))))}px`);
    wInput.value = String(w);
    hInput.value = String(h);
    const counts: Record<string, number> = {};
    for (const seat of seats) counts[seat] = (cities[seat] ?? []).length;
    sizeLineEl.textContent = `${w}×${h} · ${seats.map((s) => `${SEAT_NAME[s]} ${counts[s] ?? 0} 城`).join(' / ')}`;
  }

  function renderBrushes(): void {
    brushesEl.innerHTML = PALETTE_CHARS.filter((ch) => TERRAIN_CHARS.includes(ch))
      .map((ch) => {
        const t = terrainFromChar(ch);
        const on = brush.kind === 'terrain' && brush.ch === ch;
        return `<button type="button" class="level-brush ${on ? 'active' : ''}" data-ch="${ch}" title="字符 ${esc(
          ch,
        )}">
            <span class="level-swatch tile t-${t}"></span>
            <span>${esc(CONFIG.terrainName[t] ?? t)}<i class="level-brush-char">${esc(ch)}</i></span>
          </button>`;
      })
      .join('');

    cityBrushesEl.innerHTML = seats
      .map((seat) => {
        const on = brush.kind === 'city' && brush.seat === seat;
        return `<button type="button" class="level-brush ${on ? 'active' : ''}" data-seat="${seat}">
            <span class="level-swatch tile t-city"></span>
            <span>${SEAT_NAME[seat] ?? seat}城</span>
          </button>`;
      })
      .join('');
  }

  /* ---------- 交互 ---------- */

  const cellFromEvent = (ev: PointerEvent): { x: number; y: number } | null => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-x]');
    if (!el) return null;
    return { x: Number(el.dataset.x), y: Number(el.dataset.y) };
  };

  canvasEl.addEventListener('pointerdown', (ev) => {
    const cell = cellFromEvent(ev);
    if (!cell) return;
    ev.preventDefault();
    stroking = true;
    strokeDirty = false;
    pushUndo();
    if (rectMode && brush.kind === 'terrain') {
      rectAnchor = cell;
      return;
    }
    paintCell(cell.x, cell.y);
  });

  canvasEl.addEventListener('pointermove', (ev) => {
    const cell = cellFromEvent(ev);
    if (cell) coordEl.textContent = `第 ${cell.x}, ${cell.y} 格`;
    if (!stroking || !cell) return;
    if (rectMode && brush.kind === 'terrain') return; // 矩形在抬手时一次刷
    paintCell(cell.x, cell.y);
  });

  const endStroke = (ev: PointerEvent): void => {
    if (!stroking) return;
    const cell = cellFromEvent(ev);
    if (rectMode && rectAnchor && cell) paintRect(rectAnchor.x, rectAnchor.y, cell.x, cell.y);
    rectAnchor = null;
    stroking = false;
    // 整笔什么都没改（点了一下空地/点了同一种地形）→ 撤掉刚压进去的那条快照，
    // 否则撤销栈里会堆一串"看起来撤了但什么都没变"的步骤
    if (!strokeDirty) undoStack.pop();
    renderGrid();
  };
  canvasEl.addEventListener('pointerup', endStroke);
  canvasEl.addEventListener('pointercancel', endStroke);

  mask.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement;
    if (el.hasAttribute('data-rect')) {
      rectMode = (el as HTMLInputElement).checked;
      return;
    }
    // 尺寸输入只在失焦/回车时应用，边输边改会把 8 打成 80 再打回来
  });

  mask.addEventListener('change', (ev) => {
    const el = ev.target as HTMLElement;
    if (!el.hasAttribute('data-w') && !el.hasAttribute('data-h')) return;
    applySize(Number(wInput.value), Number(hInput.value));
  });

  const applySize = (nw: number, nh: number): void => {
    const cw = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(nw) || w));
    const chh = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(nh) || h));
    if (cw === w && chh === h) {
      renderGrid();
      return;
    }
    pushUndo();
    // 缩小时会裁掉边缘：数一下裁掉了几格"不是平原"的地形，得说一声
    let cut = 0;
    for (let y = chh; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) if ((grid[y]?.[x] ?? '.') !== '.') cut += 1;
    }
    for (let y = 0; y < Math.min(h, chh); y += 1) {
      for (let x = cw; x < w; x += 1) if ((grid[y]?.[x] ?? '.') !== '.') cut += 1;
    }
    const next = Array.from({ length: chh }, (_, y) => Array.from({ length: cw }, (_, x) => grid[y]?.[x] ?? '.'));
    grid = next;
    w = cw;
    h = chh;
    let dropped = 0;
    for (const seat of seats) {
      const keep = (cities[seat] ?? []).filter((c) => c.x + CITY_SIZE <= w && c.y + CITY_SIZE <= h);
      dropped += (cities[seat] ?? []).length - keep.length;
      cities[seat] = keep;
    }
    renderGrid();
    const notes: string[] = [];
    if (cut > 0) notes.push(`边缘裁掉了 ${cut} 格地形`);
    if (dropped > 0) notes.push(`挤掉 ${dropped} 座城（超出边界）`);
    footEl.textContent = notes.length > 0 ? `改尺寸：${notes.join('、')}。` : '尺寸改好了。';
  };

  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;

    const brushBtn = t.closest<HTMLElement>('[data-ch]');
    if (brushBtn) {
      brush = { kind: 'terrain', ch: brushBtn.dataset.ch ?? '.' };
      renderBrushes();
      footEl.textContent = `现在是「${CONFIG.terrainName[terrainFromChar((brush as { ch: string }).ch)]}」笔刷。`;
      return;
    }
    const seatBtn = t.closest<HTMLElement>('[data-seat]');
    if (seatBtn) {
      brush = { kind: 'city', seat: seatBtn.dataset.seat as PlayerId };
      renderBrushes();
      footEl.textContent = '点一下摆城（占 2×2），再点同一座城就撤掉。';
      return;
    }

    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'undo') {
      const snap = undoStack.pop();
      if (!snap) {
        footEl.textContent = '没有可撤销的了。';
        return;
      }
      redoStack.push(snapshot());
      restore(snap);
      renderGrid();
      return;
    }
    if (act === 'redo') {
      const snap = redoStack.pop();
      if (!snap) {
        footEl.textContent = '没有可重做的了。';
        return;
      }
      undoStack.push(snapshot());
      restore(snap);
      renderGrid();
      return;
    }
    if (act === 'cancel') {
      mask.remove();
      opts.onClose?.();
      return;
    }
    if (act === 'apply') {
      const built = buildMap();
      if (!built) return;
      const checked = validateFixedMap(built);
      if (!checked.ok) {
        issuesEl.innerHTML = checked.errors
          .map((e) => `<div class="level-issue is-error"><b>这张图还不能用</b>${esc(e)}</div>`)
          .join('');
        footEl.textContent = '先改完上面这些再点「用这张图」。';
        return;
      }
      opts.onApply(buildLevel(checked.map));
      mask.remove();
      toast('地图已更新，别忘了点「保存到我的关卡」');
    }
  });

  /* ---------- 出图 ---------- */

  /** 组装成 FixedMap 的原始形状（交给 validateFixedMap 判，不自己判） */
  function buildMap(): Record<string, unknown> | null {
    for (const seat of seats) {
      if ((cities[seat] ?? []).length === 0) {
        footEl.textContent = `${SEAT_NAME[seat] ?? seat}一座城都没有——每家至少要有一座，否则它第一回合就出局。`;
        return null;
      }
    }
    return {
      ...level.map,
      w,
      h,
      rows: grid.map((r) => r.join('')),
      citiesA: (cities.A ?? []).map((p) => ({ ...p })),
      citiesB: (cities.B ?? []).map((p) => ({ ...p })),
      source: level.map.source === 'builtin' ? 'builtin' : 'user',
    };
  }

  function buildLevel(checkedMap: LevelDef['map']): LevelDef {
    const next: LevelDef = {
      ...level,
      map: { ...checkedMap, name: level.map.name, id: level.map.id },
    };
    if (level.seats) {
      const extra: Record<string, MapPoint[]> = {};
      if (seats.includes('C') && (cities.C ?? []).length > 0) extra.C = (cities.C ?? []).map((p) => ({ ...p }));
      if (seats.includes('D') && (cities.D ?? []).length > 0) extra.D = (cities.D ?? []).map((p) => ({ ...p }));
      next.seats = { ...level.seats, ...(Object.keys(extra).length > 0 ? { cities: extra } : {}) };
      if (Object.keys(extra).length === 0) delete (next.seats as { cities?: unknown }).cities;
    }
    return next;
  }

  renderBrushes();
  renderGrid();
  wInput.value = String(w);
  hInput.value = String(h);
  document.body.appendChild(mask);

  // 调色板里的浅流('s')和阴影乱流共用同一个字符，提示一句免得作者困惑
  if (TERRAIN_CHARS.includes('s') && LEVEL_TERRAINS.includes('shallow')) {
    footEl.textContent = '提示：字符 s 在关卡里按「浅流」解释（陆军的涉水口）。';
  }
}
