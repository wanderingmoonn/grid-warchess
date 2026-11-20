/**
 * 「产业链目标」改造的对照尺子。
 *
 * 抽公共机制这种改动，最容易出的问题是"机制抽出来了，行为也悄悄变了"——
 * 而行为变化不会报错，只会让 AI 变得不一样，几周后才有人发现某个兵种再也不造了。
 *
 * 所以这里不给"好不好"打分，只做**指纹**：同一个种子跑同一局，把每个动作按
 * `类型:关键字段` 拼成一串，取哈希。改造前后各跑一次，哈希相同＝这一步没动行为。
 *
 * 用法：
 *   npm run probe:ai-goal            # 跑默认的 4 个种子
 *   npm run probe:ai-goal -- --save before   # 存一份，改造后再比
 */
// @ts-nocheck
import { createHash } from 'node:crypto';
import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';

/**
 * 用纵河图 + 海军包：水域够多（实测 20%），船坞那条分支才会真的被走到。
 * 不上海军包的话整张图没有一个水上产兵点，这条分支是死代码，验什么都等于没验。
 */
const STYLE = 'river-v';
const EXPANSIONS = ['naval'];
const SEEDS = [11, 22, 33, 44];
const TURNS = 90;

const argv = process.argv.slice(2);
const saveAt = argv.indexOf('--save') >= 0 ? argv[argv.indexOf('--save') + 1] : null;
const lines: string[] = [];

function run(seed: number) {
  let s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, mapStyle: STYLE, expansionIds: EXPANSIONS, aiOpponent: true, aiAlly: true },
    seed,
  );
  const budget = { maxRecruit: 3, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  const acts: string[] = [];
  const built = new Map<string, number>();
  const recruited = new Map<string, number>();

  for (let turn = 1; turn <= TURNS; turn += 1) {
    budget.recruited = 0;
    budget.upgraded = 0;
    for (let step = 0; step < AI_MAX_STEPS; step += 1) {
      const a = aiNextAction(s, budget);
      if (!a) break;
      /*
       * 指纹只取"这个决定是什么"，不取坐标以外的细节：
       *   · 建造要记坐标——选址是第一位的观测量，"同样建了一座桥"不代表一样；
       *   · 走位不记坐标（几千步，噪声太大），只记"谁在走"。
       */
      const key = [a.type, a.unitId ?? '', a.unitType ?? '', a.cityId ?? ''].join(':');
      const withPos =
        a.type === 'BUILD' ? `${key}@${a.x},${a.y}` : key;
      acts.push(withPos);
      if (a.type === 'BUILD') built.set(a.unitType, (built.get(a.unitType) ?? 0) + 1);
      if (a.type === 'RECRUIT') {
        recruited.set(a.unitType, (recruited.get(a.unitType) ?? 0) + 1);
        budget.recruited += 1;
      }
      if (a.type === 'UPGRADE') budget.upgraded += 1;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }
    if (s.winner) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
  }

  const hash = createHash('sha1').update(acts.join('|')).digest('hex').slice(0, 12);
  const fmt = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}×${v}`)
      .join(',') || '-';
  return {
    seed,
    hash,
    steps: acts.length,
    built: fmt(built),
    recruited: fmt(recruited),
    winner: s.winner ?? '-',
    turn: s.turn,
  };
}

/**
 * 手工摆一个"该建船坞"的局面。
 *
 * 为什么需要它：端到端那四局里 AI 一次船坞都没建过（工兵一直在架桥），
 * 所以光看指纹只能证明"没误伤别的分支"。这里把条件摆齐（工兵贴着水、
 * 有城、有钱、只有自己一座城），让船坞这条分支**至少跑一遍**——
 * 改造前后这个局面下的首选动作必须一样。
 */
function craftNavyCase() {
  const s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, mapStyle: STYLE, expansionIds: EXPANSIONS, aiOpponent: false, aiAlly: false, startEra: 3 },
    7,
  );
  s.current = 'A';
  // 清场：一个别的兵都不留，免得"升时代""招兵"抢在船坞前面被选中
  s.units = [];
  // 只留自己一座城：对面没城就没有"要过河"的判断，`scoreBuild` 里那刀 −45 不落下来
  s.cities = s.cities.filter((c) => c.owner === 'A');
  // 钱只够一座船坞：让"再招一个兵"这条候选根本不存在
  s.players.A.gold = 120;
  const builderDef = Object.values(s.unitTypes).find(
    (d) => (d.builds ?? []).includes('bridge') && !d.building,
  );
  if (!builderDef) return '没有能架桥的工兵';
  // 找一格水，以及它旁边的陆地
  let spot: { x: number; y: number } | null = null;
  for (let y = 0; y < s.h && !spot; y += 1) {
    for (let x = 0; x < s.w; x += 1) {
      const t = s.tiles[y * s.w + x];
      if (t.terrain !== 'water' && t.terrain !== 'shallow') continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const nt = s.tiles[ny * s.w + nx];
        if (nt.terrain === 'water' || nt.terrain === 'shallow') continue;
        if (nt.cityId) continue;
        spot = { x: nx, y: ny };
        break;
      }
    }
  }
  if (!spot) return '这张图没有"水边陆地"';
  s.units = s.units.filter((u) => u.x !== spot.x || u.y !== spot.y);
  s.units.push({
    id: 'probe-builder',
    type: builderDef.id,
    owner: 'A',
    x: spot.x,
    y: spot.y,
    hp: builderDef.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  });
  const a = aiNextAction(s);
  return a ? `${a.type} ${a.unitType ?? ''}`.trim() : '(无动作)';
}
const crafted = craftNavyCase();

for (const seed of SEEDS) {
  const r = run(seed);
  const line =
    `种子 ${String(r.seed).padStart(3)} · ${String(r.steps).padStart(4)} 步 · ` +
    `指纹 ${r.hash} · 建造 ${r.built} · 招兵 ${r.recruited} · 终局 ${r.winner}/${r.turn}`;
  lines.push(line);
  console.log(line);
}

console.log(`\n手工局面（船坞这条分支必须跑一遍）首选动作：${crafted}`);

if (saveAt) {
  const fs = await import('node:fs');
  fs.writeFileSync(saveAt, lines.join('\n') + '\n');
  console.log(`\n已存到 ${saveAt}`);
}
