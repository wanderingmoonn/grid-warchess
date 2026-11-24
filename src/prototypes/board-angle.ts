import { playerView } from '../core/fog.ts';
import { createAngledBoard } from '../ui/angled-board.ts';
import { renderBoard } from '../ui/board.ts';
import { boardAngleFixture, type BoardAngleScene } from './board-angle-fixture.ts';

const params = new URLSearchParams(location.search);
const size: 16 | 32 = params.get('size') === '16' ? 16 : 32;
const rawScene = params.get('scene');
let currentScene: BoardAngleScene =
  rawScene === 'militia' || rawScene === 'elevation' || rawScene === 'damage2' || rawScene === 'damage' || rawScene === 'future' || rawScene === 'cities' || rawScene === 'river' || rawScene === 'lake' || rawScene === 'sea' || rawScene === 'all'
    ? rawScene
    : 'all';

const flatBoard = document.querySelector<HTMLElement>('#flat-board')!;
const canvas = document.querySelector<HTMLCanvasElement>('#tilted-board')!;
const angled = createAngledBoard(canvas, new URL('../../', document.baseURI).href);

let currentView = playerView(boardAngleFixture(size, currentScene), 'A', true);

function showFlat(): void {
  if (flatBoard.offsetWidth === 0) return;
  renderBoard(flatBoard, currentView, {
    selectedId: null, selectedCityId: null, reach: [], targets: [], siegeTargets: [], placeable: [], threat: [],
  });
}

const preview = document.querySelector<HTMLElement>('.angle-preview')!;
const angleButtons = [...preview.querySelectorAll<HTMLButtonElement>('[data-angle]')];
const sceneButtons = [...preview.querySelectorAll<HTMLButtonElement>('[data-scene]')];

const sceneLabels: Record<BoardAngleScene, string> = {
  militia: '民兵微缩兵偶（四阵营 · 多地形 · 多状态）',
  elevation: '地形高差（台地 / 谷地 / 沼泽）',
  damage2: '六至八代四档受损（常态/受损/重创/废墟）',
  damage: '一至五代四档受损（常态/受损/重创/废墟）',
  future: '时代五至八（现代→未来）',
  cities: '全八时代城市演进',
  all: '河·湖·海全览',
  river: '大河渡口',
  lake: '青山明湖',
  sea: '群岛深海',
};

function renderScene(scene: BoardAngleScene): void {
  currentScene = scene;
  currentView = playerView(boardAngleFixture(size, scene), 'A', true);
  for (const label of preview.querySelectorAll('[data-map-size]')) {
    label.textContent = `${sceneLabels[scene]} · ${currentView.state.w} × ${currentView.state.h}`;
  }
  for (const button of sceneButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.scene === scene));
  }
  showFlat();
  const ui = scene === 'militia'
    ? {
        selectedId: 'preview-unit-0',
        selectedCityId: null,
        reach: [],
        targets: ['preview-unit-6'],
        siegeTargets: [],
        placeable: [],
        threat: [],
        me: 'A' as const,
      }
    : undefined;
  angled?.draw(currentView, ui);
}

function showView(view: string): void {
  preview.dataset.view = view;
  for (const button of angleButtons) button.setAttribute('aria-pressed', String(button.dataset.angle === view));
  showFlat();
}

for (const button of angleButtons) {
  button.addEventListener('click', () => showView(button.dataset.angle!));
}
for (const button of sceneButtons) {
  button.addEventListener('click', () => renderScene(button.dataset.scene as BoardAngleScene));
}

renderScene(currentScene);
showView(matchMedia('(max-width: 740px)').matches ? 'tilted' : 'compare');
new ResizeObserver(showFlat).observe(flatBoard);

// 支持原型页也按住鼠标中键旋转/调节斜俯视视角，双击中键复位
if (angled) {
  let orbit: { id: number; x: number; y: number; yaw: number; tilt: number; moved: boolean } | null = null;
  let lastMidAt = 0;
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  canvas.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const cur = angled.getCamera();
    orbit = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: cur.yaw, tilt: cur.tilt, moved: false };
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!orbit || e.pointerId !== orbit.id) return;
    const dx = e.clientX - orbit.x;
    const dy = e.clientY - orbit.y;
    if (!orbit.moved && Math.abs(dx) + Math.abs(dy) >= 3) orbit.moved = true;
    angled.setCamera({ yaw: orbit.yaw - dx * 0.0052, tilt: orbit.tilt + dy * 0.0026 });
    e.preventDefault();
  });
  const endOrbit = (e: PointerEvent): void => {
    if (!orbit || e.pointerId !== orbit.id) return;
    const wasMoved = orbit.moved;
    orbit = null;
    canvas.style.cursor = '';
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!wasMoved) {
      const now = performance.now();
      if (now - lastMidAt < 380) {
        angled.resetCamera();
        lastMidAt = 0;
      } else {
        lastMidAt = now;
      }
    }
  };
  canvas.addEventListener('pointerup', endOrbit);
  canvas.addEventListener('pointercancel', endOrbit);
}
