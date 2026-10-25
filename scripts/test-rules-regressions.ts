/** 规则边界回归：固定小局面，避免地图变化掩盖规则错误。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG, UNIT_TYPES } from '../src/core/config.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import {
  applyAction, armySize, attackableTargets, computeDamage, damageToCity,
  idx, inBounds, previewAttack, refreshMemory,
} from '../src/core/rules.ts';
import type { Action, GameState, PlayerId, Unit } from '../src/core/types.ts';

function fixture(): GameState {
  const s = createMatch({ ...DEFAULT_CONFIG, size: 12, expansionIds: [], enabledUnits: Object.keys(UNIT_TYPES) }, 721);
  s.tiles = Array.from({ length: s.w * s.h }, () => ({ terrain: 'plain', cityId: null }));
  s.units = [];
  s.cities = [
    { id: 'home', owner: 'A', x: 1, y: 9, size: 2, era: 1, hp: 90, maxHp: 90, armor: 5 },
    { id: 'enemy', owner: 'B', x: 9, y: 1, size: 2, era: 1, hp: 90, maxHp: 90, armor: 5 },
  ];
  for (const c of s.cities) {
    for (let dy = 0; dy < c.size; dy++) for (let dx = 0; dx < c.size; dx++) {
      s.tiles[idx(s, c.x + dx, c.y + dy)] = { terrain: 'city', cityId: c.id };
    }
  }
  s.players.A.gold = 10000;
  s.players.B.gold = 10000;
  s.fog = false;
  s.log = [];
  s.memory = { A: { known: [] }, B: { known: [] } };
  return s;
}

function place(s: GameState, owner: PlayerId, type: string, x: number, y: number): Unit {
  const u: Unit = { id: `u${s.nextUnitSeq++}`, owner, type, x, y, hp: s.unitTypes[type].maxHp, moved: false, acted: false, kills: 0 };
  s.units.push(u);
  return u;
}

function succeed(s: GameState, action: Action): GameState {
  const before = structuredClone(s);
  const result = applyAction(s, action);
  assert.deepEqual(s, before, '行动不可修改传入状态');
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.state;
}

function reject(s: GameState, action: unknown): void {
  const before = structuredClone(s);
  const result = applyAction(s, action as Action);
  assert.equal(result.ok, false);
  assert.deepEqual(s, before, '拒绝行动也不可修改传入状态');
  if (!result.ok) assert.ok(result.reason.length > 0);
}

test('小数坐标不能通过线性索引别名落到可达格', () => {
  const s = fixture();
  const u = place(s, 'A', 'militia', 5, 5);
  assert.equal(idx(s, 10, 4.5), idx(s, 4, 5));
  assert.equal(inBounds(s, 10, 4.5), false);
  reject(s, { type: 'MOVE', unitId: u.id, x: 10, y: 4.5 });
  const moved = succeed(s, { type: 'MOVE', unitId: u.id, x: 4, y: 5 });
  assert.equal(moved.units[0].x, 4);
});

test('未知命令、错误字段和非有限坐标返回失败而非抛异常', () => {
  const s = fixture();
  const u = place(s, 'A', 'militia', 5, 5);
  for (const invalid of [
    null, [], {}, { type: 'INVALID' }, { type: 'ATTACK', unitId: u.id },
    { type: 'MOVE', unitId: u.id, x: NaN, y: 5 },
    { type: 'MOVE', unitId: u.id, x: Infinity, y: 5 },
    { type: 'SET_ORDERS', queue: null }, { type: 'SET_ORDERS', queue: [42] },
    { type: 'RECRUIT', cityId: 'home', unitId: u.id, unitType: 'militia' },
    { type: 'RECRUIT', unitType: 'militia' },
  ]) reject(s, invalid);
});

test('装船不释放编制，下船也不额外增加编制', () => {
  const s = fixture();
  const ferry = place(s, 'A', 'ferry', 5, 5);
  const troop = place(s, 'A', 'militia', 4, 5);
  s.tiles[idx(s, 5, 5)].terrain = 'water';
  const before = armySize(s, 'A');
  let loaded = succeed(s, { type: 'LOAD', unitId: ferry.id, cargoId: troop.id });
  assert.equal(armySize(loaded, 'A'), before);
  loaded = succeed(loaded, { type: 'END_TURN' });
  loaded = succeed(loaded, { type: 'END_TURN' });
  const unloaded = succeed(loaded, { type: 'UNLOAD', unitId: ferry.id, cargoId: troop.id, x: 4, y: 5 });
  assert.equal(armySize(unloaded, 'A'), before);
  assert.equal(unloaded.units.find(u => u.id === troop.id)?.acted, true);
});

test('原型上的名称不能冒充本局兵种', () => {
  const s = fixture();
  s.config.commanderMode = true;
  for (const unitType of ['toString', 'constructor', '__proto__']) {
    reject(s, { type: 'RECRUIT', cityId: 'home', unitType });
    reject(s, { type: 'SET_ORDERS', queue: [unitType] });
  }
});

test('编制已满时，不能用货舱藏兵再招募', () => {
  const s = fixture();
  const ferry = place(s, 'A', 'ferry', 5, 5);
  for (let i = 0; i < CONFIG.maxUnits - 2; i++) place(s, 'A', 'militia', i % 12, 6 + Math.floor(i / 12));
  const troop = place(s, 'A', 'militia', 4, 5);
  s.tiles[idx(s, 5, 5)].terrain = 'water';
  const loaded = succeed(s, { type: 'LOAD', unitId: ferry.id, cargoId: troop.id });
  assert.equal(armySize(loaded, 'A'), CONFIG.maxUnits);
  reject(loaded, { type: 'RECRUIT', cityId: 'home', unitType: 'militia' });
});

test('建筑不占编制，船上陆军仍占编制', () => {
  const s = fixture();
  place(s, 'A', 'tower', 4, 4);
  place(s, 'B', 'militia', 5, 4);
  const ferry = place(s, 'A', 'ferry', 5, 5);
  ferry.cargo = [{ ...ferry, id: 'passenger', type: 'militia' }];
  assert.equal(armySize(s, 'A'), 2);
});

test('先手能力的预览和实际结算均不发生反击', () => {
  const s = fixture();
  s.unitTypes.militia.abilities = ['first-strike'];
  const attacker = place(s, 'A', 'militia', 5, 5);
  const defender = place(s, 'B', 'militia', 6, 5);
  const preview = previewAttack(s, attacker, defender);
  assert.equal(preview.counter, false);
  assert.equal(preview.toAttacker, 0);
  const after = succeed(s, { type: 'ATTACK', unitId: attacker.id, targetId: defender.id });
  assert.equal(after.units.find(u => u.id === attacker.id)?.hp, attacker.hp);
  assert.equal(after.units.find(u => u.id === defender.id)?.hp, defender.hp - preview.toDefender);
});

test('普通攻击预览与实际反击伤害保持一致', () => {
  const s = fixture();
  const attacker = place(s, 'A', 'militia', 5, 5);
  const defender = place(s, 'B', 'militia', 6, 5);
  const before = structuredClone(s);
  const preview = previewAttack(s, attacker, defender);
  assert.deepEqual(s, before, '预览不得改变状态');
  assert.equal(preview.counter, true);
  const after = succeed(s, { type: 'ATTACK', unitId: attacker.id, targetId: defender.id });
  assert.equal(after.units.find(u => u.id === attacker.id)?.hp, attacker.hp - preview.toAttacker);
});

test('攻城同样使用破甲、指挥光环和破城能力', () => {
  const s = fixture();
  const attacker = place(s, 'A', 'militia', 8, 1);
  const city = s.cities[1];
  assert.equal(damageToCity(attacker, city, s), s.unitTypes.militia.atk - city.armor);
  s.unitTypes.militia.abilities = ['armor-pierce', 'siege-master'];
  s.unitTypes.archer.abilities = ['aura-command'];
  place(s, 'A', 'archer', 7, 1);
  const expected = Math.round((s.unitTypes.militia.atk + 2 - Math.floor(city.armor / 2)) * 1.5);
  assert.equal(damageToCity(attacker, city, s), expected);
  const after = succeed(s, { type: 'SIEGE', unitId: attacker.id, cityId: city.id });
  assert.equal(after.cities[1].hp, city.hp - expected);
});

test('不能直接在未攻占的敌城中盖建筑', () => {
  const s = fixture();
  const builder = place(s, 'A', 'laborer', 8, 1);
  reject(s, { type: 'BUILD', unitId: builder.id, unitType: 'tower', x: 9, y: 1 });
  const own = place(s, 'A', 'laborer', 0, 9);
  const built = succeed(s, { type: 'BUILD', unitId: own.id, unitType: 'tower', x: 1, y: 9 });
  assert.ok(built.units.some(u => u.type === 'tower' && u.x === 1 && u.y === 9));
});

test('军营招募跳过敌城格，没有其他落点时拒绝', () => {
  const s = fixture();
  const camp = place(s, 'A', 'camp', 8, 1);
  let recruited = succeed(s, { type: 'RECRUIT', unitId: camp.id, unitType: 'militia' });
  const troop = recruited.units.find(u => u.id !== camp.id)!;
  assert.equal(recruited.tiles[idx(recruited, troop.x, troop.y)].cityId, null);
  for (const [x, y] of [[7, 1], [8, 0], [8, 2]]) s.tiles[idx(s, x, y)].terrain = 'mountain';
  reject(s, { type: 'RECRUIT', unitId: camp.id, unitType: 'militia' });
});

test('点名攻击不能绕过潜行，靠近后可以攻击', () => {
  const s = fixture();
  s.fog = true;
  s.unitTypes.militia.abilities = ['stealth'];
  const attacker = place(s, 'A', 'archer', 4, 5);
  const defender = place(s, 'B', 'militia', 6, 5);
  s.tiles[idx(s, 6, 5)].terrain = 'forest';
  assert.equal(attackableTargets(s, attacker).length, 0);
  reject(s, { type: 'ATTACK', unitId: attacker.id, targetId: defender.id });
  place(s, 'A', 'militia', 6, 6);
  assert.equal(attackableTargets(s, attacker)[0]?.id, defender.id);
  succeed(s, { type: 'ATTACK', unitId: attacker.id, targetId: defender.id });
});

test('射程大于视野时不能点名攻击视野外的目标', () => {
  const s = fixture();
  s.fog = true;
  s.unitTypes.archer.vision = 1;
  const attacker = place(s, 'A', 'archer', 4, 5);
  const defender = place(s, 'B', 'militia', 6, 5);
  reject(s, { type: 'ATTACK', unitId: attacker.id, targetId: defender.id });
  s.fog = false;
  succeed(s, { type: 'ATTACK', unitId: attacker.id, targetId: defender.id });
});

test('建筑自动攻击服从潜行规则', () => {
  const s = fixture();
  s.fog = true;
  s.unitTypes.militia.abilities = ['stealth'];
  place(s, 'A', 'tower', 4, 5);
  const defender = place(s, 'B', 'militia', 6, 5);
  s.tiles[idx(s, 6, 5)].terrain = 'forest';
  const after = succeed(s, { type: 'END_TURN' });
  assert.equal(after.units.find(u => u.id === defender.id)?.hp, defender.hp);
});

test('自动火力也必须贴近桥头才能拆桥', () => {
  const s = fixture();
  place(s, 'A', 'tower', 4, 5);
  const bridge = place(s, 'B', 'bridge', 6, 5);
  s.tiles[idx(s, 6, 5)].terrain = 'bridge';
  let after = succeed(s, { type: 'END_TURN' });
  assert.equal(after.units.find(u => u.id === bridge.id)?.hp, bridge.hp);
  s.units[0].x = 5;
  after = succeed(s, { type: 'END_TURN' });
  assert.ok(after.units.find(u => u.id === bridge.id)!.hp < bridge.hp);
});

test('同一行动序列可重复执行，并保持输入快照不变', () => {
  const initial = fixture();
  const attacker = place(initial, 'A', 'militia', 5, 5);
  const defender = place(initial, 'B', 'militia', 7, 5);
  const initialCopy = structuredClone(initial);
  const actions: Action[] = [
    { type: 'MOVE', unitId: attacker.id, x: 6, y: 5 },
    { type: 'ATTACK', unitId: attacker.id, targetId: defender.id },
    { type: 'END_TURN' }, { type: 'END_TURN' },
  ];
  const replay = () => actions.reduce((s, action) => succeed(s, action), initial);
  assert.deepEqual(replay(), replay());
  assert.deepEqual(initial, initialCopy);
  assert.equal(computeDamage(initial, attacker, defender), computeDamage(initial, attacker, defender));
  refreshMemory(initial); // fog=false，因此仍是纯数据快照。
  assert.deepEqual(initial, initialCopy);
});
