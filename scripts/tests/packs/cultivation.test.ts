// @ts-nocheck
import { test, assert, stats, fresh, place2 } from '../support.ts';
import { applyAction, effectiveStats, movePower, maxHpOf, computeDamage, heroSkillsOf, unitYield, idx, abilityApi, STATUS_REGISTRY, produceAt, citiesOf } from '../../../src/core/rules.ts';
import { cultivationRank, getAgingYears, setCultivationExp } from '../../../src/core/cultivation-packs.ts';
import { SPIRIT_STONE } from '../../../src/core/cultivation/resources.ts';
// GameState 只在 nextTurn/unitOf 的签名里当类型用；@ts-nocheck 关掉了检查，
// 但漏了真 import 的话，将来取消 nocheck 会一次冒出十几个报错。
import type { GameState } from '../../../src/core/types.ts';
import { skillsOf } from '../../../src/core/query.ts';
import {
  getExp,
  addExp,
  expForRank,
  hpGainForRank,
  totalHpBonusForRank,
  maxHpDeltaBetween,
} from '../../../src/core/cultivation/progression.ts';
import { playerView } from '../../../src/core/fog.ts';
import { spiritAuraBonusOf, SPIRIT_AURA_LABEL } from '../../../src/core/cultivation/abilities/spirit-aura.ts';
import { TOWER_BURST_CHARGES, TOWER_CHARGE_COST } from '../../../src/core/cultivation/skills/spirit-tower-shot.ts';
import { CULTIVATION_HOOKS } from '../../../src/core/cultivation/hooks.ts';
import {
  KILL_EXP_CAP_BASE,
  KILL_EXP_CAP_PER_RANK,
  SWORD_KILL_EXP_MUL,
  killExpCapOfRank,
  killExpForRank,
  trueDamageForRank,
  trueDamageOf,
} from '../../../src/core/cultivation/stats.ts';
import { bodyWardPct, BODY_WARD_TIERS } from '../../../src/core/cultivation/abilities/body-ward.ts';
import { baseLifespanOf, getExpGrowth, getLifespan } from '../../../src/core/cultivation/progression.ts';
import { EXP_GROWTH_BLOOD } from '../../../src/core/cultivation/progression.ts';
import {
  bloodRiteRadiusForRank,
  bloodRiteExpMul,
  BLOOD_RITE_ALLY_EXP_MUL,
  BLOOD_RITE_LIFESPAN_COST,
} from '../../../src/core/cultivation/skills/blood-rite.ts';
import { getCultivationPanelLines } from '../../../src/core/cultivation/panel.ts';
import { CULTIVATION_PACK } from '../../../src/core/cultivation-packs.ts';
import { UNIT_IDS } from '../../../src/core/cultivation/identity.ts';
import { CULTIVATION_ABILITIES } from '../../../src/core/cultivation/abilities/index.ts';
import { CULTIVATOR_SKILL_UNLOCKS } from '../../../src/core/cultivation/skills/unlocks.ts';
import { CULTIVATOR_ABILITY_UNLOCKS } from '../../../src/core/cultivation/abilities/unlocks.ts';
import { SKILL_EFFECTS, SKILL_PREVIEWERS } from '../../../src/core/skill-hooks.ts';
import { TELEPORT_COST, TELEPORT_RIFT_LOG } from '../../../src/core/cultivation/skills/teleport-swap.ts';

export function run() {
  console.log('\n修真扩展');

  test('修士：衰老先减益，超龄 3 年进入回光返照', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    
    qi.custom = { exp: 600 }; 
    assert.equal(cultivationRank(qi), 6, 'exp=600应该是 6 级');
    
    // 35 岁：无衰老
    qi.age = 35;
    const baseAtk = effectiveStats(s, qi).atk;
    const baseArmor = effectiveStats(s, qi).armor;
    
    // 超 1 岁，攻击 -2，护甲 -1
    qi.age = 65;
    assert.equal(effectiveStats(s, qi).atk, baseAtk - 2, '超 1 岁攻击减 2');
    assert.equal(effectiveStats(s, qi).armor, baseArmor - 1, '超 1 岁护甲减 1');
    
    // 超 3 岁，生命归 0 等待清场
    qi.age = 67;
    assert.equal(getAgingYears(qi), 3, '这里超龄 3 岁');
    
    // 模拟回合开始
    const r = applyAction({ ...s, current: 'A', units: [qi] }, { type: 'END_TURN' });
    assert.ok(r.ok);
    const r2 = applyAction(r.state, { type: 'END_TURN' });
    assert.ok(r2.ok);
    
    const doomed = r2.state.units.find(u => u.id === qi.id);
    assert.ok(doomed, '回光返照期间，单位还在场上');
    assert.equal(doomed.hp, 0, '生命值应归 0');
    assert.ok(r2.state.log.some(l => l.text.includes('油尽灯枯')), '战报应提示油尽灯枯');
    
    // 进行任意一次操作（比如结束回合），触发清场
    const r3 = applyAction(r2.state, { type: 'END_TURN' });
    assert.ok(r3.ok);
    assert.ok(!r3.state.units.some(u => u.id === qi.id), '一旦触发清场，应该被移除');
  });

  test('修士：满级（9 级）永远不会老死', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    qi.custom = { exp: 20000 }; // 9 级
    qi.age = 9999; // 活了快一万岁

    const r = applyAction({ ...s, current: 'A', units: [qi] }, { type: 'END_TURN' });
    assert.ok(r.ok);
    const r2 = applyAction(r.state, { type: 'END_TURN' });
    assert.ok(r2.ok);

    // 依然活着
    assert.ok(r2.state.units.some(u => u.id === qi.id), '满级修士不应该老死');
    // 也不应该有油尽灯枯的减益
    assert.equal(getAgingYears(r2.state.units.find(u => u.id === qi.id)!), 0, '满级修士不减益');
  });

  test('修士：溅射半径随境界成长（x/4）', () => {
    // 用一个工厂函数清理地图并摆好阵列，避免重复代码
    const setup = () => {
      const s = fresh({ expansionIds: ['cultivation'], godMode: true });
      // 清空一块平地
      for (let y = 3; y <= 7; y++) {
        for (let x = 4; x <= 10; x++) {
          s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
        }
      }
      s.unitTypes['target'] = { ...s.unitTypes.militia, id: 'target', armor: 0, maxHp: 1000, abilities: [] };
      
      // 靶子阵列：主目标 (5,5)，副目标1 (6,5) 距离 1，副目标2 (7,5) 距离 2
      const main = place2(s, 'B', 'target', 5, 5); main.hp = 1000;
      const near = place2(s, 'B', 'target', 6, 5); near.hp = 1000;
      const far  = place2(s, 'B', 'target', 7, 5); far.hp = 1000;
      
      // 修士在 (5,4)，距离主目标 1 格
      const qi = place2(s, 'A', 'qi-cultivator', 5, 4);
      qi.custom = { lifespan: 100 };
      
      return { s, qi, main, near, far };
    };

    {
      const { s, qi, main, near, far } = setup();
      qi.custom.exp = expForRank(2); // 3 级：floor(3/4) = 0
      const r = applyAction({ ...s, current: 'A', units: [qi, main, near, far] }, { type: 'ATTACK', unitId: qi.id, targetId: main.id });
      assert.ok(r.ok, r.ok ? '' : r.reason);
      assert.equal(r.state.units.find(u => u.id === near.id)!.hp, 1000, 'x=3 没有溅射');
    }

    {
      const { s, qi, main, near, far } = setup();
      qi.custom.exp = expForRank(3); // 4 级：floor(4/4) = 1
      const r = applyAction({ ...s, current: 'A', units: [qi, main, near, far] }, { type: 'ATTACK', unitId: qi.id, targetId: main.id });
      assert.ok(r.ok, r.ok ? '' : r.reason);
      assert.ok(r.state.units.find(u => u.id === near.id)!.hp < 1000, 'x=4 应该波及距离 1 的敌人');
      assert.equal(r.state.units.find(u => u.id === far.id)!.hp, 1000, 'x=4 够不到距离 2 的敌人');
    }

    // 3. x=8，半径 2：near 和 far 全波及
    {
      const { s, qi, main, near, far } = setup();
      qi.custom.exp = expForRank(7); // 8 级：floor(8/4) = 2
      const r = applyAction({ ...s, current: 'A', units: [qi, main, near, far] }, { type: 'ATTACK', unitId: qi.id, targetId: main.id });
      assert.ok(r.ok, r.ok ? '' : r.reason);
      assert.ok(r.state.units.find(u => u.id === near.id)!.hp < 1000, 'x=8 波及距离 1');
      assert.ok(r.state.units.find(u => u.id === far.id)!.hp < 1000, 'x=8 波及距离 2');
    }
  });

  test('修士：移动力随境界提升（2 + floor(x/3)）', () => {
    // 10-30 修真分支重排了经验曲线之后重算过这张表：
    // 从 r 级升到 r+1 级的门槛是 floor(10 + 10r(r+1) + 0.05·4^r)，
    // 也就是 0→10→30→70→133→222→361→634→1389→4006 这九道坎。
    // 曲线一改，旧阈值（0/4/8/32/64/256/512）就全部错位了——这正是当初这条用例被删掉的原因，
    // 但"移动力随境界涨"这件事本身没变，覆盖率不该跟着一起没。
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });

    for (let y = 3; y <= 7; y++) {
      for (let x = 4; x <= 10; x++) {
        s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
      }
    }

    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    qi.custom = { lifespan: 100 };

    const table: Array<[rank: number, expectedMove: number]> = [
      [0, 2], // 0/3 = 0 -> 2
      [2, 2], // 2/3 = 0 -> 2
      [3, 3], // 3/3 = 1 -> 3
      [5, 3], // 5/3 = 1 -> 3
      [6, 4], // 6/3 = 2 -> 4
      [8, 4], // 8/3 = 2 -> 4
      [9, 5], // 9/3 = 3 -> 5
    ];

    // 门槛一律问 expForRank，不写死数字：曲线已经加过一次"6 级以上翻倍"的墙，
    // 手写的 1389 当场从 8 级掉成 7 级，用例却只报"移动力不对"，很难查。
    for (const [rank, expectedMove] of table) {
      const exp = rank === 0 ? 0 : expForRank(rank - 1);
      setCultivationExp(qi, exp);
      assert.equal(cultivationRank(qi), rank, `exp=${exp} 应该为 ${rank} 级`);
      assert.equal(movePower(s, qi), expectedMove, `x=${rank} 时移动力应为 ${expectedMove}`);
    }
  });

  test('生命上限：跳级与逐级相加完全一致', () => {
    // 老写法是 floor(F(to) − F(from))，而累计值走的是 Σ floor(单级)，取整点不同。
    // 实测 2→4 / 3→5 / 4→6 / 5→7 / 6→8 / 7→9 六档会差 1 点：
    // 同样多的经验，一次跳两级比连升两次少 1 点血（剑气纵横一次给几百经验，会命中）。
    // 现在统一成"逐级增量求和"，跳级必须等于分几次升。
    for (let from = 0; from < 8; from++) {
      const jump = maxHpDeltaBetween(from, from + 2);
      const steps =
        maxHpDeltaBetween(from, from + 1) + maxHpDeltaBetween(from + 1, from + 2);
      assert.equal(jump, steps, `${from}→${from + 2} 一次跳级应该等于连升两次`);
    }

    // 累计值也必须等于逐级增量之和：灵体重生就是用累计值重置 maxHpBonus 的
    let sum = 0;
    for (let r = 1; r <= 9; r++) {
      sum += hpGainForRank(r);
      assert.equal(totalHpBonusForRank(r), sum, `rank ${r} 的累计值应等于逐级增量之和`);
    }

    // 曲线本身没被这次重构改动：单级增量仍是 8 / 10 / 17
    assert.deepEqual(
      [1, 2, 3].map(hpGainForRank),
      [8, 10, 17],
      '逐级增量不该被这次重构改动',
    );
  });

  test('修士：神识（视野）随境界提升，且受衰老枯竭', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });

    for (let y = 3; y <= 7; y++) {
      for (let x = 4; x <= 10; x++) {
        s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
      }
    }

    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);

    // 0 级：基础视野 3
    qi.custom = { exp: 0, lifespan: 100 };
    assert.equal(effectiveStats(s, qi).vision, 3, 'x=0 视野应为 3');

    // 9 级：基础 3 + 境界 9 = 12
    setCultivationExp(qi, expForRank(8)); // 8→9 的门槛，也就是刚好 9 级
    assert.equal(effectiveStats(s, qi).vision, 12, 'x=9 神识全开，视野 12');

    // 衰老测试用 8 级，寿元照旧由 custom 钉死，免得跟着曲线漂。
    // 这里走 expForRank(7) 而不是写死数字：曲线改过一次（6 级以上加了墙），
    // 写死的 1389 会悄悄从"8 级"掉成"7 级"，用例却还在过。
    setCultivationExp(qi, expForRank(7));
    qi.custom = { ...(qi.custom ?? {}), lifespan: 45 };
    assert.equal(effectiveStats(s, qi).vision, 11, 'x=8 且年轻，视野 11（3+8）');

    qi.age = 47; // 超龄 2 岁
    assert.equal(effectiveStats(s, qi).vision, 9, 'x=8 衰老 2 岁，视野减 2');
    assert.ok(
      effectiveStats(s, qi).visionItems.some(it => it.label === '修真' && it.delta === 6),
      '面板明细里应显示衰老带来的负修正',
    );
  });

  test('修仙：纯挂机曲线——炼气士靠打坐能撑到几级', () => {
    // 设计意图正常挂机应该在 5 级前坐化，
    // 逼玩家靠别的方法续命（例如击杀 +10 经验）。
    // 这条测试把"寿元 / 经验曲线"的效果量化下来：改动参数之后，
    // 一眼就能看出"到第几级，用了几岁"，红了就知道设计意图被破坏了。
    //
    // 判定完全走真实规则：每轮走两次 END_TURN 等价于"我的回合开始一次"，
    // turnStartSkills 会让 age +1、经验 +2（getExpGrowth 在当前等级的基础上）。
    // 不调私有函数，只问"还在不在、hp 归没归零、rank 是几"。
    const s = fresh({ expansionIds: ['cultivation'] }, 6201);
    s.units = []; // 场上只留一个修士，两座城都留着（丢城会判负，测不到曲线）
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);

    const milestones: Array<{ rank: number; age: number; exp: number }> = [
      { rank: cultivationRank(qi), age: qi.age ?? 0, exp: 0 },
    ];
    let lastAlive = { ...milestones[0]! };
    let died = false;
    const MAX_ROUNDS = 200;

    let cur = s;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // 一轮 = A 结束 → B 开始 → B 结束 → A 开始（A 的单位吃到"回合开始"）
      const r1 = applyAction(cur, { type: 'END_TURN' });
      assert.ok(r1.ok, r1.ok ? '' : r1.reason);
      const r2 = applyAction(r1.state, { type: 'END_TURN' });
      assert.ok(r2.ok, r2.ok ? '' : r2.reason);
      cur = r2.state;

      const still = cur.units.find((u) => u.id === qi.id);
      if (!still) {
        died = true; // 已经被 sweepDead 清掉，用上一步留下的 lastAlive 作为终点
        break;
      }
      const rank = cultivationRank(still);
      const age = still.age ?? 0;
      const exp = (still.custom?.exp as number) ?? 0;
      if (rank !== lastAlive.rank) milestones.push({ rank, age, exp });
      lastAlive = { rank, age, exp };
      if (still.hp <= 0) {
        died = true; // 回光返照：hp 归零，下一步会被清场
        break;
      }
    }

    console.log('    ── 纯挂机里程碑 ──');
    for (const m of milestones) {
      console.log(`    rank ${m.rank}（年龄 ${m.age}，累计经验 ${m.exp}）`);
    }
    console.log(`    终点：rank ${lastAlive.rank}，年龄 ${lastAlive.age}`);

    // 硬约束：得能坐化。挂 200 轮不死，说明寿元公式被改成了 Infinity 之类的东西。
    assert.ok(
      died,
      `200 回合挂机没有坐化（当前 rank ${lastAlive.rank}、年龄 ${lastAlive.age}）——` +
        `寿元公式里出现了 Infinity 或上限太高`,
    );

    // 设计意图：正常挂机在 5 级前坐化。这条红了说明"打坐变强"已经强到不需要战斗，
    // 玩家的最优解会退化成"开局造个修士然后挂机"，那是这个包最不想要的样子。
    assert.ok(
      lastAlive.rank <= 5,
      `纯挂机坐化于第 ${lastAlive.rank} 级（年龄 ${lastAlive.age}）——` +
        `设计意图是 5 级前必须靠战斗续命，请调寿元或经验增长`,
    );
  });

  test('剑修：剑气纵横消耗攻击次数，伤害高于普攻', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    // 造一个剑修和靶子
    const sword = place2(s, 'A', 'sword-cultivator', 5, 5);
    const target = place2(s, 'B', 'militia', 5, 6);
    
    // 新增：给剑修15点经验，让他到达1级境界，让境界加成生效（atkModifier 从 0 变成 5）
    setCultivationExp(sword, 15); 
    
    s.current = 'A';

    const baseDmg = computeDamage(s, sword, target); // 普攻伤害
    const hpBefore = target.hp;

    // 放技能（指向正下方）
    const r = applyAction(s, { 
      type: 'HERO_SKILL', 
      unitId: sword.id, 
      skillId: 'sword-sweep',
      targetX: 5,
      targetY: 8 // 指向正下方，命中 5,6 的靶子
    });
    
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const after = r.state;
    const swordAfter = after.units.find(u => u.id === sword.id)!;
    const targetAfter = after.units.find(u => u.id === target.id)!;

    // 1. 扣了次数：剑修 burst 1，放完还剩 0
    assert.equal(swordAfter.attacksLeft, 0, '剑气应该消耗一次攻击次数');

    // 2. 伤害更高：剑气伤害应该比普攻高（1级境界下，技能基础数值是 1.2倍，普攻是 0.8倍）
    const skillDmg = hpBefore - targetAfter.hp;
    assert.ok(skillDmg > baseDmg, `剑气伤害(${skillDmg}) 应该高于普攻(${baseDmg})`);

    // 3. 经验增加：初始 15（我们手动设的），放技能命中基础 +5 + 落空/施法的基础 1 = 21
    assert.equal(swordAfter.custom?.exp, 21, '施法并命中应该获得修为经验');
  });

  test('修士：死亡化作灵体，可主动重生', () => {
    // 1. 初始化沙盒环境
    let s = fresh({ expansionIds: ['cultivation'], godMode: true });
    
    // 2. 造一个 5 级修士，并强行给他 100 点额外血量
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    setCultivationExp(qi, 222); // 222 经验 = 5 级
    qi.maxHpBonus = 100;
    qi.hp = 120;
    qi.custom = { ...qi.custom, lifespan: 100 };
    qi.extraAbilities = ['spirit-ascension']; // 手动挂载能力

    // 3. 造一个一刀秒杀敌人的杀手（B方）
    const killer = place2(s, 'B', 'militia', 6, 5);
    killer.atkBonus = 1000; 
    s.current = 'B'; // 轮到 B 行动
    
    // 4. B 攻击 A 的修士（触发死亡）
    let res = applyAction(s, { type: 'ATTACK', unitId: killer.id, targetId: qi.id });
    assert.ok(res.ok);
    if (!res.ok) return; // TS 类型收窄
    s = res.state;       // ★ 必须接收新的 state

    // 5. 验证是否变成了灵体
    const spirit = s.units.find(u => u.custom?.spiritForm === true);
    assert.ok(spirit, '修士应该化作灵体存活');
    assert.equal(spirit.type, 'cultivator-spirit');
    assert.equal(spirit.custom?.originType, 'qi-cultivator');
    assert.equal(spirit.maxHpBonus, 30, '100 额外生命 × 0.3 应得 30');
    assert.equal(spirit.hp, 31, '基础生命 1 + 额外 30 = 31');
    assert.equal(spirit.extraAbilities?.includes('spirit-ascension'), false, '灵体不该有灵体道果');
    assert.ok(skillsOf(s, spirit).some(k => k.id === 'spirit-rebirth'), '灵体应该有重生技能');

    // 6. 轮到 A 行动，释放重生技能
    s.current = 'A';
    res = applyAction(s, { type: 'HERO_SKILL', unitId: spirit.id, skillId: 'spirit-rebirth' });
    assert.ok(res.ok, '重生技能释放失败: ' + (res as any).reason);
    if (!res.ok) return;
    s = res.state;       // ★ 必须接收新的 state

    // 7. 验证重生后的状态
    const rebornQi = s.units.find(u => u.id === spirit.id);
    assert.ok(rebornQi);
    assert.equal(rebornQi.type, 'qi-cultivator', '恢复为原修士形态');
    assert.equal(cultivationRank(rebornQi), 4, '5 级降为 4 级');
    // 5级的经验门槛是222（4级升5级），减半后是 111
    assert.equal(rebornQi.custom?.exp, 111, '修为减半'); 
    assert.equal(rebornQi.moved, true, '重生后本回合不能再移动');
    assert.equal(rebornQi.acted, true, '重生后本回合不能再攻击');
    
    const max = maxHpOf(s, rebornQi);
    assert.equal(rebornQi.hp, Math.max(1, Math.ceil(max * 0.1)), '恢复 10% 生命');
  });

  test('散灵台：0攻基础、耗灵石开火、自动开火联动', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.fog = false; 
    s.tiles[5 * s.w + 6] = { terrain: 'plain', cityId: null };

    s.units.push({
      id: 't-tower', type: 'cultivation-spirit-tower', owner: 'A' as const,
      x: 5, y: 5, hp: 28, kills: 0, moved: true, acted: false,
    });
    s.units.push({
      id: 't-target', type: 'militia', owner: 'B' as const,
      x: 6, y: 5, hp: 100, kills: 0, moved: true, acted: true,
    });

    s.players.A.res = { [SPIRIT_STONE]: TOWER_CHARGE_COST * 2 };

    const skillRes = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: 't-tower',
      skillId: 'tower-charge',
    });
    assert.ok(skillRes.ok, '应该能成功释放技能');
    assert.equal(
      skillRes.state.players.A.res![SPIRIT_STONE],
      TOWER_CHARGE_COST,
      `应该扣除 ${TOWER_CHARGE_COST} 灵石`,
    );
    // 👇 关键打印 1：看看放完技能后，塔的 custom 里到底存了什么
    const towerAfterSkill = skillRes.state.units.find(u => u.id === 't-tower')!;
    assert.equal(
      towerAfterSkill.custom?.burstCharges,
      TOWER_BURST_CHARGES,
      `一次充能给 ${TOWER_BURST_CHARGES} 次开火机会`,
    );
    console.log('放完技能后的 custom：', towerAfterSkill.custom);

    const r = applyAction(skillRes.state, { type: 'END_TURN' });
    assert.ok(r.ok);

    console.log('战斗日志：', r.state.log.map(l => l.text));

    const target = r.state.units.find(u => u.id === 't-target')!;
    assert.ok(target.hp <= 70, '塔应该开火并造成至少 30 点伤害');
  });

  // ── 回归（2026-11-06）────────────────────────────────

  // 灵矿的"每相邻一座高山 +2 灵石"曾经直接算 (y+dy)*w+(x+dx)，
  // 漏了 x 边界：站在最左列的灵矿，会把**上一行最右格**的山算成邻居。
  // 这条用例就是把"棋盘几何"和"内存索引"这两件事分开钉住。
  test('灵矿：相邻高山的加成不做跨行串格（左边缘）', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    for (const t of s.tiles) t.terrain = 'plain';

    // (w-1, 4) 是 (0,6) 的"左上"在索引上相邻、棋盘上隔着一整行的格子
    s.tiles[4 * s.w + (s.w - 1)] = { terrain: 'mountain', cityId: null };
    const mine = place2(s, 'A', 'cultivation-spirit-mine', 0, 6);
    assert.equal(
      unitYield(s, mine)[SPIRIT_STONE], 1,
      '左边缘不该白拿上一行最右格的 2 灵石',
    );

    // 真正的相邻格要照算，否则就是把 bug 改成"加成失效"
    s.tiles[6 * s.w + 1] = { terrain: 'mountain', cityId: null };
    assert.equal(unitYield(s, mine)[SPIRIT_STONE], 3, '右边真相邻是山时 +2 仍生效');
  });

  // 散灵台的就绪检查一度注册在 effect 名 'spirit-tower-shot' 上，
  // 而引擎是按 skill.id（'tower-charge'）查表的，于是这个检查从来没跑过——
  // 表现为"0 灵石时按钮照样是亮的，点下去才报错"。
  test('散灵台：灵石不足时「释放灵气」应提前显示为不可用', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.fog = false;
    s.units.push({
      id: 't-tower', type: 'cultivation-spirit-tower', owner: 'A' as const,
      x: 5, y: 5, hp: 28, kills: 0, moved: true, acted: false,
    });
    const tower = s.units.find((u) => u.id === 't-tower')!;
    const skillOf = () => heroSkillsOf(s, tower).find((k) => k.def.id === 'tower-charge')!;

    s.players.A.res = { [SPIRIT_STONE]: 0 };
    assert.equal(skillOf().ready, false, '0 灵石时不该显示为可放');
    assert.ok(skillOf().notReadyReason?.includes('灵石'), '应给出"灵石不足"的具体理由');

    s.players.A.res = { [SPIRIT_STONE]: TOWER_CHARGE_COST };
    assert.equal(skillOf().ready, true, `攒够 ${TOWER_CHARGE_COST} 灵石就该亮起来`);
  });

  // 面板那行「境界加成」的语义是"修到这一层本身给了多少"：
  // 不乘流派系数、不扣衰老。它一度硬编码了旧公式（漏了 /(rank+1)^0.2），
  // 9 级时印 "+407" 而实际只有 +257。
  // 期望值由 stats.ts 的 realm*Base 反推：
  //   攻击 ceil((45 + 2^8.5) / 10^0.2) = ceil(256.82) = 257
  //   护甲 ceil(-1 + 81 + 1.5^9)      = ceil(118.44) = 119
  //   射程 floor(9/2) = 4      神识 9
  test('面板「境界加成」印的是纯境界值（不乘系数、不扣衰老）', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    setCultivationExp(qi, expForRank(8));         // 9 级
    qi.custom = { ...qi.custom, lifespan: 999 };  // 钉死寿元，排除衰老干扰

    const line = getCultivationPanelLines(s, qi).find((l) => l.includes('境界加成'))!;
    assert.ok(line, '9 级应该有「境界加成」这一行');
    assert.ok(line.includes('攻击 +257'), `攻击应为 257（旧公式印 407）：${line}`);
    assert.ok(line.includes('护甲 +119'), `护甲应为 119：${line}`);
    assert.ok(line.includes('射程 +4'), `射程应为 4：${line}`);
    assert.ok(line.includes('神识 +9'), `神识应为 9：${line}`);
  });

  // ── 守卫：把"漏登记"这一类 bug 变成红灯 ────────────────
  //
  // 这个包反复踩同一个形状：某个东西在 A 处定义了、B 处没登记，于是它安静地
  // 永远不生效——灵矿造不出来（执事没进包）、散灵台灰显失效（键名对不上）都是。
  // 下面这几条断言不测玩法，只测"表和表之间对得上"。
  test('守卫：兵种 id / builds / 技能实现 / 能力 id 全部对得上', () => {
    const pack = CULTIVATION_PACK;
    const ids = new Set(Object.values(UNIT_IDS));
    const inPack = new Set((pack.units ?? []).map((u) => u.id));
    const abilityIds = new Set((pack.abilities ?? []).map((a) => a.id));

    for (const u of pack.units ?? []) {
      assert.ok(ids.has(u.id), `${u.name} 的 id「${u.id}」没登记进 UNIT_IDS`);

      for (const b of u.builds ?? []) {
        assert.ok(inPack.has(b), `${u.name} 要建的「${b}」不在包里——就是灵矿那个 bug 的形状`);
      }
      for (const sk of u.skills ?? []) {
        assert.ok(
          SKILL_EFFECTS[sk.effect],
          `${u.name} 的技能「${sk.name}」指向的 effect「${sk.effect}」没有实现`,
        );
      }
      for (const id of u.abilities ?? []) {
        assert.ok(abilityIds.has(id), `${u.name} 的能力「${id}」不在 CULTIVATION_ABILITIES 里`);
      }
    }

    // 反向：登记了 id 却没进包 = 这东西在游戏里永远出不来（执事当初就是这样）
    for (const id of ids) {
      assert.ok(inPack.has(id), `UNIT_IDS 里的「${id}」没进 CULTIVATION_PACK.units，造不出来`);
    }

    // 升级自动领悟的技能也要有实现
    for (const { skill } of CULTIVATOR_SKILL_UNLOCKS) {
      assert.ok(SKILL_EFFECTS[skill.effect], `升级领悟的「${skill.name}」没有实现`);
    }

    // 升级自动获得的能力：id 必须真的注册进 CULTIVATION_ABILITIES，
    // 否则它会挂到单位身上、然后什么也不发生（最难查的一种"漏登记"）。
    for (const { abilityId, name } of CULTIVATOR_ABILITY_UNLOCKS) {
      assert.ok(abilityIds.has(abilityId), `解锁表里的能力「${name}」不在 CULTIVATION_ABILITIES 里`);
    }
  });

  // ── 异象（2026-11-06）────────────────────────────────
  //
  // 修士突破时天象外泄：下一个敌方回合，突破时那一格被塞进敌方可见集。
  // 引擎里"被看见"只有一条通路（fog.ts 会把视野外的敌方单位整个裁掉），
  // 所以这里测的就是"那一格进没进 visibleSet、单位有没有被下发"。
  const anomalySetup = () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.fog = true;
    s.units = [];
    // 摆在自己半场：离 B 的两座城很远，B 本来绝对看不见
    const qi = place2(s, 'A', 'qi-cultivator', 8, 9);
    s.current = 'A';
    return { s, qi };
  };

  test('异象：1 级挂上，0→1 那次不点亮，1→2 才记下位置', () => {
    const { s, qi } = anomalySetup();

    addExp(qi, s, 10); // 0 → 1
    assert.equal(cultivationRank(qi), 1);
    assert.ok((qi.extraAbilities ?? []).includes('anomaly'), '1 级应该自动挂上异象');
    assert.equal(qi.custom?.anomaly, undefined, '刚获得异象的那次突破不该点亮');

    addExp(qi, s, 20); // 1 → 2
    assert.equal(cultivationRank(qi), 2);
    assert.deepEqual(qi.custom?.anomaly, { x: 8, y: 9 }, '记的是突破时所在格');
  });

  test('异象：只在敌方自己的回合点亮，我方回合里看不到', () => {
    const { s, qi } = anomalySetup();
    addExp(qi, s, 10);
    addExp(qi, s, 20); // → 2 级，异象记在 (8,9)

    // 先确认这个位置本来在 B 的视野之外——否则这条用例什么都没测到
    const mine = playerView(s, 'B'); // s.current 还是 A
    assert.ok(!mine.visible.includes(idx(s, 8, 9)), '这一格本来不该在 B 的视野里');

    s.current = 'B';
    const enemy = playerView(s, 'B');
    assert.ok(enemy.visible.includes(idx(s, 8, 9)), 'B 的回合里那一格应该被点亮');
    assert.ok(
      enemy.state.units.some((u) => u.id === qi.id),
      '画出来了就该看得见人：单位要一起下发',
    );
  });

  test('异象：敌方回合结束就熄灭', () => {
    const { s, qi } = anomalySetup();
    addExp(qi, s, 10);
    addExp(qi, s, 20);
    s.current = 'B';

    const r = applyAction(s, { type: 'END_TURN' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const after = r.state.units.find((u) => u.id === qi.id)!;
    assert.equal(after.custom?.anomaly, undefined, 'B 的回合结束，灯该灭了');
  });

  test('异象：带着异象的突破战报公开，没有的只给自己看', () => {
    const { s, qi } = anomalySetup();

    addExp(qi, s, 10); // 0→1：异象是这次突破才发给它的，战报仍私有
    const first = [...s.log].reverse().find((l) => l.text.includes('突破至'))!;
    assert.ok(!first.open, '还没有异象的时候，突破只有自己知道');

    addExp(qi, s, 20); // 1→2：身上有异象了，战报公开
    const second = [...s.log].reverse().find((l) => l.text.includes('突破至'))!;
    assert.equal(second.open, true, '有异象时突破是公开战报');
  });

  // ── 战斗历练与经验墙（2026-11-06）─────────────────────
  //
  // 这一段钉的是"设计意图"，不是某个函数：
  //   · 纯挂机到 4 级坐化（上面那条用例已经管了）；
  //   · 常规路线（挂机 + 灵田）到 6 级为止；
  //   · 只有剑修一路血战，才可能在寿元耗尽前摸到 7 级。
  // 7/8/9 是对标本体未来更高时代的，本扩展不做过分数值膨胀——所以它们是
  // "比赢一局还难的成就"，而不是练级路线。改了系数这里会红，那正是要的。

  test('历练：不值得一战的目标不给经验', () => {
    // 4 级门槛是 atk > 3：打 atk 3 的东西没有历练，atk 4 才有
    assert.equal(killExpForRank(4, 3, false), 0, 'atk=3 不该过 4 级的门槛');
    assert.equal(killExpForRank(4, 4, false), 2, 'atk=4 刚过门槛，3 × 0.8 = 2.4 → 2');
  });

  test('历练：取整在最后一步——6 级炼气 0 点，剑修仍有 1 点', () => {
    // 3 × 0.15 = 0.45。先取整成 0 再乘 2 就永远是 0，剑修会被彻底归零。
    assert.equal(killExpForRank(6, 21, false), 0, '炼气士 6 级清杂兵没有收益');
    assert.equal(
      killExpForRank(6, 21, true),
      1,
      `剑修 6 级还有 1 点（3 × 0.15 × ${SWORD_KILL_EXP_MUL} = 0.9 → 1）`,
    );
    assert.equal(killExpForRank(7, 99, true), 0, '7 级起战斗不再给历练');
  });

  test('历练：每回合封顶，杀再多也只拿一份', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    qi.custom = { exp: 0, rank: 0 };

    // 直接驱动钩子：走真实引擎的话要摆一场能稳杀的仗，测的却是同一段代码
    const kill = (id: string) => {
      const victim = { id, type: 'militia', owner: 'B', x: 6, y: 5, hp: 0, kills: 0, moved: true, acted: true } as any;
      CULTIVATION_HOOKS.onUnitKilled!({ state: s, victim, killer: qi, killerOwner: 'A' });
    };

    assert.equal(killExpForRank(0, 13, false), 5, '0 级杀民兵一次 5 点');
    assert.equal(killExpCapOfRank(0), KILL_EXP_CAP_BASE, '0 级上限就是基数');
    assert.equal(
      killExpCapOfRank(3),
      KILL_EXP_CAP_BASE + 3 * KILL_EXP_CAP_PER_RANK,
      '上限随境界线性上涨',
    );
    kill('v1');
    assert.equal(getExp(qi), 5, '第一杀全额入账');
    kill('v2'); // 额度 6，只给 1
    assert.equal(getExp(qi), killExpCapOfRank(0), `第二杀应该只补到上限 ${killExpCapOfRank(0)}`);
    kill('v3');
    assert.equal(getExp(qi), killExpCapOfRank(0), '额度用光后不再涨');

    // 换回合（s.turn 变）额度重置
    const before = getExp(qi);
    s.turn += 1;
    kill('v4');
    assert.equal(getExp(qi), before + 5, '新回合额度应该重置');
  });

  test('经验墙：6 级起的门槛被单独抬高，前 6 级不动', () => {
    // 曲线本身（不含墙）在 5→6 时是 361。墙只立在 6 级以上：
    // 6→7 的门槛是 634 × 1.65，而不是 634。
    assert.equal(expForRank(5), 361, '5→6 不该被墙影响');
    assert.equal(expForRank(6), Math.round(634 * 1.65), '6→7 的门槛被抬高');
    assert.ok(expForRank(6) > expForRank(5) * 2.5, '这是一道墙，不是平滑曲线');
  });

  test('设计预算：剑修血战能摸到 7 级，炼气士不能', () => {
    // 纯粹按导出的常量推演，不跑引擎：每回合 = 打坐 + 4 块灵田 + 满编击杀（受封顶）。
    // 参照目标是 atk 21 的戟兵（三代常规兵），比它更硬的敌人不会给更多。
    const REF_ATK = 21;
    const FIELD_BONUS = 4;
    const run = (sword: boolean, killsPerTurn: number) => {
      const u = {
        type: sword ? 'sword-cultivator' : 'qi-cultivator',
        custom: { exp: 0, rank: 0 },
      } as any;
      let peak = 0;
      for (let age = 1; age <= 400; age++) {
        const rank = u.custom.rank as number;
        const perKill = killExpForRank(rank, REF_ATK, sword);
        const gain = Math.min(perKill * killsPerTurn, killExpCapOfRank(rank));
        u.custom.exp += getExpGrowth(u) + FIELD_BONUS + gain;
        while (u.custom.rank < 9 && u.custom.exp >= expForRank(u.custom.rank)) u.custom.rank++;
        peak = Math.max(peak, u.custom.rank);
        // 寿元耗尽：超龄 3 年坐化（和 progression.ts 的 AGING_DEATH_AGE 一致）
        if (Number.isFinite(baseLifespanOf(u.custom.rank)) && age - baseLifespanOf(u.custom.rank) >= 3) {
          return peak;
        }
      }
      return peak;
    };

    assert.ok(run(true, 6) >= 7, '剑修每回合 6 杀 + 4 块灵田，应该能摸到 7 级——这是给玩家的奖励');
    assert.ok(run(false, 9) < 7, '炼气士哪怕每回合 9 杀 + 4 块灵田，也不该到 7 级');
    assert.ok(run(false, 6) <= 6, '炼气士常规路线封顶 6 级');
  });

  // ── 阵法（2026-11-06）──────────────────────────────────
  //
  // 杀伐阵是引擎里第一个**按比例**加攻击的光环（以前只有加法 +2）；
  // 封印阵是第一个能把移动力压到 0 的光环。两者都要求"面板和实际同一个数"。

  test('杀伐阵：半径 2 内友军攻击 +10%，面板与实际同源', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    place2(s, 'A', 'cultivation-kill-formation', 5, 5);
    const mate = place2(s, 'A', 'militia', 7, 5); // 距离 2：在半径内
    const far = place2(s, 'A', 'militia', 8, 5); // 距离 3：半径外

    const st = effectiveStats(s, mate);
    assert.equal(st.atk, Math.round(13 * 1.1), '13 × 1.1 = 14.3 → 四舍五入 14');
    assert.ok(
      st.atkItems.some((i) => i.label === '杀伐阵'),
      '面板要写清这几点攻击是谁加的',
    );
    assert.equal(effectiveStats(s, far).atk, 13, '半径外不该吃加成');
  });

  test('杀伐阵：有修士守阵时半径扩到 4，加成按守阵者的境界算', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    place2(s, 'A', 'cultivation-kill-formation', 5, 5);
    const mate = place2(s, 'A', 'militia', 8, 5); // 距离 3

    // 没人守阵：半径 2，够不到距离 3
    assert.equal(effectiveStats(s, mate).atk, 13, '没有修士时只有半径 2');

    // 贴一个 3 级修士：半径变 4，加成 1 + (3+1)/10 = 1.4
    const qi = place2(s, 'A', 'qi-cultivator', 5, 6);
    setCultivationExp(qi, expForRank(2));
    assert.equal(cultivationRank(qi), 3, '前置：这个修士应该是 3 级');
    assert.equal(
      effectiveStats(s, mate).atk,
      Math.round(13 * 1.4),
      '守阵修士的境界决定加成，不是人数',
    );
  });

  test('杀伐阵：两个重叠不叠乘，取最强的一条', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    place2(s, 'A', 'cultivation-kill-formation', 5, 5);
    place2(s, 'A', 'cultivation-kill-formation', 5, 6);
    const mate = place2(s, 'A', 'militia', 7, 5);

    assert.equal(
      effectiveStats(s, mate).atk,
      Math.round(13 * 1.1),
      '两个 +10% 仍然是 +10%——叠乘会让"多摆一座"变成乘法收益',
    );
  });

  test('封印阵：半径 3 内移动力减半向下取整，只剩 1 格会被完全封住', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    place2(s, 'A', 'cultivation-seal-formation', 5, 5);
    const foe = place2(s, 'B', 'militia', 7, 5); // 距离 2：在半径 3 内
    const far = place2(s, 'B', 'militia', 9, 5); // 距离 4：半径外

    assert.equal(movePower(s, foe), 1, '移动力 2 → floor(1) = 1');
    assert.equal(movePower(s, far), 2, '半径外不受影响');

    // 移动力只有 1 的单位：floor(0.5) = 0，真的走不动。
    // 这条是"保底 1 必须排在光环之前"的直接证据——排错了会永远封不住。
    s.unitTypes.militia.move = 1;
    assert.equal(movePower(s, foe), 0, '1 → 0，封住');
    assert.equal(movePower(s, far), 1, '半径外仍然是 1');

    // 面板要给出同一笔账
    const items = effectiveStats(s, foe).moveItems;
    assert.ok(items.some((i) => i.label === '封印阵'), '面板要写清是封印阵压的');
  });

  test('阵师：三个时代的建造白名单递增，而且都要花灵石', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const b1 = s.unitTypes['cultivation-formation-master'];
    const b2 = s.unitTypes['cultivation-formation-master-2'];
    const b3 = s.unitTypes['cultivation-formation-master-3'];

    assert.deepEqual(b1.builds, ['cultivation-kill-formation'], '三代阵师只会杀伐阵');
    assert.ok(b2.builds?.includes('cultivation-seal-formation'), '四代才会封印阵');
    assert.ok(b3.builds?.includes('cultivation-seal-formation'), '五代同样会');

    for (const b of [b1, b2, b3]) {
      assert.ok((b.costRes?.[SPIRIT_STONE] ?? 0) > 0, `${b.name} 要花灵石`);
    }
  });

  // ── 完全封印 + 传送阵（2026-11-06 第二期）──────────────

  test('封印阵：守阵修士的境界越高，压得越狠；0 级等于没加成', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    place2(s, 'A', 'cultivation-seal-formation', 5, 5);
    const foe = place2(s, 'B', 'militia', 7, 5); // 距离 2，在半径 3 内

    assert.equal(movePower(s, foe), 1, '没人守阵：2 × 0.5 = 1');

    const qi = place2(s, 'A', 'qi-cultivator', 5, 6); // 相邻守阵
    assert.equal(cultivationRank(qi), 0);
    assert.equal(movePower(s, foe), 1, '0 级修士守着等于没加成（他就是个凡人）');

    setCultivationExp(qi, expForRank(0)); // 升到 1 级
    assert.equal(cultivationRank(qi), 1);
    assert.equal(movePower(s, foe), 0, '1 级修士守阵：1 − 1 = 0，封住');
  });

  test('封印阵：被压到 0 的单位不能攻击，也不能放技能', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    place2(s, 'A', 'cultivation-seal-formation', 5, 5);
    const foe = place2(s, 'B', 'militia', 7, 5);
    const qi = place2(s, 'A', 'qi-cultivator', 5, 6);
    setCultivationExp(qi, expForRank(0));

    s.current = 'B';
    const atk = applyAction(s, { type: 'ATTACK', unitId: foe.id, targetId: qi.id });
    assert.equal(atk.ok, false, '被封印的单位不该能攻击');
    assert.ok(
      atk.ok ? '' : /封印/.test(atk.reason),
      `拒绝理由要说清是被封印：${atk.ok ? '' : atk.reason}`,
    );

    // 移动本来就走不了（移动力 0），这里只确认它不是"能走但没走"
    assert.equal(movePower(s, foe), 0);
  });

  test('传送阵：按矢量整体对调两侧的单位', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.players.A.res = { [SPIRIT_STONE]: 100 };
    const arr = place2(s, 'A', 'cultivation-teleport-formation', 5, 5);
    const mate = place2(s, 'A', 'militia', 6, 5); // 源侧
    const foe = place2(s, 'B', 'militia', 10, 5); // 落点侧（落点 9,5 的距离 1）

    const r = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: arr.id,
      skillId: 'teleport-swap',
      targetX: 9,
      targetY: 5,
    });
    assert.ok(r.ok, r.ok ? '' : r.reason);

    const at = (id: string) => r.state.units.find((u) => u.id === id)!;
    // 矢量 = (9,5) − (5,5) = (4,0)
    assert.deepEqual([at(arr.id).x, at(arr.id).y], [9, 5], '阵自己跟着挪到落点');
    assert.deepEqual([at(mate.id).x, at(mate.id).y], [10, 5], '源侧 +矢量');
    assert.deepEqual([at(foe.id).x, at(foe.id).y], [6, 5], '落点侧 −矢量');
    assert.equal(r.state.players.A.res![SPIRIT_STONE], 90, '扣 10 灵石');
    // 传送一旦放出去就收不回来了：界面靠这个字段清空撤回栈
    assert.equal(r.irreversible, true, '成功的传送也要封死撤回');
    assert.ok(
      r.state.log.some((e) => e.text.includes(TELEPORT_RIFT_LOG)),
      '成败都该在战报里留一句「撼动了时空结构」',
    );
  });

  test('传送阵：失败也照扣灵石，而且这一回合不能再传', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.players.A.res = { [SPIRIT_STONE]: 100 };
    const arr = place2(s, 'A', 'cultivation-teleport-formation', 5, 5);

    // 落点出界 → 过载
    const bad = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: arr.id,
      skillId: 'teleport-swap',
      targetX: -1,
      targetY: 5,
    });
    assert.ok(bad.ok, '失败仍然算作一次施放（否则灵石白扣还不用付代价）');
    assert.equal(bad.state.players.A.res![SPIRIT_STONE], 90, '失败照扣灵石');
    assert.equal(bad.irreversible, true, '失败的传送同样撤不回来，否则惩罚等于不存在');
    assert.ok(
      bad.state.log.some((e) => e.text.includes(TELEPORT_RIFT_LOG)),
      '失败时战报也要留一句「撼动了时空结构」',
    );

    const again = applyAction(bad.state, {
      type: 'HERO_SKILL',
      unitId: arr.id,
      skillId: 'teleport-swap',
      targetX: 9,
      targetY: 5,
    });
    assert.equal(again.ok, false, '同一回合不能再传');
    assert.ok(
      again.ok ? '' : /已经放过技能/.test(again.reason),
      `拒绝理由要说清是本回合用过了：${again.ok ? '' : again.reason}`,
    );
  });

  test('传送阵：灵石不足根本没放成，不扣钱也不封撤回', () => {
    // "撤不回来"只对**真的放出去**的那一次成立。钱不够时技能被拒在门口，
    // 什么都没发生——这时候还把撤回栈清掉就是白白惩罚手滑。
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.players.A.res = { [SPIRIT_STONE]: TELEPORT_COST - 1 };
    const arr = place2(s, 'A', 'cultivation-teleport-formation', 5, 5);

    const r = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: arr.id,
      skillId: 'teleport-swap',
      targetX: 9,
      targetY: 5,
    });
    assert.equal(r.ok, false, '灵石不够就该拒绝');
    assert.equal(s.players.A.res![SPIRIT_STONE], TELEPORT_COST - 1, '没放成就不该扣钱');
    assert.ok(
      !s.log.some((e) => e.text.includes(TELEPORT_RIFT_LOG)),
      '没放成不该留「撼动了时空结构」的痕',
    );
  });

  test('传送阵：2×2 大单位不参与；它挡在落点上就整体过载', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.players.A.res = { [SPIRIT_STONE]: 100 };
    s.unitTypes['test-big'] = {
      ...s.unitTypes.militia,
      id: 'test-big',
      name: '巨兵',
      footprint: 2,
    };
    const arr = place2(s, 'A', 'cultivation-teleport-formation', 5, 5);
    const big = place2(s, 'B', 'test-big', 9, 5); // 正压在落点上

    const r = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: arr.id,
      skillId: 'teleport-swap',
      targetX: 9,
      targetY: 5,
    });
    assert.ok(r.ok, '过载也是施放成功的一种结果');
    const at = (id: string) => r.state.units.find((u) => u.id === id)!;
    assert.deepEqual([at(arr.id).x, at(arr.id).y], [5, 5], '过载时谁都不该动');
    assert.deepEqual([at(big.id).x, at(big.id).y], [9, 5], '大单位原地不动');
  });

  // ── 守御阵（第三期）──────────────────────────────────
  //
  // 核心是"只转伤害、不转命中"：原目标不掉血，但反击、状态、击退全留在他身上。
  // 下面的用例按这个分界线一条条验，顺带把"阵靠修士的血硬撑"的三个数钉住。

  /** 摆一个最标准的场面：A 的守御阵护着 A 的兵，B 的兵贴脸打 */
  const guardScene = () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    const arr = place2(s, 'A', UNIT_IDS.GUARD_FORMATION, 5, 5);
    const mate = place2(s, 'A', 'militia', 6, 5);
    const foe = place2(s, 'B', 'militia', 6, 6);
    s.current = 'B';
    return { s, arr, mate, foe };
  };

  test('守御阵：伤害转到阵上，原目标不掉血也照常反击', () => {
    const { s, arr, mate, foe } = guardScene();
    const dmg = computeDamage(s, foe, mate);
    const before = { arr: arr.hp, mate: mate.hp, foe: foe.hp };

    const r = applyAction(s, { type: 'ATTACK', unitId: foe.id, targetId: mate.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);

    const at = (id: string) => r.state.units.find((u) => u.id === id)!;
    assert.equal(at(arr.id).hp, before.arr - dmg, '阵替友军吃了这一下');
    assert.equal(at(mate.id).hp, before.mate, '原目标一滴血没掉');
    assert.ok(at(foe.id).hp < before.foe, '原目标血没掉 → 照常反击（反击是保留的）');
    assert.ok(
      r.state.log.some((l) => l.text.includes('承受了')),
      '战报要写明"谁替谁承受"，否则两边都以为显示坏了',
    );
  });

  test('守御阵：友军建筑受击也转；半径外的友军不转', () => {
    const { s } = guardScene();
    s.units = [];
    const arr2 = place2(s, 'A', UNIT_IDS.GUARD_FORMATION, 5, 5);
    const building = place2(s, 'A', UNIT_IDS.KILL_FORMATION, 6, 5); // 也是建筑
    const far = place2(s, 'A', 'militia', 9, 5);                      // 距离 4，半径外
    const foe = place2(s, 'B', 'militia', 6, 6);
    const enemy2 = place2(s, 'B', 'militia', 9, 6);
    s.current = 'B';

    const d1 = computeDamage(s, foe, building);
    const r1 = applyAction(s, { type: 'ATTACK', unitId: foe.id, targetId: building.id });
    assert.ok(r1.ok, r1.ok ? '' : r1.reason);
    const at1 = (id: string) => r1.state.units.find((u) => u.id === id)!;
    assert.equal(at1(building.id).hp, s.unitTypes[UNIT_IDS.KILL_FORMATION].maxHp, '友军建筑也不掉血');
    assert.equal(at1(arr2.id).hp, arr2.hp - d1, '这一下由守御阵接走');

    const d2 = computeDamage(r1.state, enemy2, far);
    const r2 = applyAction(r1.state, { type: 'ATTACK', unitId: enemy2.id, targetId: far.id });
    assert.ok(r2.ok, r2.ok ? '' : r2.reason);
    assert.equal(
      r2.state.units.find((u) => u.id === far.id)!.hp,
      far.hp - d2,
      '半径外只能自己挨',
    );
  });

  test('守御阵：中毒/灼烧这类状态伤害不转，血仍从原目标身上掉', () => {
    const { s, arr, mate } = guardScene();
    const before = { arr: arr.hp, mate: mate.hp };
    const dmg = Math.ceil(maxHpOf(s, mate) * 0.06);
    STATUS_REGISTRY.poison.onTurnStart(s, mate, 1);
    assert.equal(mate.hp, before.mate - dmg, '中毒扣的是中毒者自己的血');
    assert.equal(arr.hp, before.arr, '阵不该替全军吃状态');
  });

  test('守御阵：自己挨打就吸守阵修士的血，每回合额度=境界', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    const arr = place2(s, 'A', UNIT_IDS.GUARD_FORMATION, 5, 5);
    const qi = place2(s, 'A', 'qi-cultivator', 5, 6); // 相邻守阵
    setCultivationExp(qi, expForRank(2));
    assert.equal(cultivationRank(qi), 3, '前置：3 级修士');
    const qiHp = qi.hp;

    // 挨 20 点：缺口 20，需要 ceil(20/3)=7 点修士血，但本回合额度只有 3
    abilityApi.hurt(s, arr, 20);
    assert.equal(qi.hp, qiHp - 3, '修士掉 3 点（额度）');
    assert.equal(arr.hp, 80 - 20 + 9, '阵回 3 × 3 = 9 点，补不满 → 持续磨损');
    assert.equal(arr.custom.guardDrainUsed, 3, '额度记在阵身上，随存档走');
    assert.ok(s.log.some((l) => l.text.includes('吸取')), '要写明是谁的血被抽了');

    // 同一回合再挨一下：额度已空，不再吸
    abilityApi.hurt(s, arr, 10);
    assert.equal(arr.hp, 69 - 10, '额度用光就只是一座普通建筑');
    assert.equal(qi.hp, qiHp - 3, '修士不再掉血');

    // 跨回合额度刷新
    s.turn += 1;
    abilityApi.hurt(s, arr, 10);
    assert.ok(qi.hp < qiHp - 3, '新一回合重新有额度');
  });

  test('守御阵：不会把修士吸死，0 级修士当不了血包', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    const arr = place2(s, 'A', UNIT_IDS.GUARD_FORMATION, 5, 5);
    const qi = place2(s, 'A', 'qi-cultivator', 5, 6);
    assert.equal(cultivationRank(qi), 0);

    abilityApi.hurt(s, arr, 20);
    assert.equal(qi.hp, s.unitTypes['qi-cultivator'].maxHp, '0 级修士一滴血都不掉');
    assert.equal(arr.hp, 60, '没有血包，阵就是普通地挨打');

    setCultivationExp(qi, expForRank(2)); // 升到 3 级
    qi.hp = 2;
    abilityApi.hurt(s, arr, 20);
    assert.equal(qi.hp, 1, '只剩 2 血时最多抽 1 点，永远留 1');
    assert.equal(arr.hp, 60 - 20 + 3, '上一发剩 60，再挨 20 → 40，抽 1 点换 3 点');
  });

  test('守御阵：多座取最近且只问一次；阵倒下后不再转移', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    const near = place2(s, 'A', UNIT_IDS.GUARD_FORMATION, 5, 5); // 距离 1
    const far = place2(s, 'A', UNIT_IDS.GUARD_FORMATION, 7, 5);  // 距离 1（同距，按 id 定）
    const mate = place2(s, 'A', 'militia', 6, 5);
    const foe = place2(s, 'B', 'militia', 6, 6);
    s.current = 'B';
    const dmg = computeDamage(s, foe, mate);

    const r = applyAction(s, { type: 'ATTACK', unitId: foe.id, targetId: mate.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const at = (id: string) => r.state.units.find((u) => u.id === id)!;
    const taker = near.id < far.id ? near : far;
    const other = near.id < far.id ? far : near;
    assert.equal(at(taker.id).hp, taker.hp - dmg, '同距按 id 字典序，联机才不会算出两种结果');
    assert.equal(at(other.id).hp, other.hp, '只问一次：接替者不会再被转一次');
    assert.equal(at(mate.id).hp, mate.hp, '原目标照样不掉血');

    // 阵倒下：不能继续替人挡刀。直接走伤害出口，避开"同一攻击者本回合已打过"
    // 这种和本用例无关的干扰。
    at(taker.id).hp = 0;
    at(other.id).hp = 0;
    const beforeMate = at(mate.id).hp;
    abilityApi.hurt(r.state, at(mate.id), 7);
    assert.equal(at(mate.id).hp, beforeMate - 7, '两座阵都没了，伤害落回原目标');
    assert.equal(at(taker.id).hp, 0, '倒下的阵不会被拉起来当血包');
  });

  test('守御阵：剑气纵横这类扩展技能直伤也走同一个出口', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    const arr = place2(s, 'A', UNIT_IDS.GUARD_FORMATION, 5, 5);
    const mate = place2(s, 'A', 'militia', 6, 5);
    const sword = place2(s, 'B', 'sword-cultivator', 6, 4);
    s.current = 'B';
    const before = { arr: arr.hp, mate: mate.hp };

    // 从 (6,4) 往下挥：剑气扫过 (6,5) 的友军
    const r = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: sword.id,
      skillId: 'sword-sweep',
      targetX: 6,
      targetY: 7,
    });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const at = (id: string) => r.state.units.find((u) => u.id === id)!;
    assert.equal(at(mate.id).hp, before.mate, '剑气也不能绕过守御阵');
    assert.ok(at(arr.id).hp < before.arr, '这一道被阵接下了');
  });

  test('守御阵：敌方修士站旁边不算守阵，更不会被抽血', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    const arr = place2(s, 'A', UNIT_IDS.GUARD_FORMATION, 5, 5);
    const enemyQi = place2(s, 'B', 'qi-cultivator', 5, 6);
    setCultivationExp(enemyQi, expForRank(2));
    assert.equal(cultivationRank(enemyQi), 3);
    const hp = enemyQi.hp;

    abilityApi.hurt(s, arr, 20);
    assert.equal(enemyQi.hp, hp, '敌人的血一滴都不能动');
    assert.equal(arr.hp, 60, '没自家修士守阵，就是普通地挨打');
  });

  test('守御阵：阵法与兵种都登记进包里，阵师白名单含守御阵', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const def = s.unitTypes[UNIT_IDS.GUARD_FORMATION];
    assert.ok(def, '兵种要在包里登记，否则根本造不出来');
    assert.equal(def.maxHp, 80);
    assert.equal(def.armor, 6);
    assert.equal(def.costRes?.[SPIRIT_STONE], 14);
    assert.ok(s.unitTypes[UNIT_IDS.FORMATION_MASTER_2].builds?.includes(UNIT_IDS.GUARD_FORMATION));
    assert.ok(s.unitTypes[UNIT_IDS.FORMATION_MASTER_3].builds?.includes(UNIT_IDS.GUARD_FORMATION));
    assert.ok(
      CULTIVATION_ABILITIES.some((a) => a.id === 'formation-guardian'),
      '能力要注册，否则 onDamaged 静默失效',
    );
    assert.ok(CULTIVATION_HOOKS.redirectDamage, '转移钩子要接进扩展');
  });

  test('传送阵：落点预览标出「谁会挪到哪」，落点是自己时为空', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    const arr = place2(s, 'A', 'cultivation-teleport-formation', 5, 5);
    place2(s, 'A', 'militia', 6, 5); // 源侧
    place2(s, 'B', 'militia', 10, 5); // 落点侧（落点 9,5）

    const previewer = SKILL_PREVIEWERS['teleport-swap'];
    assert.ok(previewer, '传送阵要注册落点预览，否则瞄准时什么都看不到');
    const set = new Set(previewer!({ state: s, self: arr, target: { x: 9, y: 5 } }));
    // 矢量 (4,0)：阵和源侧单位 +4，落点侧单位 −4
    assert.ok(set.has(idx(s, 9, 5)), '阵自己的新位置');
    assert.ok(set.has(idx(s, 10, 5)), '源侧单位的新位置');
    assert.ok(set.has(idx(s, 6, 5)), '落点侧单位的新位置');

    const selfTarget = previewer!({ state: s, self: arr, target: { x: 5, y: 5 } });
    assert.equal(selfTarget.length, 0, '落在自己身上等于没传，不给预览');
  });

  // ── 炼器（2026-11-08）──────────────────────────────

  test('炼器：白名单 + campOnly + 产地条件，一条链判完', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    s.players.A.res = { [SPIRIT_STONE]: 200 };
    s.players.A.gold = 900;

    // 铺一块平地，只在 (5,5) 留一格森林
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    s.tiles[5 * s.w + 5] = { terrain: 'forest', cityId: null };

    const forge = place2(s, 'A', 'cultivation-forge-1', 5, 4); // 挨着森林
    const bare = place2(s, 'A', 'cultivation-forge-1', 8, 8); // 什么都不挨着
    const city = citiesOf(s, 'A')[0]!;
    city.era = 4;

    const v = (src: any, id: string) => produceAt(s, src, s.unitTypes[id]);

    // 白名单：炉子不造普通兵
    assert.equal(v({ kind: 'camp', camp: bare }, 'militia').ok, false, '炼器炉不该造民兵');
    // 产地：同一座炉子，有森林能出、没有就出不了
    assert.equal(v({ kind: 'camp', camp: forge }, 'cultivation-artifact-wood').ok, true, '挨着森林该能出青木剑');
    const noForest = v({ kind: 'camp', camp: bare }, 'cultivation-artifact-wood');
    assert.equal(noForest.ok, false, '没有森林出不了青木剑');
    assert.ok(noForest.ok ? '' : /森林/.test(noForest.reason), '理由要写清缺森林');
    // 城市不产法器（campOnly）
    const fromCity = v({ kind: 'city', city }, 'cultivation-artifact-wood');
    assert.equal(fromCity.ok, false, '城市产线不供法器');
    assert.ok(fromCity.ok ? '' : /产兵建筑/.test(fromCity.reason), '理由要说明只能由产兵建筑造');
    // 白名单按时代递增：一代炉子没有寒水镜
    assert.equal(v({ kind: 'camp', camp: forge }, 'cultivation-artifact-water').ok, false, '一代炉不认三代法器');
  });

  test('法器只认点名要造它的产兵建筑：军营连灰都不该列', () => {
    // 军营的白名单是空的（= 不设限），所以它能认一整张兵种表。
    // 但"不设限"不该盖过 campOnly：法器只能出自炼器炉，
    // 否则军营里会平白多出一排灰色的"还造不出来"。
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const camp = place2(s, 'A', 'camp', 5, 5);
    const r = produceAt(s, { kind: 'camp', camp }, s.unitTypes['cultivation-artifact-wood']);
    assert.equal(r.ok, false, '军营不该认法器');
    assert.ok(r.ok ? '' : /产不了/.test(r.reason), `理由要说清是产不了：${r.ok ? '' : r.reason}`);

    // 反过来：炉子的白名单点了名，它就认
    const forge = place2(s, 'A', 'cultivation-forge-1', 8, 8);
    assert.equal(
      produceAt(s, { kind: 'camp', camp: forge }, s.unitTypes['cultivation-artifact-wood']).ok,
      false,
      '炉子挨不到森林时仍然造不出（条件不满足）',
    );
  });

  test('炼器：真能从林中炉造出青木剑，空地炉被规则层拒', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    s.players.A.res = { [SPIRIT_STONE]: 200 };
    s.players.A.gold = 900;
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    s.tiles[5 * s.w + 5] = { terrain: 'forest', cityId: null };
    const forge = place2(s, 'A', 'cultivation-forge-1', 5, 4);
    const bare = place2(s, 'A', 'cultivation-forge-1', 8, 8);

    const ok = applyAction(s, {
      type: 'RECRUIT',
      unitId: forge.id,
      unitType: 'cultivation-artifact-wood',
    });
    assert.ok(ok.ok, ok.ok ? '' : `林中炉该能造青木剑：${ok.reason}`);
    assert.ok(
      ok.state.units.some((u) => u.type === 'cultivation-artifact-wood'),
      '棋盘上应该多一柄青木剑',
    );

    const denied = applyAction(s, {
      type: 'RECRUIT',
      unitId: bare.id,
      unitType: 'cultivation-artifact-wood',
    });
    assert.equal(denied.ok, false, '空地炉造不出青木剑');
    assert.ok(denied.ok ? '' : /森林/.test(denied.reason), `理由要写清缺森林：${denied.ok ? '' : denied.reason}`);
  });

  // ── 灵气滋养 ──────────────────────────────────────────

  const nextTurn = (s: GameState) => {
    const r = applyAction(s, { type: 'END_TURN' });
    assert.ok(r.ok, `END_TURN 失败: ${r.reason}`);
    return r.state;
  };
  const unitOf = (s: GameState, type: string, owner: string) =>
    s.units.find((u) => u.type === type && u.owner === owner)!;

  // 纯查询：不走回合，直接测 spiritAuraBonusOf，最稳
  test('灵气滋养：半径1内每个灵田 +1，可叠加', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    place2(s, 'A', 'cultivation-spirit-field', 5, 5);
    const mon = place2(s, 'A', 'qi-cultivator', 5, 6);
    assert.equal(spiritAuraBonusOf(s, mon), 1);

    place2(s, 'A', 'cultivation-spirit-field', 5, 7);
    assert.equal(spiritAuraBonusOf(s, mon), 2);
  });

  test('灵气滋养：半径2不生效', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    place2(s, 'A', 'cultivation-spirit-field', 5, 5);
    const mon = place2(s, 'A', 'qi-cultivator', 5, 7);
    assert.equal(spiritAuraBonusOf(s, mon), 0);
  });

  test('灵气滋养：资敌——不计阵营', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    place2(s, 'A', 'cultivation-spirit-field', 5, 5);
    const foe = place2(s, 'B', 'qi-cultivator', 5, 6);
    assert.equal(spiritAuraBonusOf(s, foe), 1);
  });

  test('灵气滋养：非修士不吃光环，面板也不显示', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    place2(s, 'A', 'cultivation-spirit-field', 5, 5);
    const servant = place2(s, 'A', 'cultivation-servant', 5, 6);
    assert.equal(spiritAuraBonusOf(s, servant), 0);
    assert.ok(!getCultivationPanelLines(s, servant).some((l) => l.includes(SPIRIT_AURA_LABEL)));
  });

  test('灵气滋养：灵田被摧毁后不再提供', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    const field = place2(s, 'A', 'cultivation-spirit-field', 5, 5);
    const mon = place2(s, 'A', 'qi-cultivator', 5, 6);
    s.units = s.units.filter((u) => u.id !== field.id);
    assert.equal(spiritAuraBonusOf(s, mon), 0);
  });

  test('灵气滋养：面板与查询一致，无灵田时不显示', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    const mon = place2(s, 'A', 'qi-cultivator', 5, 5);
    assert.ok(!getCultivationPanelLines(s, mon).some((l) => l.includes(SPIRIT_AURA_LABEL)));

    place2(s, 'A', 'cultivation-spirit-field', 5, 6);
    const lines = getCultivationPanelLines(s, mon);
    assert.ok(lines.some((l) => l.includes(SPIRIT_AURA_LABEL) && l.includes('+1')));
  });

  // 回合触发：只测战报存在性和私有性，不测精确经验增量（打坐会污染）
  test('灵气滋养：灵田所属方回合开始写战报，且仅自己可见', () => {
    let s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    place2(s, 'A', 'cultivation-spirit-field', 5, 5);
    place2(s, 'A', 'qi-cultivator', 5, 6);
    for (let i = 0; i < 4; i++) s = nextTurn(s);
    
    const line = s.log.find((l) => l.text.includes('滋养了'));
    assert.ok(line, '应有"滋养了 N 名修士"战报');
    
    // 核心引擎中 open 默认为 false，且仅在 true 时才向对象挂载该字段。
    // 所以非公开战报的 open 字段为 undefined。
    assert.ok(!line.open, '战报应仅自己可见'); 
  });

  // 回合触发：对比法，只断言"有灵田的修士经验更多"
  test('灵气滋养：有灵田的修士经验多于无灵田（对比法）', () => {
    const runSeq = (withField: boolean) => {
      let s = fresh({ expansionIds: ['cultivation'] });
      s.units = [];
      if (withField) place2(s, 'A', 'cultivation-spirit-field', 5, 5);
      place2(s, 'A', 'qi-cultivator', 5, 6);
      for (let i = 0; i < 4; i++) s = nextTurn(s);
      return getExp(unitOf(s, 'qi-cultivator', 'A'));
    };
    const withExp = runSeq(true);
    const withoutExp = runSeq(false);
    assert.ok(withExp > withoutExp, `有灵田(${withExp})应多于无灵田(${withoutExp})`);
  });

  // ── 体修（2026-11-07）──────────────────────────────────
  test('体修：时代 2、算修士、带金刚不坏', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const body = place2(s, 'A', 'body-cultivator', 5, 5);
    assert.equal(s.unitTypes['body-cultivator'].era, 2, '体修是时代 2 的兵');
    assert.ok(
      CULTIVATION_PACK.units.some((u) => u.id === UNIT_IDS.BODY_CULTIVATOR),
      '包里要登记体修',
    );
    assert.ok(CULTIVATION_ABILITIES.some((a) => a.id === 'body-ward'), '能力表里要有金刚不坏');
    // 能修炼才算修士：升到 3 级后属性必须跟着涨
    setCultivationExp(body, expForRank(2));
    assert.ok(
      effectiveStats(s, body).atk > s.unitTypes['body-cultivator'].atk,
      '境界要加攻击，否则它只是个普通兵',
    );
    const lines = getCultivationPanelLines(s, body).join('\n');
    assert.ok(lines.includes('金刚不坏'), '面板要写金刚不坏');
    assert.ok(lines.includes('体修'), '面板要写流派系数');
  });

  test('金刚不坏：30% 起步，最后一档 50%', () => {
    assert.deepEqual([...BODY_WARD_TIERS], [0.3, 0.35, 0.4, 0.5]);
    assert.equal(bodyWardPct(100, 100), 0.3, '满血 30%');
    assert.equal(bodyWardPct(60, 100), 0.35, '掉到 60% 血是第二档');
    assert.equal(bodyWardPct(40, 100), 0.4, '掉到 40% 血是第三档');
    assert.equal(bodyWardPct(25, 100), 0.5, '最后四分之一血跳到 50%');
    assert.equal(bodyWardPct(1, 100), 0.5);
    assert.equal(bodyWardPct(1, 0), 0, '没有生命上限时不该返回减免');
  });

  test('金刚不坏：挨打真的变少，血越少越硬', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    s.current = 'A';
    const body = place2(s, 'A', 'body-cultivator', 5, 5);
    const qi = place2(s, 'A', 'qi-cultivator', 5, 7);
    const foe = place2(s, 'B', 'artillery', 8, 5);

    const full = computeDamage(s, foe, body);
    body.hp = Math.round(maxHpOf(s, body) * 0.2);
    const low = computeDamage(s, foe, body);
    assert.ok(low < full, `残血(${low})该比满血(${full})挨得少`);

    const qiDmg = computeDamage(s, foe, qi);
    assert.ok(full < qiDmg, `满血体修(${full})也该比炼气士(${qiDmg})抗打`);
  });

  test('金刚不坏：只减物理段，真元原样吃', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    s.current = 'A';
    const body = place2(s, 'A', 'body-cultivator', 5, 5);
    const qi = place2(s, 'B', 'qi-cultivator', 8, 5);
    setCultivationExp(body, expForRank(2));
    setCultivationExp(qi, expForRank(2));

    // 拉到最后一档（50%）：物理段减半，真元一分不少
    body.hp = Math.round(maxHpOf(s, body) * 0.2);
    const trueDmg = trueDamageOf(qi);
    assert.ok(trueDmg > 0, '这条用例要求对面有真元');
    const physical = Math.max(0, effectiveStats(s, qi).atk - effectiveStats(s, body).armor);
    assert.equal(
      computeDamage(s, qi, body),
      Math.round(physical * 0.5) + trueDmg,
      '真元不吃减免——炼气士/剑修才是体修的克星',
    );
  });

  test('体修：境界加成偏科（攻 ×1.1，真元/移动/射程 ×0.5）', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    const body = place2(s, 'A', 'body-cultivator', 5, 5);
    const qi = place2(s, 'A', 'qi-cultivator', 5, 7);
    const sword = place2(s, 'A', 'sword-cultivator', 5, 9);
    for (const u of [body, qi, sword]) setCultivationExp(u, expForRank(2)); // 都是 3 级

    // 射程与移动折半：3 级时炼气士各 +1，体修还是 0
    assert.equal(effectiveStats(s, body).range, 1, '体修射程不涨');
    assert.equal(effectiveStats(s, qi).range, 2, '炼气士照常 +1');
    assert.equal(effectiveStats(s, body).move, 2, '体修移动不涨');
    assert.equal(effectiveStats(s, qi).move, 3, '炼气士照常 +1');

    // 真元折半；炼气士与剑修不变
    assert.equal(trueDamageOf(body), Math.floor(trueDamageForRank(3) / 2));
    assert.equal(trueDamageOf(qi), trueDamageForRank(3));
    assert.equal(trueDamageOf(sword), trueDamageForRank(3));

    // 攻击则更高一档：体修用拳头吃饭
    const bodyAtk = effectiveStats(s, body).atk - s.unitTypes['body-cultivator'].atk;
    const qiAtk = effectiveStats(s, qi).atk - s.unitTypes['qi-cultivator'].atk;
    assert.ok(bodyAtk >= qiAtk, `体修境界攻击(${bodyAtk})不该低于炼气士(${qiAtk})`);
  });

  // ── 魔修（2026-11-07）──────────────────────────────────
  /** 摆一个只有魔修的小场景：清空编制，方便数伤害 */
  const mageScene = () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    s.units = [];
    s.current = 'A';
    const mage = place2(s, 'A', 'blood-cultivator', 5, 5);
    return { s, mage };
  };
  const castRite = (s: GameState, mage: any) =>
    applyAction(s, { type: 'HERO_SKILL', unitId: mage.id, skillId: 'blood-rite' });

  test('魔修：时代 3、带血祭、打坐只有 1 点', () => {
    const { s, mage } = mageScene();
    assert.equal(s.unitTypes['blood-cultivator'].era, 3, '魔修是时代 3');
    assert.ok(
      CULTIVATION_PACK.units.some((u) => u.id === UNIT_IDS.BLOOD_CULTIVATOR),
      '包里要登记魔修',
    );
    assert.ok(
      (s.unitTypes['blood-cultivator'].skills ?? []).some((k) => k.id === 'blood-rite'),
      '魔修要自带血祭',
    );
    assert.equal(EXP_GROWTH_BLOOD, 1);
    assert.equal(getExpGrowth(mage), EXP_GROWTH_BLOOD, '魔修打坐固定 1 点');
  });

  test('血祭：一圈之内不分敌我，友军被抽到 1 血为止', () => {
    const { s, mage } = mageScene();
    const foe = place2(s, 'B', 'militia', 6, 5);
    const ally = place2(s, 'A', 'militia', 4, 5);
    ally.hp = 3;
    const outside = place2(s, 'B', 'militia', 8, 5);

    const r = castRite(s, mage);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const at = (id: string) => r.state.units.find((u) => u.id === id)!;

    assert.ok(at(foe.id).hp < foe.hp, '敌人要掉血');
    assert.equal(at(ally.id).hp, 1, '友军最低留 1 血——否则自残就能刷击杀奖励');
    assert.equal(at(outside.id).hp, outside.hp, '半径外不动');
  });

  test('血祭：修为按伤害折算，而且绕过每回合击杀上限', () => {
    const { s, mage } = mageScene();
    const foes = [
      place2(s, 'B', 'militia', 6, 5),
      place2(s, 'B', 'militia', 4, 5),
      place2(s, 'B', 'militia', 5, 4),
    ];
    const per = computeDamage(s, mage, foes[0]);

    const r = castRite(s, mage);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const exp = getExp(r.state.units.find((u) => u.id === mage.id)!);

    assert.equal(exp, Math.floor(per * 3 * bloodRiteExpMul(0)), '伤害 × 折算率');
    assert.ok(exp > killExpCapOfRank(0), `血祭(${exp}) 要能超过击杀上限(${killExpCapOfRank(0)})`);
  });

  test('血祭：友军那部分只折四分之一修为', () => {
    const runWith = (owner: 'A' | 'B') => {
      const { s, mage } = mageScene();
      place2(s, owner, 'militia', 6, 5);
      const r = castRite(s, mage);
      assert.ok(r.ok, r.ok ? '' : r.reason);
      return getExp(r.state.units.find((u) => u.id === mage.id)!);
    };
    const foeExp = runWith('B');
    const allyExp = runWith('A');
    assert.ok(foeExp > 0);
    assert.equal(allyExp, Math.floor(foeExp * BLOOD_RITE_ALLY_EXP_MUL), '友军伤害只算 25%');
  });

  test('血祭：每次扣 1 年寿元', () => {
    const { s, mage } = mageScene();
    place2(s, 'A', 'militia', 6, 5); // 只打友军，经验不足以升级
    const before = getLifespan(mage);
    const r = castRite(s, mage);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const after = r.state.units.find((u) => u.id === mage.id)!;
    assert.equal(getLifespan(after), before - BLOOD_RITE_LIFESPAN_COST, '寿元 −1');
  });

  test('血祭：半径随境界成长，折算率随境界下降', () => {
    assert.equal(bloodRiteRadiusForRank(0), 1);
    assert.equal(bloodRiteRadiusForRank(3), 2);
    assert.equal(bloodRiteRadiusForRank(6), 3);
    assert.equal(bloodRiteRadiusForRank(9), 4);

    assert.equal(bloodRiteExpMul(0), 1);
    assert.ok(bloodRiteExpMul(3) < bloodRiteExpMul(0), '境界越高越不值钱');
    assert.ok(bloodRiteExpMul(9) < bloodRiteExpMul(3));
  });

  test('魔修：不吃击杀历练（血祭已经是绕过上限的那条路）', () => {
    const { s, mage } = mageScene();
    setCultivationExp(mage, expForRank(2)); // 3 级
    const foe = place2(s, 'B', 'halberdier', 6, 5);

    const before = getExp(mage);
    CULTIVATION_HOOKS.onUnitKilled({ state: s, victim: foe, killer: mage, killerOwner: 'A' });
    assert.equal(getExp(mage), before, '魔修不该从击杀里拿修为');

    // 对照：炼气士照常吃
    const qi = place2(s, 'A', 'qi-cultivator', 5, 7);
    setCultivationExp(qi, expForRank(2));
    const beforeQi = getExp(qi);
    CULTIVATION_HOOKS.onUnitKilled({ state: s, victim: foe, killer: qi, killerOwner: 'A' });
    assert.ok(getExp(qi) > beforeQi, '其他修士仍然吃击杀历练');
  });
}

// 这段魔法代码可以让这个文件被单独运行
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
  console.log(`\n通过 ${stats.passed} 项，失败 ${stats.failed} 项\n`);
  if (stats.failed > 0) process.exit(1);
}