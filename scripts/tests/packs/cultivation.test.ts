// @ts-nocheck
import { test, assert, stats, fresh, place2 } from '../support.ts';
import { applyAction, effectiveStats, movePower, maxHpOf, computeDamage, heroSkillsOf, unitYield, idx } from '../../../src/core/rules.ts';
import { cultivationRank, getAgingYears, setCultivationExp } from '../../../src/core/cultivation-packs.ts';
import { SPIRIT_STONE } from '../../../src/core/cultivation/resources.ts';
// GameState 只在 nextTurn/unitOf 的签名里当类型用；@ts-nocheck 关掉了检查，
// 但漏了真 import 的话，将来取消 nocheck 会一次冒出十几个报错。
import type { GameState } from '../../../src/core/types.ts';
import { skillsOf } from '../../../src/core/query.ts';
import { getExp, addExp, expForRank } from '../../../src/core/cultivation/progression.ts';
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
} from '../../../src/core/cultivation/stats.ts';
import { baseLifespanOf, getExpGrowth } from '../../../src/core/cultivation/progression.ts';
import { getCultivationPanelLines } from '../../../src/core/cultivation/panel.ts';
import { CULTIVATION_PACK } from '../../../src/core/cultivation-packs.ts';
import { UNIT_IDS } from '../../../src/core/cultivation/identity.ts';
import { CULTIVATION_ABILITIES } from '../../../src/core/cultivation/abilities/index.ts';
import { CULTIVATOR_SKILL_UNLOCKS } from '../../../src/core/cultivation/skills/unlocks.ts';
import { CULTIVATOR_ABILITY_UNLOCKS } from '../../../src/core/cultivation/abilities/unlocks.ts';
import { SKILL_EFFECTS } from '../../../src/core/skill-hooks.ts';

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
}

// 这段魔法代码可以让这个文件被单独运行
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
  console.log(`\n通过 ${stats.passed} 项，失败 ${stats.failed} 项\n`);
  if (stats.failed > 0) process.exit(1);
}