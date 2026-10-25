/** 传统 AI 的迷雾失败恢复、取消和换局隔离，不调用外部服务。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeAiTurn } from '../src/app/ai-turn.ts';
import { aiNextAction } from '../src/core/ai.ts';
import { playerView } from '../src/core/fog.ts';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';

const NO_PRODUCTION = { maxRecruit: 0, maxUpgrade: 0, recruited: 0, upgraded: 0 };

/** 一格宽走廊里藏着斥候：完整路径被阻断，但先前进一格仍然合法。 */
function hiddenBlocker(): GameState {
  const state = createMatch({ ...DEFAULT_CONFIG, size: 12, expansionIds: [] }, 42);
  state.fog = true;
  state.players.A.gold = 0;
  state.players.B.gold = 0;
  state.cities = [
    { ...state.cities[0]!, id: 'a', owner: 'A', x: 0, y: 0 },
    { ...state.cities[1]!, id: 'b', owner: 'B', x: 9, y: 4 },
  ];
  state.tiles.forEach((tile, i) => {
    tile.terrain = Math.floor(i / state.w) === 5 ? 'plain' : 'mountain';
    tile.cityId = null;
  });
  for (const city of state.cities) {
    for (let y = city.y; y < city.y + 2; y++) {
      for (let x = city.x; x < city.x + 2; x++) {
        const tile = state.tiles[y * state.w + x]!;
        tile.terrain = 'city';
        tile.cityId = city.id;
      }
    }
  }
  state.unitTypes.militia = { ...state.unitTypes.militia!, move: 4, vision: 1 };
  state.unitTypes.scout = { ...state.unitTypes.militia, id: 'scout', abilities: ['stealth'], vision: 1 };
  state.units = [
    { id: 'own', type: 'militia', owner: 'A', x: 5, y: 5, hp: state.unitTypes.militia.maxHp, moved: false, acted: false, kills: 0 },
    { id: 'hidden', type: 'scout', owner: 'B', x: 7, y: 5, hp: state.unitTypes.scout.maxHp, moved: false, acted: false, kills: 0 },
  ];
  return state;
}

test('未知障碍导致失败后，AI 重选合法动作并继续作战', async () => {
  let state = hiddenBlocker();
  const initial = state;
  assert.deepEqual(playerView(state, 'A').state.units.map((unit) => unit.id), ['own']);
  const action = aiNextAction(state, NO_PRODUCTION);
  assert.ok(action);
  const first = applyAction(state, action);
  assert.equal(first.ok, false, '起初尚不知道路径上有隐身敌兵');
  const saved: GameState[] = [];
  let failedAttempts = 0;
  const completed = await executeAiTurn({
    getState: () => state,
    setState: (next) => { state = next; },
    active: () => true,
    save: () => { saved.push(state); },
    render: () => {},
    sleep: async () => { if (state === initial) failedAttempts += 1; },
  }, NO_PRODUCTION, 0);
  assert.equal(completed, true);
  assert.ok(failedAttempts > 0);
  assert.equal(state.current, 'B');
  assert.equal(state.turn, 2);
  const own = state.units.find((unit) => unit.id === 'own')!;
  assert.equal(own.x, 6);
  assert.equal(own.y, 5);
  assert.ok(state.units.find((unit) => unit.id === 'hidden')!.hp < state.unitTypes.scout!.maxHp);
  assert.ok(saved.every((snapshot) => snapshot !== initial), '失败尝试不写入存档');
});

test('失败后的让步点允许立即取消，不继续尝试或结束回合', async () => {
  let state = hiddenBlocker();
  const initial = state;
  let active = true;
  let writes = 0;
  const completed = await executeAiTurn({
    getState: () => state,
    setState: (next) => { state = next; writes += 1; },
    active: () => active,
    save: () => {},
    render: () => {},
    sleep: async () => { active = false; },
  }, NO_PRODUCTION, 0);
  assert.equal(completed, false);
  assert.equal(writes, 0);
  assert.equal(state, initial);
});

test('失败等待期间换成同玩家同回合的存档，旧任务不能继续', async () => {
  let state = hiddenBlocker();
  const replacement = structuredClone(state);
  let writes = 0;
  const completed = await executeAiTurn({
    getState: () => state,
    setState: (next) => { state = next; writes += 1; },
    active: () => true,
    save: () => {},
    render: () => {},
    sleep: async () => { state = replacement; },
  }, NO_PRODUCTION, 0);
  assert.equal(completed, false);
  assert.equal(writes, 0);
  assert.equal(state, replacement);
  assert.equal(state.turn, 1);
});

test('成功行动后的等待中换局，即使外部 active 未失效也停止', async () => {
  let state = hiddenBlocker();
  state.units = state.units.filter((unit) => unit.owner === 'A');
  const replacement = structuredClone(state);
  let writes = 0;
  const completed = await executeAiTurn({
    getState: () => state,
    setState: (next) => { state = next; writes += 1; },
    active: () => true,
    save: () => {},
    render: () => {},
    sleep: async () => { state = replacement; },
  }, NO_PRODUCTION, 0);
  assert.equal(completed, false);
  assert.equal(writes, 1);
  assert.equal(state, replacement);
});

test('结束回合后的等待被取消或换局，不向调用方报告仍在完成旧任务', async () => {
  for (const replace of [false, true]) {
    let state = hiddenBlocker();
    state.units = [];
    const replacement = structuredClone(state);
    let active = true;
    let writes = 0;
    const completed = await executeAiTurn({
      getState: () => state,
      setState: (next) => { state = next; writes += 1; },
      active: () => active,
      save: () => {},
      render: () => {},
      sleep: async () => { if (replace) state = replacement; else active = false; },
    }, NO_PRODUCTION, 0);
    assert.equal(completed, false);
    assert.equal(writes, 1);
    if (replace) assert.equal(state, replacement);
    else assert.equal(state.turn, 2);
  }
});

test('包含失败重试的 AI 回合在相同初态下保持确定性', async () => {
  async function run(): Promise<GameState> {
    let state = hiddenBlocker();
    await executeAiTurn({
      getState: () => state, setState: (next) => { state = next; }, active: () => true,
      save: () => {}, render: () => {}, sleep: async () => {},
    }, NO_PRODUCTION, 0);
    return state;
  }
  assert.deepEqual(await run(), await run());
});
