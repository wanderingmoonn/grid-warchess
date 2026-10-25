import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { UNIT_TYPES } from '../src/core/config.ts';
import { EXPANSIONS } from '../src/core/expansions.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { blankUnit, importCustomUnits, loadCustomUnits, saveCustomUnits, upsertCustomUnit } from '../src/core/customUnits.ts';
import { isUnitTypeDef } from '../src/core/validation.ts';

const storage = new Map<string, string>();
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let writable = true;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (!writable) throw new Error('storage unavailable');
      storage.set(key, value);
    },
  },
});
beforeEach(() => { storage.clear(); writable = true; });
after(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('内置与扩展兵种全部满足共享结构校验', () => {
  for (const def of [...Object.values(UNIT_TYPES), ...EXPANSIONS.flatMap((e) => e.units ?? [])]) {
    assert.ok(isUnitTypeDef(def), def.id);
  }
});

test('兵种库拒绝残缺字段、非有限数值和损坏的嵌套数据', () => {
  const valid = blankUnit({});
  for (const patch of [
    { name: undefined }, { maxHp: 0 }, { era: 1.5 }, { cost: -1 },
    { atk: Infinity }, { move: NaN }, { builds: [null] }, { abilities: {} },
    { incomeByTerrain: { water: -1 } }, { domain: 'air' }, { id: '__proto__' },
  ]) assert.equal(isUnitTypeDef({ ...valid, ...patch }), false, JSON.stringify(patch));
  assert.equal(isUnitTypeDef({ ...valid, cost: 0, atk: 10000, abilities: ['future-ability'] }), true);
});

test('本地兵种库不能覆盖内置兵种或带入残缺记录', () => {
  const valid = blankUnit({});
  storage.set('warchess:custom-units:v1', JSON.stringify({
    [valid.id]: valid,
    militia: UNIT_TYPES.militia,
    c_broken: { id: 'c_broken', cost: 1, atk: 1 },
  }));
  assert.deepEqual(Object.keys(loadCustomUnits()), [valid.id]);
  assert.equal(upsertCustomUnit(UNIT_TYPES.militia!), false);
  assert.equal(saveCustomUnits({ militia: UNIT_TYPES.militia! }), false);
});

test('导入重编号同时修复建造者对自定义建筑的引用', () => {
  const existing = blankUnit({});
  assert.equal(upsertCustomUnit(existing), true);
  const builder = { ...blankUnit({}), category: 'builder', builds: ['c_2', 'tower'] };
  const building = { ...blankUnit({}), id: 'c_2', category: 'building', move: 0 };
  const count = importCustomUnits(JSON.stringify({
    kind: 'warchess-units', version: 1, units: { c_1: builder, c_2: building, broken: null },
  }));
  assert.equal(count, 2);
  const loaded = loadCustomUnits();
  assert.deepEqual(loaded.c_1, existing);
  assert.deepEqual(loaded.c_2!.builds, ['c_3', 'tower']);
  assert.equal(loaded.c_3!.category, 'building');
});

test('损坏或未知版本导入不污染兵种库', () => {
  for (const text of ['null', '[]', '{}', '{', JSON.stringify({
    kind: 'warchess-units', version: 2, units: { c_1: blankUnit({}) },
  })]) assert.equal(importCustomUnits(text), 0);
  assert.deepEqual(loadCustomUnits(), {});
});

test('存储失败不能报告导入或保存成功', () => {
  writable = false;
  assert.equal(upsertCustomUnit(blankUnit({})), false);
  assert.equal(importCustomUnits(JSON.stringify({
    kind: 'warchess-units', version: 1, units: { c_1: blankUnit({}) },
  })), 0);
});

test('对局拥有独立的能力、建造清单和地形产出数据', () => {
  const definition = {
    ...blankUnit({}), abilities: ['heal'], builds: ['tower'], incomeByTerrain: { plain: 2 },
  };
  const original = structuredClone(definition);
  const builtins = structuredClone(UNIT_TYPES);
  const first = createMatch(DEFAULT_CONFIG, 77, { [definition.id]: definition });
  const second = createMatch(DEFAULT_CONFIG, 77, { [definition.id]: definition });
  first.unitTypes[definition.id]!.abilities!.push('first-strike');
  first.unitTypes[definition.id]!.builds!.push('bridge');
  first.unitTypes[definition.id]!.incomeByTerrain!.plain = 99;
  for (const def of Object.values(first.unitTypes)) {
    if (def.abilities) def.abilities.push('test-only');
    if (def.builds) def.builds.push('test-only');
    if (def.incomeByTerrain) def.incomeByTerrain.plain = 999;
  }
  assert.deepEqual(definition, original);
  assert.deepEqual(second.unitTypes[definition.id], original);
  assert.deepEqual(UNIT_TYPES, builtins);
});

test('重复启用兵种不会改变开局部队与随机地图', () => {
  const config = { ...DEFAULT_CONFIG, expansionIds: [], enabledUnits: ['militia', 'archer'] };
  assert.deepEqual(
    createMatch({ ...config, enabledUnits: ['militia', 'militia', 'archer'] }, 73),
    createMatch(config, 73),
  );
});

test('保存后的配置保留实验参数，能够精确重建开局', () => {
  const config = { ...DEFAULT_CONFIG, secondGoldBonus: 0.1, noFirstIncome: true };
  const state = createMatch(config, 79);
  assert.deepEqual(createMatch(state.config, state.seed), state);
});
