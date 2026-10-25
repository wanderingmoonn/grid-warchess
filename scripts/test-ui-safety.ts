/** Imported names and IDs must remain text, including inside quoted attributes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { playerView } from '../src/core/fog.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { renderBoard } from '../src/ui/board.ts';
import { renderPanel } from '../src/ui/panel.ts';
import { openSetupPanel } from '../src/ui/setup-panel.ts';

const payload = '<img src="missing" onerror="alert(1)"><svg onload="alert(2)"> & "\'';
const attributePayload = 'unit" data-injected="true';

function assertTextOnly(root: HTMLElement): void {
  assert.equal(root.querySelector('img, svg, script, [onerror], [onload], [data-injected]'), null);
}

test('board names, icons, ghosts and entity IDs render as text', () => {
  const { window } = new JSDOM('<div id="board"></div>');
  const root = window.document.querySelector<HTMLElement>('#board')!;
  const state = createMatch(DEFAULT_CONFIG, 20261025);
  const unit = state.units[0]!;
  unit.id = attributePayload;
  state.cities[0]!.id = attributePayload;
  state.players.A.name = payload;
  state.unitTypes[unit.type]!.name = payload;
  state.unitTypes[unit.type]!.short = payload;
  const view = playerView(state, 'A', true);
  view.ghosts = [{ id: 'ghost', type: unit.type, x: 0, y: 0, seenAt: 1 }];
  renderBoard(root, view, { selectedId: null, selectedCityId: null, reach: [], targets: [], siegeTargets: [], placeable: [], threat: [] });
  assertTextOnly(root);
  assert.ok(root.textContent?.includes(payload));
  assert.equal(root.querySelector<HTMLElement>('.unit')?.dataset.id, attributePayload);
  assert.equal(root.querySelector<HTMLElement>('.city-block')?.dataset.cityId, attributePayload);
  assert.ok(root.querySelector('.unit')?.getAttribute('title')?.includes(payload));
  window.close();
});

test('panel escapes players, units, build descriptions, production lists and logs', () => {
  const { window } = new JSDOM('<div id="panel"></div>');
  const root = window.document.querySelector<HTMLElement>('#panel')!;
  const state = createMatch(DEFAULT_CONFIG, 20261025);
  state.players.A.name = payload;
  state.players.B.name = payload;
  for (const def of Object.values(state.unitTypes)) { def.name = payload; def.short = payload; }
  state.log.push({ turn: state.turn, player: 'B', text: payload });
  const unit = state.units[0]!;
  state.unitTypes[unit.type]!.builds = [Object.values(state.unitTypes).find((def) => def.category === 'building')!.id];
  const view = playerView(state, 'A', true);
  const base = { view, me: 'A' as const, selectedUnit: null, selectedCityId: null, selectedCampId: null, selectedTile: null };
  renderPanel(root, { ...base, selectedUnit: view.state.units[0]! });
  assertTextOnly(root);
  assert.equal(root.querySelector('.unit-title')?.textContent, payload);
  assert.ok(root.querySelector('.unit-notes')?.textContent?.includes(payload));
  assert.ok(root.querySelector('.log')?.textContent?.includes(payload));
  renderPanel(root, { ...base, selectedCityId: state.cities[0]!.id });
  assertTextOnly(root);
  assert.ok(root.querySelector('.recruit-btn')?.textContent?.includes(payload));
  window.close();
});

test('setup panel displays imported custom names without creating elements', async () => {
  const { window } = new JSDOM('<body></body>', { url: 'http://localhost' });
  const names = ['document', 'HTMLElement', 'localStorage'] as const;
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: window[name] });
  try {
    const state = createMatch(DEFAULT_CONFIG, 20261025);
    const def = { ...state.unitTypes[state.units[0]!.type]!, id: 'c_injected', name: payload, short: payload };
    window.localStorage.setItem('warchess:custom-units:v1', JSON.stringify({ [def.id]: def }));
    const closed = openSetupPanel(DEFAULT_CONFIG, 20261025);
    assertTextOnly(window.document.body);
    const chip = window.document.querySelector<HTMLElement>('[data-unit="c_injected"]');
    assert.ok(chip?.textContent?.includes(payload));
    window.document.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.click();
    assert.equal(await closed, null);
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    window.close();
  }
});
