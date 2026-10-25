/** AI 的终局优先级、信息公平与决策重试。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { aiActionKey, aiNextAction, DEFAULT_BUDGET } from '../src/core/ai.ts';
import { playerView } from '../src/core/fog.ts';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';

function winningPosition(seed: number): GameState {
  const state = createMatch({ ...DEFAULT_CONFIG, size: 12, commanderMode: true, expansionIds: [] }, seed);
  state.fog = false;
  state.tiles = Array.from({ length: state.w * state.h }, () => ({ terrain: 'plain', cityId: null }));
  state.cities = [
    { id: 'home', owner: 'A', x: 1, y: 8, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
    { id: 'last', owner: 'B', x: 8, y: 1, size: 2, era: 1, hp: 1, maxHp: 90, armor: 0 },
  ];
  for (const city of state.cities) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      state.tiles[(city.y + dy) * state.w + city.x + dx] = { terrain: 'city', cityId: city.id };
    }
  }
  state.units = [{ id: 'finisher', owner: 'A', type: 'militia', x: 7, y: 1,
    hp: state.unitTypes.militia!.maxHp, kills: 0, moved: false, acted: false }];
  state.players.A.gold = 10000;
  state.orders = { A: ['militia'] };
  state.log = [];
  return state;
}

test('攻陷最后一城的胜利优先于点名招募和随机候选', () => {
  for (const level of ['basic', 'advanced'] as const) {
    for (let seed = 1; seed <= 24; seed++) {
      const state = winningPosition(seed);
      state.config.aiLevel = level;
      const action = aiNextAction(state);
      assert.deepEqual(action, { type: 'SIEGE', unitId: 'finisher', cityId: 'last' });
      const result = applyAction(state, action!);
      assert.ok(result.ok);
      assert.equal(result.state.winner, 'A');
    }
  }
});

test('同一局面决策可重现，查询不修改存档或传入预算', () => {
  const state = createMatch({ ...DEFAULT_CONFIG, expansionIds: [] }, 92);
  const saved = structuredClone(state);
  const budget = { ...DEFAULT_BUDGET };
  const first = aiNextAction(state, budget);
  assert.deepEqual(aiNextAction(structuredClone(state), { ...budget }), first);
  assert.deepEqual(state, saved);
  assert.deepEqual(budget, DEFAULT_BUDGET);
});

test('实际拒绝的高分动作不再提出，可以继续选择其他行动', () => {
  const state = winningPosition(1);
  const first = aiNextAction(state)!;
  const rejected = new Set([aiActionKey(first)]);
  const next = aiNextAction(state, DEFAULT_BUDGET, rejected);
  assert.ok(next);
  assert.notEqual(aiActionKey(next), aiActionKey(first));
  assert.ok(applyAction(state, next).ok);
});

test('玩家可见信息相同时，隐藏敌军不能偷偷改变移动决策', () => {
  const state = winningPosition(1);
  state.fog = true;
  state.unitTypes.militia = { ...state.unitTypes.militia!, vision: 1, move: 4 };
  state.units[0]!.x = 3;
  state.units[0]!.y = 5;
  const budget = { ...DEFAULT_BUDGET, maxRecruit: 0, maxUpgrade: 0 };
  const action = aiNextAction(state, budget);
  assert.ok(action?.type === 'MOVE');
  const hidden = structuredClone(state);
  hidden.units.push({ ...hidden.units[0]!, id: 'unseen', owner: 'B', x: action.x, y: action.y });
  assert.deepEqual(playerView(hidden, 'A'), playerView(state, 'A'));
  assert.deepEqual(aiNextAction(hidden, budget), action);
});
