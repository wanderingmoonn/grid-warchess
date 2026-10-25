/** 上游城墙接入回归：只测试公开规则与 AI 选择，不调用网络。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { aiNextAction } from '../src/core/ai.ts';
import { enemyThreatAt } from '../src/core/ai/threat.ts';
import { ERA_PACKS } from '../src/core/era-packs.ts';
import { applyAction, attackableTargets, idx, previewAttack, siegeTargets } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from '../src/core/types.ts';
import { normalizeState } from '../src/storage/migrate.ts';

const WALLS = ['anc_palisade', 'anc_rammed_wall', 'med_wall', 'gp_chevaux',
  'gp_earthwork', 'ind_concrete', 'mod_dragonsteeth', 'mod_concretewall'];
const NO_PRODUCTION = { maxRecruit: 0, maxUpgrade: 0, recruited: 0, upgraded: 0 };

function fixture(): GameState {
  const state = createMatch({ ...DEFAULT_CONFIG, expansionIds: ERA_PACKS.map((pack) => pack.id) }, 401);
  state.tiles = Array.from({ length: state.w * state.h }, () => ({ terrain: 'plain', cityId: null }));
  state.cities = [
    { id: 'home', owner: 'A', x: 1, y: 8, size: 1, era: 5, hp: 150, maxHp: 150, armor: 0 },
    { id: 'foe', owner: 'B', x: 10, y: 1, size: 1, era: 5, hp: 150, maxHp: 150, armor: 0 },
  ];
  for (const city of state.cities) state.tiles[idx(state, city.x, city.y)] = { terrain: 'city', cityId: city.id };
  state.units = [];
  state.fog = false;
  state.memory = { A: { known: [] }, B: { known: [] } };
  state.log = [];
  state.players.A.gold = 1000;
  state.players.B.gold = 1000;
  return state;
}

function place(state: GameState, owner: PlayerId, type: string, x: number, y: number): Unit {
  const unit: Unit = { id: `test-${state.nextUnitSeq++}`, type, owner, x, y,
    hp: state.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false };
  state.units.push(unit);
  return unit;
}

function define(state: GameState, id: string, overrides: Partial<UnitTypeDef>): string {
  state.unitTypes[id] = { ...state.unitTypes.militia!, id, name: id, short: '测', ...overrides };
  return id;
}

function constructionFixture(): GameState {
  const state = fixture();
  const builder = define(state, 'wall_builder', { category: 'builder', move: 0, atk: 0, range: 0, builds: ['anc_rammed_wall'] });
  place(state, 'A', builder, 4, 5);
  place(state, 'B', 'anc_rammed_wall', 10, 5);
  return state;
}

test('桥与固定收入建筑不占城墙额度，AI 仍能选择建墙', () => {
  const initial = constructionFixture();
  const before = aiNextAction(initial, NO_PRODUCTION);
  assert.equal(before?.type, 'BUILD');
  assert.equal(before?.type === 'BUILD' && before.unitType, 'anc_rammed_wall');
  const withBridges = structuredClone(initial);
  for (const [x, y] of [[0, 0], [1, 0]]) {
    const bridge = place(withBridges, 'A', 'bridge', x!, y!);
    bridge.acted = true;
  }
  assert.deepEqual(aiNextAction(withBridges, NO_PRODUCTION), before);
  const withIncome = structuredClone(initial);
  const incomeType = define(withIncome, 'fixed_income_building', {
    category: 'building', atk: 0, range: 0, move: 0, income: 5,
  });
  for (const [x, y] of [[0, 0], [1, 0]]) place(withIncome, 'A', incomeType, x!, y!).acted = true;
  assert.deepEqual(aiNextAction(withIncome, NO_PRODUCTION), before);
});

test('真实城墙继续消耗墙体额度，达到每城两座上限时不会继续堆墙', () => {
  const state = constructionFixture();
  for (const [x, y] of [[0, 0], [1, 0]]) place(state, 'A', 'anc_rammed_wall', x!, y!).acted = true;
  assert.equal(aiNextAction(state, NO_PRODUCTION), null);
});

test('八类纯墙受到指挥光环后仍不能主动攻击、攻城或反击', () => {
  for (const type of WALLS) {
    const state = fixture();
    state.tiles[idx(state, 1, 8)] = { terrain: 'plain', cityId: null };
    state.cities[0]!.x = 6;
    state.cities[0]!.y = 5;
    state.tiles[idx(state, 6, 5)] = { terrain: 'city', cityId: 'home' };
    const attackerType = define(state, 'test_attacker', { atk: 30, armor: 0, range: 1, maxHp: 100, abilities: [] });
    const auraType = define(state, 'test_command_aura', {
      category: 'building', atk: 0, move: 0, range: 0, abilities: ['aura-command'],
    });
    const attacker = place(state, 'A', attackerType, 4, 5);
    const wall = place(state, 'B', type, 5, 5);
    place(state, 'B', auraType, 5, 4);
    assert.equal(state.unitTypes[type]!.range, 0, type);
    const preview = previewAttack(state, attacker, wall);
    assert.equal(preview.counter, false, type);
    assert.equal(preview.toAttacker, 0, type);
    assert.equal(enemyThreatAt(state, 'A', 4, 5).n, 0, type);
    state.current = 'B';
    assert.deepEqual(attackableTargets(state, wall), [], type);
    assert.deepEqual(siegeTargets(state, wall), [], type);
    assert.equal(applyAction(state, { type: 'ATTACK', unitId: wall.id, targetId: attacker.id }).ok, false, type);
    assert.equal(applyAction(state, { type: 'SIEGE', unitId: wall.id, cityId: 'home' }).ok, false, type);
    state.current = 'A';
    const result = applyAction(state, { type: 'ATTACK', unitId: attacker.id, targetId: wall.id });
    assert.equal(result.ok, true, type);
    if (result.ok) assert.equal(result.state.units.find((unit) => unit.id === attacker.id)!.hp, attacker.hp, type);
  }
});

test('瞭望塔与铁丝网等有武器工事保留射程和伤害', () => {
  for (const type of ['anc_watchtower', 'med_donjon', 'gp_bastion', 'ind_pillbox', 'ind_wire', 'mod_mgbunker']) {
    const state = fixture();
    const targetType = define(state, 'test_target', { armor: 0, maxHp: 1000, abilities: [] });
    const target = place(state, 'A', targetType, 4, 5);
    const fortification = place(state, 'B', type, 5, 5);
    assert.ok(state.unitTypes[type]!.atk > 0, type);
    assert.ok(state.unitTypes[type]!.range > 0, type);
    assert.ok(attackableTargets(state, fortification).some((unit) => unit.id === target.id), type);
    assert.ok(previewAttack(state, fortification, target).toDefender > 0, type);
  }
});

test('五代兵种包保留 69 个单位，旧局骑兵、计划和旧墙快照可继续读取', () => {
  assert.deepEqual(ERA_PACKS.map((pack) => pack.units!.length), [15, 12, 14, 14, 14]);
  const state = createMatch({ ...DEFAULT_CONFIG, commanderMode: true, expansionIds: ['pack-industry', 'pack-antiquity'] }, 207);
  assert.equal(state.unitTypes.ind_cavalry, undefined);
  assert.ok(state.unitTypes.ind_trenchmortar);
  const legacy: UnitTypeDef = { id: 'ind_cavalry', name: '骑兵', short: '骑', era: 4, category: 'combat',
    cost: 210, move: 5, atk: 42, armor: 5, maxHp: 56, range: 1, vision: 4 };
  state.unitTypes.ind_cavalry = legacy;
  state.config.enabledUnits.push('ind_cavalry');
  state.orders = { A: ['ind_cavalry'] };
  const openTile = state.tiles.findIndex((tile, index) => tile.terrain === 'plain'
    && !state.units.some((unit) => unit.y * state.w + unit.x === index));
  assert.ok(openTile >= 0);
  const oldCavalry = place(state, 'A', 'ind_cavalry', openTile % state.w, Math.floor(openTile / state.w));
  state.unitTypes.anc_rammed_wall!.range = 1;
  const loaded = normalizeState(state);
  assert.ok(loaded);
  assert.deepEqual(loaded.unitTypes.ind_cavalry, legacy);
  assert.deepEqual(loaded.units.find((unit) => unit.id === oldCavalry.id), oldCavalry);
  assert.deepEqual(loaded.orders?.A, ['ind_cavalry']);
  assert.equal(loaded.unitTypes.anc_rammed_wall!.range, 1);
  const fresh = createMatch({ ...DEFAULT_CONFIG, expansionIds: ['pack-antiquity'] }, 207);
  assert.equal(fresh.unitTypes.anc_rammed_wall!.range, 0);
});
