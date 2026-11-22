import { playerView } from '../core/fog.ts';
import { createAngledBoard } from '../ui/angled-board.ts';
import { renderBoard } from '../ui/board.ts';
import { boardAngleFixture } from './board-angle-fixture.ts';

const size = new URLSearchParams(location.search).get('size') === '16' ? 16 : 32;
const match = boardAngleFixture(size);
const view = playerView(match, 'A', true);

const flatBoard = document.querySelector<HTMLElement>('#flat-board')!;
function showFlat(): void {
  if (flatBoard.offsetWidth === 0) return;
  renderBoard(flatBoard, view, {
    selectedId: null, selectedCityId: null, reach: [], targets: [], siegeTargets: [], placeable: [], threat: [],
  });
}

const canvas = document.querySelector<HTMLCanvasElement>('#tilted-board')!;
createAngledBoard(canvas, new URL('../../', document.baseURI).href)?.draw(view);

const preview = document.querySelector<HTMLElement>('.angle-preview')!;
for (const label of preview.querySelectorAll('[data-map-size]')) label.textContent = `${size} × ${size}`;
const buttons = [...preview.querySelectorAll<HTMLButtonElement>('[data-angle]')];
function showView(view: string): void {
  preview.dataset.view = view;
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.angle === view));
  showFlat();
}

for (const button of buttons) {
  button.addEventListener('click', () => showView(button.dataset.angle!));
}
showView(matchMedia('(max-width: 740px)').matches ? 'tilted' : 'compare');
new ResizeObserver(showFlat).observe(flatBoard);
