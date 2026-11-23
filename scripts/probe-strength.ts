/**
 * 战力估值探针（S4）。
 *
 * 只验机制，不跑对局：
 *   1. 单位战力按血量打折；
 *   2. 部队战力求和、建筑与工人不算；
 *   3. 战力比在构造局面下等于预期；
 *   4. 攻城输出只算够得着的，破城回合数 Infinity / 有限 两种都对；
 *   5. 同兵种翻倍，战力翻倍（线性）；
 *   6. 精锐（高代兵）比同数量低级兵强 —— 这是"数人头"和"算战力"的区别。
 *
 * 用法：`npm run probe:strength`
 */
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import { distToCity } from '../src/core/rules.ts';
import type { City, GameState, PlayerId, Unit } from '../src/core/types.ts';
import {
  armyStrength,
  powerPerTurn,
  productionCapacity,
  productionSites,
  projectedStrength,
  offenseScore,
  siegeOutput,
  strengthRatio,
  turnsToRaze,
  unitStrength,
} from '../src/core/ai-strength.ts';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};

/** 造一个空场：清掉所有单位，只留两座城，方便手工摆兵 */
function emptyArena(seed = 11): GameState {
  let s = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 3, aiLevel: 'tactic' }, seed);
  s = { ...s, units: [] };
  return s;
}

/**
 * 在空地上摆一个兵：从左下往右上找第一块"能站且没人"的地。
 *
 * 不写死坐标——12×12 的图上 (8,8) 可能是水，写死会让用例随地图生成红掉。
 * 这批用例只关心"战力怎么算"，不关心摆在哪。
 */
function spawn(s: GameState, owner: PlayerId, type: string): GameState {
  for (let y = s.h - 1; y >= 0; y--) {
    for (let x = 0; x < s.w; x++) {
      if (s.units.some((u) => u.x === x && u.y === y)) continue;
      if (s.cities.some((c) => x >= c.x && x < c.x + 2 && y >= c.y && y < c.y + 2)) continue;
      const r = placeUnit(s, owner, type, x, y);
      if (r.ok) return r.state;
    }
  }
  throw new Error(`没有空地摆 ${type}`);
}

console.log('1 单位战力：残血按比例打折');
{
  const s0 = emptyArena();
  const type = Object.values(s0.unitTypes).find((d) => d.category === 'combat' && d.cost <= 80)!.id;
  let s = spawn(s0, 'A', type);
  const full = unitsOf(s).find((u) => u.owner === 'A')!;
  const p1 = unitStrength(s, full);
  ok(p1 > 0, `一个 ${type} 的战力 > 0（${p1.toFixed(2)}）`);
  const hurt: Unit = { ...full, hp: Math.max(1, Math.floor(full.hp / 2)) };
  const p2 = unitStrength(s, hurt);
  ok(p2 < p1 && p2 > 0, '半血单位战力低于满血（仍 > 0）');
  const dead: Unit = { ...full, hp: 0 };
  ok(unitStrength(s, dead) === 0, '0 血战力为 0');
}

console.log('2 部队战力：工人/建筑不算，翻倍线性');
{
  let s = emptyArena();
  const combat = Object.values(s.unitTypes).find((d) => d.category === 'combat' && d.cost <= 80)!.id;
  const econ = Object.values(s.unitTypes).find((d) => d.category === 'economy')!.id;
  s = spawn(s, 'A', combat);
  const one = armyStrength(s, 'A');
  s = spawn(s, 'A', combat);
  const two = armyStrength(s, 'A');
  ok(Math.abs(two - one * 2) < 1e-6, `两个同兵种战力是一个的两倍（${one.toFixed(2)} → ${two.toFixed(2)}）`);
  const before = armyStrength(s, 'A');
  s = spawn(s, 'A', econ);
  ok(Math.abs(armyStrength(s, 'A') - before) < 1e-9, '经济单位不计入部队战力');
}

console.log('3 战力比：构造 2 打 1');
{
  let s = emptyArena();
  const combat = Object.values(s.unitTypes).find((d) => d.category === 'combat' && d.cost <= 80)!.id;
  s = spawn(s, 'A', combat);
  s = spawn(s, 'A', combat);
  s = spawn(s, 'B', combat);
  const r = strengthRatio(s, 'A');
  ok(Math.abs(r - 2) < 1e-6, `2 打 1 的比值是 2（实际 ${r.toFixed(3)}）`);
  ok(Math.abs(strengthRatio(s, 'B') - 0.5) < 1e-6, '反过来是 0.5');
}

console.log('4 "高代兵比低级兵强"：数人头看不出来，战力能');
{
  let s = emptyArena();
  // 找两个同代不同级的兵，尽量拉开价值
  const combat = Object.values(s.unitTypes)
    .filter((d) => d.category === 'combat' && d.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  const strong = combat[0]!;
  const weak = combat[combat.length - 1]!;
  s = spawn(s, 'A', strong.id);
  s = spawn(s, 'B', weak.id);
  const ps = unitStrength(s, unitsOf(s).find((u) => u.owner === 'A')!);
  const pw = unitStrength(s, unitsOf(s).find((u) => u.owner === 'B')!);
  ok(ps > pw, `贵的兵战力更高（${strong.id} ${ps.toFixed(1)} > ${weak.id} ${pw.toFixed(1)}）`);
}

/** 贴着某座城摆兵（城四周的空地） */
function spawnNextToCity(s: GameState, type: string, city: City): GameState {
  // 要的是**贴着城**那一格，不是"第一块能摆的地"
  let best: GameState | null = null;
  let bestD = Infinity;
  for (let dy = -3; dy <= 4; dy++) {
    for (let dx = -3; dx <= 4; dx++) {
      const r = placeUnit(s, 'A', type, city.x + dx, city.y + dy);
      if (!r.ok) continue;
      const u = r.state.units.find((x) => x.owner === 'A')!;
      const d = distToCity(u, city);
      if (d < bestD) {
        bestD = d;
        best = r.state;
      }
    }
  }
  if (!best) throw new Error('城边没有空地');
  return best;
}

console.log('5 攻城输出：够得着才算');
{
  let s = emptyArena();
  const combat = Object.values(s.unitTypes).find(
    (d) => d.category === 'combat' && d.cost <= 80 && (d.range ?? 1) >= 1,
  )!.id;
  const city = s.cities.find((c) => c.owner === 'B')!;
  // 贴到城边
  s = spawnNextToCity(s, combat, city);
  const near = siegeOutput(s, 'A', city);
  ok(near > 0, `贴城的单位有输出（${near}）`);
  const turns = turnsToRaze(s, 'A', city);
  ok(Number.isFinite(turns) && turns >= 1, `破城回合数有限（${turns}）`);
  // 挪到地图另一头
  // 挪到离城最远的那一格（不写死坐标：城可能就开在角落上）
  let farSpot = { x: 1, y: 1 };
  let farD = -1;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const d = distToCity({ x, y }, city);
      if (d > farD) {
        farD = d;
        farSpot = { x, y };
      }
    }
  }
  const far = { ...s, units: s.units.map((u) => (u.owner === 'A' ? { ...u, x: farSpot.x, y: farSpot.y } : u)) };
  ok(siegeOutput(far, 'A', city) === 0, '离得远就没有输出');
  ok(turnsToRaze(far, 'A', city) === Number.POSITIVE_INFINITY, '没输出时破城回合数是 Infinity');
  ok(offenseScore(far, 'A', city) === 0, '砸不动时 offenseScore 归零');
}

console.log('6 空场：没有单位时战力为 0、比值不炸');
{
  const s = emptyArena();
  ok(armyStrength(s, 'A') === 0, '没有单位时部队战力为 0');
  ok(projectedStrength(s, 'A', 0) === armyStrength(s, 'A'), '投影 0 回合 = 当前战力');
  ok(Number.isFinite(strengthRatio(s, 'A')), '分母为 0 时比值仍是有限数');
}

console.log('7 产能：格子数、每回合产出、投影');
{
  const s = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 3, aiLevel: 'tactic' }, 11);
  const sites = productionSites(s, 'A');
  ok(sites.length >= 1, `有 ${sites.length} 个产兵点（城算一个）`);
  const cap = productionCapacity(s, 'A');
  ok(cap > 0, `每回合可出兵格子数 > 0（${cap}）`);
  ok(powerPerTurn(s, 'A') >= 0, `每回合产能 ${powerPerTurn(s, 'A').toFixed(1)} 战力`);
  const p0 = projectedStrength(s, 'A', 0);
  const p10 = projectedStrength(s, 'A', 10);
  ok(p10 > p0, '投影 10 回合比 0 回合强（产能计入）');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);

function unitsOf(s: GameState): Unit[] {
  return s.units;
}
