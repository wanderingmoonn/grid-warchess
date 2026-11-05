// @ts-nocheck
import { test, assert, stats, fresh, arena, place, place2 } from '../support.ts';
import { applyAction, effectiveStats, movePower, maxHpOf, computeDamage, idx, heroSkillsOf, refreshMemory, splashRadiusOf, splashRatioOf } from '../../../src/core/rules.ts';
import { cultivationRank, getAgingYears, setCultivationExp } from '../../../src/core/cultivation-packs.ts';
import { SPIRIT_STONE } from '../../../src/core/cultivation/resources.ts';
import { CONFIG, UNIT_TYPES } from '../../../src/core/config.ts';
import type { Unit } from '../../../src/core/types.ts';
import { trimChatBody, CHAT_MAX_LEN, chatWhoLabel, type ChatLine, chatLinesHtml, chatSeatOf, chatBodyOverflows, chatBodyLength, type ChatSeat } from '../../../src/net/chat.ts';
import { countWatchers, PRESENCE_TTL_MS, watchLabel, presenceFromRow } from '../../../src/net/presence.ts';
import { adoptDecision } from '../../../src/net/room.ts';
import { skillsOf } from '../../../src/core/query.ts';

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
      qi.custom.exp = 8;
      const r = applyAction({ ...s, current: 'A', units: [qi, main, near, far] }, { type: 'ATTACK', unitId: qi.id, targetId: main.id });
      assert.ok(r.ok, r.ok ? '' : r.reason);
      assert.equal(r.state.units.find(u => u.id === near.id)!.hp, 1000, 'x=3 没有溅射');
    }

    {
      const { s, qi, main, near, far } = setup();
      qi.custom.exp = 250;
      const r = applyAction({ ...s, current: 'A', units: [qi, main, near, far] }, { type: 'ATTACK', unitId: qi.id, targetId: main.id });
      assert.ok(r.ok, r.ok ? '' : r.reason);
      assert.ok(r.state.units.find(u => u.id === near.id)!.hp < 1000, 'x=4 应该波及距离 1 的敌人');
      assert.equal(r.state.units.find(u => u.id === far.id)!.hp, 1000, 'x=4 够不到距离 2 的敌人');
    }

    // 3. x=8，半径 2：near 和 far 全波及
    {
      const { s, qi, main, near, far } = setup();
      qi.custom.exp = 2000;
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

    const table: Array<[rank: number, exp: number, expectedMove: number]> = [
      [0, 0, 2],      // 0/3 = 0 -> 2
      [2, 30, 2],     // 2/3 = 0 -> 2
      [3, 70, 3],     // 3/3 = 1 -> 3
      [5, 222, 3],    // 5/3 = 1 -> 3
      [6, 361, 4],    // 6/3 = 2 -> 4
      [8, 1389, 4],   // 8/3 = 2 -> 4
      [9, 4006, 5],   // 9/3 = 3 -> 5
    ];

    for (const [rank, exp, expectedMove] of table) {
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
    setCultivationExp(qi, 4006);
    assert.equal(effectiveStats(s, qi).vision, 12, 'x=9 神识全开，视野 12');

    // 衰老测试用 8 级（exp=1389），寿元照旧由 custom 钉死，免得跟着曲线漂
    setCultivationExp(qi, 1389);
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

    s.players.A.res = { [SPIRIT_STONE]: 10 };

    const skillRes = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: 't-tower',
      skillId: 'tower-charge',
    });
    assert.ok(skillRes.ok, '应该能成功释放技能');
    assert.equal(skillRes.state.players.A.res![SPIRIT_STONE], 5, '应该扣除 5 灵石');

    // 👇 关键打印 1：看看放完技能后，塔的 custom 里到底存了什么
    const towerAfterSkill = skillRes.state.units.find(u => u.id === 't-tower')!;
    console.log('放完技能后的 custom：', towerAfterSkill.custom);

    const r = applyAction(skillRes.state, { type: 'END_TURN' });
    assert.ok(r.ok);

    // 👇 关键打印 2：看看战报里是打了几次，还是根本没打
    console.log('战斗日志：', r.state.log.map(l => l.text));

    const target = r.state.units.find(u => u.id === 't-target')!;
    assert.ok(target.hp <= 70, '塔应该开火并造成至少 30 点伤害');
  });
}

// 这段魔法代码可以让这个文件被单独运行
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
  console.log(`\n通过 ${stats.passed} 项，失败 ${stats.failed} 项\n`);
  if (stats.failed > 0) process.exit(1);
}