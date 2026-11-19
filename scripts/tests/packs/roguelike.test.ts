// @ts-nocheck
/**
 * 肉鸽切片的纯逻辑用例（2026-11-19）。
 *
 * 只测**不需要棋盘**的部分：存档往返、卡牌等级、兵种表编译、结算公式、兵额撤离。
 * 撤离状态机（runner）等有 UI 之后再补无头冒烟。
 */

import { test, assert } from '../support.ts';
import {
  RUN_KEY,
  canRestart,
  newRun,
  parseRun,
  serializeRun,
} from '../../../src/core/roguelike/run-state.ts';
import { CARDS_PER_LEVEL, cardLevel, cardWeight, cardsToNext, drawCards } from '../../../src/core/roguelike/cards.ts';
import { PER_LEVEL_PCT, compileUnits, mergeUnits } from '../../../src/core/roguelike/compile.ts';
import { SETTLE, cityUpgradeCost, settleGold } from '../../../src/core/roguelike/rewards.ts';
import { WALL_STEPS, cityCapacity, citySizeFor, isInsideCity, settleRoster } from '../../../src/core/roguelike/roster.ts';
import { SLICE_STAGES, stageAt } from '../../../src/core/roguelike/stages.ts';
import { BRANCHES, BRANCH_MAIN_MUL, branchMul, branchOf, poolOfBranch, unitPack } from '../../../src/core/roguelike/branches.ts';
import { EXPANSIONS } from '../../../src/core/expansions.ts';
import { ENEMY_POOLS, WEAK_RATIO, pickEnemies, poolForStage, poolUnits } from '../../../src/core/roguelike/enemy-pools.ts';
import { UNIT_TYPES } from '../../../src/core/config.ts';
import { validateLevel } from '../../../src/core/level.ts';
import { createMatch, DEFAULT_CONFIG } from '../../../src/core/setup.ts';

export function run() {
  test('肉鸽：新 run 的默认值', () => {
    const r = newRun(123, { allowRestart: true });
    assert.equal(r.cityEra, 1, '开局是青铜时代');
    assert.equal(r.branch, 'cold', '默认分支是冷兵器');
    assert.equal(r.v, 1);
    assert.equal(r.gold, 0);
    assert.equal(r.totalStages, 3);
    assert.deepEqual(r.roster, []);
    assert.deepEqual(r.cards, {});
    assert.equal(r.allowRestart, true);
    assert.equal(RUN_KEY, 'warchess:run:v1');
  });

  test('肉鸽：存档往返不丢字段', () => {
    const r = newRun(7, { allowRestart: false });
    r.gold = 140;
    r.roster = [{ type: 'militia', hp: 9, cardLv: 0 }];
    r.cards = { archer: 2 };
    r.wallProgress = 1;
    const back = parseRun(serializeRun(r));
    assert.ok(back);
    assert.equal(back.gold, 140);
    assert.deepEqual(back.roster, [{ type: 'militia', hp: 9, cardLv: 0 }]);
    assert.deepEqual(back.cards, { archer: 2 });
    assert.equal(back.wallProgress, 1);
    assert.equal(back.allowRestart, false);
  });

  test('肉鸽：坏存档与旧版本都返回 null（宁可重开）', () => {
    assert.equal(parseRun(null), null);
    assert.equal(parseRun('不是 json'), null);
    assert.equal(parseRun(JSON.stringify({ v: 99, seed: 1, roster: [] })), null);
  });

  test('肉鸽：不允许重开时 canRestart 为假', () => {
    assert.equal(canRestart(newRun(1, { allowRestart: false })), false);
    assert.equal(canRestart(newRun(1, { allowRestart: true })), true);
  });

  test('肉鸽：三张同名卡合成一级', () => {
    assert.equal(CARDS_PER_LEVEL, 3);
    assert.equal(cardLevel(0), 0);
    assert.equal(cardLevel(2), 0);
    assert.equal(cardLevel(3), 1);
    assert.equal(cardLevel(5), 1);
    assert.equal(cardLevel(6), 2);
    assert.equal(cardsToNext(2), 1);
    assert.equal(cardsToNext(3), 3);
  });

  test('肉鸽：抽卡确定性 + 差一张升级的卡优先出现', () => {
    const pool = ['militia', 'archer', 'knight', 'longbow', 'scout'];
    const a = drawCards(pool, {}, 42, 3);
    const b = drawCards(pool, {}, 42, 3);
    assert.deepEqual(a, b, '同一 seed 必须抽到同一组');
    assert.equal(new Set(a).size, 3, '三选一不能重复');

    const near = drawCards(pool, { archer: 2 }, 99, 3);
    assert.ok(near.includes('archer'), '差一张就升级的卡应该出现在候选里');
  });

  test('肉鸽：城市时代限制可抽的兵种，高阶出率更高', () => {
    const eraOf = (id: string): number => (id === 'a1' ? 1 : id === 'a2' ? 2 : 3);
    const pool = ['a1', 'a2', 'a3'];

    // 城市只有一代：二三代的卡抽不到
    const low = drawCards(pool, {}, 5, 2, { cityEra: 1, eraOf });
    assert.ok(!low.includes('a2') && !low.includes('a3'), `一代城市不该抽到高等兵：${low}`);

    // 城市到三代：只抽 1 个、统计 200 个种子的首个候选（抽 3 个必然全有，测不出权重）
    let c1 = 0;
    let c3 = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const first = drawCards(pool, {}, seed, 1, { cityEra: 3, eraOf })[0];
      if (first === 'a1') c1 += 1;
      if (first === 'a3') c3 += 1;
    }
    assert.ok(c3 > c1 * 1.2, `三代应该更常见：一代 ${c1} 次 / 三代 ${c3} 次`);
    // 权重本身也要能单测
    assert.ok(cardWeight(3, 3, false) > cardWeight(1, 3, false));
  });

  test('肉鸽：分支是主题线，每条都有足够多的兵种可抽', () => {
    // 包里的兵在 node 下不一定进了 UNIT_TYPES，这里自己拼全集
    const ids = [
      ...Object.keys(UNIT_TYPES),
      ...EXPANSIONS.flatMap((e) => (e.units ?? []).map((u) => u.id)),
    ];
    const eraMap = new Map<string, number>();
    for (const id of Object.keys(UNIT_TYPES)) eraMap.set(id, UNIT_TYPES[id]!.era);
    for (const e of EXPANSIONS) for (const u of e.units ?? []) eraMap.set(u.id, u.era);
    const eraOf = (id: string): number => eraMap.get(id) ?? 1;

    for (const b of BRANCHES) {
      const pool = poolOfBranch(b.id, { ids, eraOf, cityEra: 8 });
      const floor = b.id === 'naval' || b.id === 'air' ? 10 : 15;
      assert.ok(pool.length >= floor, `${b.name} 只有 ${pool.length} 个兵，池子太薄`);
    }
    // 冷兵器线必须能覆盖"整包 + 时代军备"，这是用户点名的要求
    assert.ok(poolOfBranch('cold', { ids, eraOf, cityEra: 8 }).length >= 40, '冷兵器线应该很大');
  });

  test('肉鸽：兵种按包归线，经济/建筑不进卡池', () => {
    const econ = Object.keys(UNIT_TYPES).find((id) => UNIT_TYPES[id]!.category !== 'combat');
    if (econ) assert.equal(branchOf(econ), null, '经济/建筑不该有分支');
    // 原版民兵属于冷兵器线
    assert.equal(branchOf('militia')?.id, 'cold');
    assert.equal(unitPack('militia'), 'base');
  });

  test('肉鸽：主分支权重 ×3，抽卡偏向主分支', () => {
    assert.equal(BRANCH_MAIN_MUL, 3);
    const ids = [
      ...Object.keys(UNIT_TYPES),
      ...EXPANSIONS.flatMap((e) => (e.units ?? []).map((u) => u.id)),
    ];
    const pool = poolOfBranch('cold', { ids, cityEra: 8 });
    assert.ok(pool.length > 10);
    for (const id of pool.slice(0, 20)) {
      assert.equal(branchMul(id, 'cold'), BRANCH_MAIN_MUL);
    }
    let mains = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      const pick = drawCards(ids, {}, seed, 1, { branch: 'cold' })[0];
      if (pick && branchOf(pick)?.id === 'cold') mains += 1;
    }
    assert.ok(mains > 50, `主分支应占多数，实际 ${mains}/100`);
  });

  test('肉鸽：前几场弱怪池、后几场强怪池', () => {
    assert.equal(WEAK_RATIO, 0.6);
    // 3 场：0、1 弱，2 强
    assert.equal(poolForStage(0, 3), 'weak');
    assert.equal(poolForStage(1, 3), 'weak');
    assert.equal(poolForStage(2, 3), 'strong');
    // 9 场：前 5 弱
    assert.equal(poolForStage(4, 9), 'weak');
    assert.equal(poolForStage(5, 9), 'strong');
    // 单场 run 也不能一上来就是强池
    assert.equal(poolForStage(0, 1), 'weak');

    assert.ok(poolUnits('weak').length >= 3, '弱池太薄');
    assert.ok(poolUnits('strong').length >= 3, '强池太薄');
    for (const id of [...ENEMY_POOLS.weak, ...ENEMY_POOLS.strong]) {
      assert.ok(UNIT_TYPES[id], `池子里的 ${id} 在兵种表里不存在`);
    }
  });

  test('肉鸽：敌人抽取确定性，且不会整队同型', () => {
    const pool = poolUnits('strong');
    const a = pickEnemies(pool, { count: 4, seed: 77 });
    const b = pickEnemies(pool, { count: 4, seed: 77 });
    assert.deepEqual(a, b, '同 seed 必须抽到同一队');
    assert.equal(a.length, 4);
    for (const id of a) assert.ok(pool.includes(id));
    assert.ok(new Set(a).size >= 2, `四个敌人不该全同型：${a}`);

    // 地图标签命中偏好的兵权重更高
    const tagged = pickEnemies(pool, {
      count: 6,
      seed: 5,
      arenaTags: ['forest'],
      tagsOf: (id) => (id === 'longbow' ? ['forest'] : []),
    });
    assert.ok(tagged.includes('longbow'), '带偏好标签的兵应该更容易出现');
  });

  test('肉鸽：升城市时代价钱递增', () => {
    assert.ok(cityUpgradeCost(2) > cityUpgradeCost(1));
    assert.ok(cityUpgradeCost(3) > cityUpgradeCost(2));
    assert.equal(cityUpgradeCost(1), 140);
  });

  test('肉鸽：卡等级按百分比加攻加血', () => {
    const base = {
      archer: { id: 'archer', name: '弓', atk: 11, maxHp: 24 },
    };
    // 6 张 = 2 级
    const table = compileUnits({ archer: 6, militia: 3 }, base);
    assert.equal(table.archer.atk, Math.round(11 * (1 + PER_LEVEL_PCT.atk * 2)));
    assert.equal(table.archer.maxHp, Math.round(24 * (1 + PER_LEVEL_PCT.maxHp * 2)));
    assert.ok(table.archer.atk > 11 && table.archer.maxHp > 24);
    assert.equal(table.militia, undefined, '基础表里没有的兵种不该被凭空造出来');
  });

  test('肉鸽：百分比加成随等级线性且不翻倍', () => {
    const base = { cheap: { id: 'cheap', atk: 4, maxHp: 10 } };
    const lv1 = compileUnits({ cheap: 3 }, base).cheap;
    const lv3 = compileUnits({ cheap: 9 }, base).cheap;
    assert.equal(lv1.atk, Math.round(4 * (1 + PER_LEVEL_PCT.atk)));
    assert.ok(lv3.atk > lv1.atk);
    // 3 级也不该翻倍（12% × 3 = 36%）
    assert.ok(lv3.atk < 4 * 2, '低攻杂兵不该被卡牌翻倍');
  });

  test('肉鸽：没有卡时不产生覆盖项', () => {
    assert.deepEqual(compileUnits({ militia: 2 }), {});
    const merged = mergeUnits({ militia: { id: 'militia', atk: 13 } }, {});
    assert.equal(merged.militia.atk, 13, '原表必须保留');
  });

  test('肉鸽：结算公式各分支', () => {
    assert.equal(
      settleGold({ stageIndex: 0, taken: 0, turnsSaved: 0, campDestroyed: false, halfDone: false }),
      SETTLE.base,
    );
    // 第 2 关：基础 80 + 3 人 45 + 省 2 手 16
    assert.equal(
      settleGold({ stageIndex: 1, taken: 3, turnsSaved: 2, campDestroyed: false, halfDone: false }),
      80 + 45 + 16,
    );
    // 提前结束奖励有上限
    assert.equal(
      settleGold({ stageIndex: 0, taken: 0, turnsSaved: 999, campDestroyed: false, halfDone: false }),
      SETTLE.base + SETTLE.turnCap,
    );
    // 拆营地
    assert.equal(
      settleGold({ stageIndex: 0, taken: 0, turnsSaved: 0, campDestroyed: true, halfDone: false }),
      SETTLE.base + SETTLE.camp,
    );
    // 败退三成
    assert.equal(
      settleGold({ stageIndex: 0, taken: 0, turnsSaved: 0, campDestroyed: false, halfDone: true }),
      Math.floor(SETTLE.base * SETTLE.retreatRate),
    );
  });

  test('肉鸽：兵额 = 城格数，加固两次升一级', () => {
    assert.equal(cityCapacity(2), 4);
    assert.equal(cityCapacity(3), 9);
    assert.equal(WALL_STEPS, 2);
    assert.equal(citySizeFor(0), 2);
    assert.equal(citySizeFor(1), 2, '加固一次还不够');
    assert.equal(citySizeFor(2), 3);
    assert.equal(cityCapacity(citySizeFor(2)), 9);
  });

  test('肉鸽：城格判定按左上角起算', () => {
    const city = { x: 4, y: 5 };
    assert.equal(isInsideCity(4, 5, city, 2), true);
    assert.equal(isInsideCity(5, 6, city, 2), true);
    assert.equal(isInsideCity(6, 6, city, 2), false);
    assert.equal(isInsideCity(4, 7, city, 2), false);
  });

  test('肉鸽：撤离时城内超员按身价从高到低保人，城外折半', () => {
    const inside = [
      { type: 'cheap', hp: 5, cardLv: 0 },
      { type: 'pricey', hp: 9, cardLv: 1 },
      { type: 'mid', hp: 7, cardLv: 0 },
    ];
    const outside = [{ type: 'lost', hp: 3, cardLv: 0 }];
    const valueOf = (u) => (u.type === 'pricey' ? 200 : u.type === 'mid' ? 100 : 60);
    const r = settleRoster(inside, outside, 2, valueOf);
    assert.deepEqual(
      r.taken.map((u) => u.type),
      ['pricey', 'mid'],
      '两个名额应该给贵的',
    );
    assert.deepEqual(
      r.left.map((u) => u.type).sort(),
      ['cheap', 'lost'],
    );
    // 60/2 + 60/2 = 60
    assert.equal(r.refund, 30 + 30);
  });

  test('肉鸽：关卡不再写死时代（时代由 run 决定）', () => {
    for (const st of SLICE_STAGES) {
      assert.equal(st.level.setup?.startEra, undefined, `${st.level.name} 不该钉时代`);
    }
  });

  test('肉鸽：三场手写遭遇都能过校验并建出局', () => {
    assert.equal(SLICE_STAGES.length, 3);
    for (const st of SLICE_STAGES) {
      const r = validateLevel(st.level);
      assert.ok(r.ok, `${st.level.name} 校验失败：${!r.ok ? r.errors.join(' / ') : ''}`);
      const s = createMatch({ ...DEFAULT_CONFIG, level: r.level }, 11);
      const b = s.units.filter((u) => u.owner === 'B').length;
      assert.ok(b > 0, `${st.level.name} 的敌人没摆上去`);
      assert.equal(
        s.cities.filter((c) => c.owner === 'B').length,
        0,
        `${st.level.name} 的敌人不该有城（cityless）`,
      );
      assert.equal(s.cities.filter((c) => c.owner === 'A').length, 1, '玩家必须有一座城');
      assert.ok(st.meta.evacTurns >= 1);
      assert.ok(st.meta.expectedTurns >= st.meta.evacTurns);
    }
  });

  test('肉鸽：节点越界钳到最后一场', () => {
    assert.equal(stageAt(-5).level.id, SLICE_STAGES[0].level.id);
    assert.equal(stageAt(99).level.id, SLICE_STAGES[SLICE_STAGES.length - 1].level.id);
  });

  test('肉鸽：城外全留在 left，兵额 0 时一个都带不走', () => {
    const r = settleRoster([{ type: 'a', hp: 1, cardLv: 0 }], [{ type: 'b', hp: 1, cardLv: 0 }], 0, () => 80);
    assert.equal(r.taken.length, 0);
    assert.equal(r.left.length, 2);
    assert.equal(r.refund, 40 + 40);
  });
}
