/**
 * 回放的"局面体检"：桥、连通性、废墟接管、兵力/金钱。
 *
 * **只读**：重放一份回放，每 N 回合打一行，不改任何决策代码。
 * 专门回答三件事（2026-11-23 用户提的）：
 *   · 桥修了几座、有没有真的连起来（复刻 `canReachEnemyByLand` 的 BFS）；
 *   · 有没有"踩进废墟、付重建费"这种事，付了多少、当时附近有几个敌兵；
 *   · 兵和钱堆到什么程度（大图僵持的形状）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-replay.ts results/replays/x.json --every 40
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, distToCity, cityTiles } from '../src/core/rules.ts';
import { passable } from '../src/core/config.ts';

const file = process.argv[2]!;
const EVERY = Number((() => { const i = process.argv.indexOf('--every'); return i > 0 ? process.argv[i+1] : '40'; })());
const r = JSON.parse(readFileSync(file, 'utf8')) as any;
const cfg = r.config ?? {};
let s: any = createMatch({ ...DEFAULT_CONFIG, size: Number(cfg.size ?? 12), startEra: Number(cfg.startEra ?? 2),
  mapSymmetry: cfg.mapSymmetry ?? 'fair', citySize: cfg.citySize }, r.seed);

const ME = (r.aiSides?.new ?? 'A') as string;
const dirs = [[1,0],[-1,0],[0,1],[0,-1]] as const;

/** 复刻 canReachEnemyByLand 的 BFS：从自家城格出发，桥面可走，敌城格不可走 */
function reachInfo(): { minSteps: number | null; blockedByCap: boolean } {
  const foe = s.cities.filter((c: any) => c.owner !== ME);
  if (foe.length === 0) return { minSteps: 0, blockedByCap: false };
  const dist = new Map<number, number>();
  const q: number[] = [];
  for (const c of s.cities.filter((x: any) => x.owner === ME)) for (const t of cityTiles(c)) {
    const k = t.y*s.w+t.x; if (!dist.has(k)) { dist.set(k,0); q.push(k); }
  }
  let best: number | null = null;
  const limit = Math.min(s.w, s.h);
  for (let i=0;i<q.length;i++){
    const k=q[i]!, d=dist.get(k)!;
    const x=k%s.w, y=Math.floor(k/s.w);
    if (foe.some((c: any) => distToCity({x,y}, c) <= 1)) { best = Math.min(best ?? 1e9, d); continue; }
    if (d > limit) continue;
    for (const [dx,dy] of dirs){
      const nx=x+dx, ny=y+dy;
      if (nx<0||ny<0||nx>=s.w||ny>=s.h) continue;
      const j=ny*s.w+nx; if (dist.has(j)) continue;
      const t=s.tiles[j]; if (!t || !passable(t.terrain)) continue;
      if (t.cityId) { const c=s.cities.find((z:any)=>z.id===t.cityId); if (c && c.owner!==ME) continue; }
      dist.set(j,d+1); q.push(j);
    }
  }
  return { minSteps: best, blockedByCap: best !== null && best > Math.min(s.w,s.h) };
}

const bridgesOf = () => s.units.filter((u:any)=> String(u.type).startsWith('bridge'));
const combatOf = (p:string) => s.units.filter((u:any)=>u.owner===p && s.unitTypes[u.type]?.category==='combat');

let nextSnap = 1;
const ruinSteps: string[] = [];
let tookPays = 0, tookGold = 0;
const stepIn = (a:any, res:any) => {
  if (a.type !== 'MOVE') return;
  const t = s.tiles[a.y*s.w+a.x];
  if (!t?.cityId) return;
  const c = s.cities.find((z:any)=>z.id===t.cityId);
  if (!c?.ruined) return;
  const by = (a.by ?? s.current) as string;
  const after = res.state.cities.find((z:any)=>z.id===t.cityId);
  const took = !!after && after.ruined === false;
  const goldSpent = Math.round((s.players[by].gold ?? 0) - (after && took ? res.state.players[by].gold : s.players[by].gold));
  const survived = res.state.units.some((u:any)=>u.id===a.unitId);
  const nearFoe = res.state.units.filter((u:any)=>u.owner!==by && res.state.unitTypes[u.type]?.category==='combat').filter((u:any)=>distToCity(u,c)<=4).length;
  if (took) { tookPays += 1; tookGold += goldSpent; }
  ruinSteps.push(`T${s.turn} ${a.unitId} 踩废墟 ${c.id}（原 owner=${c.owner}）· 接管=${took?'是':'否'} · 花 ${goldSpent} · 该兵存活=${survived?'是':'否'} · 废墟 4 格内敌兵 ${nearFoe}`);
};

const snap = () => {
  const foe = s.cities.filter((c:any)=>c.owner!==ME);
  const br = bridgesOf();
  const brTxt = br.length ? br.map((b:any)=>`${b.x},${b.y}`).join(' ') : '无';
  const nearBr = br.map((b:any)=>combatOf(ME).filter((u:any)=>Math.max(Math.abs(u.x-b.x),Math.abs(u.y-b.y))<=3).length).join('/');
  const ri = reachInfo();
  const ruins = s.cities.filter((c:any)=>c.ruined).map((c:any)=>`${c.id}(${c.owner})`).join(' ');
  console.log(`T${String(s.turn).padStart(3)} 我兵${combatOf(ME).length} 金${Math.round(s.players[ME].gold)} | 桥 ${br.length} 座@${brTxt} 近桥兵 ${nearBr||'-'} | 陆路最小步数 ${ri.minSteps ?? '不通'}（上限${Math.min(s.w,s.h)}）| 废墟 ${ruins||'无'} | 敌城 ${foe.filter((c:any)=>!c.ruined).map((c:any)=>`${c.id} e${c.era} hp${Math.round(c.hp)}`).join(' ')}`);
};

snap(); nextSnap = s.turn + EVERY;
for (const a of r.actions ?? []) {
  const res = applyAction(s, a);
  if (!res.ok) { console.log(`  ! T${s.turn} ${a.type} 被拒：${res.reason}`); break; }
  stepIn(a, res);
  s = res.state;
  if (s.turn >= nextSnap) { snap(); nextSnap = s.turn + EVERY; }
}
console.log(`终局 ${s.winner ?? '平'} @ ${s.turn}`);
if (ruinSteps.length) { console.log('── 踩进废墟的事件 ──'); for (const x of ruinSteps.slice(0,20)) console.log('  '+x); }
console.log(`踩废墟共 ${ruinSteps.length} 次 · 其中真的接管 ${tookPays} 次、共付 ${tookGold} 金`);
