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
import { PER_LEVEL_PCT, cardTypeId, compileUnits, mergeUnits } from '../../../src/core/roguelike/compile.ts';
import { SETTLE, cityUpgradeCost, settleGold } from '../../../src/core/roguelike/rewards.ts';
import { WALL_STEPS, cityCapacity, citySizeFor, isInsideCity, settleRoster } from '../../../src/core/roguelike/roster.ts';
import { SLICE_STAGES, stageAt } from '../../../src/core/roguelike/stages.ts';
import { BRANCHES, BRANCH_MAIN_MUL, branchMul, branchOf, poolOfBranch, unitPack } from '../../../src/core/roguelike/branches.ts';
import { EXPANSIONS } from '../../../src/core/expansions.ts';
import { initRunner, keepPlaying, observe, onPlayerEndTurn, settleStage } from '../../../src/core/roguelike/runner.ts';
import { ENEMY_POOLS, WEAK_RATIO, pickEnemies, poolForStage, poolUnits } from '../../../src/core/roguelike/enemy-pools.ts';
import { UNIT_TYPES } from '../../../src/core/config.ts';
import { validateLevel } from '../../../src/core/level.ts';
import { applyAction, incomeOf } from '../../../src/core/rules.ts';
import { TACTICS, TACTIC_BY_ID, applyTacticNow } from '../../../src/core/roguelike/tactics.ts';
import {
  capacityBonus,
  cityArmorBonus,
  healsIntake,
  hornFreebies,
  skipMoney,
} from '../../../src/core/roguelike/relics.ts';
import { canUseType } from '../../../src/core/draft.ts';
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

  test('肉鸽：清空敌人进入撤离，按换手倒计时，到点结束', () => {
    const st = SLICE_STAGES[0]!;
    const ctx = {
      run: newRun(1, { allowRestart: true }),
      stageIndex: 0,
      evacTurns: st.meta.evacTurns,
      expectedTurns: st.meta.expectedTurns,
      playerSeat: 'A',
    };
    const r = validateLevel(st.level);
    assert.ok(r.ok);
    let state = createMatch({ ...DEFAULT_CONFIG, level: r.level }, 11);
    let snap = initRunner();
    assert.equal(snap.phase, 'battle');

    // 敌人清空（直接把 B 的兵拿掉，相当于全灭）
    const prev = state;
    state = { ...state, units: state.units.filter((u) => u.owner !== 'B') };
    snap = observe(prev, state, snap, ctx);
    assert.equal(snap.phase, 'evac');
    assert.equal(snap.evacLeft, st.meta.evacTurns);
    assert.equal(snap.clearedTurn, state.turn);

    // 同一手里再走一步（回合没换手）不该扣倒计时
    const same = observe(state, { ...state }, snap, ctx);
    assert.equal(same.evacLeft, snap.evacLeft);

    // 倒计时只认"玩家结束回合"，不猜状态变化
    const same2 = onPlayerEndTurn(snap, ctx);
    assert.equal(same2.evacLeft, st.meta.evacTurns - 1, '结束一回合扣一手');
    const doneSnap = onPlayerEndTurn(same2, ctx);
    assert.equal(doneSnap.phase, 'done', '第二回合结束就该结算');

    // 胜负被按下不表（撤离期间必须还能动）
    const withWinner = { ...state, winner: 'A' };
    keepPlaying(withWinner);
    assert.equal(withWinner.winner, null);
  });

  test('肉鸽：撤离结算——城内带走、城外折半、兵额上限', () => {
    const st = SLICE_STAGES[0]!;
    const r = validateLevel(st.level);
    assert.ok(r.ok);
    let state = createMatch({ ...DEFAULT_CONFIG, level: r.level }, 11);
    // 只留两个 A 的兵：一个在城里、一个在远处
    const city = state.cities.find((c) => c.owner === 'A')!;
    const inside = { ...state.units.find((u) => u.owner === 'A')!, x: city.x, y: city.y };
    const outside = { ...state.units.find((u) => u.owner === 'A' && u.id !== inside.id)!, x: 14, y: 14 };
    state = { ...state, units: [inside, outside], winner: null };

    const ctx = {
      run: newRun(1, { allowRestart: true }),
      stageIndex: 0,
      evacTurns: st.meta.evacTurns,
      expectedTurns: st.meta.expectedTurns,
      playerSeat: 'A',
    };
    const snap = { phase: 'done' as const, evacLeft: 0, clearedTurn: 3 };
    const res = settleStage(state, snap, ctx);
    assert.equal(res.taken.length, 1, '城里的那个应该被带走');
    assert.equal(res.taken[0]!.type, inside.type);
    assert.equal(res.left.length, 1, '城外那个带不走');
    assert.ok(res.refund > 0, '城外的人应该有抚恤');
    assert.ok(res.gold > 0);
    assert.equal(res.halfDone, false);
    // 期望手数是 6，清场在第 3 手 → 提前奖励进账
    assert.ok(res.gold > res.taken.length * 15, '提前结束应该有额外奖励');
  });

  test('肉鸽：兵额满了也不让城外人进来', () => {
    const st = SLICE_STAGES[0]!;
    const r = validateLevel(st.level);
    assert.ok(r.ok);
    let state = createMatch({ ...DEFAULT_CONFIG, level: r.level }, 13);
    const city = state.cities.find((c) => c.owner === 'A')!;
    const mk = (i: number, x: number, y: number) => ({ ...state.units.find((u) => u.owner === 'A')!, id: `x${i}`, x, y });
    // 城里塞 6 个（城 2×2 只有 4 格，但站得住——兵额按格子算 4）
    state = {
      ...state,
      units: [mk(1, city.x, city.y), mk(2, city.x + 1, city.y), mk(3, city.x, city.y + 1), mk(4, city.x + 1, city.y + 1), mk(5, 14, 14)],
      winner: null,
    };
    const ctx = { run: newRun(1, { allowRestart: true }), stageIndex: 0, evacTurns: 2, expectedTurns: 6, playerSeat: 'A' };
    const res = settleStage(state, { phase: 'done', evacLeft: 0, clearedTurn: 4 }, ctx);
    assert.ok(res.taken.length <= 4, '带走人数不能超过兵额');
    assert.ok(res.left.length >= 1);
  });

  test('肉鸽：noIncome 让城市与经济单位都不产钱', () => {
    const st = SLICE_STAGES[0]!;
    const r = validateLevel(st.level);
    assert.ok(r.ok);
    const normal = createMatch({ ...DEFAULT_CONFIG, level: r.level }, 21);
    const dry = createMatch({ ...DEFAULT_CONFIG, level: r.level, noIncome: true } as never, 21);
    assert.ok(incomeOf(normal, 'A') > 0, '普通对局应该有收入');
    assert.equal(incomeOf(dry, 'A'), 0, 'noIncome 下必须一分不产');
  });

  test('肉鸽：enabledUnits 会连兵种表一起裁（所以不能拿它做"只能造卡"）', () => {
    const st = SLICE_STAGES[0]!;
    const r = validateLevel(st.level);
    assert.ok(r.ok);
    const s = createMatch(
      { ...DEFAULT_CONFIG, level: r.level, enabledUnits: ['militia', 'archer'] } as never,
      22,
    );
    assert.deepEqual([...s.config.enabledUnits].sort(), ['archer', 'militia']);
    /*
     * 关键事实：**兵种表会被一起裁掉**（不是"只是造不出来"）。
     * 关卡摆兵是按 `state.unitTypes` 查兵种的，所以拿它收窄"可造"，
     * 会连带把关卡里 deploy 的骑士/长弓变成"这一局没有这个兵种"而被静默跳过。
     */
    assert.equal(s.unitTypes.spearman, undefined, '这个行为本身就是坑，别拿它收窄可造集');
  });

  test('肉鸽：recruitOnly 只夹"能不能造"，不裁兵种表', () => {
    const r = validateLevel(SLICE_STAGES[0]!.level); // 第 3 关有长弓、骑士
    assert.ok(r.ok);
    const s = createMatch(
      { ...DEFAULT_CONFIG, level: r.level, recruitOnly: ['militia', 'archer'], noIncome: true } as never,
      31,
    );
    assert.equal(canUseType(s, 'A', 'militia'), true);
    assert.equal(canUseType(s, 'A', 'spearman'), false, '没抽到的兵种不该能造');
    // 关键：兵种表完整，所以关卡摆的敌人还在
    assert.ok(s.unitTypes.knight, '兵种表必须完整（否则关卡摆兵会被静默跳过）');
    assert.ok(s.units.filter((u) => u.owner === 'B').length > 0, '敌人必须还在场上');
    // 普通对局不受影响
    const plain = createMatch({ ...DEFAULT_CONFIG, level: r.level }, 32);
    assert.equal(canUseType(plain, 'A', 'spearman'), true);
  });

  test('肉鸽：战术卡——补给立刻给钱，空投进背包，修整回满血', () => {
    assert.equal(TACTICS.length, 3);
    const run = newRun(1, { allowRestart: true });
    run.gold = 10;
    run.roster = [{ type: 'militia', hp: 3, cardLv: 0 }];
    const maxHp = () => 28;

    applyTacticNow('supply', run, maxHp);
    assert.equal(run.gold, 130, '补给应该立刻 +120');

    applyTacticNow('airdrop', run, maxHp);
    assert.deepEqual(run.tactics, ['airdrop'], '空投要留在背包里等下一关');

    applyTacticNow('repair', run, maxHp);
    assert.equal(run.roster[0]!.hp, 28, '修整应该回满');

    // 背包要能过存档
    const back = parseRun(serializeRun(run));
    assert.ok(back);
    assert.deepEqual(back.tactics, ['airdrop']);
    assert.ok(TACTIC_BY_ID.supply.name.length > 0);
  });

  test('肉鸽：遗物真的生效——铁壁/驮马/号角/军械/吝啬鬼', () => {
    const run = newRun(1, { allowRestart: true });
    assert.equal(cityArmorBonus(run), 0, '没遗物就是 0');
    assert.equal(capacityBonus(run), 0);
    assert.equal(hornFreebies(run), 0);
    assert.equal(healsIntake(run), false);
    assert.equal(skipMoney(run), 80);

    run.relics = ['ironwall', 'packhorse', 'horn', 'arsenal', 'miser'];
    assert.equal(cityArmorBonus(run), 2, '铁壁：城防 +2');
    assert.equal(capacityBonus(run), 2, '驮马：兵额 +2');
    assert.equal(hornFreebies(run), 2, '号角：2 个免费民兵');
    assert.equal(healsIntake(run), true, '军械：带回满血');
    assert.equal(skipMoney(run), 160, '吝啬鬼：不选拿钱翻倍');
  });

  test('肉鸽：驮马与军械在撤离结算里生效', () => {
    const st = SLICE_STAGES[0]!;
    const r = validateLevel(st.level);
    assert.ok(r.ok);
    let state = createMatch({ ...DEFAULT_CONFIG, level: r.level }, 41);
    const city = state.cities.find((c) => c.owner === 'A')!;
    const mk = (i: number, x: number, y: number, hp: number) => ({
      ...state.units.find((u) => u.owner === 'A')!,
      id: `z${i}`,
      x,
      y,
      hp,
    });
    // 城里 5 个（超过默认兵额 4）+ 城外 1 个
    state = {
      ...state,
      units: [
        mk(1, city.x, city.y, 5),
        mk(2, city.x + 1, city.y, 5),
        mk(3, city.x, city.y + 1, 5),
        mk(4, city.x + 1, city.y + 1, 5),
        mk(5, city.x, city.y, 5),
        mk(6, 14, 14, 5),
      ],
      winner: null,
    };
    const base = { run: newRun(1, { allowRestart: true }), stageIndex: 0, evacTurns: 2, expectedTurns: 6, playerSeat: 'A' as const };
    const plain = settleStage(state, { phase: 'done', evacLeft: 0, clearedTurn: 4 }, base);
    const buffed = settleStage(state, { phase: 'done', evacLeft: 0, clearedTurn: 4 }, {
      ...base,
      capacityBonus: 2,
      healIntake: true,
    });
    assert.ok(buffed.taken.length > plain.taken.length, '驮马应该多带走几个人');
    assert.ok(buffed.taken.every((u) => u.hp >= 5), '军械只能加血不能减');
    assert.ok(buffed.taken.every((u) => typeof u.hp === 'number'));
  });

  test('肉鸽：撤离期间回合必须照常推进（holdWinner）', () => {
    const st = SLICE_STAGES[0]!;
    const r = validateLevel(st.level);
    assert.ok(r.ok);
    let s = createMatch({ ...DEFAULT_CONFIG, level: r.level, holdWinner: true } as never, 77);
    // 清空敌人后，结束回合必须"换手 + turn+1"，否则 moved 标记永远不重置
    s.units = s.units.filter((u) => u.owner === 'A');
    const before = s.turn;
    const res = applyAction(s, { type: 'END_TURN' });
    assert.ok(res.ok, '结束回合应当被接受');
    assert.ok(res.state.turn > before, '回合必须推进');
    assert.equal(res.state.winner, null, 'holdWinner 下不该判胜负');

    // 关掉开关后照常判胜（普通对局不受影响）
    const plain = createMatch({ ...DEFAULT_CONFIG, level: r.level } as never, 78);
    plain.units = plain.units.filter((u) => u.owner === 'A');
    const res2 = applyAction(plain, { type: 'END_TURN' });
    assert.ok(res2.ok);
    assert.equal(res2.state.winner, 'A', '没开关时清场即判胜，老行为不变');
  });

  test('肉鸽：卡每级 +25%，且真的改到攻击/血量', () => {
    const base = UNIT_TYPES.militia!;
    const out = compileUnits({ militia: 3 });
    assert.equal(out[cardTypeId('militia', 1)]!.atk, Math.round(base.atk * 1.25), '一级应当 +25% 攻');
    assert.equal(out[cardTypeId('militia', 1)]!.maxHp, Math.round(base.maxHp * 1.25), '一级应当 +25% 血');
    const six = compileUnits({ militia: 6 });
    assert.equal(six[cardTypeId('militia', 2)]!.atk, Math.round(base.atk * 1.5), '两级 +50%');
    assert.ok(out[cardTypeId('militia', 1)]!.atk > base.atk, '数字必须真的变大，不能是 NaN');
    assert.ok(Number.isFinite(out[cardTypeId('militia', 1)]!.atk));
  });

  test('肉鸽：强化兵只属于玩家，敌人既造不到也不被卡池限制', () => {
    const st = SLICE_STAGES[2]!; // Boss 关：敌人有城，会产兵
    const r = validateLevel(st.level);
    assert.ok(r.ok);
    const units = mergeUnits(undefined, compileUnits({ spearman: 3 }));
    const s = createMatch(
      { ...DEFAULT_CONFIG, level: r.level, recruitOnly: [cardTypeId('spearman', 1)] } as never,
      91,
      units,
    );
    assert.ok(s.unitTypes[cardTypeId('spearman', 1)], '强化版应当在兵种表里');
    // 玩家能造自己的强化版
    assert.equal(canUseType(s, 'A', cardTypeId('spearman', 1)), true);
    // 敌人造不到：那是玩家的兵
    assert.equal(canUseType(s, 'B', cardTypeId('spearman', 1)), false, '敌人不该能造玩家的强化兵');
    // 敌人也不该被玩家的卡池限制（Boss 有城，要能正常出兵）
    assert.equal(canUseType(s, 'B', 'spearman'), true, 'Boss 不该被玩家的卡池卡住');
    // 玩家自己的原版兵被卡池挡着
    assert.equal(canUseType(s, 'A', 'spearman'), false);
  });

  test('肉鸽：城血跨关保留，修城下一关补满', () => {
    const run = newRun(1, { allowRestart: true });
    run.cityHp = 9;
    run.freeBuilds = 2;
    const back = parseRun(serializeRun(run));
    assert.ok(back);
    assert.equal(back.cityHp, 9, '城血要过存档');
    assert.equal(back.freeBuilds, 2);
    assert.equal(back.repairNext, false);

    run.repairNext = true;
    assert.equal(parseRun(serializeRun(run))!.repairNext, true, '修城标记要过存档');
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
    const a2 = table[cardTypeId('archer', 2)]!;
    assert.equal(a2.atk, Math.round(11 * (1 + PER_LEVEL_PCT.atk * 2)));
    assert.equal(a2.maxHp, Math.round(24 * (1 + PER_LEVEL_PCT.maxHp * 2)));
    assert.ok(a2.atk > 11 && a2.maxHp > 24);
    // 原 id 不能被覆盖（否则敌人的同名兵也会变强）
    assert.equal(table.archer, undefined, '不许覆盖基础兵种');
    assert.equal(table[cardTypeId('militia', 1)], undefined, '基础表里没有的兵种不该被凭空造出来');
  });

  test('肉鸽：百分比加成随等级线性且不翻倍', () => {
    const base = { cheap: { id: 'cheap', atk: 4, maxHp: 10 } };
    const lv1 = compileUnits({ cheap: 3 }, base)[cardTypeId('cheap', 1)];
    const lv3 = compileUnits({ cheap: 9 }, base)[cardTypeId('cheap', 3)];
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

  test('肉鸽：九场遭遇（三幕×三场）都能过校验并建出局', () => {
    assert.equal(SLICE_STAGES.length, 9);
    for (const st of SLICE_STAGES) {
      const r = validateLevel(st.level);
      assert.ok(r.ok, `${st.level.name} 校验失败：${!r.ok ? r.errors.join(' / ') : ''}`);
      const s = createMatch({ ...DEFAULT_CONFIG, level: r.level }, 11);
      const b = s.units.filter((u) => u.owner === 'B').length;
      assert.ok(b > 0, `${st.level.name} 的敌人没摆上去`);
      /*
       * 三幕结构：前两场是精英（无城），第三场是 Boss（**带城**）。
       * 2026-11-19 定：城只给 Boss，精英改成「一只新怪 + 常规队」。
       */
      const foeCities = s.cities.filter((c) => c.owner === 'B').length;
      if (st.meta.slot === 3) {
        assert.equal(foeCities, 1, `${st.level.name} 是 Boss，应当有城`);
        assert.ok(!(st.level.seats.cityless ?? []).includes('B'), 'Boss 不该是无城席位');
      } else {
        assert.equal(foeCities, 0, `${st.level.name} 是精英关，不该有城`);
        assert.ok((st.level.seats.cityless ?? []).includes('B'), '精英关的敌人是无城席位');
      }
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
