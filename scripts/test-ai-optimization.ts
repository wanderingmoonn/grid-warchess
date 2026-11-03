import assert from 'node:assert/strict';
import { aiMood, aiActiveMood, aiLevelOf, aiNextAction, aiActionKey, aiDebugPlan, flankSplit, foeOutput, savingAllowance, cityThreatUrgency, cityDistanceField, DEFAULT_BUDGET } from '../src/core/ai.ts';
import { tacticalMap } from '../src/core/ai-tactics.ts';
import { applyAction, canStrike, previewAttack, siegeTargets, threatTiles, idx, refreshMemory, utype } from '../src/core/rules.ts';
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

test('换血：编制满了会解散最差的那个，换更好的兵',()=>{
  const s = arena();
  // 把英雄从兵种表里摘掉：英雄的"攒钱"优先级会盖住换血（见 buildPlan 的 savingFor），
  // 这一条要单独量换血本身，别让攒英雄把它挤掉。
  for(const [id,d] of Object.entries(s.unitTypes)) if(d.hero) delete s.unitTypes[id];
  s.fog = false; s.current='A'; s.turn=40;
  /*
   * 编制塞满：20 个民兵（火药时代的旧货）+ 6 个农民。
   *
   * 为什么要放农民：编制满的时候 AI 会问"如果有一个空位，这一回合想买谁"。
   * 经济线没铺满时，那个问题的答案是农民——于是换血这条直接判"想买的不是战斗力"，
   * 用例就测不到换血了（真实对局里这是对的：缺农民时先补农民）。
   * 把经济线喂饱，才量得到"该不该拿旧兵换新兵"。
   *
   * 为什么是 6 个而不是"够用就行"：目标农民数是
   * `min(10, 城数×2 + 3×boom)`，两座城就是 6。少一个，AI 就还有理由先补农民。
   */
  for(let i=0;i<6;i++) unit(s,'A','farmer',1+(i%2),11+Math.floor(i/2));
  const N = 20;
  for(let i=0;i<N;i++) unit(s,'A','militia',1+(i%4),5+Math.floor(i/4));
  // 主城升到能造现代兵，账上有够买一个的钱
  for(const c of s.cities) if(c.owner==='A') c.era=6;
  s.players.A.gold=420;
  s.players.B.gold=0;
  const act = aiNextAction(s,{maxRecruit:2,maxUpgrade:0,recruited:0,upgraded:0});
  assert.equal(act?.type,'DISBAND', `编制满应先把旧兵换掉，实际 ${act?.type}`);
  const who = s.units.find(u=>u.id===(act as {unitId?:string}).unitId);
  assert.ok(who && utype(s,who.type).category==='combat', '解散的应该是一个战斗单位');
  assert.ok(applyAction(s,act!).ok, '解散动作要被规则层接受');
});
test('换血：编制没满时不会去拆自己的兵',()=>{
  const s = arena();
  for(const [id,d] of Object.entries(s.unitTypes)) if(d.hero) delete s.unitTypes[id];
  s.fog=false; s.current='A'; s.turn=40;
  for(let i=0;i<10;i++) unit(s,'A','militia',1+(i%3),5+Math.floor(i/3));
  for(const c of s.cities) if(c.owner==='A') c.era=6;
  s.players.A.gold=420;
  const act = aiNextAction(s,{maxRecruit:2,maxUpgrade:0,recruited:0,upgraded:0});
  assert.notEqual(act?.type,'DISBAND', '有空位的时候不该拆兵');
});

test('攒钱意向：跨回合记住，兵力掉下去也不会把钱散回产线',()=>{
  const s = arena();
  s.fog=false; s.current='A'; s.turn=15;
  for(let i=0;i<6;i++) unit(s,'A','militia',3+(i%3),5+Math.floor(i/3));
  s.players.A.gold=300;
  const first = aiDebugPlan(s,'A');
  /*
   * 原来这里写死 'hero'。2026-11-03 换成新战力公式之后，这个局面（6 个民兵、
   * 300 金、3 代城）算出来的最优目标是"升第 4 代"：中位战力 575 → 931（+62%），
   * 每个名额都值的时代跃迁确实压过一只英雄。
   * 这条用例的真正主题是**跨回合记住**，不是"必须攒英雄"，所以断言改成
   * "记住自己当时选的那个目标"，别把某一个具体结论钉死在这。
   */
  assert.ok(first.savingFor, `这个局面应该有个攒钱目标，实际 ${String(first.savingFor)}`);
  assert.ok(first.targetCost > s.players.A.gold, '要真的还买不起，不然这条测的是别的东西');
  assert.ok(s.aiIntent?.A, '意向要写进状态');
  const since = s.aiIntent!.A!.since;
  // 兵掉到 3 个：攒钱门槛（army >= 4~6）整段被跳过——这正是那个 bug 的现场
  s.units = s.units.filter(u => u.owner!=='A' || u.id==='test-0' || u.id==='test-1' || u.id==='test-2');
  s.turn = 17;
  const again = aiDebugPlan(s,'A');
  assert.equal(again.urgent, false, '3 个兵不算急事，不然这条会被急事那条拦掉');
  assert.equal(again.savingFor, first.savingFor, `两回合后不该忘掉（原来会变成 null），实际 ${again.savingFor}`);
  assert.equal(s.aiIntent!.A!.since, since, 'since 要保持，不能每回合重置');
});
test('攒钱意向：目标没了就换，不会抱着死目标',()=>{
  const s = arena();
  s.fog=false; s.current='A'; s.turn=15;
  for(let i=0;i<6;i++) unit(s,'A','militia',3+(i%3),5+Math.floor(i/3));
  s.players.A.gold=300;
  aiDebugPlan(s,'A');
  // 同上：这个局面现在的目标是"升时代"，不再写死 hero。
  const firstGoal = s.aiIntent?.A?.goal;
  assert.ok(firstGoal, '先立一个攒钱意向');
  // 英雄从兵种表里没了（关掉那个包 / 选卡没收录）：这一条必须接得住
  for(const [id,d] of Object.entries(s.unitTypes)) if(d.hero) delete s.unitTypes[id];
  s.turn=17;
  const p = aiDebugPlan(s,'A');
  if (firstGoal === 'hero') {
    assert.notEqual(s.aiIntent?.A?.goal, 'hero', `英雄没了还在攒英雄，实际 ${s.aiIntent?.A?.goal}`);
  }
  assert.equal(p.savingFor, s.aiIntent?.A?.goal ?? null, '计划和记忆要一致');
});
test('攒钱意向：走 aiNextAction 时落在真状态上',()=>{
  const s = arena();
  s.fog=true; s.current='A'; s.turn=15;
  for(let i=0;i<6;i++) unit(s,'A','militia',3+(i%3),5+Math.floor(i/3));
  s.players.A.gold=300;
  aiNextAction(s,{maxRecruit:0,maxUpgrade:0,recruited:0,upgraded:0});
  assert.ok(s.aiIntent?.A, '雾图副本上的记忆要搬回真状态，否则下一回合又忘了');
});

test('两回合威胁：够得着但还没到的人算进 soon，不算进 exposure',()=>{
  const s = arena();
  const t = unit(s,'A','militia',4,4);
  const e = unit(s,'B','militia',11,4,{move:4,range:1,atk:20});
  const map = tacticalMap(s,'A');
  assert.equal(map.exposure(t).damage, 0, '这回合还够不着，不算眼前那一刀');
  assert.ok(map.soon(t).damage > 0, '两回合的移动力够扑上来，要预警');
  // 走不动的同一批人：两回合也到不了，就不该预警
  e.type = 'slow';
  s.unitTypes.slow = {...s.unitTypes.militia!, id:'slow', move:1};
  const slow = tacticalMap(s,'A');
  assert.equal(slow.soon(t).damage, 0, '两回合走不到的人不算威胁');
});
test('对手最强一手：按"最贵的那一刀"计价，不看最近的那个',()=>{
  const s = arena();
  const cheap = unit(s,'A','militia',6,6);
  const pricey = unit(s,'A','militia',6,8,{maxHp:200,cost:400});
  unit(s,'B','archer',6,10,{move:0,range:4,atk:30});
  const a = foeOutput(s,'A');
  assert.ok(a > 0, '有人在射程里，就该算出一笔');
  // 把便宜的挪到射程外：威胁值应该几乎不掉——真正值钱的是那台贵的
  cheap.y = 0;
  const b = foeOutput(s,'A');
  assert.ok(b >= a * 0.95, `打贵的那一刀才是主体（${a.toFixed(1)} → ${b.toFixed(1)}）`);
  // 把贵的打掉，威胁值要塌下来
  s.units = s.units.filter(u=>u.id!==pricey.id);
  assert.ok(foeOutput(s,"A") < a * 0.6, '摘掉贵的目标，威胁值要跟着掉');
});
test('两翼：分出去的那一路不超过全军三分之一，去打另一座城',()=>{
  const s = arena();
  s.fog=false;
  // 上边一撮 3 个、下边一撮 6 个；两座敌城分别在右上与右下
  for(const [x,y] of [[9,2],[10,2],[9,3]]) unit(s,'A','militia',x,y);
  for(const [x,y] of [[9,10],[10,10],[9,11],[10,11],[9,12],[10,12]]) unit(s,'A','militia',x,y);
  const b1 = s.cities.find(c=>c.id==='city2')!; // (12,1) 右上
  const b2 = s.cities.find(c=>c.id==='city3')!; // (12,12) 右下
  const land = new Map<string,number[]>([
    [b1.id, cityDistanceField(s,b1,'land')],
    [b2.id, cityDistanceField(s,b2,'land')],
  ]);
  // 主攻定在右上那座：下边那一撮自然该走另一翼
  const split = flankSplit(s,'A',land,b1.id);
  assert.equal(split.flankCityId, b2.id, '佯攻要走离主攻最远的那座');
  assert.equal(split.flank.size, 3, '上限是全军九人的三分之一');
  for(const id of split.flank){
    const u = s.units.find(u=>u.id===id)!;
    assert.ok(u.y >= 10, `分到佯攻的该是下边那一撮，实际 (${u.x},${u.y})`);
  }
});
test('两翼：兵太少不分兵',()=>{
  const s = arena(); s.fog=false;
  for(let i=0;i<4;i++) unit(s,'A','militia',9,4+i);
  const b1 = s.cities.find(c=>c.id==='city2')!;
  const b2 = s.cities.find(c=>c.id==='city3')!;
  const land = new Map<string,number[]>([
    [b1.id, cityDistanceField(s,b1,'land')],
    [b2.id, cityDistanceField(s,b2,'land')],
  ]);
  assert.equal(flankSplit(s,'A',land,b1.id).flankCityId, null, '四个兵分两路等于送');
});
test('换家：兵力和城墙都崩了，就该弃守去打对面的城',()=>{
  const s = arena(); s.fog=false; s.current='A'; s.turn=40;
  // 我 4 个民兵缩在野地里，对面 10 个重装已经贴到城下
  for(let i=0;i<4;i++) unit(s,'A','militia',7,7+i);
  for(let i=0;i<10;i++) unit(s,'B','militia',3+(i%2),3+Math.floor(i/2),{maxHp:220,atk:40,cost:400});
  // 我那两座城都半血、都在敌人嘴边
  for(const c of s.cities) if(c.owner==='A') c.hp = Math.floor(c.maxHp*0.4);
  const p = aiDebugPlan(s,'A');
  assert.equal(p.stance,'trade', `应该换家，实际 ${p.stance}`);
});
test('换家：身价没差那么多就老实守着，别动不动就弃城',()=>{
  const s = arena(); s.fog=false; s.current='A'; s.turn=40;
  for(let i=0;i<4;i++) unit(s,'A','militia',7,7+i);
  for(let i=0;i<3;i++) unit(s,'B','militia',3+(i%2),3+Math.floor(i/2));
  for(const c of s.cities) if(c.owner==='A') c.hp = Math.floor(c.maxHp*0.4);
  const p = aiDebugPlan(s,'A');
  assert.notEqual(p.stance,'trade', '势均力敌的时候不该弃城');
});

test('攒升级：咬住窗口放到 8 回合时，差 6 个回合也一分不花',()=>{
  // 目标 900、余额 300、收入 100、两座产兵城 → 差 6 个回合的收入
  assert.equal(savingAllowance(300, 100, 900, 2, true, 0), 50, '默认窗口 4：还放得开，偶数回合给一半收入');
  assert.equal(savingAllowance(300, 100, 900, 2, true, 0, 8), 0, '升级窗口 8：咬住，一分不花');
  // 更远的目标准则不变：超过窗口就照常放额度
  assert.equal(savingAllowance(100, 100, 2000, 2, true, 0, 8), 50, '差 19 个回合：超过窗口，照常放');
});

console.log(`${passed} AI optimization tests passed`);