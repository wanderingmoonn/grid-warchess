import assert from 'node:assert/strict';
import { aiMood, aiActiveMood, aiLevelOf, aiNextAction, aiActionKey, cityThreatUrgency, cityDistanceField, DEFAULT_BUDGET } from '../src/core/ai.ts';
import { tacticalMap } from '../src/core/ai-tactics.ts';
import { applyAction, canStrike, previewAttack, siegeTargets, threatTiles, idx, refreshMemory } from '../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from '../src/core/types.ts';

let passed=0;
function test(name: string, run: () => void) { run(); passed++; console.log(`✓ ${name}`); }
function arena(): GameState {
  const s = createMatch({...DEFAULT_CONFIG,size:16,startEra:3,aiLevel:'tactic',expansionIds:['fantasy-core','fantasy-heroes']}, 7654);
  s.fog=false; s.units=[]; s.current='A'; s.turn=15;
  s.players.A.gold=0; s.players.B.gold=0;
  s.cities=[['A',1,1],['A',1,12],['B',12,1],['B',12,12]].map((v,i)=>({id:`city${i}`,owner:v[0] as PlayerId,x:v[1] as number,y:v[2] as number,size:2,era:3,hp:70,maxHp:70,armor:4}));
  for(let y=0;y<s.h;y++)for(let x=0;x<s.w;x++) {
    const c=s.cities.find(c=>x>=c.x&&x<c.x+c.size&&y>=c.y&&y<c.y+c.size);
    s.tiles[y*s.w+x]={terrain:c?'city':'plain',cityId:c?.id??null};
  }
  return s;
}
function unit(s: GameState,p: PlayerId,type: string,x: number,y: number,change: Partial<UnitTypeDef>={}): Unit {
  const id=`test-${s.units.length}`;
  s.unitTypes[id]={...s.unitTypes[type]!,...change,id};
  const u={id,type:id,owner:p,x,y,hp:s.unitTypes[id]!.maxHp,kills:0,moved:false,acted:false};
  s.units.push(u); return u;
}

test('Enemy movement is reset for next-turn risk',()=>{
  const s=arena(); const target=unit(s,'A','militia',6,6);
  const enemy=unit(s,'B','militia',10,6,{move:3,range:1,atk:20});
  enemy.moved=true; enemy.acted=true;
  assert.ok(tacticalMap(s,'A').exposure(target).damage>0);
});
test('A river blocks ground threats but does not hide ranged fire',()=>{
  const s=arena(); const target=unit(s,'A','militia',6,6);
  unit(s,'B','militia',9,6,{move:3,range:1,atk:20});
  for(let y=0;y<s.h;y++) s.tiles[y*s.w+8]!.terrain='water';
  assert.equal(tacticalMap(s,'A').exposure(target).damage,0);
  unit(s,'B','archer',9,6,{move:0,range:4,atk:20});
  assert.ok(tacticalMap(s,'A').exposure(target).damage>0);
});
test('Threat sums include defensive buildings and count each enemy once',()=>{
  const s=arena(); const target=unit(s,'A','militia',6,6);
  unit(s,'B','tower',8,6,{move:0,range:3,atk:20});
  const e=tacticalMap(s,'A').exposure(target);
  assert.equal(e.count,1); assert.ok(e.damage>0);
});
test('Unfinished buildings cannot contribute fire',()=>{
  const s=arena(); const target=unit(s,'A','militia',6,6);
  const tower=unit(s,'B','tower',8,6,{move:0,range:3,atk:20});
  tower.buildDone=1; tower.buildNeed=10;
  assert.equal(tacticalMap(s,'A').exposure(target).damage,0);
});
test('Ground melee does not threaten airborne units one square away',()=>{
  const s=arena(); const target=unit(s,'A','militia',6,6,{layer:'air'});
  unit(s,'B','tower',7,6,{move:0,range:1,atk:30});
  assert.equal(tacticalMap(s,'A').exposure(target).damage,0);
});

test('Cross-layer overlap and moving into anti-air range remain threats',()=>{
  const s=arena(); const target=unit(s,'A','militia',6,6,{layer:'air'});
  const enemy=unit(s,'B','militia',6,6,{move:0,range:1,atk:30});
  assert.ok(tacticalMap(s,'A').exposure(target).damage>0);
  enemy.x=8; s.unitTypes[enemy.type]!.move=1; s.unitTypes[enemy.type]!.range=2;
  assert.ok(tacticalMap(s,'A').exposure(target).damage>0);
  s.unitTypes[enemy.type]!.move=0;
  assert.equal(tacticalMap(s,'A').exposure(target).damage,0);
});
test('A possible kill removes that enemy from follow-up exposure',()=>{
  const s=arena(); const target=unit(s,'A','militia',6,6);
  const e=unit(s,'B','archer',8,6,{move:0,range:3,atk:20});
  const map=tacticalMap(s,'A');
  assert.ok(map.exposure(target).damage>0);
  assert.equal(map.exposure(target,e.id).damage,0);
});
test('A damaged expensive army is not valued as a full-health army',()=>{
  const s=arena(); unit(s,'A','militia',3,7,{cost:100,maxHp:100});
  const e=unit(s,'B','militia',10,7,{cost:100,maxHp:100});
  const full=aiMood(s).metrics.power; e.hp=10;
  assert.ok(aiMood(s).metrics.power>full);
});
test('A safe or sole city is never abandoned',()=>{
  const s=arena(); s.players.A.gold=4000;
  unit(s,'A','farmer',3,12); unit(s,'B','militia',13,8,{cost:600,atk:50});
  assert.equal(aiMood(s).abandonedCityId,null);
  s.cities=s.cities.filter(c=>c.owner==='B'||c.id==='city0');
  s.units[1]!.x=3; s.units[1]!.y=2;
  assert.equal(aiMood(s).abandonedCityId,null);
});
test('No retreat investment when both remaining cities are threatened',()=>{
  const s=arena(); s.players.A.gold=4000;
  unit(s,'A','farmer',1,12);
  unit(s,'B','militia',3,2,{cost:600,atk:50});
  unit(s,'B','militia',3,13,{cost:600,atk:50});
  s.cities[0]!.hp=8;
  assert.equal(aiMood(s).abandonedCityId,null);
});
test('Threat to the last city has higher rescue value than a distant enemy',()=>{
  const s=arena(); s.cities=s.cities.filter(c=>c.owner==='B'||c.id==='city0');
  s.cities[0]!.hp=5;
  const near=unit(s,'B','archer',3,2,{atk:20,range:3});
  const far=unit(s,'B','archer',13,7,{atk:20,range:3});
  assert.ok(cityThreatUrgency(s,near,'A')>1);
  assert.equal(cityThreatUrgency(s,far,'A'),0);
});
test('Multi-action units spend every attack of the turn',()=>{
  // 多动之后"还能打"不再等于"这回合已经动过"：canAttack 看的是剩余次数。
  // AI 的行动循环是"再要一步、直到没有"，所以它应该把次数一次不剩地打出去——
  // 要是它打完一发就换下一个单位，多动兵在 AI 手里会白白少掉三分之二的输出。
  const s=arena(); s.players.A.gold=0;
  const mg=unit(s,'A','mg',6,6);
  const burst=s.unitTypes[mg.type]!.burst ?? 1;
  assert.ok(burst>=2,'这条用例需要一个多动兵（mg）');
  const target=unit(s,'B','militia',8,6,{maxHp:900,armor:0,atk:1,range:1});
  refreshMemory(s);
  const budget={...DEFAULT_BUDGET,maxRecruit:0,maxUpgrade:0};

  let attacks=0;
  const deltas: number[]=[];
  let prevHp=target.hp;
  for(let step=0;step<12;step++){
    const a=aiNextAction(s,budget); if(!a)break;
    const r=applyAction(s,a); assert.ok(r.ok,r.ok?'':r.reason);
    Object.assign(s,r.state);
    const cur=s.units.find(u=>u.id===target.id)!.hp;
    if(a.type==='ATTACK'&&a.unitId===mg.id){ attacks++; deltas.push(prevHp-cur); }
    prevHp=cur;
    if(s.units.find(u=>u.id===mg.id)!.acted)break;
  }
  assert.equal(attacks,burst,`多动 ${burst} 次，AI 应该全部用掉，实际 ${attacks} 次`);
  assert.equal(new Set(deltas).size,1,`每一发都该是一整击，实际伤害：${deltas.join('、')}`);
  assert.equal(s.units.find(u=>u.id===mg.id)!.acted,true,'次数打完才算行动结束');
});

test('Same state gives same legal action without mutation',()=>{
  const s=arena(); s.players.A.gold=500;
  unit(s,'A','militia',5,6); unit(s,'B','archer',7,6);
  refreshMemory(s);
  const before=JSON.stringify(s); const a=aiNextAction(s,{...DEFAULT_BUDGET});
  assert.deepEqual(a,aiNextAction(s,{...DEFAULT_BUDGET}));
  assert.equal(JSON.stringify(s),before);
  assert.ok(a); assert.equal(applyAction(s,a).ok,true);
});
for (const breached of [false,true]) test(`A viable retreat delivers development${breached ? ' after the front city falls' : ' without reinforcing the front'}`,()=>{
  let s=arena(); s.players.A.gold=300; s.cities[0]!.hp=7;
  const econ=Object.values(s.unitTypes).find(d=>d.category==='economy'&&d.era===3)!;
  unit(s,'A',econ.id,3,12); unit(s,'A',econ.id,3,13);
  unit(s,'A','militia',2,12); unit(s,'A','militia',2,13);
  for(let i=0;i<3;i++)unit(s,'B','militia',3+i,2,{cost:400,maxHp:100,atk:45});
  const mood=aiMood(s);
  assert.equal(mood.lead,'boom'); assert.equal(mood.abandonedCityId,'city0');
  let economy=0, upgrades=0, heroes=0;
  for(let turn=0;turn<6&&!s.winner;turn++) {
    const budget={...DEFAULT_BUDGET};
    for(let step=0;step<50&&!s.winner;step++) {
      const a=aiNextAction(s,budget); if(!a)break;
      if(a.type==='RECRUIT') {
        assert.notEqual(a.cityId,'city0'); budget.recruited++;
        const d=s.unitTypes[a.unitType]!;
        if(d.category==='economy')economy++;
        if(d.hero)heroes++;
      }
      if(a.type==='UPGRADE') { assert.notEqual(a.cityId,'city0'); budget.upgraded++; upgrades++; }
      const r=applyAction(s,a); assert.ok(r.ok,r.ok?'':r.reason); s=r.state;
    }
    let end=applyAction(s,{type:'END_TURN'}); assert.ok(end.ok); s=end.state;
    if (breached && turn===0) {
      const attacker=s.units.find(u=>u.owner==='B'&&u.x===3&&u.y===2)!;
      const hit=applyAction(s,{type:'SIEGE',unitId:attacker.id,cityId:'city0'});
      assert.ok(hit.ok); s=hit.state; assert.equal(s.cities[0]!.ruined,true);
    }
    end=applyAction(s,{type:'END_TURN'}); assert.ok(end.ok); s=end.state;
  }
  assert.ok(economy>0,'Retreat should build its economy');
  assert.ok(upgrades+heroes>0,'Retreat should deliver an upgrade or hero within six own turns');
});

test('Retreat cannot rely on an obsolete hero or an unavailable city upgrade',()=>{
  const s=arena(); s.players.A.gold=4000; s.cities[0]!.hp=7;
  for (const city of s.cities) city.era=5;
  for (const def of Object.values(s.unitTypes)) if (def.hero) def.era=1;
  unit(s,'A','farmer',3,12);
  for(let i=0;i<3;i++)unit(s,'B','militia',3+i,2,{cost:400,maxHp:100,atk:45});
  assert.equal(aiMood(s).abandonedCityId,null);
});
test('Small HP changes produce gradual doctrine weight changes',()=>{
  const s=arena(); unit(s,'A','militia',5,6,{cost:100,maxHp:100});
  const foe=unit(s,'B','militia',8,6,{cost:100,maxHp:100});
  let previous=aiMood(s).weight;
  for(let hp=99;hp>=30;hp--) {
    foe.hp=hp; const next=aiMood(s).weight;
    for(const d of ['rush','harass','boom'] as const) assert.ok(Math.abs(next[d]-previous[d])<0.08);
    previous=next;
  }
});
test('Rejected routes choose another candidate',()=>{
  const s=arena(); const mine=unit(s,'A','militia',5,6); unit(s,'B','militia',10,6);
  const budget={maxRecruit:0,maxUpgrade:0,recruited:0,upgraded:0};
  const first=aiNextAction(s,budget); assert.ok(first);
  const next=aiNextAction(s,budget,new Set([aiActionKey(first)]));
  assert.ok(next); assert.notDeepEqual(next,first); assert.ok(applyAction(s,next).ok);
  assert.equal(mine.moved,false);
});
test('Invisible enemy locations cannot change the first decision',()=>{
  const s=arena(); s.fog=true;
  unit(s,'A','militia',3,7,{vision:1});
  const hidden=unit(s,'B','militia',12,9,{vision:1});
  refreshMemory(s);
  const budget={maxRecruit:0,maxUpgrade:0,recruited:0,upgraded:0};
  const a=aiNextAction(s,budget);
  hidden.x=10; hidden.y=10; refreshMemory(s);
  assert.deepEqual(aiNextAction(s,budget),a);
});

test('Difficulty survives setup and advanced remains separate from doctrines',()=>{
  for (const level of ['basic','advanced','tactic'] as const) {
    const s=createMatch({...DEFAULT_CONFIG,aiLevel:level},92);
    assert.equal(aiLevelOf(s),level);
    const active=aiActiveMood(s);
    if (level==='tactic') assert.deepEqual(active,aiMood(s));
    else { assert.deepEqual(active.drive,{rush:0,harass:0,boom:0}); assert.equal(active.abandonedCityId,null); }
  }
});

test('Proactive withdrawal needs a nearby superior enemy and a productive rear',()=>{
  const s=arena(); s.players.A.gold=300;
  const econ=Object.values(s.unitTypes).find(d=>d.category==='economy'&&d.era===3)!;
  unit(s,'A',econ.id,3,12); unit(s,'A',econ.id,3,13);
  for(let i=0;i<3;i++)unit(s,'B','militia',7+i,2,{cost:400,maxHp:100,atk:45});
  assert.equal(aiActiveMood(s).abandonedCityId,'city0');
  for(const enemy of s.units.filter(u=>u.owner==='B')) enemy.x+=3;
  assert.equal(aiActiveMood(s).abandonedCityId,null);
});

test('High-ground fire is included beyond base range; low-ground fire is excluded',()=>{
  const s=arena(); s.config.expansionIds.push('height-terrain');
  // 高差只剩"一条"之后（plateau +2 / valley −1 → dh 3 ≥ 波段 2）加成是 +1，
  // 不再是"制高点 +1 再叠高差 +1"的 +2。所以取距离 4：弓兵射程 3 → 4 打得着，
  // 取 5 就只有旧的 +2 打得着，那是在测一条已经不存在的规则。
  const target=unit(s,'A','militia',4,6);
  const enemy=unit(s,'B','archer',8,6,{move:0,range:3,atk:25});
  s.tiles[idx(s,8,6)]!.terrain='plateau'; s.tiles[idx(s,4,6)]!.terrain='valley';
  assert.ok(canStrike(s,enemy,target));
  assert.ok(tacticalMap(s,'A').exposure(target).damage>0);
  assert.ok(threatTiles(s,enemy).has(idx(s,4,6)));
  target.x=5; s.tiles[idx(s,5,6)]!.terrain='plateau'; s.tiles[idx(s,8,6)]!.terrain='valley';
  assert.equal(canStrike(s,enemy,target),false);
  assert.equal(tacticalMap(s,'A').exposure(target).damage,0);
  assert.equal(threatTiles(s,enemy).has(idx(s,5,6)),false);
});

test('Siege selection and execution agree on height-dependent range',()=>{
  const s=arena(); s.config.expansionIds.push('height-terrain');
  // city2 占 (12..13, 1..2)，台地上一格是高差 +2（≥ 波段 2）→ 射程 3 变 4
  const attacker=unit(s,'A','archer',8,1,{range:3,atk:20});
  s.tiles[idx(s,8,1)]!.terrain='plateau';
  // 距离 4：平地够不到、台地够得到——"选得出目标"与"真能开火"必须是同一个答案
  assert.ok(siegeTargets(s,attacker).some(c=>c.id==='city2'));
  assert.ok(applyAction(s,{type:'SIEGE',unitId:attacker.id,cityId:'city2'}).ok);
  // 退一格到距离 5：+1 也够不到了，两处要一起说不
  attacker.x=7; s.tiles[idx(s,7,1)]!.terrain='plateau';
  assert.ok(!siegeTargets(s,attacker).some(c=>c.id==='city2'));
  assert.equal(applyAction(s,{type:'SIEGE',unitId:attacker.id,cityId:'city2'}).ok,false);
  // 同一个距离换回平地：加成没了，同样够不到
  s.tiles[idx(s,7,1)]!.terrain='plain';
  assert.ok(!siegeTargets(s,attacker).some(c=>c.id==='city2'));
});

test('AI approach distances preserve uphill and downhill direction',()=>{
  const s=arena(); s.config.expansionIds.push('height-terrain');
  for(const tile of s.tiles) tile.terrain='mountain';
  s.tiles[idx(s,3,5)]!.terrain='valley';
  s.tiles[idx(s,4,5)]!.terrain='plain';
  s.tiles[idx(s,5,5)]!.terrain='plateau';
  const goal={...s.cities[0]!,x:5,y:5,size:1};
  assert.equal(cityDistanceField(s,goal)[idx(s,3,5)],6);
  assert.equal(cityDistanceField(s,{...goal,x:3})[idx(s,5,5)],2);
});

for(const highDefender of [false,true]) test(`Counterattack preview matches execution with ${highDefender?'high':'low'} defender`,()=>{
  const s=arena(); s.config.expansionIds.push('height-terrain');
  const attacker=unit(s,'A','archer',5,6,{range:5,atk:10,maxHp:100});
  const defender=unit(s,'B','archer',8,6,{range:3,atk:20,maxHp:100});
  s.tiles[idx(s,5,6)]!.terrain=highDefender?'valley':'plateau';
  s.tiles[idx(s,8,6)]!.terrain=highDefender?'plateau':'valley';
  const preview=previewAttack(s,attacker,defender);
  assert.equal(preview.counter,highDefender);
  const result=applyAction(s,{type:'ATTACK',unitId:attacker.id,targetId:defender.id});
  assert.ok(result.ok);
  assert.equal(result.state.units.find(u=>u.id===attacker.id)!.hp,attacker.hp-preview.toAttacker);
});

// ── 海军：装卸 ───────────────────────────────────────────────
// 两座岛，中间整条深水。陆路真的走不过去，所以这是"船就是路"的那一档。
function twoIslands(): GameState {
  const s = createMatch({...DEFAULT_CONFIG, size:16, startEra:3, aiLevel:'tactic', expansionIds:['naval-fleet']}, 4321);
  s.fog = false; s.units = []; s.current = 'A'; s.turn = 5;
  s.players.A.gold = 1200; s.players.B.gold = 1200;
  s.cities = [['A',1,1],['A',1,12],['B',12,1],['B',12,12]].map((v,i)=>({
    id:`city${i}`, owner:v[0] as PlayerId, x:v[1] as number, y:v[2] as number,
    size:2, era:3, hp:70, maxHp:70, armor:4,
  }));
  for(let y=0;y<s.h;y++) for(let x=0;x<s.w;x++){
    const c = s.cities.find(c=>x>=c.x&&x<c.x+c.size&&y>=c.y&&y<c.y+c.size);
    // 6..9 列是深水：船能走，人走不了（没有浅滩，这个宽度也架不起桥）
    s.tiles[y*s.w+x] = { terrain: c?'city':(x>=6&&x<=9?'deep':'plain'), cityId: c?.id ?? null };
  }
  return s;
}

test('海军：陆路被海隔断时，运输船会把兵装上船',()=>{
  const s = twoIslands();
  unit(s,'A','nv_carrack',6,6,{move:4,maxHp:60});
  const foot = unit(s,'A','militia',5,6,{move:3,maxHp:100});
  foot.acted = false; foot.moved = false;
  const act = aiNextAction(s,{maxRecruit:0,maxUpgrade:0,recruited:0,upgraded:0});
  assert.ok(act, '应该给出一个动作');
  assert.equal(act!.type,'LOAD', `陆路不通时该装船，实际 ${act!.type}`);
  assert.equal((act as {cargoId?:string}).cargoId, foot.id);
  assert.ok(applyAction(s,act!).ok, '装船动作要被规则层接受');
});

test('海军：船到了对面那侧，就把兵放下来',()=>{
  const s = twoIslands();
  const foot = unit(s,'A','militia',9,6,{move:3,maxHp:100});
  const ferry = unit(s,'A','nv_carrack',9,6,{move:4,maxHp:60});
  // 已经装好了：船在 9 列，右边 10 列就是对面那侧的陆地
  ferry.cargo = [{...foot, x:9, y:6, moved:true, acted:true}];
  s.units = s.units.filter(u=>u.id!==foot.id);
  const act = aiNextAction(s,{maxRecruit:0,maxUpgrade:0,recruited:0,upgraded:0});
  assert.ok(act, '应该给出一个动作');
  assert.equal(act!.type,'UNLOAD', `该上岸了，实际 ${act!.type}`);
  assert.equal((act as {x?:number}).x, 10, '落点是右岸那一格');
  assert.ok(applyAction(s,act!).ok, '下船动作要被规则层接受');
});

test('海军：陆路走得通时，船不会无脑来回运人',()=>{
  const s = twoIslands();
  // 把中间那四列填成平地：路通了，装船就只是白花两回合
  for(let y=0;y<s.h;y++) for(let x=6;x<=9;x++) s.tiles[y*s.w+x]!.terrain='plain';
  unit(s,'A','nv_carrack',6,6,{move:4,maxHp:60});
  const foot = unit(s,'A','militia',5,6,{move:3,maxHp:100});
  foot.acted = false; foot.moved = false;
  const act = aiNextAction(s,{maxRecruit:0,maxUpgrade:0,recruited:0,upgraded:0});
  assert.notEqual(act?.type,'LOAD', '路通的时候不该装船');
});

console.log(`${passed} AI optimization tests passed`);