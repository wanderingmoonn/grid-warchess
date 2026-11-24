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
  bossFor,
  bossRewards,
  finishBattle,
  nextLayer,
  planLayer,
  restOptions,
  rewardOptions,
  shopStock,
  specialRewards,
  startRun,
  themeFor,
  themeOf,
  STEPS_PER_LAYER,
} from '../src/roguelike/run.ts';
import { DECISIONS, EVENTS, pickEnemyTypes, WORLDS } from '../src/roguelike/data.ts';
import { isEliminated, utype } from '../src/core/rules.ts';
import { buildBattle, outcomeOf, resultOf, spawnWave, step, survivorsOf } from '../src/roguelike/battle.ts';
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
  const qi = s2.units.find((u) => u.type === 'qi-cultivator');
  if (qi) {
    const def = utype(s2, qi.type);
    check(def.atk > 10, '修真修士吃到境界加成（基础攻 10）', `atk=${def.atk}`);
    check(def.maxHp > 20, '修真修士的血也涨了（基础 20）', `hp=${def.maxHp}`);
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
  check(sp.cities.filter((c) => c.owner === 'A').length === 1, '守城战：玩家第一次有城');
  check(sp.cities.find((c) => c.owner === 'A')!.maxHp > 45, '守城战：城被加固过', `maxHp=${sp.cities.find((c) => c.owner === 'A')!.maxHp}`);
  check(
    sp.units.filter((u) => u.owner === 'A' && sp.unitTypes[u.type]?.category === 'building').length >= 1,
    '守城战：玩家有一座塔',
  );
  check(spInit.holdRounds > 0 && spInit.waves.length >= 2, '守城战：有回合目标与至少两波援军');
  check(spInit.holdRounds === 6 + run.layer, '守城轮数按层给（L1 七轮）', String(spInit.holdRounds));
  check(spInit.enemyDoctrine === 'rush', '守城战的敌人是来攻城的（rush）');

  // 波次真的能上场
  const before = sp.units.filter((u) => u.owner === 'B').length;
  const wave = spawnWave(sp, spInit.waves[0]!.types, 77);
  check(wave.length > 0 && sp.units.filter((u) => u.owner === 'B').length > before, '波次能把新兵摆到场上');
  check(wave.every((u) => u.y <= 3), '波次从地图上沿进场', wave.map((u) => `${u.x},${u.y}`).join(' '));

  /*
   * 守满 N 轮：把回合拨到"第 N 轮结束"，再让双方各走一次。
   * 判的是"已经打完的轮数"（floor(turn/2)），所以拨到 2N-1 起手正好。
   */
  sp.turn = spInit.holdRounds * 2 - 1;
  sp.current = 'A';
  const e1 = step(sp, { type: 'END_TURN' });
  const e2 = e1.ok ? step(e1.state, { type: 'END_TURN' }) : e1;
  check(
    e1.ok && e2.ok && outcomeOf(e2.state, spInit) === 'win',
    '守到 N 轮之后判玩家赢',
    `turn=${e2.state.turn} outcome=${outcomeOf(e2.state, spInit)}`,
  );

  // 城被砸平：哪怕人还在，也算没守住
  const razed = buildBattle(spInit);
  const ownCity = razed.cities.find((c) => c.owner === 'A');
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

console.log(
  failures === 0 ? '\n全部通过。' : `\n有 ${failures} 项没通过。`,
);
if (failures > 0) process.exitCode = 1;
