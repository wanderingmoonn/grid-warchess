/** 胜负、完整轮裁决和持久产能的确定性回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG, ORDER_UPGRADE, UNIT_TYPES } from '../src/core/config.ts';
import { applyAction, evaluateOutcome, idx, outcomeText, productionError, productionOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { Action, GameState, PlayerId, Unit } from '../src/core/types.ts';

function fixture(commanderMode = false): GameState {
  const state = createMatch({ ...DEFAULT_CONFIG, commanderMode, expansionIds: [], enabledUnits: Object.keys(UNIT_TYPES) }, 401);
  state.tiles = Array.from({ length: state.w * state.h }, () => ({ terrain: 'plain', cityId: null }));
  state.cities = [
    { id: 'a1', owner: 'A', x: 1, y: 9, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
    { id: 'a2', owner: 'A', x: 8, y: 9, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
    { id: 'b1', owner: 'B', x: 1, y: 1, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
    { id: 'b2', owner: 'B', x: 8, y: 1, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
  ];
  for (const city of state.cities) {
    for (let dy = 0; dy < city.size; dy++) for (let dx = 0; dx < city.size; dx++) {
      state.tiles[idx(state, city.x + dx, city.y + dy)] = { terrain: 'city', cityId: city.id };
    }
  }
  state.units = [];
  state.log = [];
  state.memory = { A: { known: [] }, B: { known: [] } };
  state.players.A.gold = 10000;
  state.players.B.gold = 10000;
  state.fog = false;
  return state;
}

function place(state: GameState, owner: PlayerId, type: string, x: number, y: number): Unit {
  const unit: Unit = { id: `u${state.nextUnitSeq++}`, owner, type, x, y,
    hp: state.unitTypes[type]!.maxHp, kills: 0, acted: false, moved: false };
  state.units.push(unit);
  return unit;
}

function act(state: GameState, action: Action): GameState {
  const before = structuredClone(state);
  const result = applyAction(state, action);
  assert.deepEqual(state, before, '输入状态不应改变');
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.state;
}

function reject(state: GameState, action: Action): string {
  const before = structuredClone(state);
  const result = applyAction(state, action);
  assert.deepEqual(state, before, '失败不能扣钱、消耗额度或改变计划');
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('应该拒绝该行动');
  return result.reason;
}

function atTurn(state: GameState, turn: number): void {
  state.turn = turn;
  state.current = turn % 2 === 1 ? 'A' : 'B';
  state.turnProduction = { turn, player: state.current, recruited: 0, upgraded: 0 };
}

test('无兵且现金为零，只要有城就能等待收入重新招募', () => {
  let state = fixture();
  state.players.A.gold = 0;
  state.players.B.gold = 0;
  state = act(state, { type: 'END_TURN' });
  assert.equal(state.winner, null);
  assert.ok(state.players.B.gold > 0);
  state = act(state, { type: 'END_TURN' });
  assert.equal(state.winner, null);
  state = act(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  assert.equal(state.units.length, 1);
});

test('失去全部城市立即判负，剩余军队和金币不改变结论', () => {
  const state = fixture();
  for (const city of state.cities) city.owner = 'B';
  place(state, 'A', 'militia', 5, 5);
  const result = act(state, { type: 'END_TURN' });
  assert.equal(result.winner, 'B');
  assert.equal(result.resultReason, 'conquest');
  assert.equal(result.turn, 1);
  assert.match(outcomeText(result), /失去全部城市/);
});

test('双方均无城市时平局，不能按遍历顺序偏袒任一方', () => {
  for (const current of ['A', 'B'] as const) {
    const state = fixture();
    state.cities = [];
    state.current = current;
    const result = act(state, { type: 'END_TURN' });
    assert.equal(result.winner, 'draw');
    assert.equal(result.resultReason, 'no-cities');
    assert.ok(result.log.every((entry) => entry.player === 'A' || entry.player === 'B'));
  }
});

test('攻陷最后城市后先完成守军爆炸清理，再按城市判胜', () => {
  const state = fixture();
  for (const city of state.cities) city.owner = city.id === 'b1' ? 'B' : 'A';
  state.cities.find((city) => city.id === 'b1')!.hp = 1;
  state.unitTypes.militia!.abilities = ['kamikaze'];
  state.unitTypes.militia!.atk = 100;
  const attacker = place(state, 'A', 'militia', 0, 1);
  attacker.hp = 1;
  place(state, 'B', 'militia', 1, 1);
  state.players.A.gold = 0;
  const result = act(state, { type: 'SIEGE', unitId: attacker.id, cityId: 'b1' });
  assert.equal(result.units.length, 0, '守军自爆必须先结算完毕');
  assert.equal(result.winner, 'A', '没兵没钱不能推翻已经完成的攻城胜利');
  assert.equal(result.resultReason, 'conquest');
});

test('第100轮先手结束后后手仍有完整行动机会', () => {
  let state = fixture();
  atTurn(state, CONFIG.maxRounds * 2 - 1);
  state = act(state, { type: 'END_TURN' });
  assert.equal(state.current, 'B');
  assert.equal(state.turn, CONFIG.maxRounds * 2);
  assert.equal(state.winner, null);
  state = act(state, { type: 'RECRUIT', cityId: 'b1', unitType: 'militia' });
  assert.equal(state.winner, null);
  state = act(state, { type: 'END_TURN' });
  assert.equal(state.winner, 'draw');
  assert.equal(state.resultReason, 'turn-limit');
});

test('上限裁决只比较城市，不奖励囤钱、科技或剩余血量', () => {
  const state = fixture();
  atTurn(state, CONFIG.maxRounds * 2);
  state.players.A.gold = 1000000;
  state.players.B.gold = 0;
  state.cities[0]!.era = 5;
  state.cities[2]!.hp = 1;
  const result = act(state, { type: 'END_TURN' });
  assert.equal(result.winner, 'draw');
  assert.match(outcomeText(result), /2∶2/);
});

test('上限时多占一座城的一方获胜，双方都能获胜', () => {
  for (const owner of ['A', 'B'] as const) {
    const state = fixture();
    atTurn(state, CONFIG.maxRounds * 2);
    state.cities.find((city) => city.owner !== owner)!.owner = owner;
    const result = act(state, { type: 'END_TURN' });
    assert.equal(result.winner, owner);
    assert.equal(result.resultReason, 'turn-limit');
  }
});

test('后手最后一回合攻城可以把落后改成平局', () => {
  let state = fixture();
  state.cities[2]!.owner = 'A';
  state.cities[0]!.hp = 1;
  const attacker = place(state, 'B', 'militia', 0, 9);
  atTurn(state, CONFIG.maxRounds * 2 - 1);
  state = act(state, { type: 'END_TURN' });
  state = act(state, { type: 'SIEGE', unitId: attacker.id, cityId: 'a1' });
  assert.equal(state.winner, null);
  state = act(state, { type: 'END_TURN' });
  assert.equal(state.winner, 'draw');
});

test('终局不多结算下一方的收入、休整或建筑火力', () => {
  const state = fixture();
  atTurn(state, CONFIG.maxRounds * 2);
  const target = place(state, 'A', 'militia', 5, 5);
  place(state, 'B', 'tower', 6, 5);
  const result = act(state, { type: 'END_TURN' });
  assert.equal(result.turn, state.turn);
  assert.equal(result.current, 'B');
  assert.deepEqual(result.players, state.players);
  assert.deepEqual(result.units, state.units);
  assert.equal(result.units.find((unit) => unit.id === target.id)!.hp, target.hp);
  assert.deepEqual(result.cities, state.cities);
});

test('终局状态拒绝任何继续操作，获胜和平局相同', () => {
  const state = fixture(true);
  atTurn(state, CONFIG.maxRounds * 2);
  const draw = act(state, { type: 'END_TURN' });
  reject(draw, { type: 'END_TURN' });
  reject(draw, { type: 'SET_ORDERS', queue: ['militia'] });
  reject(draw, { type: 'RECRUIT', cityId: 'b1', unitType: 'militia' });
  assert.equal(evaluateOutcome(fixture()), null);
});

test('成功招募消耗全方共享额度，换城市或军营不能再造', () => {
  const initial = fixture(true);
  const campType = Object.values(initial.unitTypes).find((def) => def.barracks)!.id;
  const camp = place(initial, 'A', campType, 6, 6);
  const state = act(initial, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  assert.equal(productionOf(state).recruited, 1);
  reject(state, { type: 'RECRUIT', cityId: 'a2', unitType: 'archer' });
  reject(state, { type: 'RECRUIT', unitId: camp.id, unitType: 'militia' });
  reject(state, { type: 'UPGRADE', cityId: 'a2' });
});

test('军营先产兵也占共享额度，城市不能绕过', () => {
  const initial = fixture(true);
  const campType = Object.values(initial.unitTypes).find((def) => def.barracks)!.id;
  const camp = place(initial, 'A', campType, 6, 6);
  const state = act(initial, { type: 'RECRUIT', unitId: camp.id, unitType: 'militia' });
  reject(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
});

test('成功升级后不能升级另一城，也不能补招单位', () => {
  const state = act(fixture(true), { type: 'UPGRADE', cityId: 'a1' });
  assert.equal(productionOf(state).upgraded, 1);
  reject(state, { type: 'UPGRADE', cityId: 'a2' });
  reject(state, { type: 'RECRUIT', cityId: 'a2', unitType: 'militia' });
});

test('招募失败不扣钱和额度，腾空城市后可再次执行', () => {
  const state = fixture(true);
  for (const x of [1, 2]) for (const y of [9, 10]) place(state, 'A', 'militia', x, y);
  reject(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  assert.equal(productionOf(state).recruited, 0);
  const occupied = state.units[0]!;
  const moved = act(state, { type: 'MOVE', unitId: occupied.id, x: 0, y: 9 });
  const result = act(moved, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  assert.equal(productionOf(result).recruited, 1);
});

test('升级或招募缺钱失败不消耗产能，其他行动不影响账本', () => {
  const state = fixture(true);
  state.players.A.gold = 0;
  reject(state, { type: 'UPGRADE', cityId: 'a1' });
  reject(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  assert.deepEqual(productionOf(state), { turn: 1, player: 'A', recruited: 0, upgraded: 0 });
});

test('显式队首必须匹配兵种或升级，空位必须空过', () => {
  const state = act(fixture(true), { type: 'SET_ORDERS', queue: ['archer'] });
  reject(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  reject(state, { type: 'UPGRADE', cityId: 'a1' });
  assert.equal(act(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'archer' }).units[0]!.type, 'archer');
  const upgrade = act(fixture(true), { type: 'SET_ORDERS', queue: [ORDER_UPGRADE] });
  reject(upgrade, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  assert.equal(act(upgrade, { type: 'UPGRADE', cityId: 'a1' }).cities[0]!.era, 2);
  for (const queue of [[], ['', 'militia']]) {
    const empty = act(fixture(true), { type: 'SET_ORDERS', queue });
    reject(empty, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
    reject(empty, { type: 'UPGRADE', cityId: 'a1' });
  }
});

test('换计划与JSON往返不能重新获得已用产能', () => {
  let state = act(fixture(true), { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  state = act(state, { type: 'SET_ORDERS', queue: [ORDER_UPGRADE] });
  state = JSON.parse(JSON.stringify(state)) as GameState;
  reject(state, { type: 'UPGRADE', cityId: 'a2' });
  assert.equal(productionOf(state).recruited, 1);
});

test('交接才重置产能，两方分别得到一次机会，失败计划仍前移', () => {
  let state = act(fixture(true), { type: 'SET_ORDERS', queue: ['', 'militia'] });
  reject(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  state = act(state, { type: 'END_TURN' });
  assert.equal(productionOf(state).player, 'B');
  state = act(state, { type: 'RECRUIT', cityId: 'b1', unitType: 'militia' });
  state = act(state, { type: 'END_TURN' });
  assert.deepEqual(productionOf(state), { turn: 3, player: 'A', recruited: 0, upgraded: 0 });
  assert.deepEqual(state.orders!.A, ['militia']);
  state = act(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  assert.equal(state.winner, null);
});

test('建造不占战略产能，但每位建造者仍只能建造一次', () => {
  let state = fixture(true);
  const builderType = Object.values(state.unitTypes).find((def) => def.builds?.some((id) =>
    state.unitTypes[id]?.category === 'building' && !state.unitTypes[id]?.requiresWater && !state.unitTypes[id]?.bridges))!;
  const building = builderType.builds!.find((id) => !state.unitTypes[id]?.requiresWater && !state.unitTypes[id]?.bridges)!;
  const builder = place(state, 'A', builderType.id, 5, 5);
  state = act(state, { type: 'BUILD', unitId: builder.id, unitType: building, x: 5, y: 6 });
  assert.equal(productionOf(state).recruited + productionOf(state).upgraded, 0);
  reject(state, { type: 'BUILD', unitId: builder.id, unitType: building, x: 6, y: 5 });
  state = act(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  assert.equal(productionOf(state).recruited, 1);
});

test('装载卸载不重置已用产能', () => {
  let state = fixture(true);
  const ferry = place(state, 'A', 'ferry', 5, 5);
  const passenger = place(state, 'A', 'militia', 4, 5);
  state.tiles[idx(state, 5, 5)]!.terrain = 'water';
  state = act(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  state = act(state, { type: 'LOAD', unitId: ferry.id, cargoId: passenger.id });
  assert.equal(productionOf(state).recruited, 1);
  reject(state, { type: 'UPGRADE', cityId: 'a1' });

  let unloading = fixture(true);
  const boat = place(unloading, 'A', 'ferry', 5, 5);
  const cargo = place(unloading, 'A', 'militia', 4, 5);
  boat.cargo = [cargo];
  unloading.units = unloading.units.filter((unit) => unit.id !== cargo.id);
  unloading.tiles[idx(unloading, 5, 5)]!.terrain = 'water';
  unloading = act(unloading, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  unloading = act(unloading, { type: 'UNLOAD', unitId: boat.id, cargoId: cargo.id, x: 4, y: 5 });
  assert.equal(productionOf(unloading).recruited, 1);
  reject(unloading, { type: 'RECRUIT', cityId: 'a2', unitType: 'militia' });
});

test('普通模式保持原有生产自由，只记录实际使用量', () => {
  let state = fixture();
  state = act(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  state = act(state, { type: 'RECRUIT', cityId: 'a2', unitType: 'archer' });
  state = act(state, { type: 'UPGRADE', cityId: 'a1' });
  assert.deepEqual(productionOf(state), { turn: 1, player: 'A', recruited: 2, upgraded: 1 });
});

test('旧v4指挥官缺少账本时本回合封存，下一方正常恢复', () => {
  const state = fixture(true);
  state.version = 4;
  delete state.turnProduction;
  assert.equal(productionOf(state).legacyLocked, true);
  assert.match(productionError(state, { type: 'UPGRADE' })!, /旧存档/);
  reject(state, { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' });
  const next = act(state, { type: 'END_TURN' });
  assert.equal(next.version, 5);
  assert.equal(productionOf(next).recruited, 0);
  assert.equal(productionOf(next).legacyLocked, undefined);
  assert.equal(act(next, { type: 'UPGRADE', cityId: 'b1' }).cities[2]!.era, 2);
});

test('账本查询返回副本，完整行动序列可确定性重放', () => {
  const state = fixture(true);
  const copy = productionOf(state);
  copy.recruited = 99;
  assert.equal(productionOf(state).recruited, 0);
  const actions: Action[] = [
    { type: 'SET_ORDERS', queue: ['militia', ORDER_UPGRADE] },
    { type: 'RECRUIT', cityId: 'a1', unitType: 'militia' },
    { type: 'END_TURN' }, { type: 'UPGRADE', cityId: 'b1' },
    { type: 'END_TURN' }, { type: 'UPGRADE', cityId: 'a1' },
  ];
  const play = () => actions.reduce((current, action) => act(current, action), structuredClone(state));
  assert.deepEqual(play(), play());
});
