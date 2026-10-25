/** Rule policy shown to players, including actual saved-state boot paths. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { CONFIG, ORDER_UPGRADE } from '../src/core/config.ts';
import { playerView } from '../src/core/fog.ts';
import { applyAction } from '../src/core/rules.ts';
import { productionOf } from '../src/core/rules/production.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { Action, GameState } from '../src/core/types.ts';
import { exportMatch, importMatch } from '../src/storage/save.ts';
import { renderPanel } from '../src/ui/panel.ts';
import { estimateCommanderGold } from '../src/app/commander.ts';
import { roundStatus } from '../src/app/match-status.ts';

function match(): GameState {
  return createMatch({ ...DEFAULT_CONFIG, commanderMode: true, expansionIds: [], aiOpponent: false }, 42);
}

function apply(state: GameState, action: Action): GameState {
  const result = applyAction(state, action);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.state;
}

function panel(state: GameState, city = state.cities.find((c) => c.owner === state.current)?.id): JSDOM {
  const dom = new JSDOM('<div id="panel"></div>');
  renderPanel(dom.window.document.querySelector('#panel')!, {
    view: playerView(state, state.current, true), me: state.current,
    selectedUnit: null, selectedCityId: city ?? null, selectedCampId: null, selectedTile: null,
  });
  return dom;
}

test('轮数显示双方各行动一次为一轮，最后一轮仍有后手机会', () => {
  let state = match();
  state.turn = CONFIG.maxRounds * 2 - 1;
  state.turnProduction = { turn: state.turn, player: 'A', recruited: 0, upgraded: 0 };
  for (const side of ['A', 'B']) {
    const dom = panel(state);
    try {
      assert.equal(state.current, side);
      assert.equal(state.winner, null);
      assert.match(dom.window.document.querySelector('[data-round-status]')!.textContent!, /第 100 \/ 100 轮/);
      assert.match(dom.window.document.querySelector('[data-round-status]')!.textContent!, /剩余 1 轮/);
      assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-act="end-turn"]')!.disabled, false);
    } finally { dom.window.close(); }
    state = apply(state, { type: 'END_TURN' });
  }
  assert.equal(state.winner, 'draw');
});

test('平局显示城市比较与原因，全部生产和结束按钮停用', () => {
  let state = match();
  state.turn = CONFIG.maxRounds * 2;
  state.current = 'B';
  state.turnProduction = { turn: state.turn, player: 'B', recruited: 0, upgraded: 0 };
  state = apply(state, { type: 'END_TURN' });
  const dom = panel(state);
  try {
    const result = dom.window.document.querySelector('[data-game-result]')!;
    assert.match(result.textContent!, /平局/);
    assert.match(result.textContent!, /2∶2/);
    assert.match(result.textContent!, /100 轮/);
    assert.equal(dom.window.document.querySelector('[data-act="recruit"], [data-act="upgrade"]'), null);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-act="end-turn"]')!.disabled, true);
  } finally { dom.window.close(); }
});

test('超过新上限的旧对局显示实际完成轮数', () => {
  let state = match();
  state.turn = 246;
  state.current = 'B';
  state.turnProduction = { turn: 246, player: 'B', recruited: 0, upgraded: 0 };
  state = apply(state, { type: 'END_TURN' });
  assert.match(roundStatus(state), /第 123 轮（上限 100 轮）/);
  assert.match(roundStatus(state), /已完成 123 轮/);
});

test('轮数裁决的获胜方与城市比分显示一致，名称仍安全转义', () => {
  let state = match();
  state.turn = CONFIG.maxRounds * 2;
  state.current = 'B';
  state.turnProduction = { turn: state.turn, player: 'B', recruited: 0, upgraded: 0 };
  state.cities.find((city) => city.owner === 'B')!.owner = 'A';
  state.players.A.name = '<img onerror="alert(1)">';
  state = apply(state, { type: 'END_TURN' });
  const dom = panel(state);
  try {
    assert.equal(state.winner, 'A');
    const text = dom.window.document.querySelector('[data-game-result]')!.textContent!;
    assert.match(text, /3∶1/);
    assert.ok(text.includes(`${state.players.A.name}获胜`));
    assert.equal(dom.window.document.querySelector('img, [onerror]'), null);
  } finally { dom.window.close(); }
});

test('显式计划只启用点名兵种，产能用完后存档恢复仍禁用所有生产', () => {
  let state = match();
  state.units = [];
  state.players.A.gold = 10000;
  state = apply(state, { type: 'SET_ORDERS', queue: ['archer'] });
  let dom = panel(state);
  try {
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-act="recruit"][data-type="archer"]')!.disabled, false);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-act="recruit"][data-type="militia"]')!.disabled, true);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-act="upgrade"]')!.disabled, true);
  } finally { dom.window.close(); }
  state = apply(state, { type: 'RECRUIT', cityId: state.cities[0]!.id, unitType: 'archer' });
  state = importMatch(exportMatch(state))!;
  dom = panel(state);
  try {
    assert.match(dom.window.document.querySelector('[data-production-status]')!.textContent!, /产能已用/);
    assert.ok([...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-act="recruit"], [data-act="upgrade"]')].every((b) => b.disabled));
    const gold = estimateCommanderGold(state, 'A');
    assert.equal(gold[0], state.players.A.gold);
    assert.ok(gold[1]! > gold[0]!, '已花过的队首费用不能重复从后续预算扣款');
  } finally { dom.window.close(); }
});

test('升级计划禁用招募，空计划同时禁用招募与升级', () => {
  let state = match();
  state.units = [];
  state.players.A.gold = 10000;
  state = apply(state, { type: 'SET_ORDERS', queue: [ORDER_UPGRADE] });
  let dom = panel(state);
  try {
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-act="upgrade"]')!.disabled, false);
    assert.ok([...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-act="recruit"]')].every((b) => b.disabled));
  } finally { dom.window.close(); }
  state = apply(state, { type: 'SET_ORDERS', queue: [] });
  dom = panel(state);
  try {
    assert.ok([...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-act="recruit"], [data-act="upgrade"]')].every((b) => b.disabled));
  } finally { dom.window.close(); }
});

let bundle: Promise<string> | undefined;
async function page(state: GameState): Promise<JSDOM> {
  bundle ??= build({ entryPoints: ['src/main.ts'], bundle: true, format: 'iife', write: false,
    loader: { '.css': 'text' }, target: 'es2022', logLevel: 'silent',
  }).then((result) => result.outputFiles[0]!.text);
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  (dom.window as unknown as { structuredClone: typeof structuredClone }).structuredClone = structuredClone;
  dom.window.localStorage.setItem('warchess:match:v1', JSON.stringify(state));
  dom.window.eval(await bundle);
  return dom;
}

test('页面从 v5 保存恢复产能并禁用本回合队首，后续计划仍可编辑', async () => {
  let state = match();
  state.units = [];
  state = apply(state, { type: 'SET_ORDERS', queue: ['archer', 'militia'] });
  state = apply(state, { type: 'RECRUIT', cityId: state.cities[0]!.id, unitType: 'archer' });
  const dom = await page(state);
  try {
    const saved = JSON.parse(dom.window.localStorage.getItem('warchess:match:v1')!) as GameState;
    assert.equal(saved.seed, state.seed, '启动不能丢弃新版本存档重新开局');
    assert.equal(productionOf(saved).recruited, 1);
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>('[data-slot="0"]')!.disabled, true);
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>('[data-slot="1"]')!.disabled, false);
    assert.match(dom.window.document.querySelector('[data-cmd-production]')!.textContent!, /产能已用/);
  } finally { dom.window.close(); }
});

test('旧指挥官存档迁移显示封存提示，结束并交还回合后产能恢复', async () => {
  let state = match();
  state.version = 4;
  delete state.turnProduction;
  const dom = await page(state);
  try {
    state = JSON.parse(dom.window.localStorage.getItem('warchess:match:v1')!) as GameState;
    assert.equal(state.version, 5);
    assert.match(dom.window.document.querySelector('[data-production-status]')!.textContent!, /旧存档.*封存/);
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>('[data-slot="0"]')!.disabled, true);
  } finally { dom.window.close(); }
  state = apply(apply(state, { type: 'END_TURN' }), { type: 'END_TURN' });
  assert.equal(productionOf(state).recruited, 0);
  assert.equal(productionOf(state).legacyLocked, undefined);
});
