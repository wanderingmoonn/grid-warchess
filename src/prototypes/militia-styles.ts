import type { FixedMap } from '../core/fixed-maps.ts';
import { playerView } from '../core/fog.ts';
import { createMatch, DEFAULT_CONFIG } from '../core/setup.ts';
import type { GameState, PlayerId, Terrain, Unit } from '../core/types.ts';
import { createAngledBoard } from '../ui/angled-board.ts';
import {
  MILITIA_STYLE_IDS,
  registerMilitiaStylePrototypes,
  type MilitiaStyleKey,
} from './militia-styles-art.ts';

registerMilitiaStylePrototypes();

type TeamMode = PlayerId | 'DIM' | 'VS';
type FocusMode = 'ALL' | MilitiaStyleKey;

const STYLE_ROWS: ReadonlyArray<{
  key: MilitiaStyleKey;
  typeId: string;
  label: string;
  y: number;
}> = [
  { key: 'A', typeId: MILITIA_STYLE_IDS.A, label: 'A 像素', y: 2 },
  { key: 'B', typeId: MILITIA_STYLE_IDS.B, label: 'B 几何', y: 5 },
  { key: 'C', typeId: MILITIA_STYLE_IDS.C, label: 'C 厚涂', y: 8 },
  { key: 'D', typeId: MILITIA_STYLE_IDS.D, label: 'D 台座', y: 11 },
];

const TERRAIN_COLS: ReadonlyArray<{
  terrain: Terrain;
  label: string;
  xStart: number;
  xEnd: number;
  unitX: number;
}> = [
  { terrain: 'plain', label: '平原', xStart: 1, xEnd: 3, unitX: 2 },
  { terrain: 'forest', label: '森林', xStart: 4, xEnd: 6, unitX: 5 },
  { terrain: 'hill', label: '丘陵', xStart: 7, xEnd: 9, unitX: 8 },
  { terrain: 'plateau', label: '台地', xStart: 10, xEnd: 12, unitX: 11 },
];

const MAP_W = 16;
const MAP_H = 16;

function cellChar(x: number, y: number): string {
  // 东北角高山与山麓点缀（提供真实地形尺度与色相参照，不干扰 4×4 对比区）
  if ((x === 14 && y <= 1) || (x === 15 && y <= 2)) return '^';
  if ((x === 13 && y <= 1) || (x === 14 && y === 2) || (x === 15 && y === 3)) return 'h';

  // 南缘河流、浅滩与木桥（夹在两座青铜时代 E1 城池之间，留出 y=13 平原缓冲带）
  if (y >= 14 && x >= 5 && x <= 8) {
    if (y === 14 && (x === 6 || x === 7)) return '=';
    if (x === 5 || x === 8) return 's';
    return '~';
  }

  // 核心 4×4 真实地形对照条带（y = 1..12）
  if (y >= 1 && y <= 12) {
    if (x >= 4 && x <= 6) return 'f';
    if (x >= 7 && x <= 9) return 'h';
    if (x >= 10 && x <= 12) return 'P';
  }
  return '.';
}

const CHAR_TO_TERRAIN: Record<string, Terrain> = {
  '.': 'plain',
  f: 'forest',
  h: 'hill',
  P: 'plateau',
  '^': 'mountain',
  '~': 'water',
  s: 'shallow',
  '=': 'bridge',
};

function buildComparisonState(teamMode: TeamMode, focus: FocusMode): GameState {
  const map: FixedMap = {
    id: 'prototype-militia-styles-16',
    name: '民兵四风格真实地形对照',
    w: MAP_W,
    h: MAP_H,
    rows: Array.from({ length: MAP_H }, (_, y) =>
      Array.from({ length: MAP_W }, (_, x) => cellChar(x, y)).join('')),
    citiesA: [{ x: 1, y: 14 }],
    citiesB: [{ x: 11, y: 14 }],
  };

  const match = createMatch(
    {
      ...DEFAULT_CONFIG,
      fixedMap: map,
      size: MAP_W,
      startEra: 1,
      expansionIds: ['height-terrain'],
    },
    20261125,
    {},
  );
  match.fog = false;

  // 严格写入真实地形（保证平原 / 森林 / 丘陵 / 台地及周边高山、河流、木桥精确落位）
  for (let y = 0; y < match.h; y++) {
    for (let x = 0; x < match.w; x++) {
      const tile = match.tiles[y * match.w + x];
      if (!tile) continue;
      tile.terrain = CHAR_TO_TERRAIN[cellChar(x, y)] ?? 'plain';
    }
  }

  // 两座青铜时代（E1）真实城池用于风格融合对照
  match.cities.forEach((city) => {
    city.era = 1;
  });

  // 为 4 套风格克隆民兵属性定义（不改动任何主游戏兵种定义）
  const baseMilitia = match.unitTypes.militia!;
  for (const row of STYLE_ROWS) {
    match.unitTypes[row.typeId] = {
      ...baseMilitia,
      id: row.typeId,
      name: `民兵（${row.label}）`,
    };
  }

  const units: Unit[] = [];
  for (const row of STYLE_ROWS) {
    if (focus !== 'ALL' && focus !== row.key) continue;
    for (let colIdx = 0; colIdx < TERRAIN_COLS.length; colIdx++) {
      const col = TERRAIN_COLS[colIdx]!;
      let owner: PlayerId = 'A';
      let acted = false;
      let moved = false;
      if (teamMode === 'DIM') {
        owner = 'A';
        moved = true;
        acted = true;
      } else if (teamMode === 'VS') {
        owner = colIdx < 2 ? 'A' : 'B';
      } else {
        owner = teamMode;
      }
      units.push({
        id: `militia-${row.key}-${col.terrain}`,
        owner,
        type: row.typeId,
        x: col.unitX,
        y: row.y,
        hp: baseMilitia.maxHp,
        kills: 0,
        moved,
        acted,
      });
    }
  }
  match.units = units;
  return match;
}

const viewport = document.querySelector<HTMLElement>('#viewport')!;
const stage = document.querySelector<HTMLElement>('#stage')!;
const canvasWrap = document.querySelector<HTMLElement>('#canvas-wrap')!;
const canvas = document.querySelector<HTMLCanvasElement>('#militia-board')!;
const markersEl = document.querySelector<HTMLElement>('#markers')!;
const inspectPill = document.querySelector<HTMLElement>('#inspect-pill')!;

const angled = createAngledBoard(canvas, new URL('../../', document.baseURI).href);

let zoom = 1;
let teamMode: TeamMode = 'A';
let focusMode: FocusMode = 'ALL';
let selectedUnitId: string | null = null;
let panX = 0;
let panY = 0;
let currentState: GameState = buildComparisonState(teamMode, focusMode);

interface TagRef {
  el: HTMLDivElement;
  x: number;
  y: number;
  lift: number;
  styleKey?: MilitiaStyleKey;
}

const tagRefs: TagRef[] = [];

function buildTags(): void {
  markersEl.innerHTML = '';
  tagRefs.length = 0;
  for (const row of STYLE_ROWS) {
    const el = document.createElement('div');
    el.className = 'map-tag row-tag';
    el.textContent = row.label;
    markersEl.appendChild(el);
    tagRefs.push({ el, x: 0.05, y: row.y, lift: 5, styleKey: row.key });
  }
  for (const col of TERRAIN_COLS) {
    const el = document.createElement('div');
    el.className = 'map-tag col-tag';
    el.textContent = col.label;
    markersEl.appendChild(el);
    tagRefs.push({ el, x: col.unitX, y: 0.05, lift: 7 });
  }
}

function syncMarkerOverlay(): void {
  if (!angled) return;
  const wrapRect = canvasWrap.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  if (wrapRect.width <= 0 || canvasRect.width <= 0) return;

  // 把 canvas 实际显示区域映射回未缩放坐标系，使行列标签严丝合缝贴在真实格边
  const offLeft = (canvasRect.left - wrapRect.left) / zoom;
  const offTop = (canvasRect.top - wrapRect.top) / zoom;
  const cw = canvasRect.width / zoom;
  const ch = canvasRect.height / zoom;
  const invZoom = Math.max(0.45, Math.min(1, 1 / Math.sqrt(zoom)));

  for (const tag of tagRefs) {
    const [rx, ry] = angled.marker(tag.x, tag.y, 1, tag.lift);
    tag.el.style.left = `${offLeft + rx * cw}px`;
    tag.el.style.top = `${offTop + ry * ch}px`;
    tag.el.style.setProperty('--inv-zoom', invZoom.toFixed(3));
    if (tag.styleKey) {
      tag.el.classList.toggle('is-dimmed', focusMode !== 'ALL' && focusMode !== tag.styleKey);
    }
  }
}

function applyStageTransform(): void {
  if (zoom <= 1) {
    panX = 0;
    panY = 0;
  } else {
    const maxPanX = viewport.clientWidth * (zoom - 1) * 0.52;
    const maxPanY = viewport.clientHeight * (zoom - 1) * 0.52;
    panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
    panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
  }
  stage.style.transform = `translate(${panX.toFixed(1)}px, ${panY.toFixed(1)}px) scale(${zoom})`;
  viewport.classList.toggle('can-pan', zoom > 1);
  syncMarkerOverlay();
}

function redraw(): void {
  currentState = buildComparisonState(teamMode, focusMode);
  const view = playerView(currentState, 'A', true);
  if (selectedUnitId && !currentState.units.some((u) => u.id === selectedUnitId)) {
    selectedUnitId = null;
  }
  const me: PlayerId = teamMode === 'DIM' || teamMode === 'VS' ? 'A' : teamMode;
  angled?.draw(view, {
    selectedId: selectedUnitId,
    selectedCityId: null,
    reach: [],
    targets: [],
    siegeTargets: [],
    placeable: [],
    threat: [],
    me,
  });
  syncMarkerOverlay();
}

function syncControls(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-zoom]')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.zoom) === zoom));
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-team]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.team === teamMode));
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-focus]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.focus === focusMode));
  }
  for (const card of document.querySelectorAll<HTMLButtonElement>('[data-focus-card]')) {
    card.setAttribute('aria-pressed', String(card.dataset.focusCard === focusMode));
  }
}

function setFocus(next: FocusMode): void {
  focusMode = next;
  syncControls();
  redraw();
}

// 控件事件绑定
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-zoom]')) {
  btn.addEventListener('click', () => {
    zoom = Number(btn.dataset.zoom);
    syncControls();
    applyStageTransform();
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-team]')) {
  btn.addEventListener('click', () => {
    teamMode = btn.dataset.team as TeamMode;
    syncControls();
    redraw();
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-focus]')) {
  btn.addEventListener('click', () => {
    setFocus(btn.dataset.focus as FocusMode);
  });
}
for (const card of document.querySelectorAll<HTMLButtonElement>('[data-focus-card]')) {
  card.addEventListener('click', () => {
    const key = card.dataset.focusCard as MilitiaStyleKey;
    setFocus(focusMode === key ? 'ALL' : key);
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-cam]')) {
  btn.addEventListener('click', () => {
    if (!angled) return;
    const action = btn.dataset.cam;
    if (action === 'reset') {
      angled.resetCamera();
      panX = 0;
      panY = 0;
      applyStageTransform();
    } else {
      const cur = angled.getCamera();
      const delta = action === 'left' ? -Math.PI / 4 : Math.PI / 4;
      angled.setCamera({ yaw: cur.yaw + delta });
      syncMarkerOverlay();
    }
  });
}

// 交互：右键/中键 360° 旋转视角；放大后左键拖拽平移；点击兵偶切换选中态
let dragMode: null | {
  kind: 'orbit' | 'pan';
  id: number;
  x: number;
  y: number;
  yaw: number;
  tilt: number;
  panX: number;
  panY: number;
  moved: boolean;
} = null;
let orbitRaf = 0;
let pendingCam: { yaw: number; tilt: number } | null = null;

viewport.addEventListener('contextmenu', (e) => e.preventDefault());
viewport.addEventListener('mousedown', (e) => {
  if (e.button === 1) e.preventDefault();
});

viewport.addEventListener('pointerdown', (e) => {
  if (!angled) return;
  if (e.button === 1 || e.button === 2) {
    e.preventDefault();
    const cur = angled.getCamera();
    dragMode = {
      kind: 'orbit',
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      yaw: cur.yaw,
      tilt: cur.tilt,
      panX,
      panY,
      moved: false,
    };
    viewport.setPointerCapture?.(e.pointerId);
    viewport.classList.add('is-panning');
  } else if (e.button === 0 && zoom > 1) {
    dragMode = {
      kind: 'pan',
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      yaw: 0,
      tilt: 0,
      panX,
      panY,
      moved: false,
    };
    viewport.setPointerCapture?.(e.pointerId);
    viewport.classList.add('is-panning');
  }
});

viewport.addEventListener('pointermove', (e) => {
  if (!dragMode || e.pointerId !== dragMode.id || !angled) return;
  const dx = e.clientX - dragMode.x;
  const dy = e.clientY - dragMode.y;
  if (!dragMode.moved && Math.abs(dx) + Math.abs(dy) >= 4) dragMode.moved = true;

  if (dragMode.kind === 'orbit') {
    pendingCam = {
      yaw: dragMode.yaw - dx * 0.0052,
      tilt: dragMode.tilt + dy * 0.0026,
    };
    if (!orbitRaf) {
      orbitRaf = requestAnimationFrame(() => {
        orbitRaf = 0;
        if (pendingCam) {
          angled.setCamera(pendingCam);
          pendingCam = null;
          syncMarkerOverlay();
        }
      });
    }
  } else {
    panX = dragMode.panX + dx;
    panY = dragMode.panY + dy;
    applyStageTransform();
  }
});

const endDrag = (e: PointerEvent): void => {
  if (!dragMode || e.pointerId !== dragMode.id) return;
  const wasMoved = dragMode.moved;
  dragMode = null;
  viewport.classList.remove('is-panning');
  if (viewport.hasPointerCapture?.(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
  if (!wasMoved && e.button === 0) {
    pickUnitAt(e.clientX, e.clientY);
  }
};
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

canvas.addEventListener('click', (e) => {
  if (zoom > 1) return; // 放大状态下由 pointerup 统一判定是否为轻点
  pickUnitAt(e.clientX, e.clientY);
});

function pickUnitAt(clientX: number, clientY: number): void {
  if (!angled) return;
  const cell = angled.pick(clientX, clientY);
  if (!cell) {
    if (selectedUnitId) {
      selectedUnitId = null;
      inspectPill.textContent = '点击地图任意民兵可查看选中态 · 共 4 风格 × 4 真实地形（平原 / 森林 / 丘陵 / 台地）';
      redraw();
    }
    return;
  }
  const hit = currentState.units.find((u) => u.x === cell.x && u.y === cell.y);
  if (!hit) return;
  selectedUnitId = selectedUnitId === hit.id ? null : hit.id;
  if (selectedUnitId) {
    const row = STYLE_ROWS.find((r) => r.typeId === hit.type);
    const col = TERRAIN_COLS.find((c) => c.unitX === hit.x);
    inspectPill.textContent = `已选中：${row?.label ?? hit.type} · ${col?.label ?? ''}（再次点击取消选中）`;
  } else {
    inspectPill.textContent = '点击地图任意民兵可查看选中态 · 共 4 风格 × 4 真实地形（平原 / 森林 / 丘陵 / 台地）';
  }
  redraw();
}

buildTags();
syncControls();
redraw();
applyStageTransform();
new ResizeObserver(() => applyStageTransform()).observe(viewport);
