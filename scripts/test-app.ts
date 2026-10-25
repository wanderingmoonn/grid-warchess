/** 应用调度回归：完整批次、取消、生产预算与联机终局，均无需浏览器或云端。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { executeAiTurn } from '../src/app/ai-turn.ts';
import {
  commanderBudget,
  commanderPlayer,
  commanderSlotCost,
  estimateCommanderGold,
  executeCommanderRounds,
} from '../src/app/commander.ts';
import { restorePendingTurn, shouldAcceptRoomState, shouldSubmitTurn } from '../src/app/room-session.ts';
import { aiNextAction, type AiBudget } from '../src/core/ai.ts';
import { CONFIG, ORDER_UPGRADE } from '../src/core/config.ts';
import { applyAction, incomeOf, ordersOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import { productionOf } from '../src/core/rules/production.ts';
import { exportMatch, importMatch } from '../src/storage/save.ts';

function match(): GameState {
  return createMatch({ ...DEFAULT_CONFIG, aiOpponent: true, commanderMode: true, expansionIds: [] }, 42);
}

function endTurn(state: GameState): GameState {
  const result = applyAction(state, { type: 'END_TURN' });
  assert.ok(result.ok);
  return result.state;
}

test('指挥官视角在敌方回合仍属于人类一方', () => {
  let state = match();
  assert.equal(commanderPlayer(state), 'A');
  state = endTurn(state);
  assert.equal(state.current, 'B');
  assert.equal(commanderPlayer(state), 'A');
  state.aiControl = { A: true, B: false };
  assert.equal(commanderPlayer(state), 'B');
});

test('五轮批次完成十个玩家回合，五条计划只用于指挥方', async () => {
  let state = match();
  const initialTurn = state.turn;
  const unit = Object.values(state.unitTypes).find((def) => def.category === 'combat')!.id;
  const queue = [unit, '', ORDER_UPGRADE, unit, ''];
  const set = applyAction(state, { type: 'SET_ORDERS', queue });
  assert.ok(set.ok);
  state = set.state;
  const calls: { player: PlayerId; budget?: Partial<AiBudget> }[] = [];
  const progress: number[] = [];
  const completed = await executeCommanderRounds({
    getState: () => state,
    active: () => true,
    progress: (round) => { progress.push(round); },
    runTurn: async (budget) => {
      calls.push({ player: state.current, budget });
      state = endTurn(state);
      return true;
    },
  }, 'A');
  assert.equal(completed, true);
  assert.equal(state.turn, initialTurn + 10);
  assert.equal(state.current, 'A');
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  assert.deepEqual(calls.map((call) => call.player), ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
  assert.ok(calls.filter((call) => call.player === 'B').every((call) => call.budget === undefined));
  assert.equal(calls[0]!.budget!.order, unit);
  assert.equal(calls[2]!.budget!.maxRecruit, 0);
  assert.equal(calls[4]!.budget!.maxUpgrade, 1);
  assert.deepEqual(ordersOf(state, 'A'), []);
  assert.deepEqual(ordersOf(state, 'B'), []);
});

test('中断批次不会自动继续对手回合或报告完成', async () => {
  let state = match();
  let active = true;
  let calls = 0;
  const completed = await executeCommanderRounds({
    getState: () => state,
    active: () => active,
    progress: () => {},
    runTurn: async () => {
      calls += 1;
      state = endTurn(state);
      active = false;
      return true;
    },
  }, 'A');
  assert.equal(completed, false);
  assert.equal(calls, 1);
  assert.equal(state.current, 'B');
});

test('中断在对手回合时，下次先完成对手再推进新的批次', async () => {
  let state = endTurn(match());
  const sides: PlayerId[] = [];
  const completed = await executeCommanderRounds({
    getState: () => state,
    active: () => true,
    progress: () => {},
    runTurn: async () => {
      sides.push(state.current);
      state = endTurn(state);
      return true;
    },
  }, 'A', 1);
  assert.equal(completed, true);
  assert.deepEqual(sides, ['B', 'A', 'B']);
  assert.equal(state.current, 'A');
});

test('批次遇到胜负即停止，不驱动下一方', async () => {
  let state = match();
  let calls = 0;
  const completed = await executeCommanderRounds({
    getState: () => state,
    active: () => true,
    progress: () => {},
    runTurn: async () => {
      calls += 1;
      state = { ...state, winner: 'A' };
      return true;
    },
  }, 'A');
  assert.equal(completed, false);
  assert.equal(calls, 1);
});

test('空命令和升级命令分别限制招募与升级权限', () => {
  const state = match();
  assert.deepEqual(commanderBudget(state, 'A'), { maxRecruit: 0, maxUpgrade: 0, order: null });
  state.orders = { A: [ORDER_UPGRADE] };
  assert.deepEqual(commanderBudget(state, 'A'), { maxRecruit: 0, maxUpgrade: 1, order: null });
});

test('招募失败的计划不从后续金币估算中扣款', () => {
  const state = match();
  const expensive = Object.values(state.unitTypes).find((def) => def.category === 'combat' && def.cost > 100)!;
  state.players.A.gold = 0;
  state.orders = { A: [expensive.id] };
  const gold = estimateCommanderGold(state, 'A');
  assert.equal(gold.length, CONFIG.commanderSlots);
  assert.equal(gold[0], 0);
  assert.equal(gold[1], incomeOf(state, 'A'));
  assert.equal(commanderSlotCost(state, 'A', ''), 0);
});

test('AI 取消后保存最后动作，不在睡眠返回后结束回合', async () => {
  let state = match();
  const turn = state.turn;
  let active = true;
  let saved: GameState | null = null;
  let writes = 0;
  const completed = await executeAiTurn({
    getState: () => state,
    setState: (next) => { state = next; writes += 1; },
    active: () => active,
    save: () => { saved = state; },
    render: () => {},
    sleep: async () => { active = false; },
  }, { maxRecruit: 0, maxUpgrade: 0 }, 0);
  assert.equal(completed, false);
  assert.ok(writes > 0);
  assert.equal(saved, state);
  assert.equal(state.turn, turn);
});

test('AI 等待期间换局，旧任务不能写入新局', async () => {
  let state = match();
  const replacement = createMatch(DEFAULT_CONFIG, 99);
  let active = true;
  let writesAfterReplace = 0;
  await executeAiTurn({
    getState: () => state,
    setState: (next) => {
      if (!active) writesAfterReplace += 1;
      state = next;
    },
    active: () => active,
    save: () => {},
    render: () => {},
    sleep: async () => { state = replacement; active = false; },
  }, { maxRecruit: 0, maxUpgrade: 0 }, 0);
  assert.equal(state, replacement);
  assert.equal(writesAfterReplace, 0);
});

test('真实生产额度跨导出和恢复保留，只在交接回合或新局重置', () => {
  const state = match();
  state.units = [];
  const recruited = applyAction(state, { type: 'RECRUIT', cityId: state.cities[0]!.id, unitType: 'militia' });
  assert.ok(recruited.ok);
  const restored = importMatch(exportMatch(recruited.state));
  assert.ok(restored);
  assert.equal(productionOf(restored).recruited, 1);
  const copy = productionOf(restored);
  copy.recruited = 0;
  assert.equal(productionOf(restored).recruited, 1, '查询副本不应能改掉实际消费');
  assert.equal(productionOf(endTurn(restored)).recruited, 0);
  assert.equal(productionOf(match()).recruited, 0);
});

test('指挥官已招募后改成升级计划，不能在同一回合额外升级', async () => {
  let state = match();
  state.units = [];
  state.players.A.gold = 10000;
  const eras = state.cities.map((city) => city.era);
  const recruited = applyAction(state, { type: 'RECRUIT', cityId: state.cities[0]!.id, unitType: 'militia' });
  assert.ok(recruited.ok);
  state = importMatch(exportMatch(recruited.state))!;
  const plan = applyAction(state, { type: 'SET_ORDERS', queue: [ORDER_UPGRADE] });
  assert.ok(plan.ok);
  state = plan.state;
  await executeAiTurn({
    getState: () => state,
    setState: (next) => { state = next; },
    active: () => true,
    save: () => {},
    render: () => {},
    sleep: async () => {},
  }, { maxRecruit: 0, maxUpgrade: 1, order: null }, 0);
  assert.deepEqual(state.cities.map((city) => city.era), eras);
});

test('指挥官已升级后改成招募计划，不能在同一回合额外招募', async () => {
  let state = match();
  state.units = [];
  state.players.A.gold = 10000;
  const upgraded = applyAction(state, { type: 'UPGRADE', cityId: state.cities[0]!.id });
  assert.ok(upgraded.ok);
  state = importMatch(exportMatch(upgraded.state))!;
  const order = Object.values(state.unitTypes).find((def) => def.era === 1 && def.category === 'combat')!.id;
  const plan = applyAction(state, { type: 'SET_ORDERS', queue: [order] });
  assert.ok(plan.ok);
  state = plan.state;
  await executeAiTurn({
    getState: () => state,
    setState: (next) => { state = next; },
    active: () => true,
    save: () => {},
    render: () => {},
    sleep: async () => {},
  }, { maxRecruit: 1, maxUpgrade: 0, order }, 0);
  assert.equal(state.units.length, 0);
});

test('AI 从状态读取生产计划，调用方预算不能换掉点名的兵种', () => {
  let state = match();
  state.units = [];
  state.players.A.gold = 10000;
  const planned = applyAction(state, { type: 'SET_ORDERS', queue: ['archer'] });
  assert.ok(planned.ok);
  state = planned.state;
  const action = aiNextAction(state, { maxRecruit: 1, maxUpgrade: 1, recruited: 0, upgraded: 0, order: 'militia' });
  assert.ok(action && action.type === 'RECRUIT');
  assert.equal(action.unitType, 'archer');
  assert.ok(applyAction(state, action).ok);
});

test('普通模式 AI 恢复后也读取本回合已招募数量，不重复领取自身预算', async () => {
  let state = createMatch({ ...DEFAULT_CONFIG, expansionIds: [] }, 42);
  state.units = [];
  state.players.A.gold = 10000;
  for (let i = 0; i < 2; i++) {
    const result = applyAction(state, { type: 'RECRUIT', cityId: state.cities[0]!.id, unitType: 'militia' });
    assert.ok(result.ok);
    state = result.state;
  }
  state = importMatch(exportMatch(state))!;
  await executeAiTurn({
    getState: () => state, setState: (next) => { state = next; }, active: () => true,
    save: () => {}, render: () => {}, sleep: async () => {},
  }, { maxUpgrade: 0 }, 0);
  assert.equal(state.units.filter((unit) => unit.owner === 'A').length, 2);
});

test('联机同回合攻城获胜也需要提交', () => {
  const state = match();
  assert.equal(shouldSubmitTurn({ type: 'SET_ORDERS', queue: [] }, state), false);
  assert.equal(shouldSubmitTurn({ type: 'END_TURN' }, state), true);
  state.winner = 'A';
  assert.equal(shouldSubmitTurn({ type: 'SIEGE', unitId: 'u', cityId: 'c' }, state), true);
});

test('轮询接受敌方同回合终局，拒绝旧回合及普通同回合状态', () => {
  const local = match();
  const remote = structuredClone(local);
  assert.equal(shouldAcceptRoomState(local, remote, 'B'), false);
  remote.winner = 'A';
  assert.equal(shouldAcceptRoomState(local, remote, 'B'), true);
  remote.turn -= 1;
  assert.equal(shouldAcceptRoomState(local, remote, 'B'), false);
  const next = endTurn(local);
  assert.equal(shouldAcceptRoomState(local, next, 'B'), true);
  assert.equal(shouldAcceptRoomState(local, next, 'A'), false);
});

test('刷新恢复待提交回合，只接受与本方草稿一致的标记', () => {
  const state = match();
  const ended = endTurn(state);
  const marker = JSON.stringify(state.turn);
  assert.equal(restorePendingTurn(ended, 'A', marker), state.turn);
  assert.equal(restorePendingTurn(ended, 'B', marker), null);
  assert.equal(restorePendingTurn(ended, 'A', 'broken'), null);
  assert.equal(restorePendingTurn(ended, 'A', '-1'), null);
  assert.equal(restorePendingTurn(ended, 'A', '9999'), null);
  state.winner = 'A';
  assert.equal(restorePendingTurn(state, 'A', marker), state.turn);
});

let uiBundle: Promise<string> | undefined;
function bundledApp(): Promise<string> {
  uiBundle ??= build({
    entryPoints: ['src/main.ts'], bundle: true, format: 'iife', write: false,
    loader: { '.css': 'text' }, target: 'es2022', logLevel: 'silent',
    plugins: [{
      name: 'offline-room',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]net[\\/]room\.ts$/ }, () => ({
          contents: `
            export const loadSeat = () => globalThis.__roomTest.seat;
            export const submitTurn = (...args) => globalThis.__roomTest.submit(...args);
            export const fetchRoom = async () => null;
            export const normalizeCode = (code) => code;
            export const newToken = () => 'offline-token';
            export const saveSeat = () => {};
            export const claimSeat = async () => 'ok';
            export const createRoom = async () => { throw new Error('offline'); };
          `,
          loader: 'js',
        }));
      },
    }],
  }).then((result) => result.outputFiles[0]!.text);
  return uiBundle;
}

async function roomPage(
  entries: Map<string, string>,
  submit: (code: string, state: GameState, expectedTurn: number) => Promise<boolean>,
  seat: PlayerId = 'A',
): Promise<JSDOM> {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only',
  });
  const globals = dom.window as unknown as Record<string, unknown>;
  globals.structuredClone = structuredClone;
  globals.__roomTest = { seat: { code: 'AB2345', seat, token: 'offline-token' }, submit };
  for (const [key, value] of entries) dom.window.localStorage.setItem(key, value);
  dom.window.eval(await bundledApp());
  return dom;
}

function clickRoomButton(dom: JSDOM, action: string): void {
  const button = dom.window.document.querySelector<HTMLElement>(`[data-act="${action}"]`);
  assert.ok(button);
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

const settleUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('联机提交失败后刷新仍能重试，成功后清除按钮和待提交标记', async () => {
  const state = match();
  state.config.commanderMode = false;
  state.aiControl = { A: false, B: false };
  const entries = new Map([
    ['warchess:room-current', 'AB2345'],
    ['warchess:match:v1:room:AB2345', JSON.stringify(state)],
  ]);
  let first = await roomPage(entries, async () => { throw new Error('暂时离线'); });
  try {
    clickRoomButton(first, 'end-turn');
    await settleUi();
    const retry = first.window.document.querySelector<HTMLButtonElement>('[data-act="retry-submit"]')!;
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    assert.equal(first.window.localStorage.getItem('warchess:room-pending:AB2345'), String(state.turn));
    for (let i = 0; i < first.window.localStorage.length; i++) {
      const key = first.window.localStorage.key(i)!;
      entries.set(key, first.window.localStorage.getItem(key)!);
    }
  } finally {
    first.window.close();
  }
  let submittedTurn = -1;
  first = await roomPage(entries, async (_code, submitted, expectedTurn) => {
    assert.equal(submitted.current, 'B', '轮到对方时仍须允许提交本方草稿');
    submittedTurn = expectedTurn;
    return true;
  });
  try {
    clickRoomButton(first, 'retry-submit');
    await settleUi();
    assert.equal(submittedTurn, state.turn);
    assert.equal(first.window.localStorage.getItem('warchess:room-pending:AB2345'), null);
    assert.equal(first.window.document.querySelector<HTMLButtonElement>('[data-act="retry-submit"]')!.hidden, true);
  } finally {
    first.window.close();
  }
});

test('同回合终局恢复后可直接重试提交，不受 winner 禁止操作影响', async () => {
  const state = match();
  state.winner = 'A';
  state.aiControl = { A: false, B: false };
  let submissions = 0;
  const dom = await roomPage(new Map([
    ['warchess:room-current', 'AB2345'],
    ['warchess:match:v1:room:AB2345', JSON.stringify(state)],
    ['warchess:room-pending:AB2345', String(state.turn)],
  ]), async (_code, submitted, expectedTurn) => {
    assert.equal(submitted.winner, 'A');
    assert.equal(submitted.turn, expectedTurn);
    submissions += 1;
    return true;
  });
  try {
    clickRoomButton(dom, 'retry-submit');
    await settleUi();
    assert.equal(submissions, 1);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-act="retry-submit"]')!.hidden, true);
  } finally {
    dom.window.close();
  }
});

test('第100轮平局能够恢复并提交给另一方，界面显示平局原因', async () => {
  let state = match();
  state.turn = CONFIG.maxRounds * 2;
  state.current = 'B';
  state.turnProduction = { turn: state.turn, player: 'B', recruited: 0, upgraded: 0 };
  state.aiControl = { A: false, B: false };
  state = endTurn(state);
  assert.equal(state.winner, 'draw');
  let submissions = 0;
  const dom = await roomPage(new Map([
    ['warchess:room-current', 'AB2345'],
    ['warchess:match:v1:room:AB2345', JSON.stringify(state)],
    ['warchess:room-pending:AB2345', String(state.turn)],
  ]), async (_code, submitted, expectedTurn) => {
    assert.equal(submitted.winner, 'draw');
    assert.equal(submitted.resultReason, 'turn-limit');
    assert.equal(submitted.turn, expectedTurn);
    submissions += 1;
    return true;
  }, 'B');
  try {
    assert.match(dom.window.document.querySelector('[data-game-result]')!.textContent!, /平局/);
    assert.match(dom.window.document.querySelector('[data-game-result]')!.textContent!, /100 轮/);
    clickRoomButton(dom, 'retry-submit');
    await settleUi();
    assert.equal(submissions, 1);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-act="retry-submit"]')!.hidden, true);
  } finally {
    dom.window.close();
  }
});
