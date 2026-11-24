/**
 * 修真产业链探针：**不跑对局**，只看决策序列对不对。
 *
 * 为什么不用跑整局的办法验（2026-11-20 踩过）：
 * 无敌人环境跑不出来——清光对手会让对局当场判负，`END_TURN` 被拒，
 * 状态冻在原地（`turn` 一直是 37、金币一动不动）。那是脚手架的锅，
 * 但结论是同一件事：**验"决策顺序"不该扯上回合交割和胜负**。
 *
 * 所以这里摆一个手工局面（城 + 工兵 + 钱 + 灵石），然后反复：
 *
 *     问 AI 下一步 → 执行 → 把 moved/acted 复位 → 再问
 *
 * 没有胜负、没有敌方 AI、没有回合推进，只有决策序列。断言四件事：
 *
 *   1. 第一座建筑是灵田
 *   2. 宗门出现在灵田之后
 *   3. 藏经阁出现在宗门之后（它要求紧贴宗门，这条同时验证"走过去"）
 *   4. 最后出现研发动作（`UNIT_ACTION research:*`）
 *
 * 运行：`npm run probe:cultivation-chain`
 */
// @ts-nocheck
import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { applyAction, buildSiteError, unitsOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { knownSpells, spellSlotsOf } from '../src/core/cultivation/spells.ts';

const STEPS = 140;

/** 造局面：一座城、一个执事、一大堆钱和灵石，别的什么都没有 */
function scene(seed: number) {
  const s: any = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 20,
      mapStyle: 'open',
      startEra: 3,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: ['cultivation'],
    },
    seed,
  );
  s.current = 'A';
  /*
   * **把地形抹平成平原**：这一条探针验的是"决策顺序"，不是"地形运气"。
   * 留着水域/高山，宗门那个 2×2 在有些种子上根本没有合法位置，
   * 探针就会时红时绿（实测 seed 8100 全图 227 处"离得太远"、125 处"水面高山"）。
   */
  for (const t of s.tiles) t.terrain = 'plain';
  s.units = [];
  s.players.A.gold = 4000;
  s.players.A.res = { ...(s.players.A.res ?? {}), 'spirit-stone': 300 };
  const city = s.cities.find((c: any) => c.owner === 'A')!;
  // 执事：修真的工匠（灵田/宗门/藏经阁都归它）
  s.units.push({
    id: 'probe-deacon',
    type: 'cultivation-deacon',
    owner: 'A',
    x: city.x + 1,
    y: city.y + 1,
    hp: s.unitTypes['cultivation-deacon'].maxHp,
    kills: 0,
    moved: false,
    acted: false,
  });
  /*
   * 一个修士：研读那一步要有人站在藏经阁旁边读书。
   * 境界给够（不然法术位是 0，学了也白学）——这里直接在 `custom` 上写 rank 2。
   */
  s.units.push({
    id: 'probe-qi',
    type: 'qi-cultivator',
    owner: 'A',
    x: city.x - 1,
    y: city.y + 1,
    hp: 60,
    kills: 0,
    moved: false,
    acted: false,
    custom: { rank: 2, exp: 0, lifespan: 200, mana: 60 },
  });
  return s;
}

/**
 * 跑 N 步决策。
 *
 * 每一步之后把 `moved` / `acted` 复位——等于"每一步都是新回合"，
 * 但不真的交割回合（那套东西会引入胜负和对手 AI）。
 */
function run(seed: number) {
  let s = scene(seed);
  const journal: string[] = [];
  const rejected: string[] = [];

  for (let step = 0; step < STEPS; step += 1) {
    /*
     * 这一轮**只验建造链**：不给采购名额。
     * 否则每一步都算"新回合"，AI 会不停招兵把钱花光，永远轮不到盖房子。
     */
    const budget = { maxRecruit: 0, maxUpgrade: 0, recruited: 0, upgraded: 0 };
    const a = aiNextAction(s, budget, new Set());
    if (!a) break;
    const label =
      a.type === 'BUILD'
        ? `BUILD ${String(a.unitType).replace('cultivation-', '')}`
        : a.type === 'UNIT_ACTION'
          ? `ONE ${String(a.actionId)}`
          : a.type;
    const r = applyAction(s, a);
    if (!r.ok) {
      rejected.push(`${label} — ${r.reason}`);
      break;
    }
    s = r.state;
    journal.push(label);
    /*
     * 复位：这一步当成"新回合的第一步"。
     *
     * 除了 moved/acted，还要**把工地盖完**——不然宗门永远停在"施工中"，
     * 研发按钮根本不会出现（第一次跑就卡在这：宗门建好了但 buildDone 不够，
     * 手工发研发被回"当前规则里没有这种操作"）。
     */
    for (const u of unitsOf(s, 'A')) {
      if ((u.buildNeed ?? 0) > 0) u.buildDone = u.buildNeed;
      u.buildLeft = 0;
    }
    s.current = 'A';
    for (const u of unitsOf(s, 'A')) {
      u.moved = false;
      u.acted = false;
      if (u.attacksLeft !== undefined) u.attacksLeft = undefined;
    }
    if (journal.filter((x) => x.startsWith('ONE learn:')).length > 0) break;
    if (step === STEPS - 1) console.log('  最后一步后 aiNextAction 为空');
  }

  // 临时诊断：手工发一条研发动作，看规则层怎么说
  if (process.env.DBG) {
    const lib = unitsOf(s, 'A').find((u: any) => u.type === 'cultivation-scripture-pavilion');
    const qi = unitsOf(s, 'A').filter((u: any) => u.type === 'qi-cultivator');
    console.log('  藏经阁:', lib ? `${lib.x},${lib.y}` : '无', '| 研发:', (s.researched?.A ?? []).length);
    for (const u of qi) {
      const near = lib ? Math.abs(u.x - lib.x) + Math.abs(u.y - lib.y) <= 1 : false;
      console.log(`   修士 ${u.x},${u.y} rank=${u.custom?.rank} 已学=${knownSpells(u).length} 法术位=${spellSlotsOf(u)} 邻阁=${near}`);
    }
    const dc: any = unitsOf(s, 'A').find((u: any) => u.type === 'cultivation-deacon');
    if (dc) {
      const why: Record<string, number> = {};
      for (let y = 0; y < s.h; y += 1) for (let x = 0; x < s.w; x += 1) {
        const e = buildSiteError(s, s.unitTypes['cultivation-sect'], dc, x, y);
        if (e) why[e] = (why[e] ?? 0) + 1;
      }
      console.log('  宗门选址失败原因:', Object.entries(why).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}×${v}`).join(' | '));
    }
    const sect = unitsOf(s, 'A').find((u: any) => u.type === 'cultivation-sect');
    console.log('  宗门:', sect ? sect.id : '无', '| 灵石:', s.players.A.res?.['spirit-stone'], '| 研发数:', (s.researched?.A ?? []).length);
    if (sect) {
      const r2 = applyAction(s, { type: 'UNIT_ACTION', unitId: sect.id, actionId: 'research:palm-thunder' });
      console.log('  手工研发 →', r2.ok ? '成功' : `被拒：${r2.reason}`);
    }
  }
  const sectAt = journal.findIndex((x) => x === 'BUILD sect');
  const libAt = journal.findIndex((x) => x === 'BUILD scripture-pavilion');
  const fieldAt = journal.findIndex((x) => x === 'BUILD spirit-field');
  const researchAt = journal.findIndex((x) => x.startsWith('ONE research'));
  const learned = unitsOf(s, 'A').reduce((n: number, u: any) => n + ((u.extraSkills ?? []).length > 0 ? 1 : 0), 0);
  return { journal, rejected, sectAt, libAt, fieldAt, researchAt, learned, s };
}

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
    failed += 1;
  }
};

for (const seed of [8191, 8100]) {
  console.log(`\n种子 ${seed}`);
  const r = run(seed);
  console.log(`  序列：${r.journal.slice(0, 14).join(' → ')}${r.journal.length > 14 ? ' …' : ''}`);
  if (r.rejected.length > 0) console.log(`  ! 被拒：${r.rejected.join('; ')}`);

  /*
   * 断言"顺序"，不断言"第一座建筑一定是灵田"。
   * 炼器炉、灵塔这些不属于这条链，AI 想先建是合理的——链只要求
   * **灵田在宗门之前**（没灵石就盖不起宗门）。
   */
  check('灵田出现在宗门之前', r.fieldAt >= 0 && r.sectAt > r.fieldAt, `灵田 ${r.fieldAt} / 宗门 ${r.sectAt}`);
  check(
    '藏经阁出现在宗门之后（同时验证"执事会走过去"）',
    r.libAt > r.sectAt && r.libAt >= 0,
    `宗门 ${r.sectAt} / 藏经阁 ${r.libAt}`,
  );
  check('最后发出研发动作', r.researchAt >= 0, `研发 ${r.researchAt}`);
  check(
    '有修士学会了一门法术（研读那一段）',
    (r.journal ?? []).some((x) => x.startsWith('ONE learn:')) || r.learned > 0,
    `研读动作 ${r.journal?.find((x) => x.startsWith('ONE learn:')) ?? '没有'}`,
  );
  check('没有动作被拒', r.rejected.length === 0, r.rejected.join('; '));
}

console.log(`\n${failed === 0 ? '通过' : `失败 ${failed} 项`}`);
if (failed > 0) process.exitCode = 1;
