/**
 * 肉鸽试玩版的无头冒烟测试。
 *
 * 不开浏览器，直接把"房间图生成 → 逐房推进 → 跨层 → 结局"这条链跑一遍，
 * 再用真实的 AI 打一场，确认战斗适配层造出来的局面能被规则层正常推演。
 *
 *   node --experimental-strip-types scripts/rogue-smoke.ts
 *
 * 它不属于 `npm test`（那套是本体自己的回归），也不改任何既有脚本。
 */
import { AI_MAX_STEPS, aiActionKey, aiNextAction } from '../src/core/ai.ts';
import { DEFAULT_BUDGET } from '../src/core/ai-meta.ts';
import {
  afterRoom,
  applyEffect,
  armyCount,
  battleFor,
  bonusOf,
  bossFor,
  bossRewards,
  finishBattle,
  nextLayer,
  planLayer,
  restOptions,
  resolveWorld,
  rewardOptions,
  scaleGold,
  shopStock,
  specialRewards,
  startRun,
  themeFor,
  themeOf,
  trialActive,
  STEPS_PER_LAYER,
} from '../src/roguelike/run.ts';
import { DECISIONS, DEFENSE_UNIT_DEFS, EVENTS, eventById, pickEnemyTypes, WORLDS } from '../src/roguelike/data.ts';
import { attackableTargets, isEliminated, maxHpOf, sameTeam, utype } from '../src/core/rules.ts';
import { realmAtkFor } from '../src/core/cultivation/stats.ts';
import { baseTypeOf, buildBattle, outcomeOf, resultOf, spawnWave, step, survivorsOf } from '../src/roguelike/battle.ts';
import { makeRng } from '../src/roguelike/rng.ts';
import type { LayerId, RoomKind, RunState } from '../src/roguelike/types.ts';

const at = <T,>(list: readonly T[], i: number): T => list[i] as T;

let failures = 0;
function check(ok: boolean, label: string, extra = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

// ---------------------------------------------------------------- 1. 房间图
console.log('\n[1] 房间图生成（200 层）');
{
  const counts = new Map<RoomKind, number>();
  let bad = 0;
  for (let i = 0; i < 200; i += 1) {
    const layer = ((i % 3) + 1) as LayerId;
    const plan = planLayer(layer, makeRng(i * 7919 + layer));
    if (plan.steps.length !== STEPS_PER_LAYER) bad += 1;
    for (const doors of plan.steps) if (doors.length !== 2) bad += 1;
    const kinds = plan.steps.flat().map((r) => r.kind);
    if (kinds.length !== 20) bad += 1;
    if (plan.steps[0]?.some((d) => d.kind !== 'battle')) bad += 1;
    if (!kinds.includes('shop') || !kinds.includes('rest')) bad += 1;
    if (i === 0) for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  check(bad === 0, '每层 10 步 × 2 门、第 1 步必战、至少各有一个商店与营地', `异常 ${bad}`);
  const battle = (counts.get('battle') ?? 0);
  const elite = counts.get('elite') ?? 0;
  const siege = counts.get('siege') ?? 0;
  const special = counts.get('special') ?? 0;
  console.log(
    `    一层比例：战斗 ${battle} / 精英 ${elite} / 攻坚 ${siege} / 守城 ${special} / 事件 ${counts.get('event') ?? 0} / 商店 ${
      counts.get('shop') ?? 0
    } / 营地 ${counts.get('rest') ?? 0}`,
  );
  check(battle + elite + siege + special === 10, '战斗房共 10 个（6 普通 + 2 精英 + 1 攻坚 + 1 守城）');
  let specials = 0;
  for (let i = 0; i < 60; i += 1) {
    const plan = planLayer(((i % 3) + 1) as LayerId, makeRng(i * 31 + 5));
    specials += plan.steps.flat().filter((r) => r.kind === 'special').length;
    if (plan.steps.flat().filter((r) => r.kind === 'special').length !== 1) bad += 1;
  }
  check(specials === 60, '每层正好一场守城战', `实际 ${specials}/60`);
}

// ---------------------------------------------------------------- 2. 走完三层
console.log('\n[2] 流程推进（60 局，全部走完三层）');
{
  let ended = 0;
  let survived = 0;
  for (let i = 0; i < 60; i += 1) {
    const rng = makeRng(i * 104729 + 7);
    const run: RunState = startRun(i + 1, ['frontier', 'skirmish', 'horse'][i % 3] as string);
    let guard = 0;
    while (!run.over && guard < 200) {
      guard += 1;
      if (run.step >= STEPS_PER_LAYER) {
        // 层末 boss：用"惨胜"代替真打，只验证流程
        const { init } = bossFor(run, run.seed + guard);
        finishBattle(run, {
          win: true,
          survivors: run.army.map((a) => ({ ...a })),
          gold: init.playerGold + 100,
          turns: 20,
        });
        bossRewards(run, rng);
        if (run.layer >= 3) {
          run.over = { win: true, title: '常规结局 · 破钟', body: '' };
        } else {
          nextLayer(run, run.seed);
        }
        continue;
      }
      const doors = run.plan.steps[run.step] as RunState['plan']['steps'][number];
      const node = at(doors, rng.int(doors.length));
      if (node.kind === 'battle' || node.kind === 'elite' || node.kind === 'siege' || node.kind === 'special') {
        const init = battleFor(run, node, run.seed + guard);
        // 简化：赢，损失一个兵（兵被扣完就让流程自然结束）
        const survivors = run.army.map((a) => ({ ...a }));
        const first = survivors.find((a) => a.count > 0);
        if (first) first.count -= 1;
        finishBattle(run, {
          win: true,
          survivors: survivors.filter((a) => a.count > 0),
          gold: init.playerGold + 50,
          turns: 15,
        });
        if (armyCount(run.army) === 0) {
          run.over = { win: false, title: '全灭', body: '' };
          break;
        }
        if (node.kind === 'special') {
          specialRewards(run, node, rng);
        } else {
          const rewards = rewardOptions(run, node.kind, rng);
          applyEffect(run, at(rewards, 0).effect, rng);
        }
        afterRoom(run);
      } else if (node.kind === 'shop') {
        const stock = shopStock(run, rng);
        const affordable = stock.find((s) => s.price <= run.gold);
        if (affordable) {
          run.gold -= affordable.price;
          applyEffect(run, affordable.effect, rng);
        }
        afterRoom(run);
      } else if (node.kind === 'rest') {
        const opts = restOptions(run, rng);
        applyEffect(run, at(opts, rng.int(opts.length)).effect, rng);
        afterRoom(run);
      } else {
        afterRoom(run);
      }
    }
    if (run.over) {
      ended += 1;
      if (run.over.win) survived += 1;
    }
  }
  check(ended === 60, '60 局都在 200 步内到达结局');
  console.log(`    通关 ${survived} 局（用简化战斗，只验证流程不会卡死）`);
}

// ---------------------------------------------------------------- 3. 真打一场
console.log('\n[3] 真实对局：L1 遭遇战，双方 AI 打到分出胜负');
{
  const run = startRun(4242, 'frontier');
  const node = { kind: 'battle' as const, title: '遭遇战', sub: '冒烟测试' };
  const init = battleFor(run, node, 999);
  const s = buildBattle(init);
  check(s.units.filter((u) => u.owner === 'A').length > 0, '我军已布阵');
  check(s.units.filter((u) => u.owner === 'B').length > 0, '敌军已布阵');
  check(s.cities.length === 0, '遭遇战：双方都没有城', `实际 ${s.cities.length} 座`);
  check(s.w === 8, '遭遇战地图 8×8', `实际 ${s.w}`);
  const water = s.tiles.filter((t) => t.terrain === 'water' || t.terrain === 'deep' || t.terrain === 'mountain').length;
  const plain = s.tiles.filter((t) => t.terrain === 'plain').length;
  check(water === 0, '地图没有水/山（不用绕路）', `实际 ${water} 格`);
  check(plain / s.tiles.length > 0.7, '平原占七成以上', `实际 ${Math.round((plain / s.tiles.length) * 100)}%`);
  check(s.fog === false, '无城关卡关雾（AI 才有方向）');
  check(s.players.A.gold === init.playerGold, '金币按 run 的值带进战斗');

  let state = s;
  const rejected = new Set<string>();
  let actions = 0;
  let guard = 0;
  const overLimit = (): boolean => Math.ceil(state.turn / 2) > init.roundLimit;
  while (!outcomeOf(state) && !overLimit() && guard < 4000) {
    guard += 1;
    const budget = { ...DEFAULT_BUDGET };
    const action = aiNextAction(state, budget, rejected);
    if (!action) {
      const end = step(state, { type: 'END_TURN' });
      if (!end.ok) break;
      state = end.state;
      rejected.clear();
      continue;
    }
    const r = step(state, action);
    if (!r.ok) {
      rejected.add(aiActionKey(action));
      if (rejected.size > AI_MAX_STEPS * 4) break;
      continue;
    }
    rejected.clear();
    state = r.state;
    actions += 1;
  }
  const outcome = outcomeOf(state);
  console.log(
    `    ${actions} 个动作、${Math.ceil(state.turn / 2)} 轮（上限 ${init.roundLimit}）后：${
      outcome ?? (overLimit() ? '超时判负' : '未分出胜负')
    }`,
  );
  check(outcome !== null || overLimit(), '对局在回合上限内结束（不会卡死）');
  check(typeof state.turn === 'number' && state.turn > 1, '回合在推进');
  const surv = survivorsOf(state);
  check(Array.isArray(surv), '幸存者能翻译回军队');
  const res = resultOf(state, outcome === 'win');
  check(res.gold >= 0, '结算里的金币是合法数值');
}

// ---------------------------------------------------------------- 4. 攻坚/层末的城数
console.log('\n[4] 关卡规格');
{
  const run = startRun(777, 'skirmish');
  const siege = buildBattle(battleFor(run, { kind: 'siege', title: '攻坚战', sub: '' }, 5));
  check(siege.cities.filter((c) => c.owner === 'B').length === 1, '攻坚战敌方 1 座城');
  check(siege.cities.filter((c) => c.owner === 'A').length === 0, '攻坚战玩家仍然没有城');
  const { init } = bossFor(run, 6);
  const boss = buildBattle(init);
  check(boss.cities.filter((c) => c.owner === 'B').length === 1, 'L1 层末：敌方 1 座城');
  check(boss.units.filter((u) => u.owner === 'B').length >= 3, '层末会战敌军有编成');
  const run3 = startRun(888, 'frontier');
  run3.layer = 3;
  run3.clock = 8;
  const boss3 = buildBattle(bossFor(run3, 9).init);
  check(boss3.cities.filter((c) => c.owner === 'B').length === 2, 'L3 钟楼：敌方 2 座城');
  /*
   * 无城判负：把我军全撤掉之后，A 席应当立刻算"出局"。
   * 这条是这次改动的核心——上一版是靠"给一座营城"绕过去的。
   */
  const wipe = { ...boss, units: boss.units.filter((u) => u.owner !== 'A') };
  check(isEliminated(wipe, 'A'), '无城席位：兵打光＝出局');
  check(!isEliminated(boss, 'A'), '还有兵时不算出局');
}

// ---------------------------------------------------------------- 5. 阵型
console.log('\n[5] 阵型：射程越远越靠后，快兵在两翼');
{
  const run = startRun(31415, 'skirmish');
  const s = buildBattle(battleFor(run, { kind: 'battle', title: '遭遇战', sub: '' }, 2718));
  const line = (owner: 'A' | 'B') => {
    const us = s.units.filter((u) => u.owner === owner);
    const melee = us.filter((u) => (utype(s, u.type).range ?? 1) <= 1);
    const ranged = us.filter((u) => (utype(s, u.type).range ?? 1) >= 3);
    const avg = (l: typeof us): number => (l.length ? l.reduce((n, u) => n + u.y, 0) / l.length : NaN);
    return { melee: avg(melee), ranged: avg(ranged), meleeN: melee.length, rangedN: ranged.length };
  };
  const a = line('A');
  check(a.meleeN > 0 && a.rangedN > 0, '我军近战与远程都在场');
  check(a.ranged > a.melee, '我军远程站在近战后面', `近战 y=${a.melee.toFixed(1)} 远程 y=${a.ranged.toFixed(1)}`);

  const scout = s.units.find((u) => u.owner === 'A' && utype(s, u.type).id === 'scout');
  const militia = s.units.find((u) => u.owner === 'A' && utype(s, u.type).id === 'militia');
  if (scout && militia) {
    const cx = s.units.filter((u) => u.owner === 'A').reduce((n, u) => n + u.x, 0) / 7;
    check(
      Math.abs(scout.x - cx) >= Math.abs(militia.x - cx),
      '快兵（斥候 move 4）站得比民兵靠边',
      `斥候 ${scout.x} / 民兵 ${militia.x} / 中线 ${cx.toFixed(1)}`,
    );
  }
}

// ---------------------------------------------------------------- 6. 成长与奖励
console.log('\n[6] 成长与奖励');
{
  // 跨层不换装
  const run = startRun(4242, 'frontier');
  const before = run.army.map((a) => a.type).join(',');
  run.step = STEPS_PER_LAYER;
  nextLayer(run, run.seed);
  check(run.army.map((a) => a.type).join(',') === before, '跨层不自动换装（队伍原样带走）');

  // 开局三房用上一代兵池
  const run2 = startRun(515, 'frontier');
  run2.layer = 2;
  run2.clock = 0;
  const init2 = battleFor(run2, { kind: 'battle', title: '', sub: '' }, 6);
  const prev = new Set(['spearman', 'longbow', 'crossbow', 'knight']);
  check(
    init2.enemyTypes.every((t) => prev.has(t)),
    'L2 开局（钟 0）敌人全是上一代（e2）',
    init2.enemyTypes.join(','),
  );
  run2.clock = 4;
  const init2b = battleFor(run2, { kind: 'battle', title: '', sub: '' }, 6);
  check(
    init2b.enemyTypes.some((t) => !prev.has(t)),
    'L2 中段（钟 4）敌人换成本代（e3）',
    init2b.enemyTypes.join(','),
  );

  // 普通战：钱 ≈ 1.15 个兵价
  const rng = makeRng(9);
  const run3 = startRun(99, 'frontier');
  const opts = rewardOptions(run3, 'battle', rng);
  const unitOpt = opts.find((o) => o.id === 'unit');
  const goldOpt = opts.find((o) => o.id === 'gold');
  check(!!unitOpt && !!goldOpt, '普通战奖励里有「兵」和「钱」两项');
  if (unitOpt && goldOpt) {
    check((unitOpt.effect.add?.count ?? 0) === 1, '普通战给 1 个兵');
    const gold = goldOpt.effect.gold ?? 0;
    check(gold > 25 && gold < 260, '普通战的钱在一个兵的价位上', `${gold} 金`);
  }

  // 精英：3 个兵 / 3 兵价的钱 / 1 兵 + 藏品
  const elite = rewardOptions(run3, 'elite', makeRng(11));
  check(elite.length === 3, '精英战给三个选项');
  check(elite.some((o) => (o.effect.add?.count ?? 0) === 3), '精英战有「三个兵」');
  check(elite.some((o) => (o.effect.add?.count ?? 0) === 1 && !!o.effect.relic), '精英战有「一兵 + 一藏品」');

  // 层末：1 藏 + 1 本层高级兵 + 1 下层初级兵 + 高级兵价钱
  const run4 = startRun(1234, 'frontier');
  const relicsBefore = run4.relics.length;
  const goldBefore = run4.gold;
  const armyBefore = armyCount(run4.army);
  const notes = bossRewards(run4, makeRng(21));
  check(run4.relics.length === relicsBefore + 1, '层末必给 1 件藏品');
  check(armyCount(run4.army) === armyBefore + 2, '层末给 2 个兵（本层高级 + 下层初级）');
  check(run4.gold > goldBefore, '层末给一笔钱');
  check(notes.some((n) => n.includes('下一层的兵')), '层末战利品里点明"下一层的兵"', notes.join(' / '));
}

// ---------------------------------------------------------------- 7. 第二层的四种世界
console.log('\n[7] 第二层的四种世界（正史 / 军备 / 奇想 / 修真）');
{
  const ids = ['base', 'arms', 'fantasy', 'cultivation'] as const;
  for (const id of ids) {
    const t = themeFor(id, 2);
    check(t.pool.length > 0 && t.poolHigh.length > 0, `「${WORLDS[id].name}」有低代与高代兵池`);
    check(t.name.includes('第二层'), `「${WORLDS[id].name}」有自己的层名`, t.name);
  }
  check(themeFor('fantasy', 2).expansions.includes('fantasy'), '奇想层要开 fantasy 扩展');
  check(themeFor('cultivation', 2).expansions.includes('cultivation'), '修真层要开 cultivation 扩展');

  // 选完路之后，第二层的名字与兵池都换了
  const run = startRun(31, 'frontier');
  run.step = STEPS_PER_LAYER;
  run.world = 'fantasy';
  nextLayer(run, run.seed);
  check(run.layer === 2 && themeOf(run).name.includes('异境'), '选奇想后第二层变成「异境」', themeOf(run).name);

  const init = battleFor(run, { kind: 'battle', title: '', sub: '' }, 77);
  check(init.expansions.includes('fantasy'), '第二层战斗里带着 fantasy 扩展');
  const s = buildBattle(init);
  const known = new Set(Object.keys(s.unitTypes));
  const missing = themeFor('fantasy', 2).pool.filter((t) => !known.has(t));
  check(missing.length === 0, '奇想的兵都能进本局兵种表', missing.join(','));

  // 修真：修士按境界加攻血（demo 用固定加成代替修炼循环）
  const r2 = startRun(32, 'frontier');
  r2.layer = 2;
  r2.clock = 6;
  r2.world = 'cultivation';
  const init2 = battleFor(r2, { kind: 'battle', title: '', sub: '' }, 78);
  // 固定一个修士上场，专门看境界加成（随机编成不一定抽到人）
  init2.enemyTypes = ['qi-cultivator'];
  const s2 = buildBattle(init2);
  // 修士现在会套"境界变体"（rg:qi-cultivator@…），按基础 id 找
  const qi = s2.units.find((u) => baseTypeOf(u.type) === 'qi-cultivator');
  if (qi) {
    /*
     * 境界不再写进"变体兵种"：DLC 的 `stats.ts` 在伤害结算时按 rank 现算
     * 攻/甲/射/移，生命走 `maxHpOf`（基础 + `maxHpBonus`）。所以断言要查
     * **实际生效值**，不是 `utype().atk`——那个只是兵种基础。
     */
    const def = utype(s2, qi.type);
    check(realmAtkFor(qi) > 0, '修真修士吃到境界加成（攻击）', `境界+${realmAtkFor(qi)}`);
    check(maxHpOf(s2, qi) > def.maxHp, '修真修士的血也涨了', `${def.maxHp} → ${maxHpOf(s2, qi)}`);
  } else {
    check(false, '修真层派出了修士', '场上没有 qi-cultivator');
  }

  // 层末战利品里的"下一层兵"要跟着世界走
  const r3 = startRun(33, 'frontier');
  r3.world = 'cultivation';
  const notes3 = bossRewards(r3, makeRng(5));
  check(notes3.some((n) => n.includes('炼气士')), '选修真后，第一层末给的是修真的兵', notes3.join(' / '));

  // 第三层的溢出与末法之世
  check(themeFor('fantasy', 3).pool.includes('archmage'), '奇想的 e5 兵溢到第三层');
  check(themeFor('cultivation', 3).subtitle.includes('末法'), '修真没有 e5 兵，第三层是「末法之世」');
}

// ---------------------------------------------------------------- 8. 精英 / 层末 / 守城的场地
console.log('\n[8] 精英战有塔、层末有城有塔、守城战有城守得住');
{
  const run = startRun(2024, 'frontier');
  const elite = buildBattle(battleFor(run, { kind: 'elite', title: '精英战', sub: '' }, 3));
  const eliteTowers = elite.units.filter((u) => u.owner === 'B' && elite.unitTypes[u.type]?.category === 'building');
  check(elite.cities.length === 0, '精英战：双方都没有城', `实际 ${elite.cities.length} 座`);
  check(eliteTowers.length >= 1, '精英战：敌军有一座防御塔', `实际 ${eliteTowers.length} 处工事`);

  const siege = buildBattle(battleFor(run, { kind: 'siege', title: '攻坚战', sub: '' }, 4));
  check(siege.cities.filter((c) => c.owner === 'B').length === 1, '攻坚：敌方 1 座城');
  check(
    siege.units.filter((u) => u.owner === 'B' && siege.unitTypes[u.type]?.category === 'building').length >= 1,
    '攻坚：城边有工事',
  );

  const { init: bossInit } = bossFor(run, 5);
  const boss = buildBattle(bossInit);
  const bossWorks = boss.units.filter((u) => u.owner === 'B' && boss.unitTypes[u.type]?.category === 'building');
  check(boss.cities.filter((c) => c.owner === 'B').length >= 1, '层末：有城');
  check(bossWorks.length >= 1, '层末：城边有工事（不是光一座城挨打）', `实际 ${bossWorks.length}`);

  const spInit = battleFor(run, { kind: 'special', title: '守城战', sub: '', special: { faction: 0, name: '守墙人', unit: 'knight' } }, 6);
  const sp = buildBattle(spInit);
  check(sp.cities.filter((c) => c.owner === 'B').length === 1, '守城战：城在友军 B 手里');
  const allyCity = sp.cities.find((c) => c.owner === 'B');
  check(!!allyCity && allyCity.maxHp > 45, '守城战：友军的城被加固过', `maxHp=${allyCity?.maxHp}`);
  check(
    sp.units.filter((u) => u.owner === 'B' && sp.unitTypes[u.type]?.category === 'building').length >= 1,
    '守城战：友军城边有工事',
  );
  check(spInit.holdRounds > 0 && spInit.waves.length >= 3, '守城战：有回合目标与至少三波援军');
  check(spInit.holdRounds === 6 + run.layer, '守城轮数按层给（L1 七轮）', String(spInit.holdRounds));
  check(spInit.enemyDoctrine === 'rush', '守城战的敌人是来攻城的（rush）');

  // 波次真的能上场（第三席 C = 攻方）
  const before = sp.units.filter((u) => u.owner === 'C').length;
  const wave = spawnWave(sp, spInit.waves[0]!.types, 77, 'C');
  check(wave.length > 0 && sp.units.filter((u) => u.owner === 'C').length > before, '波次能把新兵摆到场上');
  check(wave.every((u) => u.y <= 3), '波次从地图上沿进场', wave.map((u) => `${u.x},${u.y}`).join(' '));

  /*
   * 守满 N 轮：把回合拨到"第 N 轮结束"，再让双方各走一次。
   * 判的是"已经打完的轮数"（floor(turn/2)），所以拨到 2N-1 起手正好。
   */
  // 三席：一轮 = 三次行动。拨到"第 N 轮最后一次行动"之前，走完就满 N 轮
  sp.turn = spInit.holdRounds * 3 - 1;
  sp.current = 'A';
  const e1 = step(sp, { type: 'END_TURN' });
  check(
    e1.ok && outcomeOf(e1.state, spInit) === 'win',
    '守到 N 轮之后判玩家赢',
    `turn=${e1.ok ? e1.state.turn : '-'} outcome=${e1.ok ? outcomeOf(e1.state, spInit) : '-'}`,
  );

  // 城被砸平：哪怕人还在，也算没守住
  const razed = buildBattle(spInit);
  const ownCity = razed.cities.find((c) => c.owner === 'B');
  if (ownCity) ownCity.ruined = true;
  check(outcomeOf(razed, spInit) === 'lose', '城被砸平就算输（哪怕人还在）');
}

// ---------------------------------------------------------------- 9. 事件与决议不同质
console.log('\n[9] 事件池 / 休整 / 临战决议各管一摊');
{
  check(EVENTS.length >= 15, '事件池至少 15 条', `实际 ${EVENTS.length}`);
  const buffEvents = EVENTS.filter((e) => e.choices.some((c) => c.effect.nextAtk || c.effect.nextArmor || c.effect.nextHp));
  check(buffEvents.length === 0, '事件里不再有"下一战 +攻/+甲/+血"（那是决议的活）', buffEvents.map((e) => e.title).join(','));
  const risky = EVENTS.filter((e) => e.choices.some((c) => c.effect.risk));
  const removers = EVENTS.filter((e) => e.choices.some((c) => c.effect.remove));
  const promoters = EVENTS.filter((e) => e.choices.some((c) => c.effect.promote));
  check(risky.length >= 4, '有"赌一把"的事件', `实际 ${risky.length}`);
  check(removers.length >= 4, '有要拿兵去换的事件', `实际 ${removers.length}`);
  check(promoters.length >= 2, '有"整编"的事件', `实际 ${promoters.length}`);
  const choiceCounts = new Set(EVENTS.map((e) => e.choices.length));
  check(choiceCounts.size >= 2, '事件选项数量不都是一个模子', [...choiceCounts].join('/'));

  check(DECISIONS.length >= 6, '临战决议至少 6 个', `实际 ${DECISIONS.length}`);
  check(
    DECISIONS.every(
      (d) => d.atk || d.hp || d.armor || d.move || d.enemyCut || d.cityDamage || d.defenseDamage || d.enemyHp || d.tempUnits,
    ),
    '决议全是这一场的战术修正（没有金币/兵/藏品的收益）',
  );
  check(DECISIONS.filter((d) => (d.armor ?? 0) < 0 || (d.move ?? 0) < 0).length >= 2, '决议里有"拿一样换一样"的代价');

  const rest = restOptions(startRun(11, 'frontier'), makeRng(12));
  check(
    rest.every((r) => !r.effect.nextAtk && !r.effect.nextArmor && !r.effect.nextHp),
    '休整只管人/钱/编制，不再和决议抢战斗加成',
    rest.map((r) => r.title).join(','),
  );

  // 效果本身能用：整编 / 减兵 / 赌博
  const r2 = startRun(13, 'frontier');
  const lowType = r2.army[0]!.type;
  const beforeGold = r2.gold;
  const notes = applyEffect(r2, { promote: 1 }, makeRng(1));
  check(notes.some((n) => n.includes('整编')), '整编有效果', notes.join('/'));
  const r3 = startRun(14, 'frontier');
  const n0 = armyCount(r3.army);
  applyEffect(r3, { remove: { type: 'layer-low', count: 1 } }, makeRng(1));
  check(armyCount(r3.army) < n0, '减兵有效果');
  const r4 = startRun(15, 'frontier');
  const g0 = r4.gold;
  const riskNotes = applyEffect(r4, { gold: -50, risk: { chance: 1, win: { gold: 200 }, winText: '赢', loseText: '输' } }, makeRng(2));
  check(r4.gold === g0 + 150 && riskNotes.includes('赢'), '赌博：先扣钱，再按概率结算', `${g0}→${r4.gold}`);
  void lowType;
  void beforeGold;
}

// ---------------------------------------------------------------- 10. 守城报酬 / 编成人数
console.log('\n[10] 守城报酬与编成人数');
{
  const run = startRun(16, 'frontier');
  const node = { kind: 'special' as const, title: '守城战', sub: '', special: { faction: 1, name: '持秤者', unit: 'knight' } };
  const relics = run.relics.length;
  const army = armyCount(run.army);
  const notes = specialRewards(run, node, makeRng(3));
  check(run.relics.length === relics + 1, '守城成功给 1 件藏品');
  check(armyCount(run.army) === army + 1, '守城成功给东家的兵');
  check(notes.some((n) => n.includes('持秤者')), '报酬里点明是谁给的', notes.join(' / '));

  // 人数：说几个人就上几个人（钱够的前提下）
  const pool = ['militia', 'archer', 'scout', 'ge'];
  const cost = (id: string): number => ({ militia: 25, archer: 40, scout: 45, ge: 35 } as Record<string, number>)[id] ?? 0;
  const want = 4;
  const budget = 4 * 32;
  const picked = pickEnemyTypes(pool, budget, cost, want);
  check(picked.length === want, '编成按人头给足（不再"算 4 个来 3 个"）', picked.join(','));
  check(new Set(picked).size >= 2, '编成不会连着四个一样的', picked.join(','));
}

// ---------------------------------------------------------------- 11. 工事 / 英雄 / 价格
console.log('\n[11] 工事、英雄与按层价格（2026-11-25 修）');
{
  /*
   * 工事**不能动**：以前"骑军 +1 移动 / 急行靴 +1 移动"会套到土墙和塔上，
   * 建筑在本体里是 move 0，到了肉鸽却能走一格。
   */
  const run = startRun(21, 'horse');
  run.layer = 2;
  run.world = 'fantasy';
  run.army = [{ type: 'berserker', count: 3 }];
  const node = { kind: 'special' as const, title: '守城战', sub: '', special: { faction: 0, name: '守墙人', unit: 'berserker' } };
  const s = buildBattle(battleFor(run, node, 3011));
  const buildings = s.units.filter((u) => s.unitTypes[u.type]?.category === 'building');
  check(buildings.length > 0, '守城战有工事');
  check(
    buildings.every((u) => utype(s, u.type).move === 0),
    '工事移动力为 0（不吃方略/藏品的 +移动）',
    buildings.map((u) => `${utype(s, u.type).name}:${utype(s, u.type).move}`).join(','),
  );
  check(
    buildings.every((u) => !utype(s, u.type).produce),
    '工事不是产兵建筑（不再拿军营当墙）',
    buildings.map((u) => utype(s, u.type).name).join(','),
  );
  const allWallsOk = Object.values(DEFENSE_UNIT_DEFS).every(
    (d) => d.category === 'building' && d.move === 0 && (d as unknown as { produce?: boolean }).produce !== true,
  );
  check(allWallsOk, '关卡自带的工事兵种都是不可移动、不产兵的建筑');

  /*
   * 波次 + 召唤：**id 不能重复**。
   *
   * 上一次的"国王闪现到哥布林营地旁边然后消失"就是两个 u10：波次按
   * "当前最大 id + 1"发号，没推进 `nextUnitSeq`，下一回合战营召唤的小兵
   * 又拿到同一个号，渲染层按 id 认节点，两张牌共用一个 DOM。
   */
  const waveRun = startRun(22, 'frontier');
  waveRun.layer = 2;
  waveRun.world = 'fantasy';
  waveRun.army = [{ type: 'berserker', count: 3 }];
  const ws = buildBattle(battleFor(waveRun, node, 4012));
  spawnWave(ws, ['elf-archer', 'elf-archer'], 1);
  let wsState = ws;
  const e1 = step(wsState, { type: 'END_TURN' });
  if (e1.ok) wsState = e1.state;
  const e2 = step(wsState, { type: 'END_TURN' });
  if (e2.ok) wsState = e2.state;
  const ids = wsState.units.map((u) => u.id);
  check(new Set(ids).size === ids.length, '波次与召唤之后没有重复的单位 id', `${ids.length} 个单位`);

  /*
   * 英雄：一方最多一个；解锁费算进自身费用。
   */
  const heroRun = startRun(23, 'frontier');
  heroRun.layer = 3;
  heroRun.world = 'fantasy';
  heroRun.army = [{ type: 'berserker', count: 2 }];
  applyEffect(heroRun, { add: { type: 'elf-queen', count: 1 } }, makeRng(1));
  applyEffect(heroRun, { add: { type: 'archmage', count: 1 } }, makeRng(1));
  const heroes = heroRun.army.filter((a) => a.type === 'elf-queen' || a.type === 'archmage');
  check(heroes.length === 1 && (heroes[0]?.count ?? 0) === 1, '英雄只能有一位，第二个发不出来', JSON.stringify(heroes));

  const bossHeroRun = startRun(24, 'frontier');
  bossHeroRun.layer = 2;
  bossHeroRun.world = 'fantasy';
  bossHeroRun.army = [{ type: 'berserker', count: 6 }];
  const bossInit = bossFor(bossHeroRun, 77).init;
  // 只数**数据里标了 `hero: true`** 的：国王（royal-king）在本体里不是 hero 标记，
  // 它可以被重复招募；这条断言只钉引擎定义下的"英雄唯一"。
  const bossHeroes = bossInit.enemyTypes.filter((t) => ['holy-knight-lord', 'elf-queen', 'archmage'].includes(t));
  check(bossHeroes.length <= 1, '敌方编成最多一个英雄', bossHeroes.join(','));

  const stock = shopStock(bossHeroRun, makeRng(2));
  const heroItem = stock.find((it) => it.effect.add && ['holy-knight-lord', 'royal-king'].includes(it.effect.add.type));
  check(!heroItem || heroItem.price > (heroItem.effect.add ? 470 : 0), '英雄的标价含解锁费', heroItem ? `${heroItem.title} ${heroItem.price}` : '本批没上架');

  /*
   * 价格水位：第一层的 30 金，到第三层应该是 270 金（×9），而不是还是 30。
   */
  const p1 = startRun(25, 'frontier');
  const p3 = startRun(26, 'frontier');
  p3.layer = 3;
  check(scaleGold(-30, p1) === -30 && scaleGold(-30, p3) === -270, '花销按层换算（L1 −30 / L3 −270）');
  const g3 = p3.gold;
  applyEffect(p3, { gold: -30 }, makeRng(1), { scaleGold: true });
  check(p3.gold === Math.max(0, g3 - 270), '事件扣钱走的是换算后的数', `${g3}→${p3.gold}`);

  /*
   * 四种世界 × 三层：守城战的工事都必须是"真墙 / 真塔"。
   *
   * 这条是给第 2 条兜底的：只要哪个世界又拿军营当墙（`produce: true`），
   * 这里就会红，不用等人玩到那一层才发现"给我一座产兵建筑我又不能产兵"。
   */
  let workBad = '';
  for (const w of ['base', 'arms', 'fantasy', 'cultivation'] as const) {
    for (const layer of [1, 2, 3] as const) {
      const rr = startRun(31 + layer, 'frontier');
      rr.layer = layer;
      rr.world = w;
      rr.army = [{ type: 'ge', count: 3 }];
      const st = buildBattle(battleFor(rr, node, 700 + layer));
      for (const u of st.units.filter((x) => st.unitTypes[x.type]?.category === 'building')) {
        const d = st.unitTypes[u.type] as { name: string; move: number; produce?: unknown };
        if (d.move !== 0 || d.produce) workBad += `${w}L${layer}:${d.name};`;
      }
    }
  }
  check(workBad === '', '四种世界各层的工事都 move 0、不产兵', workBad);

  /*
   * 两座城：工事与兵都要分开，不能一座满一座空。
   */
  const twoRun = startRun(27, 'frontier');
  twoRun.layer = 3;
  twoRun.army = [{ type: 'hmg', count: 4 }, { type: 'tank', count: 3 }];
  const twoInit = bossFor(twoRun, 991).init;
  check(twoInit.enemyCityCount === 2, 'L3 层末有两座城');
  const twoState = buildBattle(twoInit);
  const enemyCities = twoState.cities.filter((c) => c.owner === 'B');
  const structs = twoState.units.filter((u) => u.owner === 'B' && twoState.unitTypes[u.type]?.category === 'building');
  const combat = twoState.units.filter((u) => u.owner === 'B' && twoState.unitTypes[u.type]?.category === 'combat');
  const nearOf = (list: typeof structs, c: (typeof enemyCities)[number]): number =>
    list.filter((u) => Math.abs(u.x - c.x) <= 3 && u.y <= c.y + 4).length;
  check(structs.length >= 4, 'L3 层末至少四件工事', `${structs.length} 件`);
  check(enemyCities.every((c) => nearOf(structs, c) >= 1), '两座城都有工事', enemyCities.map((c) => nearOf(structs, c)).join('/'));
  check(enemyCities.every((c) => nearOf(combat, c) >= 1), '两座城都有守军', enemyCities.map((c) => nearOf(combat, c)).join('/'));

  /*
   * 守城战的 AI：无城的一方必须往前压（引擎的 `level.ai.pressure`）。
   */
  const lvl = twoState.config.level;
  const specRun = startRun(28, 'frontier');
  specRun.layer = 2;
  specRun.world = 'fantasy';
  const specState = buildBattle(battleFor(specRun, node, 5013));
  const pressure = specState.config.level?.ai?.pressure ?? 0;
  check(pressure > 0, '守城战的攻方带"僵局压力"（不会聚在出兵点不动）', `pressure=${pressure}`);
  void lvl;
}

// ---------------------------------------------------------------- 12. 藏品与成本曲线
console.log('\n[12] 藏品按层成长、医官额度、移动加成只给慢兵');
{
  // 用骑军测：它的被动是 +1 移动，不会污染护甲的读数
  const withRelics = (layer: LayerId): ReturnType<typeof startRun> => {
    const r = startRun(41, 'horse');
    r.layer = layer;
    r.relics = ['forge', 'armorplate', 'rampart', 'boots'];
    return r;
  };
  const b1 = bonusOf(withRelics(1));
  const b3 = bonusOf(withRelics(3));
  check(b1.atk === 1 && b3.atk === 3, '铁匠铺按层成长（L1 +1 / L3 +3）', `${b1.atk}/${b3.atk}`);
  check(b1.armor === 1 && b3.armor === 2, '铁甲按层成长（L1 +1 / L3 +2）', `${b1.armor}/${b3.armor}`);
  check(b1.hp === 6 && b3.hp === 12, '壁垒图按层成长（L1 +6 / L3 +12）', `${b1.hp}/${b3.hp}`);
  check(b1.moveSlow === 1 && b3.moveSlow === 1, '急行靴的移动不随层涨（它靠的是节奏）', `${b1.moveSlow}/${b3.moveSlow}`);
  check(b1.move === 1 && b3.move === 1, '方略的 +移动仍是全军生效', `${b1.move}/${b3.move}`);

  // 文案要和实际值一致
  const { relicDesc } = await import('../src/roguelike/run.ts');
  check(relicDesc('forge', 3).includes('+3'), '商店/奖励的文案按当前层写', relicDesc('forge', 3));
  check(relicDesc('rampart', 2).includes('+9'), '壁垒图在第二层写 +9', relicDesc('rampart', 2));

  // 医官：每层 2 个额度，用完就没有；进下一层重置
  const medic = startRun(42, 'frontier');
  medic.relics = ['medic'];
  medic.reviveLeft = 2;
  medic.army = [{ type: 'ge', count: 6 }];
  const dead = { win: true, survivors: [{ type: 'ge', count: 3 }], gold: 100, turns: 10 };
  const n1 = finishBattle(medic, dead).some((t) => t.includes('随军医官'));
  const n2 = finishBattle(medic, dead).some((t) => t.includes('随军医官'));
  const n3 = finishBattle(medic, dead).some((t) => t.includes('随军医官'));
  check(n1 && n2 && !n3 && medic.reviveLeft === 0, '随军医官每层只救 2 次', `${n1}/${n2}/${n3}`);
  medic.army = [{ type: 'ge', count: 3 }];
  nextLayer(medic, 1);
  check(medic.reviveLeft === 2, '进下一层重置医官额度', String(medic.reviveLeft));

  // 移动加成只给基础移速 ≤3 的兵（骑兵 4/5 不吃）
  // 用边军（无移动被动）+ 急行靴：只看"慢兵是否 +1、骑兵是否不吃"
  const mv = startRun(43, 'frontier');
  mv.layer = 2;
  mv.relics = ['boots'];
  mv.army = [{ type: 'scout', count: 1 }, { type: 'ge', count: 1 }];
  const st = buildBattle(battleFor(mv, { kind: 'battle', title: 't', sub: '' }, 808));
  const scout = st.units.find((u) => u.owner === 'A' && st.unitTypes[u.type]?.name === '斥候');
  const ge = st.units.find((u) => u.owner === 'A' && st.unitTypes[u.type]?.name === '戈兵');
  check(!!scout && utype(st, scout.type).move === 4, '骑兵不额外吃 +1 移动', scout ? String(utype(st, scout.type).move) : 'missing');
  check(!!ge && utype(st, ge.type).move === 3, '步兵吃 +1 移动（2→3）', ge ? String(utype(st, ge.type).move) : 'missing');
}

// ---------------------------------------------------------------- 13. 钱也是兵力 / 工事换编制
console.log('\n[13] 我方金币计入敌方编成、工事换成守军编制');
{
  const mk = (gold: number, layer: LayerId = 1) => {
    const r = startRun(51, 'frontier');
    r.layer = layer;
    r.clock = 4;
    r.army = [{ type: layer === 1 ? 'ge' : 'hmg', count: 5 }];
    r.gold = gold;
    return battleFor(r, { kind: 'battle', title: 't', sub: '' }, 606);
  };
  const poor = mk(0);
  const rich = mk(800);
  check(
    rich.enemyTypes.length > poor.enemyTypes.length,
    '同样 5 个兵，屯 800 金时敌人更多（钱算兵力）',
    `${poor.enemyTypes.length} → ${rich.enemyTypes.length}`,
  );
  check(mk(200).enemyTypes.length === poor.enemyTypes.length, '正常带着两百金不会立刻变难', `${poor.enemyTypes.length} → ${mk(200).enemyTypes.length}`);

  // 工事换编制：层末比同层遭遇战多（L3 四件工事 = +2 人）
  const bossRun = startRun(52, 'frontier');
  bossRun.layer = 3;
  bossRun.world = 'base';
  bossRun.clock = 5;
  bossRun.gold = 0;
  bossRun.army = [{ type: 'hmg', count: 6 }];
  const boss = bossFor(bossRun, 77).init;
  const structs = boss.enemyDefense.reduce((n, d) => n + d.count, 0);
  check(structs === 4, 'L3 层末有四件工事', String(structs));
  check(boss.enemyTypes.length >= 6, '工事不倒扣兵，反而多给编制（6 兵 + 4 工事 → ≥6 守军）', String(boss.enemyTypes.length));

  // 守城战不该吃这条（攻方没有工事）
  const sp = startRun(53, 'frontier');
  sp.layer = 2;
  sp.world = 'fantasy';
  sp.gold = 500;
  sp.army = [{ type: 'berserker', count: 5 }];
  const spInit = battleFor(sp, { kind: 'special', title: 't', sub: '' }, 11);
  check(spInit.enemyDefense.length === 0, '守城战的攻方没有工事编制');
}

// ---------------------------------------------------------------- 14. 三席守城
console.log('\n[14] 守城战：三席、城在友军手里、攻方加波');
{
  const r = startRun(61, 'frontier');
  r.layer = 2;
  r.world = 'fantasy';
  r.army = [{ type: 'berserker', count: 3 }, { type: 'elf-archer', count: 3 }];
  const init = battleFor(r, { kind: 'special', title: '守城战', sub: 't' }, 4242);
  check(init.allyCity === true && init.playerCity === false, '守城战：城在友军 B 手里，玩家无城');
  check(init.allyArmy.length > 0 && init.allyDefense.length > 0, '友军自带守军与工事', `${init.allyArmy.length}/${init.allyDefense.length}`);
  check(init.waves.length === 3 && init.waves[0]?.atRound === 2, '攻方四波（开场 + 2/4/6 轮）', JSON.stringify(init.waves.map((w) => w.atRound)));

  const s = buildBattle(init);
  check(s.config.playerCount === 3, '三席', String(s.config.playerCount));
  check(s.cities.some((c) => c.owner === 'B' && !c.ruined), '城归友军 B');
  check(JSON.stringify(s.config.level?.seats?.teams) === JSON.stringify([['A', 'B'], ['C']]), 'A/B 同盟、C 单列');
  check(s.units.some((u) => u.owner === 'C'), '攻方 C 在场上');
  check(s.config.holdWinner === true, '守城战自己判胜负（不让引擎按全灭收场）');
  check(
    s.units.filter((u) => u.owner === 'B' && s.unitTypes[u.type]?.category === 'combat').length > 0,
    '友军有兵（不是光一座城）',
  );
}

// ---------------------------------------------------------------- 15. 中立单位
console.log('\n[15] 中立单位：不主动、AI 不打、被打会还手、不参与胜负');
{
  const r = startRun(91, 'frontier');
  r.layer = 1;
  r.world = 'base';
  r.gold = 0;
  r.army = [{ type: 'ge', count: 4 }, { type: 'archer', count: 2 }];
  const init = battleFor(r, { kind: 'battle', title: 't', sub: '' }, 20);
  check((init.neutral?.length ?? 0) > 0, '这一关有中立单位', JSON.stringify(init.neutral));
  const s = buildBattle(init);
  const allC = s.units.filter((u) => u.owner === 'C');
  check(allC.length === 2, '中立单位有两个（一左一右）', String(allC.length));
  check(
    allC.some((u) => u.x <= 2) && allC.some((u) => u.x >= s.w - 3),
    '一个贴左边、一个贴右边，不挡中间的道',
    allC.map((u) => `${u.x},${u.y}`).join(' '),
  );
  const n = allC[0];
  check(sameTeam(s, 'B', 'C') && !sameTeam(s, 'A', 'C'), 'AI 视它为友军，玩家与它不同队');
  if (n) {
    const a = s.units.find((u) => u.owner === 'A' && s.unitTypes[u.type]?.category === 'combat');
    const b = s.units.find((u) => u.owner === 'B' && s.unitTypes[u.type]?.category === 'combat');
    if (a) {
      a.x = n.x;
      a.y = n.y + 1;
      check(attackableTargets(s, a).some((t) => t.id === n.id), '玩家能把它列为目标');
    }
    if (b) {
      b.x = n.x;
      b.y = n.y - 1;
      check(!attackableTargets(s, b).some((t) => t.id === n.id), 'AI 不会把它列为目标');
    }
    // 打它一下：它要还手
    if (a) {
      const beforeHp = a.hp;
      const hit = step(s, { type: 'ATTACK', unitId: a.id, targetId: n.id, x: n.x, y: n.y });
      check(hit.ok && (hit.state.units.find((u) => u.id === a.id)?.hp ?? 0) < beforeHp, '攻击中立单位会遭到反击');
    }
    check((s.config.level?.seats?.hidden ?? []).includes('C'), '中立单位躲在"隐藏席位"里（不占回合）');
  }

  // 胜负不把中立算进去：打光 B，A 仍然赢
  const win = buildBattle(init);
  for (const u of win.units) if (u.owner === 'B') u.hp = 0;
  win.units = win.units.filter((u) => u.hp > 0);
  const end = step(win, { type: 'END_TURN' });
  check(end.ok && end.state.winner === 'A' && end.state.units.some((u) => u.owner === 'C'), '中立单位不挡胜利');
}

// ---------------------------------------------------------------- 16. 试验型方略
console.log('\n[16] 试验型方略：成长型英雄 / 成长型坦克');
{
  const v = startRun(81, 'vanguard');
  check(v.gold === 150, '试验队开局 150 金', String(v.gold));
  const vs = buildBattle(battleFor(v, { kind: 'battle', title: 't', sub: '' }, 7));
  check(
    vs.units.some((u) => u.owner === 'A' && vs.unitTypes[u.type]?.name === '坦克'),
    '试验队能带出高两代的兵（坦克）',
  );

  const h = startRun(82, 'champion');
  check(h.gold === 220, '英雄队开局 220 金（一个人要花钱添人）', String(h.gold));
  check(h.army.length === 1 && h.army[0]?.count === 1, '英雄开局只有一个人', JSON.stringify(h.army));
  const hs = buildBattle(battleFor(h, { kind: 'battle', title: 't', sub: '' }, 7));
  check(
    hs.units.filter((u) => u.owner === 'A').length === 1 &&
      hs.units.some((u) => u.owner === 'A' && hs.unitTypes[u.type]?.hero === true),
    '英雄队能带出英雄（且兵种包已开）',
  );

  /*
   * 成长：同一个兵，层数越高越强，到它自己的时代是 1（完全体）。
   * 用 battleFor 的三个层去量，不看公式看结果。
   */
  const heroAt = (layer: LayerId) => {
    const r = startRun(83, 'champion');
    r.layer = layer;
    const st = buildBattle(battleFor(r, { kind: 'battle', title: 't', sub: '' }, 9));
    const u = st.units.find((x) => x.owner === 'A');
    return u ? utype(st, u.type) : null;
  };
  const h1 = heroAt(1);
  const h2 = heroAt(2);
  const h3 = heroAt(3);
  check(!!h1 && !!h2 && h1.atk < h2.atk && h1.maxHp < h2.maxHp, '英雄第 1 层是半成品', `${h1?.atk}/${h2?.atk}`);
  check(!!h2 && !!h3 && h2.atk === h3.atk && h2.maxHp === h3.maxHp, '英雄在第 2 层（e4 的时代）就长满了', `${h2?.atk}/${h3?.atk}`);
  check(!!h2 && h2.atk === 36 && h2.maxHp === 170, '完全体就是它自己的数值（36/170）', `${h2?.atk}/${h2?.maxHp}`);

  const tankAt = (layer: LayerId) => {
    const r = startRun(84, 'vanguard');
    r.layer = layer;
    const st = buildBattle(battleFor(r, { kind: 'battle', title: 't', sub: '' }, 9));
    const u = st.units.find((x) => x.owner === 'A' && st.unitTypes[x.type]?.name === '坦克');
    return u ? utype(st, u.type) : null;
  };
  const t1 = tankAt(1);
  const t3 = tankAt(3);
  check(!!t1 && !!t3 && t1.atk < t3.atk && t3.atk === 56, '坦克第 1 层是半成品、第 3 层是 56 攻', `${t1?.atk}/${t3?.atk}`);
  check((t1?.armor ?? 0) < (t3?.armor ?? 0), '护甲也一起长（减法公式里它最要紧）', `${t1?.armor}/${t3?.armor}`);

  // 进层时要在行记里说一声"它长大了"
  const gr = startRun(85, 'champion');
  gr.layer = 1;
  nextLayer(gr, 7);
  check(gr.log.some((l) => l.includes('完全体')), '进第 2 层时提示英雄长成完全体', gr.log.slice(-3).join(' / '));
}

console.log('\n[17] 史线：军备靠事件、奇想/修真靠试炼，什么都不做就是正史');
{
  /* ---- 一层房间图：试炼 + 史线事件都排在最前面 ---- */
  const r = startRun(91, 'frontier');
  const trialRoom = r.plan.steps[1]?.[0];
  check(trialRoom?.kind === 'trial', '第 2 步左门是一场史线试炼', trialRoom?.kind ?? '');
  check(!!trialRoom?.trial, '试炼带着目标世界与写死的敌人');
  check(
    trialRoom?.trial?.world === 'fantasy' || trialRoom?.trial?.world === 'cultivation',
    '试炼来自奇想或修真',
    trialRoom?.trial?.world ?? '',
  );
  const firstEvent = r.plan.steps.flat().find((n) => n.kind === 'event');
  check(eventById(firstEvent?.eventId ?? '').story === 'arms', '第一个事件房是军备史线事件', firstEvent?.eventId ?? '');
  check(r.worldLock === null && r.worldBan.length === 0, '开局没有锁任何史线');

  /* ---- 军备事件：四个选项各走一遍 ---- */
  const story = eventById('story-arms');
  const pay = story.choices[0];
  const cheer = story.choices[1];
  const idle = story.choices[2];
  const reject = story.choices[3];
  check(!!pay && !!cheer && !!idle && !!reject, '军备事件有四个选项');

  // 支持：−300 金 + 一个兵 + 锁军备（钟满 → 一定高代）
  const payRun = startRun(92, 'frontier');
  payRun.clock = STEPS_PER_LAYER;
  const payGold = payRun.gold;
  const payBefore = new Set(payRun.army.map((a) => a.type));
  const payNotes = applyEffect(payRun, pay!.effect, makeRng(3), { scaleGold: true });
  const added = payRun.army.find((a) => !payBefore.has(a.type));
  check(payRun.gold === Math.max(0, payGold - 300), '「支持」扣 300 金（不够就夹到 0）', String(payRun.gold));
  check(!!added && WORLDS.arms.theme.poolHigh.includes(added.type), '钟满时「支持」给的是 e4 兵', added?.type ?? '无');
  check(payRun.worldLock === 'arms', '「支持」把第二层锁定到军备');
  check(payNotes.some((n) => n.includes('时代军备')), '结算文案写明路已定', payNotes.join('，'));

  // 钟 0：给低代
  const earlyRun = startRun(93, 'frontier');
  const earlyBefore = new Set(earlyRun.army.map((a) => a.type));
  applyEffect(earlyRun, pay!.effect, makeRng(4), { scaleGold: true });
  const earlyAdded = earlyRun.army.find((a) => !earlyBefore.has(a.type));
  check(
    !!earlyAdded && WORLDS.arms.theme.pool.includes(earlyAdded.type),
    '钟 0 时「支持」给的是 e3 兵',
    earlyAdded?.type ?? '无',
  );

  // 表态：白拿锁定（不给兵、不动钱）
  const cheerRun = startRun(94, 'frontier');
  const cheerGold = cheerRun.gold;
  const cheerArmy = armyCount(cheerRun.army);
  applyEffect(cheerRun, cheer!.effect, makeRng(1), { scaleGold: true });
  check(
    cheerRun.worldLock === 'arms' && cheerRun.gold === cheerGold && armyCount(cheerRun.army) === cheerArmy,
    '「这是好事啊」白拿锁定，不扣钱不给兵',
  );

  // 观望：什么都不发生
  const idleRun = startRun(95, 'frontier');
  const idleNotes = applyEffect(idleRun, idle!.effect, makeRng(1), { scaleGold: true });
  check(
    idleRun.worldLock === null && idleRun.worldBan.length === 0 && idleNotes.length === 0,
    '「观望」什么都不发生',
  );

  // 排斥：ban 军备
  const rejectRun = startRun(96, 'frontier');
  const rejectNotes = applyEffect(rejectRun, reject!.effect, makeRng(1), { scaleGold: true });
  check(rejectRun.worldBan.includes('arms'), '「武器不是好东西」把军备划掉');
  check(rejectNotes.some((n) => n.includes('不再进入')), '结算文案写明军备被排斥', rejectNotes.join('，'));

  // 锁优先于 ban
  const firm = startRun(97, 'frontier');
  applyEffect(firm, cheer!.effect, makeRng(1), { scaleGold: true });
  applyEffect(firm, reject!.effect, makeRng(1), { scaleGold: true });
  check(firm.worldLock === 'arms' && !firm.worldBan.includes('arms'), '已经锁定的路不能被一句 ban 改掉');

  /* ---- 一层末：lock → 那支史；没锁 → 正史 ---- */
  const toArms = startRun(98, 'frontier');
  applyEffect(toArms, cheer!.effect, makeRng(1), { scaleGold: true });
  check(
    resolveWorld(toArms) === 'arms' && WORLDS[toArms.world].theme.name.includes('军械库'),
    '第一层末按 lock 进入军械库',
    WORLDS[toArms.world].theme.name,
  );

  const toBase = startRun(99, 'frontier');
  check(resolveWorld(toBase) === 'base', '什么都没做 → 正史');

  const onlyBan = startRun(100, 'frontier');
  applyEffect(onlyBan, reject!.effect, makeRng(1), { scaleGold: true });
  check(resolveWorld(onlyBan) === 'base', '只 ban 过、没锁 → 仍是正史');

  /* ---- 试炼战斗：写死的少量 e3、无城、不补员 ---- */
  const tr = startRun(101, 'frontier');
  const trRoom = tr.plan.steps[1]?.[0];
  const init = battleFor(tr, trRoom!, 11);
  const want = trRoom?.trial?.enemy ?? [];
  check(init.kind === 'trial', '战斗类型是 trial');
  check(init.enemyTypes.length === want.length, '试炼敌人数量写死（不按预算）', `${init.enemyTypes.length}/${want.length}`);
  check(init.enemyTypes.every((t) => want.includes(t)), '试炼敌人就是写死的那几个', init.enemyTypes.join('、'));
  check(init.era === 3, '试炼敌人固定 e3', String(init.era));
  check(init.enemyCityCount === 0 && init.enemyRecruit === 0, '试炼无城、不补员');
  check(
    WORLDS[trRoom!.trial!.world].theme.expansions.every((e) => init.expansions.includes(e)),
    '试炼当场开了目标世界的包',
    init.expansions.join('、'),
  );
  check(init.size === 10, '试炼用固定小图（10×10）', String(init.size));

  // 路定了以后，试炼退回普通战斗
  const afterLock = startRun(102, 'frontier');
  applyEffect(afterLock, cheer!.effect, makeRng(1), { scaleGold: true });
  check(!trialActive(afterLock, trRoom!), '路已定后试炼失效');
  check(
    battleFor(afterLock, { ...trRoom!, kind: 'battle' as const }, 11).kind === 'battle',
    '失效的试炼按普通战斗打',
  );

  // 被 ban 的史线也失效
  const banned = startRun(103, 'frontier');
  applyEffect(banned, { world: { ban: trRoom!.trial!.world } }, makeRng(1), { scaleGold: true });
  check(!trialActive(banned, trRoom!), '被 ban 的史线试炼失效');
}

console.log(
  failures === 0 ? '\n全部通过。' : `\n有 ${failures} 项没通过。`,
);
if (failures > 0) process.exitCode = 1;
