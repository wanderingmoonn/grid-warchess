// @ts-nocheck
import { test, assert, stats, fresh, place2 } from '../support.ts';
import { applyAction, effectiveStats, movePower, maxHpOf, computeDamage, heroSkillsOf, unitYield, idx, abilityApi, STATUS_REGISTRY, produceAt, citiesOf, reachableTiles, recruitResCost, airLayer, canStandAt, canStrike, strikeDistance } from '../../../src/core/rules.ts';
import { distBetweenUnits } from '../../../src/core/query.ts';
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
  getRank,
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
import { trueDamageWithMods } from '../../../src/core/cultivation/stats.ts';
import { warmNourishHeal, WARM_NOURISH_RADIUS } from '../../../src/core/cultivation/artifacts.ts';
import { SWORD_QI_ATK_PCT, SWORD_QI_RADIUS } from '../../../src/core/cultivation/abilities/artifact-auras.ts';
import { EXP_GROWTH_BLOOD } from '../../../src/core/cultivation/progression.ts';
import {
  bloodRiteRadiusForRank,
  bloodRiteExpMul,
  BLOOD_RITE_ALLY_EXP_MUL,
  BLOOD_RITE_LIFESPAN_COST,
} from '../../../src/core/cultivation/skills/blood-rite.ts';
import { getCultivationPanelLines } from '../../../src/core/cultivation/panel.ts';
import { detailCardHtml } from '../../../src/ui/panel.ts';
import {
  QI_BUILDING_SOURCE,
  QI_MAX,
  QI_TERRAIN_SOURCE,
  QI_VIEW_TIERS,
  exchangeMana,
  previewExchange,
  qiAt,
  qiOverlayCells,
  qiSourceLabel,
  qiTierOf,
  stepQiField,
} from '../../../src/core/cultivation/qi-field.ts';
import { CULTIVATION_PACK } from '../../../src/core/cultivation-packs.ts';
import { UNIT_IDS } from '../../../src/core/cultivation/identity.ts';
import { isCultivatorUnit } from '../../../src/core/cultivation/identity.ts';
import { SKY_STEP_SKILL } from '../../../src/core/cultivation/skills/sky-step.ts';
import { PALM_THUNDER_SKILL } from '../../../src/core/cultivation/skills/palm-thunder.ts';
import { CULTIVATION_ABILITIES } from '../../../src/core/cultivation/abilities/index.ts';
import { CORE_ABILITIES } from '../../../src/core/abilities.ts';
import { CULTIVATOR_SKILL_UNLOCKS } from '../../../src/core/cultivation/skills/unlocks.ts';
import { CULTIVATOR_ABILITY_UNLOCKS } from '../../../src/core/cultivation/abilities/unlocks.ts';
import { SKILL_EFFECTS, SKILL_PREVIEWERS } from '../../../src/core/skill-hooks.ts';
import { TELEPORT_COST, TELEPORT_RIFT_LOG } from '../../../src/core/cultivation/skills/teleport-swap.ts';
import { SPRING_HP_PER_STONE } from '../../../src/core/cultivation/skills/spirit-spring.ts';
import { sectLegacyMul, sectRecruitStone } from '../../../src/core/cultivation/sect.ts';
import {
  HEAL_PILL,
  PILL_CARRY_BASE,
  PILLS,
  SPIRIT_PILL,
  WARD_PILL,
  WARD_PILL_TURNS,
  addPill,
  furnaceNextTo,
  pillBrewProblem,
  pillCarryCap,
  pillCountOf,
  pillOf,
  pillsOf,
  pillUseProblem,
} from '../../../src/core/cultivation/pills.ts';
import {
  LIBRARY_SPELL_SLOTS,
  RESEARCH_BASE_SLOTS,
  activeLibrariesOf,
  forgetProblem,
  isResearched,
  knownSpells,
  libraryIsActive,
  pavilionIsActive,
  researchCapOf,
  researchCostOf,
  researchProblem,
  researchedOf,
  silentPavilionNextTo,
  spellLearnProblem,
  spellOf,
  spellSlotsOf,
  teachSpell,
} from '../../../src/core/cultivation/spells.ts';
import { MANA_REGEN, manaLimitForRank, manaOf, maxManaOf, setMana } from '../../../src/core/cultivation/mana.ts';
import { PALM_THUNDER_COST, palmThunderDamage } from '../../../src/core/cultivation/skills/palm-thunder.ts';
import {
  SPIRIT_BREATH_COST,
  SPIRIT_BREATH_EXP_FLOOR,
  SPIRIT_BREATH_EXP_PER_RANK,
  SPIRIT_BREATH_MIN_QI,
  SPIRIT_BREATH_QI_PER_EXP,
  spiritBreathCap,
  spiritBreathExp,
} from '../../../src/core/cultivation/skills/spirit-breath.ts';
import {
  GANG_WIND_COST,
  GANG_WIND_MIN_RANK,
  GANG_WIND_RADIUS,
  gangWindDamage,
} from '../../../src/core/cultivation/skills/gang-wind.ts';

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
    const abilityIds = new Set([
      ...(pack.abilities ?? []).map((a) => a.id),
      // 本体那批公共词汇（fly / heal / first-strike…）扩展当然可以用：
      // 守卫要拦的是"谁都没定义过的 id"，不是"不是我家定义的 id"。
      ...CORE_ABILITIES.map((a) => a.id),
    ]);

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

  // ── 灵泉（2026-11-08）──────────────────────────────
  //
  // 加它的直接原因是"地图不一定生成水"：寒水镜原本只认水面/浅滩，
  // 一张没有河湖的图上这条产品线整条作废。灵泉既是备用产地，也是一座支援建筑。

  test('灵泉：四代建筑，只有管事会盖', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const spring = s.unitTypes['cultivation-spirit-spring'];
    assert.ok(spring, '灵泉应该在对局兵种表里');
    assert.equal(spring.era, 4, '灵泉是四代建筑');
    assert.equal(spring.category, 'building', '它是建筑，不是兵');

    const builds = (id: string) => s.unitTypes[id].builds ?? [];
    assert.ok(!builds('cultivation-servant').includes('cultivation-spirit-spring'), '仆役不会开泉');
    assert.ok(!builds('cultivation-deacon').includes('cultivation-spirit-spring'), '执事也不会');
    assert.ok(builds('cultivation-steward').includes('cultivation-spirit-spring'), '管事会开泉');

    // 真盖一次：管事投 24 点、灵泉要 30 点 → 当回合只是工地
    const t = fresh({ expansionIds: ['cultivation'], godMode: true });
    t.units = [];
    t.current = 'A';
    t.players.A.gold = 900;
    t.players.A.res = { [SPIRIT_STONE]: 100 };
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) t.tiles[y * t.w + x] = { terrain: 'plain', cityId: null };
    }
    const steward = place2(t, 'A', 'cultivation-steward', 5, 5);
    const built = applyAction(t, {
      type: 'BUILD',
      unitId: steward.id,
      unitType: 'cultivation-spirit-spring',
      x: 6,
      y: 5,
    });
    assert.ok(built.ok, built.ok ? '' : built.reason);
    const site = built.state.units.find((u) => u.type === 'cultivation-spirit-spring');
    assert.ok(site, '应该落下一个工地');
    assert.ok(
      (site!.buildDone ?? 0) < (site!.buildNeed ?? 0),
      '管事一次投 24 点、灵泉要 30 点，当回合立不起来',
    );
  });

  test('寒水镜：没有水的地图上，灵泉旁边一样炼得出来', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    s.players.A.res = { [SPIRIT_STONE]: 200 };
    s.players.A.gold = 900;
    // 铺一块干地：整片平原，没有水
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    const forge = place2(s, 'A', 'cultivation-forge-2', 5, 5);
    const v = (camp: any) => produceAt(s, { kind: 'camp', camp }, s.unitTypes['cultivation-artifact-water']);

    const dry = v(forge);
    assert.equal(dry.ok, false, '四邻没水也没灵泉时炼不出寒水镜');
    assert.ok(
      dry.ok ? '' : dry.reason.includes('灵泉'),
      `拒绝理由要写明有另一条路：${dry.ok ? '' : dry.reason}`,
    );

    place2(s, 'A', 'cultivation-spirit-spring', 6, 5);
    assert.equal(v(forge).ok, true, '灵泉就挨着炉子，应该能炼');
  });

  test('泉涌：四邻友军各回 10%，按实际回血量收灵石，每回合一次', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const spring = place2(s, 'A', 'cultivation-spirit-spring', 5, 5);
    const left = place2(s, 'A', 'qi-cultivator', 4, 5);
    const down = place2(s, 'A', 'qi-cultivator', 5, 6);
    const foe = place2(s, 'B', 'qi-cultivator', 6, 5); // 敌人的伤员：不该被治
    const far = place2(s, 'A', 'qi-cultivator', 7, 5); // 四邻之外
    for (const u of [left, down, foe, far]) u.hp = 5;
    s.players.A.res = { [SPIRIT_STONE]: 100 };

    const maxHp = maxHpOf(s, left);
    const heal = Math.max(1, Math.round(maxHp * 0.1));
    const r = applyAction(s, { type: 'HERO_SKILL', unitId: spring.id, skillId: 'spring-surge' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const at = (id: string) => r.state.units.find((u) => u.id === id)!;

    assert.equal(at(left.id).hp, 5 + heal, `回 ${heal} 点（${maxHp} 上限的 10%）`);
    assert.equal(at(down.id).hp, 5 + heal, '第二个相邻友军同样回');
    assert.equal(at(foe.id).hp, 5, '泉水不替敌人疗伤');
    assert.equal(at(far.id).hp, 5, '四邻之外不治（不含两格外）');

    // 总回血量 = 2 × heal；每 5 点 1 块，至少 1 块
    const cost = Math.max(1, Math.ceil((heal * 2) / SPRING_HP_PER_STONE));
    assert.equal(r.state.players.A.res![SPIRIT_STONE], 100 - cost, `应该扣 ${cost} 块灵石`);

    // 没有冷却，但 multiCast: false → 同一回合一放完就灰
    const again = applyAction(r.state, { type: 'HERO_SKILL', unitId: spring.id, skillId: 'spring-surge' });
    assert.equal(again.ok, false, '一回合只能泉涌一次');
  });

  test('泉涌：灵石不够时每个单位只回 1 点，最低价照扣', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const spring = place2(s, 'A', 'cultivation-spirit-spring', 5, 5);
    const mud = [
      place2(s, 'A', 'body-cultivator', 4, 5),
      place2(s, 'A', 'body-cultivator', 5, 6),
      place2(s, 'A', 'body-cultivator', 6, 5),
    ];
    for (const u of mud) u.hp = 5;
    // 三个体修（30 血）各回 3 点 = 9 点 → 满额要 2 块；只给 1 块
    s.players.A.res = { [SPIRIT_STONE]: 1 };

    const r = applyAction(s, { type: 'HERO_SKILL', unitId: spring.id, skillId: 'spring-surge' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const at = (id: string) => r.state.units.find((u) => u.id === id)!;
    for (const u of mud) assert.equal(at(u.id).hp, 6, '降级后每人只回 1 点');
    assert.equal(r.state.players.A.res![SPIRIT_STONE], 0, '最低价 1 块照扣，不能白刷');
    assert.ok(
      r.state.log.some((l) => l.text.includes('灵石不足')),
      '战报要说清这次是降级',
    );
  });

  test('泉涌：没灵石 / 旁边没伤员时都放不出来', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const spring = place2(s, 'A', 'cultivation-spirit-spring', 5, 5);
    const whole = place2(s, 'A', 'qi-cultivator', 4, 5); // 满血
    const skillOf = () => heroSkillsOf(s, spring).find((k) => k.def.id === 'spring-surge')!;

    s.players.A.res = { [SPIRIT_STONE]: 0 };
    assert.equal(skillOf().ready, false, '一块灵石都没有时按钮该是灰的');
    assert.ok(skillOf().notReadyReason?.includes('灵石'), '理由要说"灵石不足"');

    s.players.A.res = { [SPIRIT_STONE]: 10 };
    assert.equal(skillOf().ready, false, '四邻只有满血友军时也不该亮');
    assert.ok(
      /救治|伤员/.test(skillOf().notReadyReason ?? ''),
      `理由要说清没人可治：${skillOf().notReadyReason}`,
    );

    whole.hp = 1;
    assert.equal(skillOf().ready, true, '有人受伤就该亮');
    const r = applyAction(s, { type: 'HERO_SKILL', unitId: spring.id, skillId: 'spring-surge' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.ok(
      (r.state.units.find((u) => u.id === whole.id)!.hp) <= maxHpOf(s, whole),
      '回血不会超过上限',
    );
  });

  // ── 法器：器灵 / 温养 / 剑气环 / 产地（2026-11-08）──────

  test('法器：每件都带 artifact 标记与两条公共能力', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const arts = Object.values(s.unitTypes).filter((d) => d.artifact);
    assert.equal(arts.length, 4, '应该正好四件法器');
    for (const d of arts) {
      assert.equal(d.campOnly, true, `${d.name} 只能由产兵建筑造`);
      assert.ok(d.abilities?.includes('artifact-spirit'), `${d.name} 缺「器灵」`);
      assert.ok(d.abilities?.includes('warm-nourish'), `${d.name} 缺「温养」`);
    }
  });

  test('器灵：出了修士神识移动力减半，修士死了也不算', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const sword = place2(s, 'A', 'cultivation-artifact-wood', 5, 5);
    // 青木剑 4 移；场上没有修士 → 减半
    assert.equal(movePower(s, sword), 2, '没有修士看着，飞剑只能拖着走');

    const qi = place2(s, 'A', 'qi-cultivator', 6, 5);
    assert.equal(movePower(s, sword), 4, '修士在神识内 → 全额');

    // 走远到神识之外
    qi.x = s.w - 1;
    qi.y = s.h - 1;
    assert.equal(movePower(s, sword), 2, '出了神识又掉回减半');

    // 死在旁边：死人不看路
    qi.x = 6;
    qi.y = 5;
    qi.hp = 0;
    assert.equal(movePower(s, sword), 2, '死掉的修士不再护持');
  });

  test('器灵：神识内加甲，取范围内护甲最高的修士的一半', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const sword = place2(s, 'A', 'cultivation-artifact-wood', 5, 5);
    const base = s.unitTypes['cultivation-artifact-wood'].armor;
    assert.equal(effectiveStats(s, sword).armor, base, '没修士就只有本体的甲');

    const qi = place2(s, 'A', 'qi-cultivator', 6, 5);
    const qiArmor = effectiveStats(s, qi).armor;
    assert.equal(
      effectiveStats(s, sword).armor,
      base + Math.floor(qiArmor / 2),
      '神识内加半个修士甲',
    );

    // 再来一个甲更高的体修：**取最高**，不是相加
    const body = place2(s, 'A', 'body-cultivator', 5, 6);
    addExp(body, s, expForRank(4)); // rank 5
    const bodyArmor = effectiveStats(s, body).armor;
    assert.ok(bodyArmor > qiArmor, `体修的甲(${bodyArmor})该高于炼气士(${qiArmor})`);
    assert.equal(
      effectiveStats(s, sword).armor,
      base + Math.floor(bodyArmor / 2),
      '两个修士只按最高的那位算，不叠乘',
    );

    // 敌方修士不管用
    const foe = place2(s, 'B', 'qi-cultivator', 4, 5);
    assert.ok(foe);
  });

  test('器灵：敌方修士不给加持', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const sword = place2(s, 'A', 'cultivation-artifact-wood', 5, 5);
    place2(s, 'B', 'qi-cultivator', 6, 5);
    const base = s.unitTypes['cultivation-artifact-wood'].armor;
    assert.equal(effectiveStats(s, sword).armor, base, '敌人的神识不会替你御剑');
    assert.equal(movePower(s, sword), 2, '也不会让你的飞剑走得快');
  });

  test('温养：半径内己方修士才回血，按最高境界算', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const sword = place2(s, 'A', 'cultivation-artifact-wood', 5, 5);
    assert.equal(warmNourishHeal(s, sword), 0, '没修士就没得养');

    const qi = place2(s, 'A', 'qi-cultivator', 6, 5);
    assert.equal(warmNourishHeal(s, sword), 1, '0 级修士回 1 点');

    addExp(qi, s, expForRank(4)); // rank 5
    assert.equal(warmNourishHeal(s, sword), 3, '5 级修士回 1 + ⌊5/2⌋ = 3 点');

    // 出了温养半径（2 格）就断粮——注意它和"神识"是两个半径
    qi.x = 5 + (WARM_NOURISH_RADIUS + 1);
    assert.equal(warmNourishHeal(s, sword), 0, '离远了就不养了');
  });

  test('温养：回合开始真的回血，敌方修士不算', () => {
    let s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const sword = place2(s, 'A', 'cultivation-artifact-wood', 5, 5);
    const qi = place2(s, 'A', 'qi-cultivator', 6, 5);
    addExp(qi, s, expForRank(4)); // rank 5 → 每回合 3 点
    place2(s, 'B', 'militia', 1, 1); // 留个对手，免得结束回合直接判胜
    sword.hp = 10;

    let r = applyAction(s, { type: 'END_TURN' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    r = applyAction(r.state, { type: 'END_TURN' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const back = r.state.units.find((u) => u.id === sword.id);
    assert.ok(back, '青木剑还该在场上');
    assert.equal(back!.hp, 13, '一个完整回合后该被养回 3 点');

    // 敌方修士不该养
    const s2 = fresh({ expansionIds: ['cultivation'], godMode: true });
    s2.units = [];
    s2.current = 'A';
    const mine = place2(s2, 'A', 'cultivation-artifact-wood', 5, 5);
    place2(s2, 'B', 'qi-cultivator', 6, 5);
    assert.equal(warmNourishHeal(s2, mine), 0, '别人的修士不会替你养剑');
  });

  test('剑气环：半径 2 内友军攻击 +15%', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const sword = place2(s, 'A', 'cultivation-artifact-wood', 5, 5);
    const mate = place2(s, 'A', 'spearman', 6, 5);

    // 先量基准：把剑挪到半径**之外**（距离按"剑到兵的格数"算，不是从原位置算）
    sword.x = mate.x + SWORD_QI_RADIUS + 1;
    const plain = effectiveStats(s, mate).atk;
    assert.equal(plain, s.unitTypes['spearman'].atk, '出了半径就只剩本体攻击');

    // 挪回半径内
    sword.x = mate.x - 1;
    const buffed = effectiveStats(s, mate).atk;
    assert.equal(
      buffed,
      Math.round(plain * (1 + SWORD_QI_ATK_PCT)),
      `半径内该 +${Math.round(SWORD_QI_ATK_PCT * 100)}%`,
    );
    assert.ok(buffed > plain, '加成果然生效了');
  });

  // ── 后三件法器：护甲光环 / 迟缓 / 熔甲 / 真元光环（2026-11-08）──

  test('法器：四件都真的飞在空中层（id 是 fly-over，名字叫「飞行」）', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const arts = Object.values(s.unitTypes).filter((d) => d.artifact);
    assert.equal(arts.length, 4, '应该正好四件法器');
    for (const d of arts) {
      // 2026-11-08：法器的"飞"从「掠空」（只掠水）换成「飞行」（空中层）。
      // 名字和 id 是反的：fly-over 叫飞行，fly 叫掠空——见 abilities.ts 顶部注释。
      assert.ok(d.abilities?.includes('fly-over'), `${d.name} 应该是真飞行（fly-over）`);
      assert.ok(!d.abilities?.includes('fly'), `${d.name} 不该再挂掠空`);
      assert.equal(airLayer(d), true, `${d.name} 要在空中层`);
    }
  });

  test('磐石：半径 2 内友军护甲按比例加成，不足 1 点按 1 点', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const seal = place2(s, 'A', 'cultivation-artifact-stone', 5, 5);
    const mate = place2(s, 'A', 'spearman', 6, 5);

    // 先把印挪到半径外量基准
    seal.x = mate.x + 3;
    const plain = effectiveStats(s, mate).armor;
    assert.ok(plain > 0);

    seal.x = mate.x - 1;
    const buffed = effectiveStats(s, mate).armor;
    // 长枪兵 3 甲，10% 取整是 0，但规则层有 +1 保底
    assert.equal(buffed, plain + Math.max(1, Math.round(plain * 0.1)), '护甲光环要带 +1 保底');
    assert.ok(buffed > plain, '加成果然生效');
  });

  test('迟缓：移动力减半，至少留 1 格', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const u = place2(s, 'A', 'spearman', 5, 5);
    assert.equal(movePower(s, u), 2, '长枪兵 2 移');
    u.status = { chill: 2 };
    assert.equal(movePower(s, u), 1, '2 移减半 = 1');
    // 剩 1 移的单位再减半仍然是 1：这是"追不上"，不是定身
    const seal = place2(s, 'A', 'cultivation-artifact-stone', 8, 8);
    seal.status = { chill: 2 };
    assert.equal(movePower(s, seal), 1, '2 移的玄石印被冻慢后仍是 1，不会归零');
  });

  test('熔甲：护甲减半，按当前护甲算', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const seal = place2(s, 'A', 'cultivation-artifact-stone', 5, 5);
    const before = effectiveStats(s, seal).armor;
    seal.status = { sunder: 2 };
    assert.equal(effectiveStats(s, seal).armor, Math.floor(before / 2), '熔甲把护甲打成一半');
  });

  test('寒水镜：主目标和被波及的都吃迟缓，射程外的没事', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    const mirror = place2(s, 'A', 'cultivation-artifact-water', 4, 5);
    const main = place2(s, 'B', 'militia', 8, 5);
    const near = place2(s, 'B', 'militia', 8, 6);
    const far = place2(s, 'B', 'militia', 8, 9);
    main.hp = near.hp = far.hp = 500;

    const r = applyAction(s, { type: 'ATTACK', unitId: mirror.id, targetId: main.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const at = (id: string) => r.state.units.find((u) => u.id === id);
    assert.equal(at(main.id)?.status?.chill, 2, '主目标要迟缓');
    assert.equal(at(near.id)?.status?.chill, 2, '溅射波及的也要迟缓');
    assert.equal(at(far.id)?.status?.chill, undefined, '射程外不该被冻');
    assert.ok((at(near.id)?.hp ?? 0) < 500, '波及的要掉血');
  });

  test('赤炎珠：溅射挂熔甲；真元光环让修士真元 +10%（保底 +1）', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    const bead = place2(s, 'A', 'cultivation-artifact-fire', 4, 5);
    const main = place2(s, 'B', 'militia', 7, 5);
    const near = place2(s, 'B', 'militia', 7, 6);
    main.hp = near.hp = 500;

    const r = applyAction(s, { type: 'ATTACK', unitId: bead.id, targetId: main.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const at = (id: string) => r.state.units.find((u) => u.id === id);
    assert.equal(at(main.id)?.status?.sunder, 2, '主目标要熔甲');
    assert.equal(at(near.id)?.status?.sunder, 2, '波及的也要熔甲');

    // 真元光环：裸值 → 含光环
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    addExp(qi, s, expForRank(2)); // rank 3
    const base = trueDamageOf(qi);
    const withAura = trueDamageWithMods(base, 0.1);
    assert.equal(withAura, base + Math.max(1, Math.round(base * 0.1)), '真元光环带 +1 保底');
    assert.ok(withAura > base);
  });

  test('飞行：法器悬在空中层——能跨水、能停在水上、地面近战够不着', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    // 铺一条竖着的水带在 x=6，其余平地
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) {
        s.tiles[y * s.w + x] = { terrain: x === 6 ? 'water' : 'plain', cityId: null };
      }
    }
    const sword = place2(s, 'A', 'cultivation-artifact-wood', 5, 5);
    const reach = reachableTiles(s, sword);
    // 没有修士在旁边 → 器灵减半，移 4 只剩 2 格。
    // 直线跨水到 (7,5) 正好 2 步；绕陆地走要 4 步，所以这一条就能证明它会飞。
    assert.equal(movePower(s, sword), 2, '器灵减半后是 2 格');
    assert.ok(reach.has(idx(s, 7, 5)), '飞剑应该能飞到水对岸');
    // `fly` 是"掠水"，水上**可以停**（见 rules.tileStandsOk 的注释）。
    assert.ok(reach.has(idx(s, 6, 5)), '悬在空中层，水面照样能停');

    // 空中层的两个连带效果：地形一概不挡、地面射程 1 够不着
    const mountain = s.tiles[idx(s, 8, 5)];
    (mountain as { terrain: string }).terrain = 'mountain';
    assert.equal(canStandAt(s, 8, 5, 'cultivation-artifact-wood'), true, '高山也能停');
    const grunt = place2(s, 'B', 'militia', 4, 5); // 和飞剑相邻（真实距离 1）
    assert.equal(distBetweenUnits(s, grunt, sword), 1, '前提：真的是隔壁那格');
    assert.equal(strikeDistance(s, grunt, sword), 2, '打空中的目标要按 +1 距离算');
    assert.equal(canStrike(s, grunt, sword), false, '射程 1 的地面兵够不着头顶那一层');
  });

  test('青木剑产地：相邻森林 或 2 块己方灵田', () => {
    const mk = () => {
      const s = fresh({ expansionIds: ['cultivation'], godMode: true });
      s.units = [];
      s.current = 'A';
      s.players.A.res = { [SPIRIT_STONE]: 300 };
      // 把炉子附近摊平，免得默认地形里正好有林子
      for (let y = 3; y <= 7; y++) {
        for (let x = 3; x <= 7; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
      }
      return s;
    };
    const v = (s: GameState, forge: { id: string }) =>
      produceAt(s, { kind: 'camp', camp: s.units.find((u) => u.id === forge.id)! }, s.unitTypes['cultivation-artifact-wood']);

    // 1) 空地：两个条件都不满足
    {
      const s = mk();
      const forge = place2(s, 'A', 'cultivation-forge-1', 5, 5);
      const r = v(s, forge);
      assert.equal(r.ok, false, '什么都没有就不该造得出来');
      assert.ok(r.ok ? '' : /森林/.test(r.reason), '理由里要提森林');
    }
    // 2) 挨着森林：满足
    {
      const s = mk();
      s.tiles[4 * s.w + 5] = { terrain: 'forest', cityId: null };
      const forge = place2(s, 'A', 'cultivation-forge-1', 5, 5);
      assert.equal(v(s, forge).ok, true, '挨着森林就该能造');
    }
    // 3) 只有一块灵田：不够
    {
      const s = mk();
      place2(s, 'A', 'cultivation-spirit-field', 4, 5);
      const forge = place2(s, 'A', 'cultivation-forge-1', 5, 5);
      assert.equal(v(s, forge).ok, false, '一块灵田不够');
    }
    // 4) 两块灵田：够
    {
      const s = mk();
      place2(s, 'A', 'cultivation-spirit-field', 4, 5);
      place2(s, 'A', 'cultivation-spirit-field', 6, 5);
      const forge = place2(s, 'A', 'cultivation-forge-1', 5, 5);
      assert.equal(v(s, forge).ok, true, '两块灵田也够');
    }
    // 5) 一块是自己的、一块是敌人的：敌田不算
    {
      const s = mk();
      place2(s, 'A', 'cultivation-spirit-field', 4, 5);
      place2(s, 'B', 'cultivation-spirit-field', 6, 5);
      const forge = place2(s, 'A', 'cultivation-forge-1', 5, 5);
      assert.equal(v(s, forge).ok, false, '敌方灵田不该给你的炉子供灵');
    }
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

  // ── 宗门大殿（2026-11-08）──────────────────────────────
  //
  // 两个功能都挂在"贴着宗门站的修士"上：招募（灵石、认师父）与传承（打坐倍率）。
  // 放在文件末尾是因为要用上面那几个 nextTurn / unitOf 辅助函数——
  // 它们是在 `run()` 中途才声明的，写在前面会踩 TDZ。

  /** 一块干净的空地，宗门摆 (4,4)-(5,5)，周围的格子留给师徒 */
  const sectScene = () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    s.players.A.res = { [SPIRIT_STONE]: 100 };
    s.players.A.gold = 900;
    const sect = place2(s, 'A', 'cultivation-sect', 4, 4);
    return { s, sect };
  };

  test('宗门：2×2、时代 3、执事与管事会盖', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const def = s.unitTypes['cultivation-sect'];
    assert.ok(def, '宗门要在本局兵种表里');
    assert.equal(def.footprint, 2, '宗门占 2×2');
    assert.equal(def.era, 3, '宗门是三代建筑');

    assert.ok(!(s.unitTypes['cultivation-servant'].builds ?? []).includes('cultivation-sect'), '仆役不会盖');
    assert.ok(s.unitTypes['cultivation-deacon'].builds?.includes('cultivation-sect'), '执事会盖');
    assert.ok(s.unitTypes['cultivation-steward'].builds?.includes('cultivation-sect'), '管事继承');
  });

  test('宗门：2×2 的选址按整块地算距离，贴现着的那面墙不报"太远"', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    s.players.A.gold = 900;
    s.players.A.res = { [SPIRIT_STONE]: 100 };
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    // 建造者站在 (7,5)：到锚点 (4,4) 是 4 格（> buildRange 2），
    // 但到 2×2 的最近一格 (5,5) 只有 2 格——按锚点算的话这里会被拒。
    const deacon = place2(s, 'A', 'cultivation-deacon', 7, 5);
    const r = applyAction(s, {
      type: 'BUILD',
      unitId: deacon.id,
      unitType: 'cultivation-sect',
      x: 4,
      y: 4,
    });
    assert.ok(r.ok, r.ok ? '' : r.reason);
  });

  test('宗门：招弟子要相邻有 ≥2 期师傅，且只认己方', () => {
    const { s, sect } = sectScene();
    const qi = s.unitTypes['qi-cultivator'];
    const v = () => produceAt(s, { kind: 'camp', camp: sect }, qi);

    // 没人：拒绝，并写清缺什么
    const none = v();
    assert.equal(none.ok, false, '没有师傅就不该招得出来');
    assert.ok(none.ok ? '' : /师傅/.test(none.reason), `理由要写清缺师傅：${none.ok ? '' : none.reason}`);

    // 0 期的徒弟站在旁边：还是不行
    const novice = place2(s, 'A', 'qi-cultivator', 6, 4);
    assert.equal(v().ok, false, '0 期修士当不了师傅');

    // 敌方 3 期修士贴着站：也不算
    const foe = place2(s, 'B', 'qi-cultivator', 4, 6);
    setCultivationExp(foe, expForRank(2));
    assert.equal(v().ok, false, '敌方修士不给你当师傅');

    // 己方 2 期：够了
    setCultivationExp(novice, expForRank(1));
    assert.equal(getRank(novice), 2, '前提：这位到了第 2 层');
    assert.equal(v().ok, true, '2 期师傅就能开坛收徒');
  });

  test('宗门：招弟子收灵石、不收金币（城市产线照旧收金币）', () => {
    const { s, sect } = sectScene();
    const qi = s.unitTypes['qi-cultivator'];
    const master = place2(s, 'A', 'qi-cultivator', 6, 4);
    setCultivationExp(master, expForRank(1)); // 2 期

    const stone = sectRecruitStone(qi.cost);
    const inSect = recruitResCost(s, 'A', qi, { kind: 'camp', camp: sect });
    assert.equal(inSect[SPIRIT_STONE], stone, `宗门里招炼气士要 ${stone} 灵石`);
    assert.equal(inSect.gold, undefined, '宗门里不收金币');
    // 同城里的价：还是金币
    assert.equal(recruitResCost(s, 'A', qi).gold, qi.cost, '城市产线照旧是金币价');

    const beforeGold = s.players.A.gold;
    const r = applyAction(s, {
      type: 'RECRUIT',
      unitId: sect.id,
      unitType: 'qi-cultivator',
    });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.equal(r.state.players.A.gold, beforeGold, '不该扣金币');
    assert.equal(r.state.players.A.res![SPIRIT_STONE], 100 - stone, '扣灵石');
    assert.equal(
      r.state.units.filter((u) => u.type === 'qi-cultivator' && u.owner === 'A').length,
      2,
      '新弟子应该站出来了',
    );
  });

  test('传承：摸不到宗门 / 师父不够高都是 ×1；差 3 层才 ×2', () => {
    const { s, sect } = sectScene();
    const disciple = place2(s, 'A', 'qi-cultivator', 6, 4); // 贴着宗门的右边
    assert.equal(sectLegacyMul(s, disciple), 1, '旁边没别人，没有传承');

    const master = place2(s, 'A', 'qi-cultivator', 4, 6); // 贴着宗门的下面
    setCultivationExp(master, expForRank(1)); // 2 期
    assert.equal(sectLegacyMul(s, disciple), 1, '2 期师父带 0 期弟子：2−0−1=1，白搭');

    setCultivationExp(master, expForRank(2)); // 3 期
    assert.equal(sectLegacyMul(s, disciple), 2, '3 期师父带 0 期弟子：×2');

    // 敌人不算师父：把师父换成 B 方
    master.owner = 'B';
    assert.equal(sectLegacyMul(s, disciple), 1, '敌方修士不给你传承');

    // 离开宗门就吃不到
    master.owner = 'A';
    disciple.x = 9;
    disciple.y = 9;
    assert.equal(sectLegacyMul(s, disciple), 1, '离宗门远了就没有传承');
    void sect;
  });

  test('传承：真的让打坐变快（对比法），面板也写出来', () => {
    const runSeq = (withMaster: boolean) => {
      const { s, sect } = sectScene();
      place2(s, 'A', 'qi-cultivator', 6, 4); // 弟子：0 期，贴着宗门
      if (withMaster) {
        const master = place2(s, 'A', 'qi-cultivator', 4, 6);
        setCultivationExp(master, expForRank(2)); // 3 期
        void sect;
      }
      const start = getExp(unitOf(s, 'qi-cultivator', 'A'));
      let cur = s;
      for (let i = 0; i < 4; i++) cur = nextTurn(cur);
      return getExp(unitOf(cur, 'qi-cultivator', 'A')) - start;
    };
    const withMaster = runSeq(true);
    const without = runSeq(false);
    assert.ok(withMaster > without, `有师父(${withMaster})该比没师父(${without})涨得快`);

    // 面板：只在吃得到的时候写这一行
    const { s } = sectScene();
    const disciple = place2(s, 'A', 'qi-cultivator', 6, 4);
    assert.ok(
      !getCultivationPanelLines(s, disciple).some((l) => l.includes('宗门传承')),
      '没师父时面板不该冒出传承行',
    );
    const master = place2(s, 'A', 'qi-cultivator', 4, 6);
    setCultivationExp(master, expForRank(2));
    const line = getCultivationPanelLines(s, disciple).find((l) => l.includes('宗门传承'));
    assert.ok(line, '有师父时要有「宗门传承」这一行');
    assert.ok(line!.includes('×2'), `要把倍率写出来：${line}`);
  });

  // ── 法术 / 灵力 / 藏经阁 / 研发（2026-11-08）──────────────
  //
  // 两条**互不相干**的上限，别再混起来：
  //   · 研发额度（阵营级）= 2 × 生效中的藏经阁 —— 这一方"知道"多少门法术；
  //   · 法术位（修士级）= ⌊境界 ÷ 2⌋ —— 一个修士"记得住"多少门。

  /** 宗门（4,4 起 2×2）+ 贴着它的藏经阁（6,4） */
  const spellScene = () => {
    const { s, sect } = sectScene();
    const lib = place2(s, 'A', 'cultivation-scripture-pavilion', 6, 4);
    return { s, sect, lib };
  };

  const doAction = (s: GameState, unitId: string, actionId: string) =>
    applyAction(s, { type: 'UNIT_ACTION', unitId, actionId });

  test('灵力：上限按境界算，全部是整十，老存档读出来是满的', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    assert.equal(manaLimitForRank(0), 40, '0 期 40');
    assert.equal(manaLimitForRank(9), 130, '9 期 130');
    for (let r = 0; r <= 9; r++) {
      assert.equal(manaLimitForRank(r) % 10, 0, `${r} 期的上限也必须是整十`);
    }

    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    assert.equal(maxManaOf(qi), 40, '没有落库字段时按当前境界现算');
    assert.equal(manaOf(qi), 40, '老存档没有 mana 字段 → 按满灵力处理');
    setMana(qi, 999);
    assert.equal(manaOf(qi), 40, '写入要被上限夹住');
  });

  test('灵力：回合开始回 30，上限随境界刷新', () => {
    let s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    setMana(qi, 0);
    // 两次结束回合才轮到 A 的下一个回合开始（中间夹着 B 的回合）
    s = nextTurn(nextTurn(s));
    const after = unitOf(s, 'qi-cultivator', 'A');
    assert.equal(manaOf(after), MANA_REGEN, `一回合回 ${MANA_REGEN} 点`);
    assert.equal(maxManaOf(after), manaLimitForRank(getRank(after)), '上限跟着境界走');
  });

  test('藏经阁：只能贴着自家宗门建，宗门没了就失效', () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    s.players.A.gold = 900;
    s.players.A.res = { [SPIRIT_STONE]: 100 };
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    const deacon = place2(s, 'A', 'cultivation-deacon', 6, 6);

    const alone = applyAction(s, {
      type: 'BUILD',
      unitId: deacon.id,
      unitType: 'cultivation-scripture-pavilion',
      x: 7,
      y: 6,
    });
    assert.equal(alone.ok, false, '没有宗门就不该能盖藏经阁');

    const sect = place2(s, 'A', 'cultivation-sect', 4, 4);
    const r = applyAction(s, {
      type: 'BUILD',
      unitId: deacon.id,
      unitType: 'cultivation-scripture-pavilion',
      x: 6,
      y: 4,
    });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const lib = r.state.units.find((u) => u.type === 'cultivation-scripture-pavilion')!;
    assert.ok(libraryIsActive(r.state, lib), '贴着宗门就是生效的');
    assert.equal(activeLibrariesOf(r.state, 'A').length, 1);

    const gone = { ...r.state, units: r.state.units.filter((u) => u.id !== sect.id) };
    assert.equal(libraryIsActive(gone, lib), false, '宗门没了，藏书楼就废了');
    assert.equal(activeLibrariesOf(gone, 'A').length, 0);
  });

  test('研发：额度来自藏经阁，花灵石，重复与额度满都会被拒', () => {
    const { s, sect } = spellScene();
    const spell = spellOf('palm-thunder')!;

    // 一座藏经阁 = 2 个研发额度
    assert.equal(researchCapOf(s, 'A'), LIBRARY_SPELL_SLOTS, '一座藏经阁给 2 个额度');
    assert.equal(researchedOf(s, 'A').length, 0);

    // 灵石不够：拒
    s.players.A.res = { [SPIRIT_STONE]: 10 };
    assert.ok((researchProblem(s, 'A', spell) ?? '').includes('灵石'), '要说清灵石不足');
    const poor = doAction(s, sect.id, 'research:palm-thunder');
    assert.equal(poor.ok, false, '灵石不够研发不了');

    // 够了：研发成功、扣灵石、进目录
    s.players.A.res = { [SPIRIT_STONE]: 100 };
    const r = doAction(s, sect.id, 'research:palm-thunder');
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.equal(researchedOf(r.state, 'A').length, 1);
    assert.ok(isResearched(r.state, 'A', 'palm-thunder'));
    assert.equal(r.state.players.A.res![SPIRIT_STONE], 100 - researchCostOf(spell), '扣灵石');
    assert.ok(r.state.log.some((l) => l.text.includes('研发')), '战报要写明研发了什么');

    // 重复研发：拒（而且面板上不会再出现"研发"那条按钮）
    const again = doAction(r.state, sect.id, 'research:palm-thunder');
    assert.equal(again.ok, false, '不能研发第二遍');

    // 额度满：塞两条假 id 把 2 个额度占满
    const full = { ...r.state, researched: { A: ['fake-a', 'fake-b'] } };
    assert.ok((researchProblem(full, 'A', spell) ?? '').includes('额度'), '额度满了要说额度');

    // 没有藏经阁（= 没有额度）：理由指向藏经阁
    // 注意要用"还没研发过"的那份状态，否则会先被"已经研发过"拦下来
    const noLib = { ...s, units: s.units.filter((u) => u.type !== 'cultivation-scripture-pavilion') };
    assert.equal(researchCapOf(noLib, 'A'), RESEARCH_BASE_SLOTS);
    assert.ok((researchProblem(noLib, 'A', spell) ?? '').includes('藏经阁'), '要说清是缺藏经阁');
  });

  test('遗弃：腾出研发额度，已经学会的修士保留', () => {
    const { s, sect } = spellScene();
    const qi = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(qi, expForRank(1)); // 2 期，1 个法术位

    let cur = s;
    const r1 = doAction(cur, sect.id, 'research:palm-thunder');
    assert.ok(r1.ok, r1.ok ? '' : r1.reason);
    cur = r1.state;

    const learn = doAction(cur, qi.id, 'learn:palm-thunder');
    assert.ok(learn.ok, learn.ok ? '' : learn.reason);
    cur = learn.state;

    // 遗弃：目录清空，但那个修士还留着它
    const r2 = doAction(cur, sect.id, 'abandon:palm-thunder');
    assert.ok(r2.ok, r2.ok ? '' : r2.reason);
    assert.equal(researchedOf(r2.state, 'A').length, 0, '研发额度腾出来了');
    assert.equal(
      knownSpells(r2.state.units.find((u) => u.id === qi.id)!).length,
      1,
      '已经学会的人不受影响（遗忘是静心阁的事）',
    );

    // 再遗弃一次：没有可遗弃的
    const r3 = doAction(r2.state, sect.id, 'abandon:palm-thunder');
    assert.equal(r3.ok, false);
  });

  test('学法术：必须先研发；法术位只看境界，与藏经阁无关', () => {
    const { s, sect } = spellScene();
    const qi = place2(s, 'A', 'qi-cultivator', 6, 5);
    const spell = spellOf('palm-thunder')!;

    setCultivationExp(qi, expForRank(1)); // 2 期
    // 没研发：拒绝，理由指向宗门大殿
    assert.ok((spellLearnProblem(s, qi, spell) ?? '').includes('研发'), '没研发的学不了');
    const early = doAction(s, qi.id, 'learn:palm-thunder');
    assert.equal(early.ok, false);

    const r = doAction(s, sect.id, 'research:palm-thunder');
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const learned = doAction(r.state, qi.id, 'learn:palm-thunder');
    assert.ok(learned.ok, learned.ok ? '' : learned.reason);

    // 法术位只按境界：2 期 1 个，3 期还是 1 个，6 期 3 个
    assert.equal(spellSlotsOf(qi), 1);
    const qi3 = place2(s, 'A', 'qi-cultivator', 6, 6);
    setCultivationExp(qi3, expForRank(2));
    assert.equal(spellSlotsOf(qi3), 1, '3 期仍然是 1 个');
    const qi6 = place2(s, 'A', 'qi-cultivator', 4, 7);
    setCultivationExp(qi6, expForRank(5));
    assert.equal(spellSlotsOf(qi6), 3, '6 期 3 个');
  });

  test('掌心雷：无视护甲、扣灵力、灵力够就能连放、超射程不生效', () => {
    const { s, sect } = spellScene();
    const mage = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(mage, expForRank(8)); // 9 期：灵力上限 130，够连放两发

    const r0 = doAction(s, sect.id, 'research:palm-thunder');
    assert.ok(r0.ok, r0.ok ? '' : r0.reason);
    const r1 = doAction(r0.state, mage.id, 'learn:palm-thunder');
    assert.ok(r1.ok, r1.ok ? '' : r1.reason);
    let cur = r1.state;
    const caster = cur.units.find((u) => u.id === mage.id)!;

    const heavy = place2(cur, 'B', 'body-cultivator', 5, 7); // 护甲 2、血 30；距离 3 格
    heavy.hp = 500;
    const dmg = palmThunderDamage(getRank(caster));
    const before = manaOf(caster);

    const hit = (target: Unit) =>
      applyAction(cur, {
        type: 'HERO_SKILL',
        unitId: caster.id,
        skillId: 'palm-thunder',
        targetX: target.x,
        targetY: target.y,
      });

    const a = hit(heavy);
    assert.ok(a.ok, a.ok ? '' : a.reason);
    assert.equal(a.state.units.find((u) => u.id === heavy.id)!.hp, 500 - dmg, `伤害要正好 ${dmg} 点（护甲不参与）`);
    assert.equal(manaOf(a.state.units.find((u) => u.id === caster.id)!), before - PALM_THUNDER_COST, '扣灵力');

    // 第二发：**不限每回合一次**，只要灵力够
    cur = a.state;
    const b = applyAction(cur, {
      type: 'HERO_SKILL',
      unitId: caster.id,
      skillId: 'palm-thunder',
      targetX: heavy.x,
      targetY: heavy.y,
    });
    assert.ok(b.ok, `灵力够就该能连放：${b.ok ? '' : b.reason}`);

    // 第三发：灵力只剩 30，不够 50
    const c3 = applyAction(b.state, {
      type: 'HERO_SKILL',
      unitId: caster.id,
      skillId: 'palm-thunder',
      targetX: heavy.x,
      targetY: heavy.y,
    });
    assert.equal(c3.ok, false, '灵力见底就放不出来');
    assert.ok(c3.ok ? '' : /灵力/.test(c3.reason), `理由要说灵力：${c3.ok ? '' : c3.reason}`);

    // 射程外
    const s2 = spellScene().s;
    const m2 = place2(s2, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(m2, expForRank(1));
    teachSpell(m2, spellOf('palm-thunder')!);
    const far = place2(s2, 'B', 'body-cultivator', 9, 9);
    const tooFar = applyAction(s2, {
      type: 'HERO_SKILL',
      unitId: m2.id,
      skillId: 'palm-thunder',
      targetX: far.x,
      targetY: far.y,
    });
    assert.equal(tooFar.ok, false, '超出射程应该被拒');
    assert.ok(tooFar.ok ? '' : /射程|太远/.test(tooFar.reason), `理由要说射程：${tooFar.ok ? '' : tooFar.reason}`);
  });

  test('掌心雷：灵力不够时按钮是灰的，硬放也不扣灵力', () => {
    const { s } = spellScene();
    const mage = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(mage, expForRank(1));
    teachSpell(mage, spellOf('palm-thunder')!);
    const foe = place2(s, 'B', 'militia', 5, 7);
    foe.hp = 100;

    setMana(mage, PALM_THUNDER_COST - 1);
    const skill = heroSkillsOf(s, mage).find((k) => k.def.id === 'palm-thunder')!;
    assert.equal(skill.ready, false, '灵力不足时不该显示就绪');
    assert.ok(skill.notReadyReason?.includes('灵力'), `理由要说灵力：${skill.notReadyReason}`);

    const r = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: mage.id,
      skillId: 'palm-thunder',
      targetX: foe.x,
      targetY: foe.y,
    });
    assert.equal(r.ok, false);
    assert.equal(manaOf(s.units.find((u) => u.id === mage.id)!), PALM_THUNDER_COST - 1, '失败不扣灵力');
  });

  // ── 吐纳术 / 罡风（2026-11-13）────────────────────
  //
  // 「用法术补强度」的头两发：一个补成长（环境灵气换修为），
  // 一个补面积（远距离、大范围、无视护甲）。
  // 这一组断言守的是同一件事——**按钮上写的数就是实际发生的数**。

  /** 把某一格的灵气钉死（跳过 stepQiField，免得地形缺省来搅局） */
  const setQi = (s: GameState, x: number, y: number, qi: number) => {
    s.tiles[idx(s, x, y)] = { terrain: 'plain', cityId: null, custom: { qi } };
  };

  test('吐纳术：抽走一半灵气换修为，账面按 2:1 平账', () => {
    const { s } = spellScene();
    const mon = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(mon, expForRank(5)); // 6 期
    teachSpell(mon, spellOf('spirit-breath')!);
    setQi(s, 6, 5, 100);

    const card = heroSkillsOf(s, mon).find((k) => k.def.id === 'spirit-breath');
    assert.ok(card, '学会之后技能栏里要有它');
    assert.ok(card!.ready, `灵气和灵力都够，就该能点：${card!.notReadyReason}`);

    const expBefore = getExp(mon);
    const manaBefore = manaOf(mon);
    const r = applyAction(s, { type: 'HERO_SKILL', unitId: mon.id, skillId: 'spirit-breath' });
    assert.ok(r.ok, r.ok ? '' : r.reason);

    const after = r.state.units.find((u) => u.id === mon.id)!;
    const exp = spiritBreathExp(100, 6);
    assert.equal(exp, 24, '100 的一半是 50，2 换 1 得 25，被 6 期上限 24 截掉 1');
    assert.equal(getExp(after) - expBefore, exp, '修为按算出来的数入账');
    assert.equal(
      qiAt(r.state, 6, 5),
      100 - exp * SPIRIT_BREATH_QI_PER_EXP,
      '抽走的灵气 = 修为 × 每点修为的灵气（账要平）',
    );
    assert.equal(manaOf(after), manaBefore - SPIRIT_BREATH_COST, '扣灵力');
  });

  test('吐纳术：低境界有上限、灵气太薄时是灰的且不扣灵力', () => {
    const { s } = spellScene();
    const mon = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(mon, expForRank(1)); // 2 期
    teachSpell(mon, spellOf('spirit-breath')!);
    setQi(s, 6, 5, 100);

    assert.equal(spiritBreathCap(2), 8, '2 期一口最多 8 点（约两回合打坐）');
    assert.equal(spiritBreathExp(100, 2), 8, '满灵气也只给上限那么多');

    setQi(s, 6, 5, SPIRIT_BREATH_MIN_QI - 1);
    const card = heroSkillsOf(s, mon).find((k) => k.def.id === 'spirit-breath')!;
    assert.equal(card.ready, false, '灵气不够时不该是可点的');
    assert.ok(card.notReadyReason?.includes('灵气'), `理由要说灵气：${card.notReadyReason}`);

    const manaBefore = manaOf(mon);
    const r = applyAction(s, { type: 'HERO_SKILL', unitId: mon.id, skillId: 'spirit-breath' });
    assert.equal(r.ok, false, '硬放要被拒');
    assert.equal(manaOf(s.units.find((u) => u.id === mon.id)!), manaBefore, '失败不扣灵力');
  });

  test('罡风：半径内全中、半径外不中，伤害无视护甲', () => {
    const { s } = spellScene();
    const mage = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(mage, expForRank(3)); // 4 期：刚好够门槛
    teachSpell(mage, spellOf('gang-wind')!);

    const onPoint = place2(s, 'B', 'militia', 7, 5); // 落点正上
    const edge = place2(s, 'B', 'militia', 6, 6); // 距落点 2 格，压线
    const outside = place2(s, 'B', 'militia', 9, 7); // 距落点 4 格
    for (const u of [onPoint, edge, outside]) u.hp = 500;

    const dmg = gangWindDamage(4);
    const manaBefore = manaOf(mage);
    const r = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: mage.id,
      skillId: 'gang-wind',
      targetX: 7,
      targetY: 5,
    });
    assert.ok(r.ok, r.ok ? '' : r.reason);

    const hpOf = (id: string) => r.state.units.find((u) => u.id === id)!.hp;
    assert.equal(hpOf(onPoint.id), 500 - dmg, `落点上要正好掉 ${dmg}（民兵 1 甲不参与）`);
    assert.equal(hpOf(edge.id), 500 - dmg, `半径 ${GANG_WIND_RADIUS} 内（含斜角）都要中`);
    assert.equal(hpOf(outside.id), 500, '半径外的不能波及');
    assert.equal(
      manaOf(r.state.units.find((u) => u.id === mage.id)!),
      manaBefore - GANG_WIND_COST,
      '扣灵力',
    );
  });

  test('罡风：空放不扣灵力，超射程直接拒', () => {
    const { s } = spellScene();
    const mage = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(mage, expForRank(3));
    teachSpell(mage, spellOf('gang-wind')!);

    const manaBefore = manaOf(mage);
    const empty = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: mage.id,
      skillId: 'gang-wind',
      targetX: 7,
      targetY: 5,
    });
    assert.equal(empty.ok, false, '圈里没人就该被拒');
    assert.equal(manaOf(s.units.find((u) => u.id === mage.id)!), manaBefore, '空放不花灵力');

    const far = applyAction(s, {
      type: 'HERO_SKILL',
      unitId: mage.id,
      skillId: 'gang-wind',
      targetX: 14,
      targetY: 14,
    });
    assert.equal(far.ok, false, '超出射程应该被拒');
    assert.ok(far.ok ? '' : /射程|太远/.test(far.reason), `理由要说射程：${far.ok ? '' : far.reason}`);
  });

  test('罡风：4 期才学得会——法术位之外还有一道境界门槛', () => {
    const { s, sect } = spellScene();
    const low = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(low, expForRank(2)); // 3 期
    assert.equal(spellOf('gang-wind')!.minRank, GANG_WIND_MIN_RANK, '法术池里要登记门槛');

    const r = doAction(s, sect.id, 'research:gang-wind');
    assert.ok(r.ok, r.ok ? '' : r.reason);

    const early = doAction(r.state, low.id, 'learn:gang-wind');
    assert.equal(early.ok, false, '3 期不该学得会');
    assert.ok(early.ok ? '' : /境界/.test(early.reason), `理由要说境界：${early.ok ? '' : early.reason}`);

    // 藏经阁在 (6,4)，所以 4 期那位要站在它旁边（(7,4)）——否则会先被"站远"拦下
    const mid = place2(r.state, 'A', 'qi-cultivator', 7, 4);
    setCultivationExp(mid, expForRank(3)); // 4 期
    const ok = doAction(r.state, mid.id, 'learn:gang-wind');
    assert.ok(ok.ok, ok.ok ? '' : ok.reason);
  });

  test('宗门大殿的按钮：研发一组、遗弃一组，遗弃带确认文案', () => {
    const { s, sect } = spellScene();
    const before = CULTIVATION_HOOKS.unitActions!({ state: s, unit: sect, viewer: 'A' });
    const research = before.find((b) => b.id === 'research:palm-thunder');
    assert.ok(research, '没研发过时要列「研发」');
    assert.equal(research!.group, '研发');
    assert.ok(!research!.confirm, '研发是花钱做好事，不该弹确认');

    // 研发之后变成「遗弃」，而且是破坏性操作
    const r = doAction(s, sect.id, 'research:palm-thunder');
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const after = CULTIVATION_HOOKS.unitActions!({ state: r.state, unit: sect, viewer: 'A' });
    const abandon = after.find((b) => b.id.startsWith('abandon:'));
    assert.ok(abandon, '研发过之后要给「遗弃」按钮');
    assert.equal(abandon!.group, '遗弃');
    assert.ok(abandon!.confirm && abandon!.confirm.includes('遗弃'), '遗弃必须带确认文案');

    // 别人的宗门：一个按钮都不给
    assert.equal(CULTIVATION_HOOKS.unitActions!({ state: s, unit: sect, viewer: 'B' }).length, 0);
  });

  // ── 静心阁（2026-11-08）────────────────────────
  //
  // 藏经阁的对称件：一个往里装、一个往外倒。造型/造价/选址完全一样，
  // 差别只有"站在旁边能做什么"。

  /** 宗门（4,4 起 2×2）+ 藏经阁（6,4）+ 静心阁（3,4） */
  const forgetScene = () => {
    const { s, sect } = sectScene();
    const lib = place2(s, 'A', 'cultivation-scripture-pavilion', 6, 4);
    const silent = place2(s, 'A', 'cultivation-silent-pavilion', 3, 4);
    return { s, sect, lib, silent };
  };

  test('静心阁：和藏经阁对称（1×1、时代 3、只能贴宗门、执事会盖）', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const def = s.unitTypes['cultivation-silent-pavilion'];
    const lib = s.unitTypes['cultivation-scripture-pavilion'];
    assert.ok(def, '静心阁要在本局兵种表里');
    assert.equal(def.footprint ?? 1, 1, '1×1');
    assert.equal(def.era, lib.era, '和藏经阁同一个时代');
    assert.equal(def.cost, lib.cost, '造价对齐');
    assert.deepEqual(def.adjacent, lib.adjacent, '选址条件对齐：贴着宗门');
    assert.ok(s.unitTypes['cultivation-deacon'].builds?.includes('cultivation-silent-pavilion'), '执事会盖');
    assert.ok(s.unitTypes['cultivation-steward'].builds?.includes('cultivation-silent-pavilion'), '管事继承');
  });

  test('静心阁：宗门没了就失效，站远了也忘不了', () => {
    const { s, silent } = forgetScene();
    const qi = place2(s, 'A', 'qi-cultivator', 3, 5); // 贴着静心阁
    setCultivationExp(qi, expForRank(1));
    teachSpell(qi, spellOf('palm-thunder')!);

    assert.ok(pavilionIsActive(s, silent), '贴着宗门就是生效的');
    assert.ok(silentPavilionNextTo(s, qi), '站在旁边就找得到');
    assert.equal(forgetProblem(s, qi, spellOf('palm-thunder')!), null, '有位可忘');

    // 站远：忘不了
    qi.x = 9;
    qi.y = 9;
    assert.equal(silentPavilionNextTo(s, qi), null);
    assert.ok((forgetProblem(s, qi, spellOf('palm-thunder')!) ?? '').includes('静心阁'), '理由要指向静心阁');
    qi.x = 3;
    qi.y = 5;

    // 宗门被拆：静心阁一起废掉
    const gone = {
      ...s,
      units: s.units.filter((u) => u.type !== 'cultivation-sect'),
    };
    assert.equal(pavilionIsActive(gone, silent), false, '宗门没了，静心阁也废了');
    assert.equal(silentPavilionNextTo(gone, qi), null);
  });

  test('静心阁：忘掉法术腾出法术位，回藏经阁还能再学', () => {
    const { s, sect } = forgetScene();
    const qi = place2(s, 'A', 'qi-cultivator', 6, 5); // 先站在藏经阁旁边
    setCultivationExp(qi, expForRank(1)); // 2 期：1 个法术位

    let cur = s;
    const r1 = doAction(cur, sect.id, 'research:palm-thunder');
    assert.ok(r1.ok, r1.ok ? '' : r1.reason);
    cur = r1.state;
    const r2 = doAction(cur, qi.id, 'learn:palm-thunder');
    assert.ok(r2.ok, r2.ok ? '' : r2.reason);
    cur = r2.state;

    const learned = cur.units.find((u) => u.id === qi.id)!;
    assert.equal(knownSpells(learned).length, 1);
    assert.ok(heroSkillsOf(cur, learned).some((k) => k.def.id === 'palm-thunder'), '技能栏里能看到');

    // 挪到静心阁旁边才能忘（走动是玩家自己的时间成本）
    learned.x = 3;
    learned.y = 5;
    const r3 = doAction(cur, qi.id, 'forget:palm-thunder');
    assert.ok(r3.ok, r3.ok ? '' : r3.reason);
    const after = r3.state.units.find((u) => u.id === qi.id)!;
    assert.equal(knownSpells(after).length, 0, '忘掉了');
    assert.ok(!heroSkillsOf(r3.state, after).some((k) => k.def.id === 'palm-thunder'), '技能栏里也没了');
    assert.ok(r3.state.log.some((l) => l.text.includes('忘掉')), '战报要写');

    // 再忘一次：本来就不会了
    const r4 = doAction(r3.state, after.id, 'forget:palm-thunder');
    assert.equal(r4.ok, false);

    // 回藏经阁能重新学（研发还在）
    const back = r3.state.units.find((u) => u.id === qi.id)!;
    back.x = 6;
    back.y = 5;
    const r5 = doAction(r3.state, back.id, 'learn:palm-thunder');
    assert.ok(r5.ok, r5.ok ? '' : r5.reason);
  });

  test('静心阁：只列"会"的法术，按钮带确认文案；不会的技能不出现', () => {
    const { s } = forgetScene();
    const qi = place2(s, 'A', 'qi-cultivator', 3, 5); // 贴着静心阁
    setCultivationExp(qi, expForRank(3)); // 4 期

    // 什么都不会：一个遗忘按钮都没有
    const none = CULTIVATION_HOOKS.unitActions!({ state: s, unit: qi, viewer: 'A' });
    assert.equal(none.filter((b) => b.group === '遗忘').length, 0, '不会就别列');

    teachSpell(qi, spellOf('palm-thunder')!);
    const after = CULTIVATION_HOOKS.unitActions!({ state: s, unit: qi, viewer: 'A' });
    const forget = after.find((b) => b.id === 'forget:palm-thunder');
    assert.ok(forget, '会了才列');
    assert.equal(forget!.group, '遗忘');
    assert.ok(forget!.confirm && forget!.confirm.includes('忘掉'), '遗忘必须带确认文案');
    assert.equal(forget!.disabled, false);

    // 流派技能（剑气纵横）不在额外技能里，天然不会出现在列表
    assert.ok(!after.some((b) => b.id.includes('sword-sweep')), '流派技能不该出现在遗忘列表');
  });

  test('法术：面板写出灵力、法术位与本方研发', () => {
    const { s, sect } = spellScene();
    const qi = place2(s, 'A', 'qi-cultivator', 6, 5);
    setCultivationExp(qi, expForRank(5)); // 6 期 → 3 个法术位
    const r = doAction(s, sect.id, 'research:palm-thunder');
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const lines = getCultivationPanelLines(r.state, r.state.units.find((u) => u.id === qi.id)!);
    assert.ok(lines.some((l) => l.includes('灵力') && l.includes('每回合')), '要有灵力行');
    assert.ok(lines.some((l) => l.includes('法术位') && l.includes('3')), '法术位要按境界写');
    assert.ok(lines.some((l) => l.includes('本方研发') && l.includes('藏经阁')), '要有本方研发额度行');
  });

  // ── 丹药 / 炼丹炉（2026-11-08）────────────────────────
  //
  // 三条边界，每条都要钉住：
  //   · 动作发起者是**修士**不是炉子（炉子只是个站位条件）；
  //   · 数量是**隐藏信息**（对手看得见 buff，数不出兜里几颗）；
  //   · 服用不需要站在任何地方（药是随身带的）。

  /** 修士（5,5）+ 炼丹炉（6,5）：贴着站 */
  const alchemyScene = () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    for (let y = 3; y <= 9; y++) {
      for (let x = 3; x <= 9; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    s.players.A.res = { [SPIRIT_STONE]: 100 };
    s.players.A.gold = 900;
    const furnace = place2(s, 'A', 'cultivation-alchemy-furnace', 6, 5);
    const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
    return { s, furnace, qi };
  };

  const doAct = (s: GameState, unitId: string, actionId: string) =>
    applyAction(s, { type: 'UNIT_ACTION', unitId, actionId });

  test('炼丹炉：1×1、时代 3、执事与管事会盖', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const def = s.unitTypes['cultivation-alchemy-furnace'];
    assert.ok(def, '炼丹炉要在本局兵种表里');
    assert.equal(def.footprint ?? 1, 1, '1×1');
    assert.equal(def.era, 3, '三代');
    assert.equal(def.atk, 0, '不打人');
    assert.ok(s.unitTypes['cultivation-deacon'].builds?.includes('cultivation-alchemy-furnace'), '执事会盖');
    assert.ok(s.unitTypes['cultivation-steward'].builds?.includes('cultivation-alchemy-furnace'), '管事继承');
  });

  test('携带上限：3 + ⌊境界/2⌋，装满了就炼不了', () => {
    const { s, qi } = alchemyScene();
    assert.equal(pillCarryCap(qi), PILL_CARRY_BASE, '0 期 3 颗');
    setCultivationExp(qi, expForRank(5)); // 6 期
    assert.equal(pillCarryCap(qi), PILL_CARRY_BASE + 3, '6 期 6 颗');

    while (addPill(qi, HEAL_PILL.id)) {
      /* 一直装到满 */
    }
    assert.equal(pillCountOf(qi), pillCarryCap(qi));
    assert.ok((pillBrewProblem(s, 'A', qi, HEAL_PILL) ?? '').includes('装不下'), '满了要说装不下');
  });

  test('炼丹：站炉子旁才炼得动，扣金币与灵石，丹进自己袋子', () => {
    const { s, qi } = alchemyScene();
    assert.ok(furnaceNextTo(s, qi), '贴着炉子');

    // 站远：炼不了，理由指向炉子
    qi.x = 9;
    qi.y = 9;
    assert.equal(furnaceNextTo(s, qi), null);
    assert.ok((pillBrewProblem(s, 'A', qi, HEAL_PILL) ?? '').includes('炼丹炉'), '理由要说炉子');
    const far = doAct(s, qi.id, `brew:${HEAL_PILL.id}`);
    assert.equal(far.ok, false, '离得远炼不了');
    qi.x = 5;
    qi.y = 5;

    // 资源不足
    s.players.A.gold = 1;
    assert.ok((pillBrewProblem(s, 'A', qi, HEAL_PILL) ?? '').includes('金币'), '金币不足要说清');
    s.players.A.gold = 900;
    s.players.A.res = { [SPIRIT_STONE]: 0 };
    assert.ok((pillBrewProblem(s, 'A', qi, HEAL_PILL) ?? '').includes('灵石'), '灵石不足要说清');
    s.players.A.res = { [SPIRIT_STONE]: 100 };

    // 真炼一颗
    const beforeGold = s.players.A.gold;
    const beforeStone = s.players.A.res![SPIRIT_STONE];
    const r = doAct(s, qi.id, `brew:${HEAL_PILL.id}`);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const after = r.state.units.find((u) => u.id === qi.id)!;
    assert.equal(pillsOf(after)[HEAL_PILL.id], 1, '身上多了一颗');
    assert.equal(r.state.players.A.gold, beforeGold - HEAL_PILL.cost.gold, '扣金币');
    assert.equal(
      r.state.players.A.res![SPIRIT_STONE],
      beforeStone - HEAL_PILL.cost.stone,
      '扣灵石',
    );
    assert.ok(r.state.log.some((l) => l.text.includes('炼成')), '战报要写炼成了什么');
  });

  test('回春丹：按生命上限回 12%，满血时吃不了', () => {
    const { s, qi } = alchemyScene();
    addPill(qi, HEAL_PILL.id);
    const max = maxHpOf(s, qi);

    assert.ok((pillUseProblem(s, qi, HEAL_PILL) ?? '').includes('满'), '满血时按钮该灰');
    const full = doAct(s, qi.id, `use:${HEAL_PILL.id}`);
    assert.equal(full.ok, false);
    assert.equal(pillCountOf(s.units.find((u) => u.id === qi.id)!), 1, '被拒时不该扣药');

    qi.hp = Math.floor(max / 2);
    const before = qi.hp;
    const r = doAct(s, qi.id, `use:${HEAL_PILL.id}`);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const after = r.state.units.find((u) => u.id === qi.id)!;
    // 名义回 12%，但不能超过上限：修士 0 期只有一条薄血，按一半血起跳会顶到天花板
    const want = Math.min(Math.max(15, Math.round(max * 0.12)), max - before);
    assert.equal(after.hp, before + want, `该回 ${want} 点`);
    assert.equal(pillCountOf(after), 0, '吃完就没了');
    assert.equal(pillsOf(after)[HEAL_PILL.id], undefined, '归零的键要删掉，别留着 0');
  });

  test('聚灵丹：回 40 灵力，满灵力时吃不了', () => {
    const { s, qi } = alchemyScene();
    addPill(qi, SPIRIT_PILL.id);
    setMana(qi, 0);
    const r = doAct(s, qi.id, `use:${SPIRIT_PILL.id}`);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.equal(manaOf(r.state.units.find((u) => u.id === qi.id)!), 40, '回 40 点');

    const { s: s2, qi: qi2 } = alchemyScene();
    addPill(qi2, SPIRIT_PILL.id);
    assert.ok((pillUseProblem(s2, qi2, SPIRIT_PILL) ?? '').includes('满'), '满灵力该灰');
  });

  test('护体丹：+25% 护甲，2 个自己的回合后掉掉；面板与结算读同一个字段', () => {
    const { s, qi } = alchemyScene();
    setCultivationExp(qi, expForRank(5)); // 6 期，护甲够高才看得出百分比
    addPill(qi, WARD_PILL.id);
    const armorBefore = effectiveStats(s, qi).armor;

    const r = doAct(s, qi.id, `use:${WARD_PILL.id}`);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const after = r.state.units.find((u) => u.id === qi.id)!;
    assert.equal(after.buff?.armorPct, 0.25, '要给 buff.armorPct');
    assert.equal(after.buff?.turns, 2);
    const armorAfter = effectiveStats(r.state, after).armor;
    assert.ok(armorAfter > armorBefore, `护甲该变高：${armorBefore} → ${armorAfter}`);
    assert.equal(
      armorAfter,
      armorBefore + Math.max(1, Math.round(armorBefore * 0.25)),
      '加值要按面板那条式子算',
    );

    // 覆盖而不是叠加：再吃一颗，还是 25%
    addPill(after, WARD_PILL.id);
    const r2 = doAct(r.state, qi.id, `use:${WARD_PILL.id}`);
    assert.ok(r2.ok, r2.ok ? '' : r2.reason);
    assert.equal(
      r2.state.units.find((u) => u.id === qi.id)!.buff?.armorPct,
      0.25,
      '药力只有一份，新药压旧药',
    );
  });

  test('丹药是隐藏信息：敌方拿到的视图里没有 pills，buff 照旧可见', () => {
    const { s, qi } = alchemyScene();
    addPill(qi, HEAL_PILL.id);
    addPill(qi, WARD_PILL.id);
    qi.buff = { armorPct: 0.25, turns: 2, label: '护体丹' };

    // 自己：看得见
    const mine = playerView(s, 'A').state.units.find((u) => u.id === qi.id)!;
    assert.equal(pillsOf(mine)[HEAL_PILL.id], 1, '自己看得见自己的袋子');

    // 对手：抹掉 pills，但 buff 留着（"看得见吃了药，看不见还有几颗"）
    const foe = playerView(s, 'B').state.units.find((u) => u.id === qi.id);
    assert.ok(foe, '无雾模式下对手看得见这个单位');
    assert.deepEqual(foe!.custom?.pills, undefined, '对手数不出几颗');
    assert.equal(foe!.buff?.armorPct, 0.25, '吃药的痕迹藏不住');

    // 观战：不裁（复盘要看全）
    const replay = playerView(s, 'B', true).state.units.find((u) => u.id === qi.id)!;
    assert.equal(pillsOf(replay)[HEAL_PILL.id], 1, '观战不裁');
  });

  test('面板：只有本人看得到「携带丹药」，敌方那张卡整行不出现', () => {
    const { s, qi } = alchemyScene();
    addPill(qi, HEAL_PILL.id);
    addPill(qi, HEAL_PILL.id);
    const mine = getCultivationPanelLines(s, qi, 'A');
    const line = mine.find((l) => l.includes('携带丹药'));
    assert.ok(line, '自己要有这一行');
    assert.ok(line!.includes(HEAL_PILL.name) && line!.includes('×2'), `要写清种类与数量：${line}`);

    const foe = getCultivationPanelLines(s, qi, 'B');
    assert.ok(!foe.some((l) => l.includes('携带丹药')), '敌方不该看到这一行（连 0 都不该印）');
  });

  test('按钮：站炉子旁列「炼丹」，身上有丹列「服用」，敌方一个都没有', () => {
    const { s, qi } = alchemyScene();
    const brew = CULTIVATION_HOOKS.unitActions!({ state: s, unit: qi, viewer: 'A' });
    assert.equal(brew.filter((b) => b.group === '炼丹').length, PILLS.length, '三颗都列出来');
    assert.equal(brew.filter((b) => b.group === '服用').length, 0, '没药就别列服用');

    addPill(qi, HEAL_PILL.id);
    addPill(qi, WARD_PILL.id);
    const withPills = CULTIVATION_HOOKS.unitActions!({ state: s, unit: qi, viewer: 'A' });
    const use = withPills.filter((b) => b.group === '服用');
    assert.equal(use.length, 2, '有什么列什么');
    // 能点的那些右侧写"还剩几颗"；还不能点的（比如满血时的回春丹）写的是原因
    assert.ok(
      use.filter((b) => !b.disabled).every((b) => b.note?.includes('颗')),
      `能吃的要写清还剩几颗：${JSON.stringify(use.map((b) => b.note))}`,
    );

    // 敌方：连"炼丹"都不该看到（炉子是自己的，更别说袋子）
    assert.equal(CULTIVATION_HOOKS.unitActions!({ state: s, unit: qi, viewer: 'B' }).length, 0);
  });

  test('丹药只在修士身上：工匠站炉子旁也炼不了', () => {
    const { s } = alchemyScene();
    const deacon = place2(s, 'A', 'cultivation-deacon', 6, 6);
    assert.ok(furnaceNextTo(s, deacon), '贴着炉子');
    assert.ok((pillBrewProblem(s, 'A', deacon, HEAL_PILL) ?? '').includes('修士'), '只有修士炼丹');
  });

  test('药力显示：和「中毒 n 回合」同一排，带剩余回合；属性明细里不重复', () => {
    const { s, qi } = alchemyScene();
    setCultivationExp(qi, expForRank(5));
    addPill(qi, WARD_PILL.id);
    const armorBefore = effectiveStats(s, qi).armor;
    const r = doAct(s, qi.id, `use:${WARD_PILL.id}`);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const st = r.state;
    const unit = st.units.find((u) => u.id === qi.id)!;

    // 1）属性明细里不再出现药力（那串读起来像地形/永久加成，而且没有回合数）
    const eff = effectiveStats(st, unit);
    assert.ok(
      !eff.armorItems.some((it: { label: string }) => it.label === WARD_PILL.name),
      `armorItems 不该列药力：${JSON.stringify(eff.armorItems)}`,
    );
    // 但护甲该加的还是加了（只是不写进明细）
    assert.ok(eff.armor > armorBefore, `药力仍然算进护甲：${armorBefore} → ${eff.armor}`);

    // 2）状态栏里有一条「护体丹 · 2 回合」
    const html = detailCardHtml(
      {
        view: playerView(st, 'A'),
        me: 'A',
        selectedUnit: unit,
        selectedCityId: null,
        selectedCampId: null,
        selectedTile: null,
      },
      true,
    );
    const chip = /<span class="status-chip st-buff"[^>]*>\s*<b>([^<]+)<\/b><i>([^<]+)<\/i>/.exec(html);
    assert.ok(chip, '药力要画成状态徽章（和中点/减速同一排）');
    assert.equal(chip![1], WARD_PILL.name, '徽章写丹药名');
    assert.ok(
      chip![2]!.includes(String(WARD_PILL_TURNS)) && chip![2]!.includes('回合'),
      `徽章要写剩余回合：${chip![2]}`,
    );
  });

  // ── 灵气浓度（2026-11-09）────────────────────────────
  //
  // 一条扩散方程，四个坑：稳定性、边界零通量、双重缓冲、源汇符号。
  // 这里钉住后三个（稳定性靠常量 D ≤ 0.25 保证，写死在实现里）。

  /** 一张全平原的图（灵气缺省 0），方便逐格铺地形 */
  const qiScene = () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    s.units = [];
    s.current = 'A';
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
    }
    return s;
  };

  const fillQi = (s: GameState, v: number) => {
    for (let i = 0; i < s.tiles.length; i++) {
      s.tiles[i] = { ...s.tiles[i], custom: { qi: v } };
    }
  };

  test('灵气：没有落库字段时按地形取缺省（老存档不用迁移）', () => {
    const s = qiScene();
    s.tiles[idx(s, 2, 2)] = { terrain: 'forest', cityId: null };
    s.tiles[idx(s, 3, 2)] = { terrain: 'mountain', cityId: null };
    s.tiles[idx(s, 4, 2)] = { terrain: 'water', cityId: null };
    assert.equal(qiAt(s, 2, 2), 50, '森林 50 = 5 / 0.1');
    assert.equal(qiAt(s, 3, 2), 100, '高山 100 = 10 / 0.1');
    assert.equal(qiAt(s, 4, 2), 50, '水域也算');
    assert.equal(qiAt(s, 1, 1), 0, '平原 0');

    // 显式写 0 就是"空的"，不该再退回地形缺省
    s.tiles[idx(s, 2, 2)] = { ...s.tiles[idx(s, 2, 2)], custom: { qi: 0 } };
    assert.equal(qiAt(s, 2, 2), 0, '落库的 0 要压过缺省');
  });

  test('灵气：从浓往稀流，边缘不掉得比中间多（零通量边界）', () => {
    const s = qiScene();
    s.tiles[idx(s, 4, 4)] = { terrain: 'mountain', cityId: null }; // 100
    stepQiField(s);
    assert.ok(qiAt(s, 4, 4) < 100, '浓的那格往外流了');
    assert.ok(qiAt(s, 4, 3) > 0, '邻居涨了');
    assert.ok(
      qiAt(s, 4, 3) > qiAt(s, 4, 1),
      '近的比远的浓——这就是梯度，不用单独算',
    );

    // 全图同浓度：一步之后中心和边缘掉得一样多（边缘没有额外失血）
    const t = qiScene();
    fillQi(t, 50);
    stepQiField(t);
    const corner = qiAt(t, 0, 0);
    const middle = qiAt(t, Math.floor(t.w / 2), Math.floor(t.h / 2));
    assert.ok(
      Math.abs(corner - middle) < 0.01,
      `边缘不该比中间掉得多：角${corner} vs 中${middle}`,
    );
  });

  test('灵气：灵田/灵泉是源，灵矿是汇（不是源）', () => {
    assert.equal(QI_BUILDING_SOURCE['cultivation-spirit-field'], 15);
    assert.equal(QI_BUILDING_SOURCE['cultivation-spirit-spring'], 20);
    assert.equal(QI_BUILDING_SOURCE['cultivation-spirit-mine'], -5, '灵矿是汇');

    const s = qiScene();
    // 两块同样的空地，一块摆灵矿，一块不摆
    place2(s, 'A', 'cultivation-spirit-mine', 6, 6);
    s.tiles[idx(s, 6, 6)] = { ...s.tiles[idx(s, 6, 6)], custom: { qi: 80 } };
    s.tiles[idx(s, 2, 2)] = { ...s.tiles[idx(s, 2, 2)], custom: { qi: 80 } };
    stepQiField(s);
    assert.ok(
      qiAt(s, 6, 6) < qiAt(s, 2, 2),
      `灵矿那格该掉得更狠：${qiAt(s, 6, 6)} vs ${qiAt(s, 2, 2)}`,
    );

    // 灵泉把周围养起来
    const t = qiScene();
    const spring = place2(t, 'A', 'cultivation-spirit-spring', 8, 8);
    const before = qiAt(t, 8, 8);
    for (let i = 0; i < 8; i++) stepQiField(t);
    assert.ok(qiAt(t, 8, 8) > before, '灵泉那格涨了');
    assert.ok(qiAt(t, 7, 8) > 0, '旁边也被带起来了');
    assert.equal(spring.hp > 0, true);
  });

  test('灵气：工地还不吐纳，建好才算源', () => {
    const s = qiScene();
    const field = place2(s, 'A', 'cultivation-spirit-field', 5, 5);
    field.buildNeed = 30;
    field.buildDone = 0;
    assert.equal(qiSourceLabel(s, 5, 5), '', '工地不该出现在源汇说明里');

    field.buildDone = 30;
    assert.ok(qiSourceLabel(s, 5, 5).includes('灵田'), '建好了才算');
    assert.equal(qiSourceLabel(s, 5, 5).includes('+15'), true);
  });

  test('灵气：修士吸灵力——缺口越大吸越多，且不会抽干格子', () => {
    const s = qiScene();
    s.tiles[idx(s, 4, 4)] = { ...s.tiles[idx(s, 4, 4)], custom: { qi: 100 } };
    const qi = place2(s, 'A', 'qi-cultivator', 4, 4);

    // 缺口大：全空
    setMana(qi, 0);
    const max = maxManaOf(qi);
    const r = exchangeMana(s, qi);
    assert.equal(r.delta, Math.ceil(max * 0.25), '吸 = 缺口 × 25%');
    assert.equal(manaOf(qi), r.delta, '灵力涨了这么多');
    assert.equal(qiAt(s, 4, 4), 100 - r.delta, '格子少了同样的量');

    // 缺口小：只差 1 点就只吸 1
    setMana(qi, max - 1);
    assert.equal(exchangeMana(s, qi).delta, 1, '缺口 1 就吸 1');

    // 一次最多抽走一半：格子只剩 2 点时吸不到 12
    const s2 = qiScene();
    s2.tiles[idx(s2, 4, 4)] = { ...s2.tiles[idx(s2, 4, 4)], custom: { qi: 2 } };
    const q2 = place2(s2, 'A', 'qi-cultivator', 4, 4);
    setMana(q2, 0);
    const r2 = exchangeMana(s2, q2);
    assert.equal(r2.delta, 1, 'floor(2 × 0.5) = 1');
    assert.equal(qiAt(s2, 4, 4), 1, '还剩一半');
  });

  test('灵气：贫瘠时灵力反向外漏，境界越高漏得越少', () => {
    const s = qiScene(); // 全 0
    const low = place2(s, 'A', 'qi-cultivator', 3, 3);
    setCultivationExp(low, expForRank(0));
    setMana(low, maxManaOf(low));
    const before = manaOf(low);
    const r = exchangeMana(s, low);
    assert.ok(r.delta < 0, '0 期站在荒地里会漏灵力');
    assert.ok(manaOf(low) < before, '灵力真的少了');
    assert.ok(qiAt(s, 3, 3) > 0, '漏出去的有一半回到格子里');

    const high = place2(s, 'A', 'qi-cultivator', 6, 6);
    setCultivationExp(high, expForRank(8)); // 9 期
    setMana(high, maxManaOf(high));
    const r2 = exchangeMana(s, high);
    assert.ok(r2.delta >= -1, `9 期基本不漏：${r2.delta}`);
  });

  test('灵气：预览和实扣是同一套式子（面板说 +8 就得真涨 8）', () => {
    const s = qiScene();
    s.tiles[idx(s, 4, 4)] = { ...s.tiles[idx(s, 4, 4)], custom: { qi: 100 } };
    const qi = place2(s, 'A', 'qi-cultivator', 4, 4);
    setMana(qi, 10);

    const preview = previewExchange(s, qi);
    const real = exchangeMana(s, qi);
    assert.equal(preview.delta, real.delta, '预览与实际一致');
  });

  test('灵气视图：分 5 档，每格都有颜色（空白也是信息）', () => {
    assert.equal(QI_VIEW_TIERS, 5);
    assert.equal(qiTierOf(0), 0);
    assert.equal(qiTierOf(19.9), 0);
    assert.equal(qiTierOf(20), 1);
    assert.equal(qiTierOf(60), 3);
    assert.equal(qiTierOf(100), QI_VIEW_TIERS - 1, '满值落在最后一档');

    const s = qiScene();
    s.tiles[idx(s, 2, 2)] = { terrain: 'mountain', cityId: null };
    const cells = qiOverlayCells(s);
    assert.equal(cells.length, s.w * s.h, '每一格都要返回——空白格本身也是信息');
    assert.ok(cells.every((c) => c.color.startsWith('rgba')), '颜色是带 alpha 的 CSS 串');
    const hot = cells.find((c) => c.x === 2 && c.y === 2)!;
    const cold = cells.find((c) => c.x === 0 && c.y === 0)!;
    assert.notEqual(hot.color, cold.color, '浓淡要看得出来');
  });

  test('灵气视图：通过 boardViews 暴露，核心只拿到"格子和颜色"', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const views = CULTIVATION_HOOKS.boardViews!({ state: s });
    const qi = views.find((v) => v.id === 'cultivation-qi');
    assert.ok(qi, '要有灵气视图');
    assert.equal(qi!.label, '灵气', '顶栏 chip 上就两个字');
    assert.ok(qi!.hint.length > 0, '要有悬停提示');
    const cells = qi!.cells!({ state: s, viewer: 'A' });
    assert.equal(cells.length, s.w * s.h);
    assert.ok(cells[0]!.color.includes('rgba'));
    // 视图定义里**不带颜色**：颜色在 cells 的返回值里，核心拿到的是"这一格染什么"
    assert.equal('color' in (qi as unknown as Record<string, unknown>), false);
  });

  test('灵气：面板写出脚下浓度与格子的源汇', () => {
    const s = qiScene();
    s.tiles[idx(s, 4, 4)] = { terrain: 'forest', cityId: null };
    const qi = place2(s, 'A', 'qi-cultivator', 4, 4);
    setMana(qi, 0);

    const lines = getCultivationPanelLines(s, qi, 'A');
    assert.ok(lines.some((l) => l.includes('脚下灵气')), '修士面板要有这一行');
    const tileLines = CULTIVATION_HOOKS.getTilePanelLines!({ state: s, x: 4, y: 4, viewer: 'A' });
    assert.ok(tileLines.some((l) => l.includes('灵气浓度')), '格子面板要有这一行');
    assert.ok(tileLines[0]!.includes('50'), `森林该写 50：${tileLines[0]}`);
    assert.ok(qiAt(s, 4, 4) <= QI_MAX);
    assert.ok((QI_TERRAIN_SOURCE.forest ?? 0) > 0);
  });

  // ── 魂修（2026-11-09）────────────────────────────────
  //
  // 它的全部特殊性都在"化灵"那一刻。判据是 identity.ts 的 SOUL_MASTER_IDS，
  // 三个消费者分别是 stats.ts（攻击/护甲/移动）和 spirit-ascension.ts 的两处
  // （生命加成、技能）。下面几条把它们逐一钉住，并且留一组普通修士做对照——
  // 少了对照，"魂修没折"和"两边都折了只是数值不同"是分不出来的。

  /** 造一个 9 期修士 → 挂灵体道果 → 被一刀打死，返回化灵后的灵体 */
  const ascend = (type: string) => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    const u = place2(s, 'A', type, 5, 5);
    setCultivationExp(u, expForRank(8)); // 9 期：境界加成够大，折减看得出来
    u.maxHpBonus = 100;
    u.hp = 101;
    u.custom = { ...u.custom, lifespan: 100 };
    u.extraAbilities = ['spirit-ascension'];
    // 两条**普通**技能（都没有 soulBound 标记）：普通修士死了要丢掉它们
    u.extraSkills = [SKY_STEP_SKILL, PALM_THUNDER_SKILL];
    const killer = place2(s, 'B', 'militia', 6, 5);
    killer.atkBonus = 1000;
    s.current = 'B';
    const r = applyAction(s, { type: 'ATTACK', unitId: killer.id, targetId: u.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (!r.ok) return null;
    const spirit = r.state.units.find((x) => x.custom?.spiritForm === true);
    assert.ok(spirit, '应该化灵了');
    return { s: r.state, spirit: spirit! };
  };

  test('魂修：3 代修士，吃修炼也吃灵力', () => {
    const s = fresh({ expansionIds: ['cultivation'] });
    const def = s.unitTypes['soul-cultivator'];
    assert.ok(def, '魂修要在本局兵种表里');
    assert.equal(def.era, 3, '三代');
    assert.equal(def.category, 'combat');
    const u = place2(s, 'A', 'soul-cultivator', 5, 5);
    assert.ok(isCultivatorUnit(s, u), '要算修士，否则不修炼、不吸灵气');
  });

  test('魂修化灵：境界血一点不折，学过的技能全留着', () => {
    const r = ascend('soul-cultivator');
    assert.ok(r);
    assert.equal(r!.spirit.type, 'cultivator-spirit', '变成灵体');
    assert.equal(r!.spirit.custom?.originType, 'soul-cultivator');
    assert.equal(r!.spirit.maxHpBonus, 100, '魂修不折减：100 还是 100');
    assert.equal(r!.spirit.hp, 101, '基础 1 + 100');
    const ids = skillsOf(r!.s, r!.spirit).map((k) => k.id);
    assert.ok(ids.includes(SKY_STEP_SKILL.id), '领悟的技能要带进魂里');
    assert.ok(ids.includes(PALM_THUNDER_SKILL.id), '学来的法术也在');
  });

  test('对照：普通修士化灵后血掉七成、非魂法技能散掉', () => {
    const r = ascend('qi-cultivator');
    assert.ok(r);
    assert.equal(r!.spirit.maxHpBonus, 30, '100 × 0.3');
    assert.equal(r!.spirit.hp, 31);
    const ids = skillsOf(r!.s, r!.spirit).map((k) => k.id);
    assert.ok(!ids.includes(SKY_STEP_SKILL.id), '没标魂法的技能要散掉');
    assert.ok(!ids.includes(PALM_THUNDER_SKILL.id), '学来的法术也散');
  });

  test('魂修灵体不吃削弱：攻击按境界算，比普通灵体高一截', () => {
    const soul = ascend('soul-cultivator')!;
    const plain = ascend('qi-cultivator')!;
    const a = effectiveStats(soul.s, soul.spirit);
    const b = effectiveStats(plain.s, plain.spirit);

    // 普通灵体攻击 ×0.1；魂修按正常境界值 → 差一个数量级
    assert.ok(a.atk > b.atk * 3, `魂修灵体攻击该高得多：${a.atk} vs ${b.atk}`);
    // 护甲反过来：普通灵体 ×10 是补偿，魂修按正常算
    assert.ok(a.armor < b.armor, `魂修护甲按正常算：${a.armor} vs ${b.armor}`);
    // 但要和"活着的魂修"一个量级 —— 这才是"战斗力没掉"的意思。
    // 差的那一点是**兵种基础值**：灵体 atk/armor 都是 0，魂修活着时是 8/1。
    const soulDef = soul.s.unitTypes['soul-cultivator'];
    const spiritDef = soul.s.unitTypes['cultivator-spirit'];
    const alive = place2(soul.s, 'A', 'soul-cultivator', 3, 3);
    setCultivationExp(alive, expForRank(8));
    const live = effectiveStats(soul.s, alive);
    assert.equal(
      a.atk - (spiritDef.atk ?? 0),
      live.atk - soulDef.atk,
      `境界给的攻击加成和活着时一样：灵体 ${a.atk} / 活人 ${live.atk}`,
    );
    assert.equal(
      a.armor - (spiritDef.armor ?? 0),
      live.armor - soulDef.armor,
      `境界给的护甲加成也一样：灵体 ${a.armor} / 活人 ${live.armor}`,
    );
  });
}

// 这段魔法代码可以让这个文件被单独运行
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
  console.log(`\n通过 ${stats.passed} 项，失败 ${stats.failed} 项\n`);
  if (stats.failed > 0) process.exit(1);
}
