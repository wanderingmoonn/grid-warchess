import { playerView } from '../core/fog.ts';
import { createAngledBoard } from '../ui/angled-board.ts';
import { renderBoard } from '../ui/board.ts';
import { boardAngleFixture, type BoardAngleScene } from './board-angle-fixture.ts';

const params = new URLSearchParams(location.search);
const size: 16 | 32 = params.get('size') === '16' ? 16 : 32;
const rawScene = params.get('scene');
let currentScene: BoardAngleScene =
  rawScene === 'river' || rawScene === 'lake' || rawScene === 'sea' || rawScene === 'all' ? rawScene : 'all';

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
  all: '河·湖·海全览',
  river: '大河渡口',
  lake: '青山明湖',
  sea: '群岛深海',
};

function renderScene(scene: BoardAngleScene): void {
  currentScene = scene;
  currentView = playerView(boardAngleFixture(size, scene), 'A', true);
  for (const label of preview.querySelectorAll('[data-map-size]')) {
    label.textContent = `${sceneLabels[scene]} · ${size} × ${size}`;
  }
  for (const button of sceneButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.scene === scene));
  }
  showFlat();
  angled?.draw(currentView);
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
