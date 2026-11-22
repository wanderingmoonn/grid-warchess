import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, recruitSpawnCells } from '../src/core/rules.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import { DEFAULT_BUDGET } from '../src/core/ai.ts';
import { aiNextAction } from '../src/core/ai-v3.ts';

let s = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 2, mapSymmetry: 'fair' }, 31);
const me = 'A';
const city = s.cities.find((c) => c.owner === me)!;
const probe = Object.values(s.unitTypes)
  .filter((d) => d.category === 'combat' && d.domain !== 'water')
  .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0]!;
const countOf = (st: typeof s): number => recruitSpawnCells(st, city.id, undefined, probe.id).length;
console.log('城', city.id, city.x, city.y, '产兵格', countOf(s));

// 先清掉我方原有单位，再把**产兵格**全部塞满农民（构造堵塞）
s = structuredClone(s);
s.units = s.units.filter((u) => u.owner !== me);
let n = 0;
const cells0 = recruitSpawnCells(s, city.id, undefined, probe.id);
console.log('产兵格坐标', cells0.map((c) => c.x + ',' + c.y).join(' '));
// 产兵格 + 它们的 8 邻格都塞满（构造"链"：让位目标也会被占）
const fill = new Set<string>();
for (const c of cells0) {
  fill.add(c.x + ',' + c.y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) fill.add(c.x + dx + ',' + c.y + dy);
}
for (const key of fill) {
  const [x, y] = key.split(',').map(Number) as [number, number];
  const t = s.tiles[y * s.w + x];
  if (!t || t.terrain === 'water' || t.terrain === 'deep') continue;
  if (s.units.some((u) => u.x === x && u.y === y)) continue;
  const placed = placeUnit(s, me, 'farmer', x, y);
  if (placed.ok) {
    s = placed.state;
    n += 1;
  } else {
    console.log('放不了', x, y, placed.reason);
  }
}
console.log('塞入农民', n, '产兵格', countOf(s));

// 钱清零：排掉"另一座城一直在造兵"的干扰，只看让位
s = structuredClone(s);
s.players[me].gold = 0;
const dists = s.units.filter((u) => u.owner === me).map((u) => `${u.x},${u.y} d${Math.abs(u.x - city.x) + Math.abs(u.y - city.y)}`);
console.log('农民位置', dists.join(' '), 'choked 含 c1:', (s as any).aiFocus ? '?' : '?');

// 跑 6 步，看农民有没有让开
const budget = { ...DEFAULT_BUDGET };
const rejected = new Set<string>();
for (let i = 0; i < 6; i++) {
  const a = aiNextAction(s, budget, rejected);
  if (!a) { console.log('无动作'); break; }
  const r = applyAction(s, a);
  if (!r.ok) { console.log('非法', a.type, r.reason); break; }
  s = r.state;
  const uid = 'unitId' in a ? String((a as { unitId?: string }).unitId ?? '') : '';
  const to = 'x' in a ? `→ ${(a as { x: number }).x},${(a as { y: number }).y}` : '';
  console.log('步', i + 1, a.type, uid, to);
}
console.log('产兵格（让位后）', countOf(s));

// 第二轮：把刚才腾出来的空地再占上，验证"链"（目标格被占 → 继续往里让）
console.log('—— 第二轮：再塞一层 ——');
let m = 0;
for (const u of s.units.filter((x) => x.owner === me)) {
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as Array<[number, number]>) {
    const nx = u.x + dx;
    const ny = u.y + dy;
    const t = s.tiles[ny * s.w + nx];
    if (!t || t.terrain === 'water' || t.terrain === 'deep' || t.terrain === 'city') continue;
    if (s.units.some((z) => z.x === nx && z.y === ny)) continue;
    const placed = placeUnit(s, me, 'farmer', nx, ny);
    if (placed.ok) { s = placed.state; m += 1; }
  }
}
console.log('再塞', m, '产兵格', countOf(s));
const rejected2 = new Set<string>();
for (let i = 0; i < 10; i++) {
  const a = aiNextAction(s, budget, rejected2);
  if (!a) { console.log('无动作'); break; }
  const r = applyAction(s, a);
  if (!r.ok) { console.log('非法', a.type, r.reason); break; }
  s = r.state;
  const uid = 'unitId' in a ? String((a as { unitId?: string }).unitId ?? '') : '';
  console.log('链步', i + 1, a.type, uid, 'x' in a ? `→ ${(a as { x: number }).x},${(a as { y: number }).y}` : '');
}
console.log('产兵格（链后）', countOf(s));
