import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {aiNextAction as baselineAiNextAction,aiActionKey,AI_MAX_STEPS,DEFAULT_BUDGET} from './snapshot/core/ai.ts';
import {mageOpeningUpgrade} from './snapshot/core/ai-mage-experiment.ts';
import {createMatch} from './snapshot/core/setup.ts';
import {applyAction,prepareSimulation,armySize,recruitPriceOf,recruitSpawnCells,heroBlocked,unitYield,reachableTiles,unitAt,cityTiles,cityById,rebuildCost} from './snapshot/core/rules.ts';
import {nextUpgradeCost} from './snapshot/core/config.ts';
import {playerView} from './snapshot/core/fog.ts';
import {aurasOfUnit} from './snapshot/core/auras.ts';
import {buildMatchReport,reportJson} from './snapshot/core/report.ts';
const dir=path.dirname(fileURLToPath(import.meta.url));
const protocol=JSON.parse(fs.readFileSync(path.join(dir,'protocol.json'),'utf8'));
const args=process.argv.slice(2),arg=(name,d)=>{const i=args.indexOf('--'+name);return i<0?d:args[i+1];};
const requested=arg('job','');
const pilot=arg('pilot','');
const job=requested?protocol.jobs.find(j=>j.id===requested):{id:`pilot-${pilot}-${arg('seat','A')}`,target:pilot==='control'?null:pilot,stage:Number(arg('stage','3')),seed:Number(arg('seed','218500')),seat:arg('seat','A')};
if(!job)throw Error('Unknown job '+requested);
if(!protocol.groups.some(g=>g.id===job.group))throw Error('Unknown variant');
const variantAiNextAction=(await import('./variants/'+job.group+'/core/ai.ts')).aiNextAction;
const liveFolder=path.join(dir,'live');fs.mkdirSync(liveFolder,{recursive:true});
const focus=job.target?protocol.targets.find(t=>t.id===job.target):null;
const side=job.seat,foe=side==='A'?'B':'A',started=performance.now();
let s=prepareSimulation(createMatch(protocol.config,job.seed));
const actions=[];
const paid=new Set(),built=new Set(),completed=new Set(),children=new Set();
const focusStats={quota:focus?.quota??0,forced:0,recruited:0,spent:0,firstRecruitTurn:null,fieldedTurns:0,unitTurns:0,attacks:0,unitDamage:0,skillDamage:0,childDamage:0,cityDamage:0,childCityDamage:0,counterDamage:0,kills:0,killedEconomy:0,deaths:0,disbanded:0,income:0,buildingIncome:0,buildActions:0,buildSpend:0,buildings:0,completedBuildings:0,heroSkills:{},summons:0,summonTypes:{},loads:0,unloads:0,auraAllyTurns:0,nearbyWoundedAllyTurns:0,nearbyCityTurns:0,peakAlive:0,noSiteTurns:0,waitingGoldTurns:0,transformed:[]};
const rejected={A:0,B:0},recruitment={A:{},B:{}},spend={A:0,B:0},income={A:0,B:0},upgrades={A:0,B:0};
const badActions=[];
const strategyDecisions=[],turnDecisions=[];let focusBoughtThisTurn=0;
let prefixTurns=0,prepEndTurn=1,terminalError=null;
function alive(st,id){return st.units.find(u=>u.id===id);}
function amount(st,id,before){const u=alive(st,id);return Math.max(0,before.hp-(u?.hp??0));}
function step(action,{forced=false,prep=false}={}){
 const before=s,actor=s.current,priorIds=new Set(s.units.map(u=>u.id));
 let quote=0,buildingQuote=0;
 if(action.type==='RECRUIT')quote=recruitPriceOf(s,actor,s.unitTypes[action.unitType]).gold;
 if(action.type==='BUILD')buildingQuote=s.unitTypes[action.unitType]?.cost??0;
 const res=applyAction(s,action);if(!res.ok)return res;
 s=res.state;actions.push(action);
 if(action.type==='RECRUIT'){
  if(actor===side&&action.unitType===focus?.id)focusBoughtThisTurn++;
  recruitment[actor][action.unitType]=(recruitment[actor][action.unitType]??0)+1;spend[actor]+=quote;
  if(actor===side&&action.unitType===focus?.id){
   focusStats.recruited++;focusStats.spent+=quote;if(forced)focusStats.forced++;
   focusStats.firstRecruitTurn??=before.turn;
   for(const u of s.units)if(u.owner===side&&u.type===focus.id&&!priorIds.has(u.id))paid.add(u.id);
  }
 }
 if(action.type==='UPGRADE')upgrades[actor]++;
 if(!prep&&focus){
  const ownActor=action.unitId?alive(before,action.unitId):null;
  const trackedActor=ownActor&&paid.has(ownActor.id);
  const childActor=ownActor&&children.has(ownActor.id);
  if(action.type==='ATTACK'&&trackedActor){
   focusStats.attacks++;
   for(const b of before.units.filter(u=>u.owner!==side)){
    const lost=amount(s,b.id,b);focusStats.unitDamage+=lost;
    if(!alive(s,b.id)){focusStats.kills++;if(before.unitTypes[b.type]?.category==='economy')focusStats.killedEconomy++;}
   }
  }
  if((action.type==='HERO_SKILL'&&trackedActor)||(action.type==='ATTACK'&&childActor)){
   const damage=before.units.filter(u=>u.owner!==side).reduce((n,u)=>n+amount(s,u.id,u),0);
   if(action.type==='HERO_SKILL')focusStats.skillDamage+=damage;else focusStats.childDamage+=damage;
  }
  if(action.type==='ATTACK'&&action.targetId&&paid.has(action.targetId)&&actor!==side){
   const attacker=alive(before,action.unitId);if(attacker)focusStats.counterDamage+=amount(s,attacker.id,attacker);
  }
  if(action.type==='SIEGE'&&trackedActor){
   const b=before.cities.find(c=>c.id===action.cityId),a=s.cities.find(c=>c.id===action.cityId);
   if(b)focusStats.cityDamage+=Math.max(0,b.hp-(a?.hp??0));
  }
  if(action.type==='SIEGE'&&childActor){const b=before.cities.find(c=>c.id===action.cityId),a=s.cities.find(c=>c.id===action.cityId);if(b)focusStats.childCityDamage+=Math.max(0,b.hp-(a?.hp??0));}
  if(action.type==='BUILD'&&trackedActor){
   focusStats.buildActions++;focusStats.buildSpend+=buildingQuote;
   for(const u of s.units)if(!priorIds.has(u.id)&&u.owner===side&&s.unitTypes[u.type]?.category==='building'){built.add(u.id);focusStats.buildings++;}
  }
  if(action.type==='HERO_SKILL'&&trackedActor)focusStats.heroSkills[action.skillId]=(focusStats.heroSkills[action.skillId]??0)+1;
  if(action.type==='LOAD'&&trackedActor)focusStats.loads++;
  if(action.type==='UNLOAD'&&trackedActor)focusStats.unloads++;
  const generatedTypes=new Set();
  if(action.type==='END_TURN'&&s.current===side){for(const u of before.units.filter(u=>paid.has(u.id))){const def=before.unitTypes[u.type];for(const type of def.summon?.random??[def.summon?.type])if(type)generatedTypes.add(type);}}
  for(const u of s.units.filter(u=>u.owner===side&&!priorIds.has(u.id))){
   if((trackedActor&&action.type==='HERO_SKILL')||generatedTypes.has(u.type)){children.add(u.id);focusStats.summons++;focusStats.summonTypes[u.type]=(focusStats.summonTypes[u.type]??0)+1;}
  }
  // Follow hatching/replacement while keeping generated damage distinct from purchased bodies.
  if(action.type==='END_TURN')for(const u of before.units.filter(u=>children.has(u.id)&&before.unitTypes[u.type]?.hatch)){
   const nextType=before.unitTypes[u.type].hatch.into;
   for(const v of s.units.filter(v=>v.owner===side&&v.type===nextType&&!priorIds.has(v.id)))children.add(v.id);
  }
  for(const id of paid){const b=alive(before,id),a=alive(s,id);if(b&&!a){if(action.type==='DISBAND'&&action.unitId===id)focusStats.disbanded++;else if(action.type==='HERO_SKILL'&&trackedActor&&id===action.unitId)focusStats.transformed.push({turn:before.turn,from:b.type,to:'skill-derived-units'});else focusStats.deaths++;}if(b&&a&&b.type!==a.type)focusStats.transformed.push({turn:before.turn,from:b.type,to:a.type});}
 }
 return res;
}
function earnMove(st){
 const view=playerView(st,st.current).state;
 for(const u of view.units.filter(u=>u.owner===st.current&&view.unitTypes[u.type]?.category==='economy'&&!u.moved)){
  const current=unitYield(view,u).gold??0;let best=null;
  for(const i of reachableTiles(view,u).keys()){
   const x=i%view.w,y=Math.floor(i/view.w);if(unitAt(view,x,y))continue;
   const g=unitYield(view,{...u,x,y}).gold??0;
   if(g>current&&(!best||g>best.g))best={x,y,g};
  }
  if(best)return {type:'MOVE',unitId:u.id,x:best.x,y:best.y};
 }
 return null;
}
// A shared, fully legal development prefix, never changing stats/resources directly.
if(job.stage>3){
 while(s.turn<=protocol.cap){
  const both=['A','B'].every(p=>s.cities.some(c=>c.owner===p&&c.era>=job.stage));
  if(both&&s.current==='A')break;
  const budget={...DEFAULT_BUDGET};
  for(let k=0;k<AI_MAX_STEPS;k++){
   const city=s.cities.filter(c=>c.owner===s.current).sort((a,b)=>a.id.localeCompare(b.id))[0];
   let action=null;
   if(city&&city.era<job.stage&&budget.upgraded<1&&s.players[s.current].gold>=(nextUpgradeCost(city.era)??Infinity))action={type:'UPGRADE',cityId:city.id};
   else action=earnMove(s);
   if(!action)break;
   const res=step(action,{prep:true});if(!res.ok)throw Error('Preparation rejected: '+res.reason);
   if(action.type==='UPGRADE')budget.upgraded++;
  }
  const res=step({type:'END_TURN'},{prep:true});if(!res.ok)throw Error(res.reason);prefixTurns++;
 }
 if(s.turn>protocol.cap)throw Error('Could not legally reach evaluation era within cap');
 prepEndTurn=s.turn;
}
const prefixHash=crypto.createHash('sha256').update(JSON.stringify(actions)).digest('hex');
const startStateHash=crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex');
function exposureAction(budget){
 if(focus&&s.current===side&&focusStats.recruited<focus.quota){
  if(job.group==='upgrade'){const upgrade=mageOpeningUpgrade(playerView(s,side).state,budget,focusStats.recruited);if(upgrade)return {action:upgrade,hold:false,reason:'upgrade-first'};}
  if(job.group==='batch'&&focusBoughtThisTurn>=1)return {action:null,hold:false,reason:'batch-limit'};
 }
 if(!focus||s.current!==side||focusStats.recruited>=focus.quota||budget.recruited>=budget.maxRecruit)return {action:null,hold:false};
 if(armySize(s,side)>=protocol.aiArmyCap||heroBlocked(s,side,s.unitTypes[focus.id]))return {action:null,hold:false};
 const sites=s.cities.filter(c=>c.owner===side&&!c.ruined&&c.era>=focus.era).sort((a,b)=>a.id.localeCompare(b.id));
 const allowed=sites.filter(c=>recruitSpawnCells(s,c.id,undefined,focus.id).length>0);
 if(!allowed.length)return {action:null,hold:false,noSite:true};
 if(recruitPriceOf(s,side,s.unitTypes[focus.id]).gold>s.players[side].gold)return {action:null,hold:true,waitingGold:true};
 return {action:{type:'RECRUIT',cityId:allowed[0].id,unitType:focus.id},hold:true};
}
while(!s.winner&&s.turn<=protocol.cap){
 if(s.turn%10===1)fs.writeFileSync(path.join(liveFolder,job.id+'.json'),JSON.stringify({id:job.id,turn:s.turn,seconds:(performance.now()-started)/1000,fielded:focusStats.recruited,actions:actions.length}));
 const actor=s.current,budget={...DEFAULT_BUDGET},denied=new Set();focusBoughtThisTurn=0;let decisionCount=0;
 income[actor]+=s.units.filter(u=>u.owner===actor).reduce((n,u)=>n+(unitYield(s,u).gold??0),0);
 if(focus&&actor===side){
  const live=s.units.filter(u=>paid.has(u.id));if(live.length)focusStats.fieldedTurns++;
  focusStats.unitTurns+=live.length;focusStats.peakAlive=Math.max(focusStats.peakAlive,live.length);
  for(const u of live){
   focusStats.income+=unitYield(s,u).gold??0;
   const abilities=s.unitTypes[u.type].abilities??[];
   const radii=aurasOfUnit(s,u).map(a=>a.radius??1);if(abilities.some(a=>['heal-aura','purge','aura-speed'].includes(a)))radii.push(1);
   const radius=radii.length?Math.max(...radii):0;
   if(radius){const allies=s.units.filter(v=>v.owner===side&&v.id!==u.id&&Math.abs(u.x-v.x)+Math.abs(u.y-v.y)<=radius);focusStats.auraAllyTurns+=allies.length;focusStats.nearbyWoundedAllyTurns+=allies.filter(v=>v.hp<s.unitTypes[v.type].maxHp+(v.maxHpBonus??0)).length;}
   if(abilities.includes('repair'))focusStats.nearbyCityTurns+=s.cities.filter(c=>c.owner===side&&cityTiles(c).some(p=>Math.abs(p.x-u.x)+Math.abs(p.y-u.y)<=1)).length;
  }
  for(const u of s.units.filter(u=>built.has(u.id))){focusStats.buildingIncome+=unitYield(s,u).gold??0;if(!(u.buildNeed>0&&(u.buildDone??0)<u.buildNeed))completed.add(u.id);}
  const ex=exposureAction(budget);if(ex.noSite)focusStats.noSiteTurns++;if(ex.waitingGold)focusStats.waitingGoldTurns++;
 }
 for(let k=0;k<protocol.maxActions&&!s.winner;k++){
  decisionCount++;
  const ex=exposureAction(budget);
  const adjusted=ex.hold?{...budget,maxRecruit:0,maxUpgrade:0}:budget;
  const currentBudget=actor===side&&job.group==='batch'&&focusStats.recruited<focus.quota
   ? {...adjusted,mageBatch:{purchased:focusStats.recruited,quota:focus.quota,purchasedThisTurn:focusBoughtThisTurn,armyCap:protocol.aiArmyCap}}:adjusted;
  const controller=actor===side?variantAiNextAction:baselineAiNextAction;
  const action=ex.action??controller(s,currentBudget,denied);
  if(actor===side&&action)strategyDecisions.push({turn:s.turn,decision:k,action,reason:ex.reason??null,bought:focusStats.recruited,boughtThisTurn:focusBoughtThisTurn,gold:s.players[actor].gold});
  if(!action||action.type==='END_TURN')break;
  const res=step(action,{forced:!!ex.action});
  if(!res.ok){
   rejected[actor]++;if(badActions.length<12)badActions.push({turn:s.turn,actor,action,reason:res.reason});
   if(ex.action)throw Error('Exposure action rejected: '+res.reason);
   denied.add(aiActionKey(action));continue;
  }
  denied.clear();if(action.type==='RECRUIT')budget.recruited++;if(action.type==='UPGRADE')budget.upgraded++;
 }
 turnDecisions.push({turn:s.turn,actor,decisions:decisionCount});
 if(s.winner)break;
 const res=step({type:'END_TURN'});if(!res.ok){terminalError=res.reason;break;}
}
focusStats.completedBuildings=completed.size;
const outcome=s.winner?(s.winner===side?'win':'loss'):(terminalError?'error':'capped');
const final={gold:{A:s.players.A.gold,B:s.players.B.gold},cities:Object.fromEntries(['A','B'].map(p=>[p,s.cities.filter(c=>c.owner===p&&!c.ruined).length])),units:Object.fromEntries(['A','B'].map(p=>[p,s.units.filter(u=>u.owner===p).length])),paidAlive:s.units.filter(u=>paid.has(u.id)).length,maxEra:Object.fromEntries(['A','B'].map(p=>[p,Math.max(0,...s.cities.filter(c=>c.owner===p).map(c=>c.era))]))};
const actionHash=crypto.createHash('sha256').update(JSON.stringify(actions)).digest('hex');
const budgetAudit={maxRecruit:0,maxUpgrade:0,maxActions:0};let turnCounts={recruit:0,upgrade:0,actions:0};
for(const action of actions){
 if(action.type==='END_TURN'){turnCounts={recruit:0,upgrade:0,actions:0};continue;}
 turnCounts.actions++;if(action.type==='RECRUIT')turnCounts.recruit++;if(action.type==='UPGRADE')turnCounts.upgrade++;
 budgetAudit.maxRecruit=Math.max(budgetAudit.maxRecruit,turnCounts.recruit);budgetAudit.maxUpgrade=Math.max(budgetAudit.maxUpgrade,turnCounts.upgrade);budgetAudit.maxActions=Math.max(budgetAudit.maxActions,turnCounts.actions);
}
if(budgetAudit.maxRecruit>2||budgetAudit.maxUpgrade>1||budgetAudit.maxActions>50)throw Error('Turn budget violated '+JSON.stringify(budgetAudit));
const result={...job,variantFingerprint:protocol.variantFingerprints[job.group].fingerprint,testedController:job.group,opponentController:"baseline",strategyDecisions,turnDecisions,role:focus?.role??null,quota:focus?.quota??0,sourceFingerprint:protocol.sourceFingerprint,winner:s.winner??null,outcome,turns:s.turn,turnsConsumed:Math.min(protocol.cap,s.turn),prefixTurns,prepEndTurn,prefixHash,startStateHash,actionHash,actionCount:actions.length,budgetAudit,rejected,badActions,terminalError,focus:focusStats,recruitment,spend,income,upgrades,final,seconds:(performance.now()-started)/1000,memory:process.memoryUsage()};
const folder=path.join(dir,requested?'games':'pilot');fs.mkdirSync(folder,{recursive:true});
fs.writeFileSync(path.join(folder,job.id+'.json'),JSON.stringify(result));
const replay=buildMatchReport(s,new Date(),null,actions);
fs.writeFileSync(path.join(folder,job.id+'.replay.json.gz'),zlib.gzipSync(reportJson(replay)));
fs.writeFileSync(path.join(liveFolder,job.id+'.json'),JSON.stringify({id:job.id,turn:s.turn,seconds:result.seconds,fielded:focusStats.recruited,actions:actions.length,complete:true}));
console.log(JSON.stringify({id:job.id,outcome,turns:s.turn,forced:focusStats.forced,fielded:focusStats.recruited,seconds:result.seconds,actions:actions.length,rejected}));
