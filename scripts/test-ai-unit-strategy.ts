import assert from 'node:assert/strict';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { applyAction, prepareSimulation } from '../src/core/rules.ts';
import { playerView } from '../src/core/fog.ts';
import { tacticalMap } from '../src/core/ai-tactics.ts';
import { aiNextAction, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import { focusedPurchasePlan, holyBannerCandidate, specialistRecruitAllowed } from '../src/core/ai-unit-strategy.ts';
import type { AiBudget } from '../src/core/ai-meta.ts';
import type { GameState, Unit } from '../src/core/types.ts';

let passed=0;
const test=(name:string,run:()=>void):void=>{run();passed++;console.log('PASS '+name);};
function arena(era=3): GameState {
 const s=prepareSimulation(createMatch({...DEFAULT_CONFIG,size:20,startEra:3,aiLevel:'advanced',expansionIds:['fantasy','pack-contemporary']},835700));
 s.units=[];s.fog=false;s.current='A';s.players.A.gold=709;s.players.B.gold=0;
 for(const c of s.cities)if(c.owner==='A')c.era=era;
 for(let y=5;y<=15;y++)for(let x=5;x<=15;x++)s.tiles[y*s.w+x]={terrain:'plain',cityId:null};
 return s;
}
function put(s:GameState,type:string,owner:'A'|'B',x:number,y:number):Unit {
 const u:Unit={id:'strategy-'+s.nextUnitSeq++,type,owner,x,y,hp:s.unitTypes[type]!.maxHp,kills:0,moved:false,acted:false};s.units.push(u);return u;
}
function focus(type:'mage'|'holy-knight-lord',extra:Partial<NonNullable<AiBudget['recruitFocus']>>={}): AiBudget {
 return {...DEFAULT_BUDGET,recruitFocus:{unitType:type,purchased:0,quota:type==='mage'?4:1,purchasedThisTurn:0,supportPurchased:0,rangedSupportPurchased:0,...extra}};
}
test('Mage focus preserves the first era upgrade and pays its native cost',()=>{
 const s=arena(),b=focus('mage'),before=JSON.stringify(s.unitTypes),p=focusedPurchasePlan(s,b)!;
 assert.equal(p.action?.type,'UPGRADE');if(p.action?.type!=='UPGRADE')throw Error('upgrade');
 const r=applyAction(s,p.action);assert.ok(r.ok);assert.equal(r.state.players.A.gold,169);assert.equal(JSON.stringify(s.unitTypes),before);
});
test('Mage group recruits its frontline before the first fragile caster',()=>{
 const s=arena(4);s.players.A.gold=169;const p=focusedPurchasePlan(s,focus('mage'))!;
 assert.equal(p.action?.type,'RECRUIT');if(p.action?.type!=='RECRUIT')throw Error('recruit');assert.equal(p.action.unitType,'ge');assert.ok(applyAction(s,p.action).ok);
});
test('Mage focus limits direct purchases to one caster per own turn',()=>{
 const s=arena(4);s.players.A.gold=1000;put(s,'ge','A',7,7);put(s,'mage','A',7,8);
 const p=focusedPurchasePlan(s,focus('mage',{purchased:1,purchasedThisTurn:1,supportPurchased:1}))!;
 assert.equal(p.action,null);assert.equal(p.reserveGold,150);
});
test('Finished focus releases its reserve to ordinary mixed procurement',()=>{
 assert.equal(focusedPurchasePlan(arena(4),focus('mage',{purchased:4})),null);
});
test('Holy knight group first buys ranged support instead of holding every recruitment slot',()=>{
 const s=arena(4);s.players.A.gold=273;
 const p=focusedPurchasePlan(s,focus('holy-knight-lord'))!;
 assert.equal(p.action?.type,'RECRUIT');if(p.action?.type!=='RECRUIT')throw Error('recruit');assert.equal(p.action.unitType,'musketeer');assert.ok(applyAction(s,p.action).ok);
});
test('Holy knight focus buys the hero once the mixed escort is funded',()=>{
 const s=arena(4);s.players.A.gold=700;put(s,'ge','A',7,7);put(s,'musketeer','A',7,8);
 const p=focusedPurchasePlan(s,focus('holy-knight-lord',{supportPurchased:2,rangedSupportPurchased:1}))!;
 assert.equal(p.action?.type,'RECRUIT');if(p.action?.type!=='RECRUIT')throw Error('recruit');assert.equal(p.action.unitType,'holy-knight-lord');assert.ok(applyAction(s,p.action).ok);
});
test('Ordinary hero recruitment requires actual combat company',()=>{
 const s=arena(4);put(s,'farmer','A',7,7);put(s,'farmer','A',7,8);
 assert.equal(specialistRecruitAllowed(s,s.unitTypes['holy-knight-lord']!,false),false);
 put(s,'ge','A',8,8);put(s,'musketeer','A',8,9);
 assert.equal(specialistRecruitAllowed(s,s.unitTypes['holy-knight-lord']!,false),true);
});
test('Ordinary mage procurement avoids stacking specialists without an escort',()=>{
 const s=arena();put(s,'ge','A',7,7);put(s,'mage','A',7,8);
 assert.equal(specialistRecruitAllowed(s,s.unitTypes.mage!,false),false);
 put(s,'ge','A',8,8);put(s,'musketeer','A',8,9);
 assert.equal(specialistRecruitAllowed(s,s.unitTypes.mage!,false),true);
});
test('Holy banner moves toward the combat group before spending the cooldown',()=>{
 const s=arena(4),u=put(s,'holy-knight-lord','A',7,7);
 put(s,'musketeer','A',7,8);put(s,'musketeer','A',10,7);put(s,'musketeer','A',10,8);put(s,'musketeer','A',11,7);put(s,'ge','B',13,7);
 const c=holyBannerCandidate(s,u,tacticalMap(s,'A'),new Set());assert.equal(c?.action.type,'MOVE');
 const moved=applyAction(s,c!.action);assert.ok(moved.ok);
 const next=moved.state.units.find(v=>v.id===u.id)!;
 const cast=holyBannerCandidate(moved.state,next,tacticalMap(moved.state,'A'),new Set());assert.equal(cast?.action.type,'HERO_SKILL');assert.ok(applyAction(moved.state,cast!.action).ok);
});
test('Economy-only company does not trigger a cold holy banner',()=>{
 const s=arena(4),u=put(s,'holy-knight-lord','A',7,7);put(s,'farmer','A',7,8);put(s,'farmer','A',8,7);put(s,'ge','B',13,7);
 assert.equal(holyBannerCandidate(s,u,tacticalMap(s,'A'),new Set()),null);
});
test('Rejected support moves are not repeated',()=>{
 const s=arena(4),u=put(s,'holy-knight-lord','A',7,7);put(s,'musketeer','A',10,7);put(s,'musketeer','A',10,8);put(s,'musketeer','A',11,7);put(s,'ge','B',13,7);
 const first=holyBannerCandidate(s,u,tacticalMap(s,'A'),new Set());assert.ok(first);
 const next=holyBannerCandidate(s,u,tacticalMap(s,'A'),new Set([aiActionKey(first.action)]));assert.ok(!next||aiActionKey(next.action)!==aiActionKey(first.action));
});
test('Unseen enemies cannot alter focused procurement through the public AI entry',()=>{
 const s=arena();s.fog=true;
 const ownCity=s.cities.find(c=>c.owner==='A')!;put(s,'farmer','A',ownCity.x,ownCity.y);
 const visible=playerView(s,'A').state;
 const unseen=s.tiles.map((_,i)=>({x:i%s.w,y:Math.floor(i/s.w)})).filter(p=>!visible.units.some(u=>u.owner==='A'&&Math.abs(u.x-p.x)+Math.abs(u.y-p.y)<=6)&&p.x>12);
 const foe=put(s,'phoenix','B',unseen[0]!.x,unseen[0]!.y);assert.ok(!playerView(s,'A').state.units.some(u=>u.id===foe.id));
 const other=structuredClone(s);Object.assign(other.units.find(u=>u.id===foe.id)!,unseen.at(-1)!);
 assert.deepEqual(aiNextAction(s,focus('mage')),aiNextAction(other,focus('mage')));
});
console.log(JSON.stringify({passed}));
