/** 外部控制器观察的字段白名单、迷雾与数据隔离测试；完全离线。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { observeGame } from '../src/controllers/observation.ts';
import { CONFIG } from '../src/core/config.ts';
import { activeExpansions } from '../src/core/expansions.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, Unit } from '../src/core/types.ts';

function fixture(): GameState {
  const state = createMatch({ ...DEFAULT_CONFIG, size: 12, expansionIds: [], commanderMode: true }, 42);
  state.tiles = Array.from({ length: state.w * state.h }, () => ({ terrain: 'plain', cityId: null }));
  state.cities = [
    { id: 'a', owner: 'A', x: 0, y: 0, size: 2, era: 1, hp: 30, maxHp: 30, armor: 0 },
    { id: 'b', owner: 'B', x: 9, y: 0, size: 2, era: 1, hp: 30, maxHp: 30, armor: 0 },
  ];
  for (const city of state.cities) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    state.tiles[(city.y + dy) * state.w + city.x + dx] = { terrain: 'city', cityId: city.id };
  }
  state.unitTypes.militia!.vision = 1;
  const unit = (id: string, owner: 'A' | 'B', x: number, y: number): Unit => ({
    id, owner, type: 'militia', x, y, hp: state.unitTypes.militia!.maxHp,
    kills: 0, moved: false, acted: false,
  });
  state.units = [unit('own', 'A', 2, 2), unit('seen', 'B', 3, 2), unit('hidden', 'B', 10, 10)];
  state.memory = { A: { known: [] }, B: { known: [] } };
  state.orders = { A: ['militia', ''], B: ['archer', '@upgrade'] };
  state.log = [];
  state.fog = true;
  return state;
}

test('观察提供当前方、公开城市与地形，只列出可见敌军', () => {
  const state = fixture();
  const observation = observeGame(state, 'A');
  assert.equal(observation.version, 1);
  assert.equal(observation.player, 'A');
  assert.equal(observation.current, 'A');
  assert.equal(observation.turn, 1);
  assert.equal(observation.round, 1);
  assert.equal(observation.maxRounds, CONFIG.maxRounds);
  assert.equal(observation.board.terrain.length, 144);
  assert.deepEqual(observation.units.map((unit) => unit.id), ['own', 'seen']);
  assert.deepEqual(observation.cities.map((city) => city.id), ['a', 'b']);
  assert.equal(observation.self.gold, state.players.A.gold);
  assert.equal(observation.self.recruitCosts.militia, state.unitTypes.militia!.cost);
  assert.deepEqual(Object.keys(observation.self.upgradeCosts), ['a']);
  assert.match(observation.rules.coordinates, /从 0 开始/);
});

test('隐藏单位、敌方经济与计划、日志和种子变化不改变观察', () => {
  const state = fixture();
  const changed = structuredClone(state);
  changed.seed = 999;
  changed.nextUnitSeq += 100;
  changed.players.B.gold = 93241;
  changed.players.B.name = 'private opponent name';
  changed.orders!.B = ['@upgrade'];
  changed.memory.B.known = [{ id: 'private-memory', type: 'militia', x: 1, y: 1, seenAt: 1 }];
  changed.log = [{ turn: 1, player: 'B', text: 'private attack log' }];
  changed.aiControl = { A: true, B: true };
  const enemy = changed.units.find((unit) => unit.id === 'hidden')!;
  enemy.x = 8;
  enemy.hp = 1;
  enemy.cargo = [{ ...enemy, id: 'private-cargo' }];
  changed.units.push({ ...enemy, id: 'another-hidden', x: 9, y: 8 });
  assert.deepEqual(observeGame(changed, 'A'), observeGame(state, 'A'));
});

test('未知嵌套字段不会随 DTO 外发，包括单位定义与生产账本附加数据', () => {
  const state = fixture();
  const mark = 'PRIVATE_CANARY_92741';
  Object.assign(state, { secret: mark });
  Object.assign(state.config, { secret: mark });
  Object.assign(state.players.A, { secret: mark });
  Object.assign(state.turnProduction!, { secret: mark });
  Object.assign(state.cities[0]!, { secret: mark });
  Object.assign(state.units[0]!, { secret: mark });
  Object.assign(state.unitTypes.militia!, { secret: mark });
  state.unitTypes.militia!.incomeByTerrain = { plain: 5 };
  Object.assign(state.unitTypes.militia!.incomeByTerrain, { secret: mark });
  state.memory.A.known = [{ id: 'ghost', type: 'militia', x: 7, y: 7, seenAt: 1 }];
  Object.assign(state.memory.A.known[0]!, { secret: mark });
  const observation = observeGame(state, 'A');
  assert.ok(!JSON.stringify(observation).includes(mark));
  assert.deepEqual(observation.unitTypes.militia!.incomeByTerrain, { plain: 5 });
  assert.equal(Object.hasOwn(observation, 'seed'), false);
  assert.equal(Object.hasOwn(observation, 'log'), false);
  assert.equal(Object.hasOwn(observation, 'memory'), false);
});

test('己方货舱白名单扁平展开，敌方货舱不随可见运输单位公开', () => {
  const state = fixture();
  state.units[0]!.cargo = [{ ...state.units[0]!, id: 'own-passenger' }];
  state.units[0]!.cargo[0]!.cargo = [{ ...state.units[0]!, id: 'nested-secret', cargo: [] }];
  state.units[1]!.cargo = [{ ...state.units[1]!, id: 'enemy-passenger' }];
  Object.assign(state.units[0]!.cargo[0]!, { secret: 'cargo-secret' });
  const observation = observeGame(state, 'A');
  const own = observation.units.find((unit) => unit.id === 'own')!;
  assert.equal(own.cargo!.length, 1);
  assert.equal(own.cargo![0]!.id, 'own-passenger');
  assert.equal(Object.hasOwn(own.cargo![0]!, 'cargo'), false);
  assert.equal(Object.hasOwn(observation.units.find((unit) => unit.id === 'seen')!, 'cargo'), false);
  assert.ok(!JSON.stringify(observation).includes('enemy-passenger'));
  assert.ok(!JSON.stringify(observation).includes('cargo-secret'));
});

test('关闭迷雾只公开所有单位位置，不开放敌方货舱或私有状态', () => {
  const state = fixture();
  state.fog = false;
  state.units[2]!.cargo = [{ ...state.units[2]!, id: 'hidden-cargo' }];
  state.memory.A.known = [{ id: 'old', type: 'militia', x: 6, y: 6, seenAt: 1 }];
  const observation = observeGame(state, 'A');
  assert.equal(observation.units.length, 3);
  assert.equal(observation.board.visible.length, 144);
  assert.deepEqual(observation.ghosts, []);
  assert.ok(!JSON.stringify(observation).includes('hidden-cargo'));
  const privateChange = structuredClone(state);
  privateChange.orders!.B = [];
  privateChange.players.B.gold += 100;
  privateChange.memory.B.known = [{ id: 'enemy-memory', type: 'militia', x: 0, y: 0, seenAt: 1 }];
  assert.deepEqual(observeGame(privateChange, 'A'), observation);
});

test('幽灵仅使用本方最后已知位置，并剔除当前已经看到的单位', () => {
  const state = fixture();
  state.memory.A.known = [
    { id: 'hidden', type: 'militia', x: 5, y: 5, seenAt: 1 },
    { id: 'seen', type: 'militia', x: 4, y: 2, seenAt: 1 },
  ];
  state.memory.B.known = [{ id: 'opponent-only', type: 'militia', x: 1, y: 1, seenAt: 1 }];
  const observation = observeGame(state, 'A');
  assert.deepEqual(observation.ghosts, [{ id: 'hidden', type: 'militia', x: 5, y: 5, seenAt: 1 }]);
});

test('DTO 可 JSON 往返，修改任意嵌套结果不会改变原局面或全局规则', () => {
  const state = fixture();
  state.units[0]!.cargo = [{ ...state.units[0]!, id: 'own-cargo' }];
  state.unitTypes.militia!.builds = ['mill'];
  state.unitTypes.militia!.incomeByTerrain = { plain: 5 };
  state.memory.A.known = [{ id: 'ghost', type: 'militia', x: 7, y: 7, seenAt: 1 }];
  const before = structuredClone(state);
  const configBefore = structuredClone(CONFIG);
  const observation = observeGame(state, 'A');
  assert.deepEqual(JSON.parse(JSON.stringify(observation)), observation);
  observation.units[0]!.hp = -1;
  observation.units[0]!.cargo![0]!.hp = -1;
  observation.cities[0]!.hp = -1;
  observation.ghosts[0]!.x = -1;
  observation.board.terrain[0] = 'water';
  observation.board.visible.length = 0;
  observation.unitTypes.militia!.builds!.push('private');
  observation.unitTypes.militia!.incomeByTerrain!.plain = 0;
  observation.rules.terrainCost.plain = 999;
  observation.rules.expansionIds.push('private');
  observation.rules.abilities[0]!.summary = 'changed';
  observation.self.orders![0] = 'changed';
  observation.self.production.recruited = 99;
  assert.deepEqual(state, before);
  assert.deepEqual(CONFIG, configBefore);
});

test('无显式计划与显式空计划保持不同语义，已用额度保留', () => {
  const state = fixture();
  delete state.orders!.A;
  assert.equal(observeGame(state, 'A').self.orders, null);
  state.orders!.A = [];
  state.turnProduction!.recruited = 1;
  const observation = observeGame(state, 'A');
  assert.deepEqual(observation.self.orders, []);
  assert.equal(observation.self.production.recruited, 1);
});

test('仅接受当前操控方，B 行动时只下发 B 自己的计划和经济', () => {
  const state = fixture();
  assert.throws(() => observeGame(state, 'B'), /当前行动方/);
  state.current = 'B';
  state.turn = 2;
  state.turnProduction = { turn: 2, player: 'B', recruited: 0, upgraded: 0 };
  const observation = observeGame(state, 'B');
  assert.equal(observation.self.gold, state.players.B.gold);
  assert.deepEqual(observation.self.orders, state.orders!.B);
  assert.equal(observation.self.production.player, 'B');
  assert.equal(observation.round, 1);
});

test('旧指挥官局保守封存额度，终局仍允许读取最终观察', () => {
  const state = fixture();
  state.version = 4;
  delete state.turnProduction;
  const observation = observeGame(state, 'A');
  assert.equal(observation.self.production.legacyLocked, true);
  assert.equal(observation.self.production.recruited, 1);
  state.winner = 'draw';
  assert.equal(observeGame(state, 'A').winner, 'draw');
});

test('公开启用扩展的说明，不外传扩展钩子或未知字段', () => {
  const state = fixture();
  state.config.expansionIds = ['veterans', 'bloodbath'];
  const active = activeExpansions(state);
  const expansion = active[0]!;
  const extra = expansion as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(expansion, 'privateMetadata');
  extra.privateMetadata = 'PRIVATE_EXPANSION_CANARY';
  try {
    const observation = observeGame(state, 'A');
    assert.deepEqual(observation.rules.expansionIds, state.config.expansionIds);
    assert.deepEqual(observation.rules.expansions, active.map(({ id, name, summary }) => ({ id, name, summary })));
    assert.match(observation.rules.expansions.find((item) => item.id === 'veterans')!.summary, /攻击力/);
    assert.match(observation.rules.expansions.find((item) => item.id === 'bloodbath')!.summary, /回血/);
    assert.ok(observation.rules.expansions.every((item) => !Object.hasOwn(item, 'hooks')));
    assert.ok(!JSON.stringify(observation).includes('PRIVATE_EXPANSION_CANARY'));
    assert.doesNotThrow(() => structuredClone(observation));
  } finally {
    if (previous) Object.defineProperty(expansion, 'privateMetadata', previous);
    else delete extra.privateMetadata;
  }
});
