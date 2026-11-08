import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),option=(n,d)=>{const i=args.indexOf('--'+n);return i<0?d:args[i+1];};
const benchmark=path.resolve(option('benchmark',path.join(dir,'../unit-benchmark-20261108')));
const load=name=>JSON.parse(fs.readFileSync(path.join(benchmark,name),'utf8'));
const rules=await import(pathToFileURL(path.join(benchmark,'snapshot/core/rules.ts')).href);
const {createMatch}=await import(pathToFileURL(path.join(benchmark,'snapshot/core/setup.ts')).href);
const {playerView}=await import(pathToFileURL(path.join(benchmark,'snapshot/core/fog.ts')).href);
const {prepareSimulation,applyAction,canAttack,attackableTargets,siegeTargets,computeDamage,unitYield,recruitPriceOf,recruitSpawnCells,armySize,heroBlocked}=rules;
const protocol=load('protocol.json');
const targets=['mage','holy-knight-lord','ge'];
const jobs=protocol.jobs.filter(j=>targets.includes(j.target)||(!j.target&&[3,4].includes(j.stage)));
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const records=[],keyFrames=[];
const manhattan=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const unitBrief=(s,u)=>({id:u.id,type:u.type,name:s.unitTypes[u.type].name,owner:u.owner,x:u.x,y:u.y,hp:u.hp,armor:s.unitTypes[u.type].armor,magicRes:s.unitTypes[u.type].magicRes??0,flight:!!s.unitTypes[u.type].flight,category:s.unitTypes[u.type].category,buff:u.buff??null});
const hpLoss=(before,after,owner)=>before.units.filter(u=>u.owner===owner).reduce((n,u)=>n+Math.max(0,u.hp-(after.units.find(v=>v.id===u.id)?.hp??0)),0);
function sample(s,seat){
 const units=s.units.filter(u=>u.owner===seat),roster={};for(const u of units)roster[u.type]=(roster[u.type]??0)+1;
 return {turn:s.turn,seat,gold:s.players[seat].gold,cities:s.cities.filter(c=>c.owner===seat&&!c.ruined).map(c=>({id:c.id,era:c.era,hp:c.hp,x:c.x,y:c.y})),incomePreview:units.reduce((n,u)=>n+(unitYield(s,u).gold??0),0),army:armySize(s,seat),roster};
}
for(const job of jobs){
 const result=load('games/'+job.id+'.json');
 const report=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(benchmark,'games',job.id+'.replay.json.gz'))));
 assert.equal(sha(JSON.stringify(report.actions)),result.actionHash);
 let s=prepareSimulation(createMatch(report.config,report.seed));
 const target=protocol.targets.find(t=>t.id===job.target),paid=new Map(),purchases=[],upgrades=[],timeline=[],events=[],unused=[],bannerCasts=[],bannerHits=[],holds=new Set(),armyOutput={A:{},B:{}};
 const outputOf=(seat,type)=>(armyOutput[seat][type]??={attacks:0,skills:0,unitDamage:0,counterDamage:0,cityDamage:0});
 const bannerOrigins=new Map();let lastSample=0,initialBought=0,initialSpend=0,quotaCompleteTurn=null;
 for(let step=0;step<report.actions.length;step++){
  const action=report.actions[step],before=s,owner=s.current;
  if(s.turn!==lastSample){timeline.push(sample(s,'A'),sample(s,'B'));lastSample=s.turn;for(const life of paid.values())if(s.current===job.seat&&s.units.some(u=>u.id===life.id))life.ownTurnSamples++;}
  const focalActor=action.unitId&&paid.has(action.unitId),actor=action.unitId?s.units.find(u=>u.id===action.unitId):null;
  if(target&&s.turn>=result.prepEndTurn&&owner===job.seat&&initialBought<target.quota&&armySize(s,owner)<protocol.aiArmyCap&&!heroBlocked(s,owner,s.unitTypes[target.id])){
   const city=s.cities.filter(c=>c.owner===owner&&!c.ruined&&c.era>=target.era).find(c=>recruitSpawnCells(s,c.id,undefined,target.id).length>0);
   if(city&&recruitPriceOf(s,owner,s.unitTypes[target.id]).gold>s.players[owner].gold)holds.add(s.turn);
  }
  if(action.type==='END_TURN'&&target&&owner===job.seat){
   const view=playerView(s,owner).state;
   for(const u of view.units.filter(u=>paid.has(u.id)&&canAttack(u))){
    const shots=attackableTargets(view,u).filter(v=>computeDamage(view,u,v)>0);
    const cities=siegeTargets(view,u);
    if(shots.length||cities.length)unused.push({step,turn:s.turn,unit:unitBrief(s,u),targets:shots.map(v=>({unit:unitBrief(s,v),damage:computeDamage(view,u,v)})),cities:cities.map(c=>c.id)});
   }
  }
  let banner=null;
  if(focalActor&&action.type==='HERO_SKILL'&&action.skillId==='holy-banner'){
   const radius=s.unitTypes[actor.type].skills.find(k=>k.id===action.skillId).radius??2;
   const recipients=s.units.filter(u=>u.owner===owner&&u.hp>0&&manhattan(u,actor)<=radius);
   banner={step,turn:s.turn,caster:unitBrief(s,actor),movedBeforeCast:!!actor.moved,recipients:recipients.map(u=>unitBrief(s,u)),hpSaved:0,protectionEvents:0};
   bannerCasts.push(banner);for(const u of recipients)bannerOrigins.set(u.id,bannerCasts.length-1);
   keyFrames.push({job:job.id,kind:'banner-cast',step,turn:s.turn,state:s});
  }
  const buffed=target?.id==='holy-knight-lord'?s.units.filter(u=>u.owner===job.seat&&u.buff?.label==='圣旗'):[];
  let withoutBanner=null;
  if(buffed.length){
   const shadow=structuredClone(s);for(const u of shadow.units)if(u.owner===job.seat&&u.buff?.label==='圣旗')delete u.buff;
   const probe=applyAction(shadow,action);assert.ok(probe.ok);withoutBanner=probe.state;
  }
  const applied=applyAction(s,action);assert.ok(applied.ok,job.id+' step '+step);s=applied.state;
  if(actor&&(action.type==='ATTACK'||action.type==='HERO_SKILL')){
   const o=outputOf(owner,actor.type);if(action.type==='ATTACK')o.attacks++;else o.skills++;
   o.unitDamage+=hpLoss(before,s,owner==='A'?'B':'A');
   if(action.type==='ATTACK'){
    const defender=before.units.find(v=>v.id===action.targetId);
    if(defender)outputOf(defender.owner,defender.type).counterDamage+=Math.max(0,actor.hp-(s.units.find(v=>v.id===actor.id)?.hp??0));
   }
  }
  if(actor&&action.type==='SIEGE'){
   const old=before.cities.find(c=>c.id===action.cityId),now=s.cities.find(c=>c.id===action.cityId);outputOf(owner,actor.type).cityDamage+=Math.max(0,old.hp-(now?.hp??0));
  }
  if(action.type==='RECRUIT'){
   const ids=s.units.filter(u=>!before.units.some(v=>v.id===u.id)&&u.owner===owner&&u.type===action.unitType).map(u=>u.id);
   const purchase={step,turn:before.turn,owner,type:action.unitType,cost:before.players[owner].gold-s.players[owner].gold,site:action.cityId??action.campId??null,ids};purchases.push(purchase);
   if(target&&owner===job.seat&&action.unitType===target.id){
    if(initialBought<target.quota){initialBought++;initialSpend+=purchase.cost;if(initialBought===target.quota)quotaCompleteTurn=before.turn;}
    for(const id of ids)paid.set(id,{id,type:target.id,bornTurn:before.turn,bornStep:step,cost:purchase.cost,attacks:0,moves:0,skills:0,damage:0,cityDamage:0,counterDamage:0,hpLost:0,hpRecovered:0,ownTurnSamples:0,firstAttackTurn:null,death:null});
   }
  }
  if(action.type==='UPGRADE')upgrades.push({step,turn:before.turn,owner,cityId:action.cityId,era:s.cities.find(c=>c.id===action.cityId)?.era,cost:before.players[owner].gold-s.players[owner].gold,goldAfter:s.players[owner].gold,phase:before.turn<result.prepEndTurn?'preparation':'evaluation',beforeQuotaComplete:before.turn>=result.prepEndTurn&&owner===job.seat&&!!target&&initialBought<target.quota});
  if(focalActor){
   const life=paid.get(action.unitId);
   if(action.type==='MOVE')life.moves++;
   if(action.type==='HERO_SKILL')life.skills++;
   if(action.type==='ATTACK'){
    life.attacks++;life.firstAttackTurn??=before.turn;
    const damage=hpLoss(before,s,owner==='A'?'B':'A');life.damage+=damage;
    events.push({step,turn:before.turn,kind:'attack',actor:unitBrief(before,actor),target:unitBrief(before,before.units.find(u=>u.id===action.targetId)),damage});
   }
   if(action.type==='SIEGE'){
    const old=before.cities.find(c=>c.id===action.cityId),now=s.cities.find(c=>c.id===action.cityId);const damage=Math.max(0,old.hp-(now?.hp??0));life.cityDamage+=damage;
    events.push({step,turn:before.turn,kind:'siege',actor:unitBrief(before,actor),city:action.cityId,damage});
   }
  }
  if(action.type==='ATTACK'&&paid.has(action.targetId)&&owner!==job.seat){
   const life=paid.get(action.targetId);life.counterDamage+=Math.max(0,actor.hp-(s.units.find(u=>u.id===actor.id)?.hp??0));
  }
  for(const life of paid.values()){
   const old=before.units.find(u=>u.id===life.id),now=s.units.find(u=>u.id===life.id);if(!old)continue;
   const lost=Math.max(0,old.hp-(now?.hp??0));life.hpLost+=lost;life.hpRecovered+=Math.max(0,(now?.hp??0)-old.hp);
   if(lost)events.push({step,turn:before.turn,kind:'injury',unit:unitBrief(before,old),lost,action:action.type,attacker:actor?unitBrief(before,actor):null,primary:action.targetId===old.id});
   if(!now&&!life.death){
    life.death={step,turn:before.turn,action:action.type,attacker:actor?unitBrief(before,actor):null,lastHp:old.hp,primary:action.targetId===old.id,wasDisband:action.type==='DISBAND'};
    keyFrames.push({job:job.id,kind:'focal-death',step,turn:before.turn,state:before});
   }
  }
  if(withoutBanner){
   const actual=hpLoss(before,s,job.seat),ablated=hpLoss(before,withoutBanner,job.seat),saved=ablated-actual;
   const beneficiaries=before.units.filter(u=>u.owner===job.seat).map(u=>{const actualLoss=Math.max(0,u.hp-(s.units.find(v=>v.id===u.id)?.hp??0)),withoutLoss=Math.max(0,u.hp-(withoutBanner.units.find(v=>v.id===u.id)?.hp??0));return {...unitBrief(before,u),actualLoss,withoutLoss,hpSaved:withoutLoss-actualLoss,castIndex:u.buff?.label==='圣旗'?bannerOrigins.get(u.id)??null:null};}).filter(u=>u.actualLoss||u.withoutLoss);
   if(saved!==0||beneficiaries.some(u=>u.buff?.label==='圣旗')){
    const hit={step,turn:before.turn,action:action.type,actor:actor?unitBrief(before,actor):null,target:action.targetId??null,actualOwnHpLost:actual,withoutBannerOwnHpLost:ablated,hpSaved:saved,beneficiaries};bannerHits.push(hit);
    const credited=new Set();for(const u of beneficiaries)if(u.castIndex!==null&&u.hpSaved!==0){const cast=bannerCasts[u.castIndex];cast.hpSaved+=u.hpSaved;if(!credited.has(u.castIndex)){cast.protectionEvents++;credited.add(u.castIndex);}}
   }
  }
 }
 assert.equal(s.winner??null,result.winner);assert.equal(s.turn,result.turns);
 for(const seat of ['A','B'])assert.equal(s.players[seat].gold,result.final.gold[seat]);
 const lives=[...paid.values()];
 if(target){assert.equal(lives.length,result.focus.recruited);assert.equal(lives.reduce((n,l)=>n+l.damage,0),result.focus.unitDamage);assert.equal(lives.reduce((n,l)=>n+l.counterDamage,0),result.focus.counterDamage);assert.equal(lives.reduce((n,l)=>n+l.cityDamage,0),result.focus.cityDamage);}
 const record={id:job.id,target:job.target,seed:job.seed,seat:job.seat,stage:job.stage,outcome:result.outcome,winner:result.winner,turns:result.turns,prefixTurns:result.prefixTurns,prepEndTurn:result.prepEndTurn,actionHash:result.actionHash,actions:report.actions.length,finalVerified:true,initialBought,initialSpend,quota:target?.quota??null,quotaCompleteTurn,heldOwnTurns:[...holds],lives,purchases,upgrades,timeline,events,unused,bannerCasts,bannerHits,armyOutput,bannerHpSaved:bannerHits.reduce((n,h)=>n+h.hpSaved,0)};
 records.push(record);console.log(JSON.stringify({id:job.id,lives:lives.length,zeroAttackDeaths:lives.filter(l=>l.death&&!l.attacks).length,initialSpend,quotaCompleteTurn,held:holds.size,unused:unused.length,banners:bannerCasts.length,bannerHpSaved:record.bannerHpSaved}));
}
fs.writeFileSync(path.join(dir,'replay-review.json'),JSON.stringify({sourceFingerprint:protocol.sourceFingerprint,games:records,definitions:{bannerHpSaved:'Each fixed recorded action replayed with own holy-banner buffs removed only; signed difference in immediate clipped own-unit HP loss. Includes own attacks/counterattacks and automatic effects in END_TURN. Each action resets to its actual recorded pre-state, so local effects do not simulate a buff-free whole game. Per-cast attribution uses the last cast that actually assigned the recipient buff; any indirect contribution remains in the action total.',unused:'At the end of own turn, a tracked paid unit retains attack readiness and has a visible legal positive-damage attack or siege target. Legality does not establish that taking the action is tactically better.',incomePreview:'Native yield-function estimate at the sampled state, not a separately attributed cash ledger.'}},null,2));
fs.writeFileSync(path.join(dir,'key-frames.json.gz'),zlib.gzipSync(JSON.stringify(keyFrames)));
console.log(JSON.stringify({complete:true,games:records.length,keyFrames:keyFrames.length}));
