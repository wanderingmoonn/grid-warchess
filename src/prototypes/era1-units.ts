import type { FixedMap } from '../core/fixed-maps.ts';
import { playerView } from '../core/fog.ts';
import { createMatch, DEFAULT_CONFIG } from '../core/setup.ts';
import type { GameState, PlayerId, Terrain, Unit } from '../core/types.ts';
import { createAngledBoard } from '../ui/angled-board.ts';

type TeamMode = PlayerId | 'DIM' | 'VS';

interface ShowcaseSlot {
  typeId: string;
  label: string;
  x: number;
  y: number;
  side: 'A' | 'B';
}

const SLOTS: ReadonlyArray<ShowcaseSlot> = [
  // 第 1 排（y=2）：四大时代 1 陆战兵种（平原 -> 森林 -> 丘陵 -> 台地）
  { typeId: 'militia', label: '民兵 25金', x: 2, y: 2, side: 'A' },
  { typeId: 'ge', label: '戈兵 30金', x: 5, y: 2, side: 'A' },
  { typeId: 'archer', label: '弓手 35金', x: 8, y: 2, side: 'B' },
  { typeId: 'scout', label: '斥候 50金', x: 11, y: 2, side: 'B' },

  // 第 2 排（y=5）：经济与工兵单位（农民平原 / 牧民丘陵 / 奴隶台地）
  { typeId: 'farmer', label: '农民 45金', x: 2, y: 5, side: 'A' },
  { typeId: 'herder', label: '牧民 45金', x: 7, y: 5, side: 'A' },
  { typeId: 'laborer', label: '奴隶 50金', x: 11, y: 5, side: 'B' },

  // 第 3 排（y=8）：野外防御、经济与产兵建筑（磨坊平原 / 军营丘陵 / 箭塔台地）
  { typeId: 'mill', label: '磨坊 65金', x: 2, y: 8, side: 'A' },
  { typeId: 'camp', label: '军营 90金', x: 7, y: 8, side: 'A' },
  { typeId: 'tower', label: '箭塔 55金', x: 11, y: 8, side: 'B' },

  // 第 4 排（y=12）：宽阔河道中的水上单位与木桥建筑（舢板 / 渡船 / 木桥）
  { typeId: 'boat', label: '舢板 45金', x: 4, y: 12, side: 'A' },
  { typeId: 'ferry', label: '渡船 60金', x: 7, y: 12, side: 'B' },
  { typeId: 'bridge', label: '木桥 45金', x: 10, y: 12, side: 'A' },
];

const GROUP_TAGS: ReadonlyArray<{ label: string; x: number; y: number; lift: number }> = [
  { label: '陆战兵种', x: 0.15, y: 2, lift: 5 },
  { label: '经济 / 工兵', x: 0.15, y: 5, lift: 5 },
  { label: '野外建筑', x: 0.15, y: 8, lift: 5 },
  { label: '水上 / 架桥', x: 0.15, y: 12, lift: 3 },
];

const MAP_W = 16;
const MAP_H = 16;

function cellChar(x: number, y: number): string {
  // 东北角高山点缀
  if ((x === 14 && y <= 1) || (x === 15 && y <= 2)) return '^';
  if ((x === 13 && y <= 1) || (x === 14 && y === 2) || (x === 15 && y === 3)) return 'h';

  // 南侧宽阔河道（y = 11..13, x = 2..12）供舢板、渡船、木桥展示
  if (y >= 11 && y <= 13 && x >= 2 && x <= 12) {
    if (y === 11 || y === 13) return 's';
    return '~';
  }

  // 主展示区（y = 1..9）真实地形分区：平原(1..3) · 森林(4..5) · 丘陵(6..9) · 台地(10..12)
  if (y >= 1 && y <= 9) {
    if (x >= 4 && x <= 5 && y <= 6) return 'f';
    if (x >= 6 && x <= 9) return 'h';
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

function buildEra1State(teamMode: TeamMode): GameState {
  const map: FixedMap = {
    id: 'prototype-era1-all-units',
    name: '时代 1 全单位实机总览',
    w: MAP_W,
    h: MAP_H,
    rows: Array.from({ length: MAP_H }, (_, y) =>
      Array.from({ length: MAP_W }, (_, x) => cellChar(x, y)).join('')),
    citiesA: [{ x: 1, y: 14 }],
    citiesB: [{ x: 13, y: 14 }],
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

  for (let y = 0; y < match.h; y++) {
    for (let x = 0; x < match.w; x++) {
      const tile = match.tiles[y * match.w + x];
      if (!tile) continue;
      tile.terrain = CHAR_TO_TERRAIN[cellChar(x, y)] ?? 'plain';
    }
  }
  match.cities.forEach((city) => {
    city.era = 1;
  });

  const units: Unit[] = SLOTS.map((slot) => {
    const def = match.unitTypes[slot.typeId]!;
    let owner: PlayerId = 'A';
    let moved = false;
    let acted = false;
    if (teamMode === 'DIM') {
      owner = 'A';
      moved = true;
      acted = true;
    } else if (teamMode === 'VS') {
      owner = slot.side;
    } else {
      owner = teamMode;
    }
    return {
      id: `era1-${slot.typeId}`,
      owner,
      type: slot.typeId,
      x: slot.x,
      y: slot.y,
      hp: def.maxHp,
      kills: 0,
      moved,
      acted,
    };
  });
  match.units = units;
  return match;
}

const viewport = document.querySelector<HTMLElement>('#viewport')!;
const stage = document.querySelector<HTMLElement>('#stage')!;
const canvasWrap = document.querySelector<HTMLElement>('#canvas-wrap')!;
const canvas = document.querySelector<HTMLCanvasElement>('#era1-board')!;
const markersEl = document.querySelector<HTMLElement>('#markers')!;
const inspectPill = document.querySelector<HTMLElement>('#inspect-pill')!;
const toggleTagsBtn = document.querySelector<HTMLButtonElement>('#toggle-tags')!;

const angled = createAngledBoard(canvas, new URL('../../', document.baseURI).href);

let zoom = 1;
let teamMode: TeamMode = 'A';
let showTags = true;
let selectedUnitId: string | null = null;
let panX = 0;
let panY = 0;
let currentState: GameState = buildEra1State(teamMode);

interface TagRef {
  el: HTMLDivElement;
  x: number;
  y: number;
  lift: number;
}
const tagRefs: TagRef[] = [];

function buildTags(): void {
  markersEl.innerHTML = '';
  tagRefs.length = 0;
  for (const g of GROUP_TAGS) {
    const el = document.createElement('div');
    el.className = 'group-tag';
    el.textContent = g.label;
    markersEl.appendChild(el);
    tagRefs.push({ el, x: g.x, y: g.y, lift: g.lift });
  }
  for (const slot of SLOTS) {
    const el = document.createElement('div');
    el.className = 'unit-tag';
    el.textContent = slot.label;
    markersEl.appendChild(el);
    const lift = slot.typeId === 'tower' ? 37 : slot.typeId === 'mill' ? 33 : slot.typeId === 'camp' ? 28 : 28;
    tagRefs.push({ el, x: slot.x, y: slot.y, lift });
  }
}

function syncMarkerOverlay(): void {
  if (!angled) return;
  const wrapRect = canvasWrap.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  if (wrapRect.width <= 0 || canvasRect.width <= 0) return;

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
  currentState = buildEra1State(teamMode);
  const view = playerView(currentState, 'A', true);
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
  toggleTagsBtn.setAttribute('aria-pressed', String(showTags));
  markersEl.classList.toggle('hidden', !showTags);
}

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
toggleTagsBtn.addEventListener('click', () => {
  showTags = !showTags;
  syncControls();
});
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
    pendingCam = { yaw: dragMode.yaw - dx * 0.0052, tilt: dragMode.tilt + dy * 0.0026 };
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
  if (!wasMoved && e.button === 0) pickUnitAt(e.clientX, e.clientY);
};
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

canvas.addEventListener('click', (e) => {
  if (zoom > 1) return;
  pickUnitAt(e.clientX, e.clientY);
});

function pickUnitAt(clientX: number, clientY: number): void {
  if (!angled) return;
  const cell = angled.pick(clientX, clientY);
  if (!cell) {
    if (selectedUnitId) {
      selectedUnitId = null;
      inspectPill.textContent = '共 13 个时代 1 单位：陆战 4 · 经济/工兵 3 · 建筑 3 · 水上/桥梁 3';
      redraw();
    }
    return;
  }
  const hit = currentState.units.find((u) => u.x === cell.x && u.y === cell.y);
  if (!hit) return;
  selectedUnitId = selectedUnitId === hit.id ? null : hit.id;
  if (selectedUnitId) {
    const def = currentState.unitTypes[hit.type]!;
    inspectPill.textContent = `已选中：${def.name}（${def.cost} 金 · 血 ${def.maxHp} · 攻 ${def.atk} · 甲 ${def.armor} · 移 ${def.move}）`;
  } else {
    inspectPill.textContent = '共 13 个时代 1 单位：陆战 4 · 经济/工兵 3 · 建筑 3 · 水上/桥梁 3';
  }
  redraw();
}

buildTags();
syncControls();
redraw();
applyStageTransform();
new ResizeObserver(() => applyStageTransform()).observe(viewport);
