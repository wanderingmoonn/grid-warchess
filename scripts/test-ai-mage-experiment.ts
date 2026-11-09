import assert from 'node:assert/strict';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { applyAction, prepareSimulation } from '../src/core/rules.ts';
import { playerView } from '../src/core/fog.ts';
import { tacticalMap } from '../src/core/ai-tactics.ts';
import { DEFAULT_BUDGET } from '../src/core/ai-meta.ts';
import { focusedPurchasePlan, specialistMoveBias } from '../src/core/ai-unit-strategy.ts';
import { mageOpeningUpgrade, mageBatchActionAllowed, magePositionBias, type MageExperimentBudget } from '../src/core/ai-mage-experiment.ts';
import type { GameState, Unit } from '../src/core/types.ts';
let passed=0;
const test=(name:string,fn:()=>void):void=>{fn();passed++;console.log('PASS '+name);};
function arena():GameState {
 const s=prepareSimulation(createMatch({...DEFAULT_CONFIG,size:20,startEra:3,aiLevel:'advanced',expansionIds:['fantasy','pack-contemporary']},835710));
 s.current='A';s.fog=false;s.units=[];s.players.A.gold=709;
 for(let y=5;y<=15;y++)for(let x=5;x<=15;x++)s.tiles[y*s.w+x]={terrain:'plain',cityId:null};
 return s;
}
function put(s:GameState,type:string,owner:'A'|'B',x:number,y:number):Unit {
 const u:Unit={id:'mage-exp-'+s.nextUnitSeq++,type,owner,x,y,hp:s.unitTypes[type]!.maxHp,kills:0,moved:false,acted:false};s.units.push(u);return u;
}
const batch=(extra:Partial<NonNullable<MageExperimentBudget['mageBatch']>>={}):MageExperimentBudget=>({...DEFAULT_BUDGET,mageBatch:{purchased:1,quota:4,purchasedThisTurn:1,armyCap:24,...extra}});
test('Opening upgrade preserves native price, stats and the next mage budget',()=>{
 const s=arena(),defs=JSON.stringify(s.unitTypes),a=mageOpeningUpgrade(s,DEFAULT_BUDGET,0);assert.equal(a?.type,'UPGRADE');
 const r=applyAction(s,a!);assert.ok(r.ok);assert.equal(r.state.players.A.gold,169);assert.equal(JSON.stringify(r.state.unitTypes),defs);
});
test('Opening upgrade agrees with the prior combined strategy on a legal unescorted opening',()=>{
 const s=arena(),b={...DEFAULT_BUDGET,recruitFocus:{unitType:'mage' as const,purchased:0,quota:4,purchasedThisTurn:0,supportPurchased:0,rangedSupportPurchased:0}};
 assert.deepEqual(mageOpeningUpgrade(s,b,0),focusedPurchasePlan(s,b)?.action);
});
test('Upgrade-only does not upgrade after the first mage purchase',()=>assert.equal(mageOpeningUpgrade(arena(),DEFAULT_BUDGET,1),null));
test('Upgrade-only respects cash for one mage, not only cash for the upgrade',()=>{
 const s=arena();s.players.A.gold=600;assert.equal(mageOpeningUpgrade(s,DEFAULT_BUDGET,0),null);
});
test('Upgrade-only respects the per-turn upgrade budget',()=>assert.equal(mageOpeningUpgrade(arena(),{...DEFAULT_BUDGET,upgraded:1},0),null));
test('A visible enemy near the upgrade city prevents the opening upgrade',()=>{
 const s=arena(),c=s.cities.find(c=>c.owner==='A')!;put(s,'ge','B',c.x+1,c.y);assert.equal(mageOpeningUpgrade(s,DEFAULT_BUDGET,0),null);
});
test('A previous era4 upgrade stops the opening intervention',()=>{
 const s=arena();s.cities.find(c=>c.owner==='A')!.era=4;assert.equal(mageOpeningUpgrade(s,DEFAULT_BUDGET,0),null);
});
test('Batch cap rejects the second target mage while keeping cheap mixed purchases possible',()=>{
 const s=arena(),c=s.cities.find(c=>c.owner==='A')!;s.players.A.gold=559;
 assert.equal(mageBatchActionAllowed(s,batch(),{type:'RECRUIT',cityId:c.id,unitType:'mage'}),false);
 assert.equal(mageBatchActionAllowed(s,batch(),{type:'RECRUIT',cityId:c.id,unitType:'ge'}),true);
});
test('Batch reserve rejects an upgrade that would consume the next mage cash',()=>{
 const s=arena(),c=s.cities.find(c=>c.owner==='A')!;s.players.A.gold=559;
 assert.equal(mageBatchActionAllowed(s,batch(),{type:'UPGRADE',cityId:c.id}),false);
 s.players.A.gold=900;assert.equal(mageBatchActionAllowed(s,batch(),{type:'UPGRADE',cityId:c.id}),true);
});
test('Batch cap and cash reserve release at the fourth purchase',()=>{
 const s=arena(),c=s.cities.find(c=>c.owner==='A')!;s.players.A.gold=559;
 assert.equal(mageBatchActionAllowed(s,batch({purchased:4}),{type:'RECRUIT',cityId:c.id,unitType:'mage'}),true);
 assert.equal(mageBatchActionAllowed(s,batch({purchased:4}),{type:'UPGRADE',cityId:c.id}),true);
});
test('Batch policy does not block movement, attacks or turn completion',()=>{
 const s=arena();s.players.A.gold=0;const u=put(s,'mage','A',7,7);
 assert.equal(mageBatchActionAllowed(s,batch(),{type:'MOVE',unitId:u.id,x:7,y:8}),true);
 assert.equal(mageBatchActionAllowed(s,batch(),{type:'END_TURN'}),true);
});
test('No explicit experiment context leaves ordinary AI candidate eligibility unchanged',()=>{
 const s=arena(),c=s.cities.find(c=>c.owner==='A')!;s.players.A.gold=559;
 assert.equal(mageBatchActionAllowed(s,DEFAULT_BUDGET,{type:'UPGRADE',cityId:c.id}),true);
});
test('Mage positioning exactly matches the prior sealed formula across risk and escort positions',()=>{
 const s=arena(),u=put(s,'mage','A',7,7);put(s,'ge','A',8,7);put(s,'musketeer','A',9,7);put(s,'night-necromancer','B',12,7);put(s,'phoenix','B',13,9);
 const tactical=tacticalMap(s,'A'),before=JSON.stringify(s);
 for(const [x,y]of [[7,7],[8,7],[9,8],[10,7],[11,8],[7,10],[6,7],[8,9]])assert.equal(magePositionBias(s,u,x!,y!,tactical),specialistMoveBias(s,u,x!,y!,tactical));
 assert.equal(JSON.stringify(s),before);
});
test('Position-only gives no bias to holy knights, guards or other unit types',()=>{
 const s=arena();for(const type of ['ge','holy-knight-lord','musketeer']){const u=put(s,type,'A',7,7);assert.equal(magePositionBias(s,u,8,7,tacticalMap(s,'A')),0);}
});
test('Opening upgrade consumes only the fog view supplied by the controller',()=>{
 const s=arena();s.fog=true;const visible=playerView(s,'A').state;
 const hidden=s.tiles.map((_,i)=>({x:i%s.w,y:Math.floor(i/s.w)})).find(p=>!visible.units.some(u=>u.owner==='A'&&Math.abs(u.x-p.x)+Math.abs(u.y-p.y)<7)&&p.x>15)!;
 const foe=put(s,'night-necromancer','B',hidden.x,hidden.y);assert.ok(!playerView(s,'A').state.units.some(u=>u.id===foe.id));
 assert.deepEqual(mageOpeningUpgrade(playerView(s,'A').state,DEFAULT_BUDGET,0),mageOpeningUpgrade(visible,DEFAULT_BUDGET,0));
});
console.log(JSON.stringify({passed}));
