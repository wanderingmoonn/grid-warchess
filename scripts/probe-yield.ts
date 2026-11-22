import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, recruitSpawnCells } from '../src/core/rules.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import { DEFAULT_BUDGET } from '../src/core/ai.ts';
import { aiNextAction } from '../src/core/ai-v3.ts';

let s = createMatch({ ...DEFAULT_CONFIG, size: 12, startEra: 2, mapSymmetry: 'fair' }, 30);
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
for (const c of cells0) {
  const placed = placeUnit(s, me, 'farmer', c.x, c.y);
  if (placed.ok) {
    s = placed.state;
    n += 1;
  } else {
    console.log('放不了', c.x, c.y, placed.reason);
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
