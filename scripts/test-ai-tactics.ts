/** 战术回归：地形可达威胁、有效攻击与最后城市的即时防守。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiNextAction, type AiBudget } from '../src/core/ai.ts';
import { enemyThreatAt, inDanger } from '../src/core/ai/threat.ts';
import { UNIT_TYPES } from '../src/core/config.ts';
import { playerView } from '../src/core/fog.ts';
import { applyAction, idx } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from '../src/core/types.ts';

const NO_PRODUCTION: AiBudget = { maxRecruit: 0, maxUpgrade: 0, recruited: 0, upgraded: 0 };

function fixture(): GameState {
  const s = createMatch({ ...DEFAULT_CONFIG, size: 12, expansionIds: [], enabledUnits: Object.keys(UNIT_TYPES) }, 401);
  s.tiles = Array.from({ length: s.w * s.h }, () => ({ terrain: 'plain', cityId: null }));
  s.cities = [
    { id: 'home', owner: 'A', x: 1, y: 7, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
    { id: 'foe', owner: 'B', x: 9, y: 1, size: 2, era: 1, hp: 90, maxHp: 90, armor: 4 },
  ];
  for (const c of s.cities) {
    for (let dy = 0; dy < c.size; dy++) for (let dx = 0; dx < c.size; dx++) {
      s.tiles[idx(s, c.x + dx, c.y + dy)] = { terrain: 'city', cityId: c.id };
    }
  }
  s.units = [];
  s.fog = false;
  s.log = [];
  s.memory = { A: { known: [] }, B: { known: [] } };
  s.players.A.gold = 0;
  s.players.B.gold = 0;
  return s;
}

function type(s: GameState, id: string, overrides: Partial<UnitTypeDef> = {}): string {
  s.unitTypes[id] = { ...s.unitTypes.militia!, id, name: id, atk: 10, range: 1, move: 2, armor: 0, maxHp: 20, ...overrides };
  return id;
}

function place(s: GameState, owner: PlayerId, id: string, x: number, y: number): Unit {
  const u: Unit = { id: `u${s.nextUnitSeq++}`, owner, type: id, x, y, hp: s.unitTypes[id]!.maxHp, kills: 0, moved: false, acted: false };
  s.units.push(u);
  return u;
}

test('威胁遵守地形，近战不会隔着整列山脉或河流冲锋', () => {
  for (const terrain of ['mountain', 'water'] as const) {
    const s = fixture();
    place(s, 'B', type(s, 'enemy', { move: 4 }), 3, 4);
    for (let y = 0; y < s.h; y++) s.tiles[idx(s, 4, y)] = { terrain, cityId: null };
    assert.equal(inDanger(s, 'A', 5, 4), false);
    assert.equal(inDanger(s, 'A', 2, 4), true);
  }
});

test('慢速单位不能穿过一圈超出移动力的森林来制造虚假威胁', () => {
  const s = fixture();
  place(s, 'B', type(s, 'slow', { move: 1 }), 5, 5);
  for (const [x, y] of [[4, 5], [6, 5], [5, 4], [5, 6]]) s.tiles[idx(s, x!, y!)] = { terrain: 'forest', cityId: null };
  assert.equal(inDanger(s, 'A', 7, 5), false);
});

test('每只敌军只计算一次，并预测下一回合完整行动能力', () => {
  const s = fixture();
  const enemy = place(s, 'B', type(s, 'mobile', { range: 2, move: 3 }), 5, 5);
  enemy.moved = true;
  enemy.acted = true;
  const before = structuredClone(s);
  assert.equal(enemyThreatAt(s, 'A', 9, 5).n, 1);
  assert.equal(enemyThreatAt(s, 'A', 6, 5).n, 1);
  assert.deepEqual(s, before);
});

test('无武器单位不会吓退 AI，军事建筑的真实火力会计入威胁', () => {
  const s = fixture();
  place(s, 'B', type(s, 'unarmed', { atk: 0, range: 1, move: 4, category: 'economy' }), 2, 3);
  place(s, 'B', type(s, 'tower', { move: 0, range: 3, category: 'building', autoAttack: true }), 8, 5);
  assert.equal(inDanger(s, 'A', 2, 4), false);
  assert.equal(enemyThreatAt(s, 'A', 6, 5).n, 1);
});

test('水军威胁从实际航道延伸，不穿越陆地', () => {
  const s = fixture();
  s.tiles[idx(s, 5, 5)] = { terrain: 'water', cityId: null };
  place(s, 'B', type(s, 'boat', { domain: 'water', move: 4 }), 5, 5);
  assert.equal(inDanger(s, 'A', 6, 5), true);
  assert.equal(inDanger(s, 'A', 8, 5), false);
});

test('玩家视图之外的敌军不会进入威胁图', () => {
  const s = fixture();
  s.fog = true;
  place(s, 'B', type(s, 'hidden', { range: 4 }), 10, 10);
  const view = playerView(s, 'A').state;
  assert.equal(view.units.length, 0);
  assert.equal(inDanger(view, 'A', 9, 10), false);
});

test('自定义小数射程按整数棋格计算，超长射程最多覆盖整张棋盘', () => {
  const s = fixture();
  place(s, 'B', type(s, 'fractional', { range: 1.5, move: 0 }), 5, 5);
  assert.equal(inDanger(s, 'A', 6, 5), true);
  assert.equal(inDanger(s, 'A', 7, 5), false);
  const huge = fixture();
  place(huge, 'B', type(huge, 'huge', { range: 1000000, move: 0 }), 5, 5);
  assert.equal(inDanger(huge, 'A', 11, 11), true);
});

test('完全打不动目标时不浪费攻击机会', () => {
  const s = fixture();
  const own = place(s, 'A', type(s, 'weak'), 5, 5);
  own.moved = true;
  place(s, 'B', type(s, 'armored', { armor: 100 }), 6, 5);
  assert.equal(aiNextAction(s, NO_PRODUCTION), null);
});

test('主目标零伤害但可以溅射伤敌时仍会攻击', () => {
  const s = fixture();
  const own = place(s, 'A', type(s, 'splash', { splash: 1 }), 5, 5);
  own.moved = true;
  const primary = place(s, 'B', type(s, 'armored', { armor: 100 }), 6, 5);
  place(s, 'B', type(s, 'soft'), 7, 5);
  const action = aiNextAction(s, NO_PRODUCTION);
  assert.deepEqual(action, { type: 'ATTACK', unitId: own.id, targetId: primary.id });
  assert.ok(applyAction(s, action!).ok);
});

function defenseScene(): { s: GameState; threat: Unit; decoy: Unit; own: Unit } {
  const s = fixture();
  const own = place(s, 'A', type(s, 'archer', { range: 3, move: 2 }), 4, 6);
  const threat = place(s, 'B', type(s, 'siege', { cost: 25 }), 3, 8);
  const decoy = place(s, 'B', type(s, 'expensive', { cost: 1000, atk: 0 }), 6, 5);
  threat.hp = 1;
  decoy.hp = 1;
  return { s, threat, decoy, own };
}

test('最后城市即将被夺取时优先击杀攻城者，而不是追逐昂贵诱饵', () => {
  const { s, threat, own } = defenseScene();
  s.cities[0]!.hp = 1;
  const before = structuredClone(s);
  const action = aiNextAction(s, NO_PRODUCTION);
  assert.deepEqual(action, { type: 'ATTACK', unitId: own.id, targetId: threat.id });
  assert.deepEqual(aiNextAction(s, NO_PRODUCTION), action);
  assert.deepEqual(s, before);
  assert.ok(applyAction(s, action!).ok);
});

test('城市安全时仍选择有价值的交换，不永久追逐城边杂兵', () => {
  const { s, decoy, own } = defenseScene();
  assert.deepEqual(aiNextAction(s, NO_PRODUCTION), { type: 'ATTACK', unitId: own.id, targetId: decoy.id });
});
