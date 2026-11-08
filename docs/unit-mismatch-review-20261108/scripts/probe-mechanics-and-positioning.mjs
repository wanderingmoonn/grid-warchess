import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const argv=process.argv.slice(2),arg=(n,d)=>{const i=argv.indexOf('--'+n);return i<0?d:argv[i+1];};
const benchmark=path.resolve(arg('benchmark',path.join(dir,'../unit-benchmark-20261108')));
const rules=await import(pathToFileURL(path.join(benchmark,'snapshot/core/rules.ts')).href);
const {createMatch}=await import(pathToFileURL(path.join(benchmark,'snapshot/core/setup.ts')).href);
const {playerView}=await import(pathToFileURL(path.join(benchmark,'snapshot/core/fog.ts')).href);
const {prepareSimulation,applyAction,canStrike,computeDamage,previewAttack,reachableTiles,attackableTargets}=rules;
const p=JSON.parse(fs.readFileSync(path.join(benchmark,'protocol.json'),'utf8'));
const data=JSON.parse(fs.readFileSync(path.join(dir,'replay-review.json'),'utf8'));
const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const brief=(s,u)=>({id:u.id,type:u.type,name:s.unitTypes[u.type].name,x:u.x,y:u.y,hp:u.hp});
function danger(view,u,pos){
 const at={...u,...pos};let damage=0;const threats=[];
 for(const f of view.units.filter(f=>f.owner!==u.owner&&view.unitTypes[f.type].category==='combat')){
  const enemy={...f};delete enemy.heroBuff;
  if(!canStrike(view,enemy,at))continue;
  const d=computeDamage(view,enemy,at);damage+=d;
  if(d>=at.hp)threats.push({...brief(view,f),damage:d});
 }
 return {damage,lethal:threats};
}
function safeShots(before,view,u){
 const positions=[{x:u.x,y:u.y,stay:true},...[...reachableTiles(view,u).keys()].map(i=>({x:i%view.w,y:Math.floor(i/view.w),stay:i===u.y*view.w+u.x}))];
 const candidates=[];
 for(const pos of positions){
  if(!pos.stay&&view.units.some(v=>v.id!==u.id&&v.x===pos.x&&v.y===pos.y))continue;
  if(danger(view,u,pos).lethal.length)continue;
  const fake={...u,x:pos.x,y:pos.y},at={...view,units:view.units.map(v=>v.id===u.id?fake:v)};
  for(const foe of attackableTargets(at,fake)){
   const preview=previewAttack(at,fake,foe);
   if(preview.toDefender<=0||preview.toAttacker>=u.hp)continue;
   candidates.push({pos,target:brief(view,foe),damage:preview.toDefender+preview.toSplash,counter:preview.toAttacker,risk:danger(view,u,pos).damage});
  }
 }
 candidates.sort((a,b)=>b.damage-a.damage||a.risk-b.risk||a.counter-b.counter||distance(a.pos,u)-distance(b.pos,u));
 // Candidates are ranked from visible information. The full engine only validates legality.
 for(const c of candidates){
  let shadow=structuredClone(before);
  if(!c.pos.stay){const move=applyAction(shadow,{type:'MOVE',unitId:u.id,x:c.pos.x,y:c.pos.y});if(!move.ok)continue;shadow=move.state;}
  const shot=applyAction(shadow,{type:'ATTACK',unitId:u.id,targetId:c.target.id});if(!shot.ok)continue;
  if(!shot.state.units.some(v=>v.id===u.id))continue;
  return {...c,legallyVerified:true};
 }
 return null;
}
const mageMoves=[];
for(const record of data.games.filter(g=>g.target==='mage')){
 const report=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(benchmark,'games',record.id+'.replay.json.gz'))));
 let s=prepareSimulation(createMatch(report.config,report.seed));
 const paid=new Set(),pending=[];
 for(let step=0;step<report.actions.length;step++){
  const action=report.actions[step],before=s,owner=s.current;
  if(action.type==='MOVE'&&paid.has(action.unitId)){
   const view=playerView(s,owner).state,u=view.units.find(v=>v.id===action.unitId);
   const oldRisk=danger(view,u,u),newRisk=danger(view,u,{x:action.x,y:action.y});
   const item={game:record.id,step,turn:s.turn,unit:brief(s,u),to:{x:action.x,y:action.y},oldRisk,newRisk,actedBeforeMove:!!u.acted};
   if(!oldRisk.lethal.length&&newRisk.lethal.length&&!u.acted){item.safeAttackAlternative=safeShots(s,view,u);pending.push(item);}
   mageMoves.push(item);
  }
  if(action.type==='END_TURN'&&owner===record.seat)for(const move of pending.filter(m=>m.turn===before.turn)){
   const u=before.units.find(v=>v.id===move.unit.id);
   move.samePositionAtTurnEnd=!!u&&u.x===move.to.x&&u.y===move.to.y;
   move.knownThreatsStillAliveAtTurnEnd=move.newRisk.lethal.filter(f=>before.units.some(v=>v.id===f.id)).map(f=>f.id);
   const death=record.lives.find(l=>l.id===move.unit.id)?.death;
   move.killedByKnownThreatNextTurn=!!death&&death.turn===before.turn+1&&move.knownThreatsStillAliveAtTurnEnd.includes(death.attacker?.id);
  }
  const res=applyAction(s,action);assert.ok(res.ok);s=res.state;
  if(action.type==='RECRUIT'&&owner===record.seat&&action.unitType==='mage')for(const u of s.units)if(!before.units.some(v=>v.id===u.id)&&u.owner===owner&&u.type==='mage')paid.add(u.id);
 }
}
const keyFrames=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir,'key-frames.json.gz'))));
const bannerPositions=[];
for(const frame of keyFrames.filter(f=>f.kind==='banner-cast')){
 const record=data.games.find(g=>g.id===frame.job),cast=record.bannerCasts.find(c=>c.step===frame.step),s=frame.state;
 const u=s.units.find(v=>v.id===cast.caster.id),view=playerView(s,u.owner).state;
 const count=pos=>view.units.filter(v=>v.owner===u.owner&&v.id!==u.id&&view.unitTypes[v.type].category==='combat'&&distance(v,pos)<=2).length;
 const current=count(u),currentRisk=danger(view,u,u).damage;
 const options=[];
 if(!u.moved)for(const i of reachableTiles(view,u).keys()){
  const pos={x:i%view.w,y:Math.floor(i/view.w)};
  if(view.units.some(v=>v.id!==u.id&&v.x===pos.x&&v.y===pos.y))continue;
  const coverage=count(pos),risk=danger(view,u,pos).damage;
  if(coverage<=current||risk>currentRisk)continue;
  options.push({pos,coverage,risk});
 }
 options.sort((a,b)=>b.coverage-a.coverage||a.risk-b.risk||distance(a.pos,u)-distance(b.pos,u));
 let alternative=null;
 for(const option of options){
  const move=applyAction(structuredClone(s),{type:'MOVE',unitId:u.id,x:option.pos.x,y:option.pos.y});if(!move.ok)continue;
  const skill=applyAction(move.state,{type:'HERO_SKILL',unitId:u.id,skillId:'holy-banner'});if(!skill.ok)continue;
  if(!skill.state.units.some(v=>v.id===u.id))continue;
  alternative={...option,legallyVerified:true};break;
 }
 bannerPositions.push({game:frame.job,step:frame.step,turn:frame.turn,caster:cast.caster,movedBeforeCast:cast.movedBeforeCast,otherCombatRecipients:current,currentRisk,alternative});
}

// Controlled flat-terrain native-rule calculations: change no unit definitions or saved values.
function arena(){const s=prepareSimulation(createMatch(p.config,218600));s.units=[];s.current='A';s.winner=null;for(let y=4;y<=14;y++)for(let x=4;x<=14;x++)s.tiles[y*s.w+x]={terrain:'plain',cityId:null};return s;}
function put(s,type,owner,x,y,extras={}){const d=s.unitTypes[type];const u={id:'mechanic-'+s.nextUnitSeq++,type,owner,x,y,hp:d.maxHp,kills:0,moved:false,acted:false,...(d.ammo?{ammoLeft:d.ammo}:{}),...extras};s.units.push(u);return u;}
const matchups=[];
for(const type of ['ge','mage','holy-knight-lord'])for(const foe of ['cataphract','night-necromancer','phoenix','musketeer','rifleman','mg'])for(const gap of [1,3]){
 const s=arena(),a=put(s,type,'A',7,7),b=put(s,foe,'B',7+gap,7);
 matchups.push({type,foe,gap,canAttack:canStrike(s,a,b),damageIfLegal:canStrike(s,a,b)?computeDamage(s,a,b):null,enemyCanAttack:canStrike(s,b,a),enemyDamageIfLegal:canStrike(s,b,a)?computeDamage(s,b,a):null,ownHp:a.hp,enemyHp:b.hp});
}
const holySkillChecks=[];
for(const attackerType of ['musketeer','night-necromancer','mage','phoenix']){
 const s=arena(),lord=put(s,'holy-knight-lord','A',7,7),ally=put(s,'musketeer','A',7,8),enemy=put(s,attackerType,'B',8,8);
 const before=computeDamage(s,enemy,ally);
 const cast=applyAction(s,{type:'HERO_SKILL',unitId:lord.id,skillId:'holy-banner'});assert.ok(cast.ok);
 const savedLord=cast.state.units.find(v=>v.id===lord.id),savedAlly=cast.state.units.find(v=>v.id===ally.id);
 const after=computeDamage(cast.state,cast.state.units.find(v=>v.id===enemy.id),savedAlly);
 holySkillChecks.push({attackerType,before,after,reduction:before-after,allyBuff:savedAlly.buff,lordCanMoveAfterCast:!savedLord.moved,lordCanAttackAfterCast:!savedLord.acted});
}
const out={mageMoves,mageNewKnownLethalMoves:mageMoves.filter(m=>!m.oldRisk.lethal.length&&m.newRisk.lethal.length&&!m.actedBeforeMove),bannerPositions,matchups,holySkillChecks,limitations:['Threat checks use only enemies visible before the recorded move/cast, fixed enemy positions, native per-shot damage and no assumed hidden information. They omit enemy movement, multi-shot bursts, focus fire and future turn changes.','A legal local alternative with lower visible exposure is a positioning opportunity, not proof of a better whole-game strategy or win.','Controlled mechanic arenas use native definitions unchanged on flat terrain. They are diagnostic calculations, not extra outcome samples.']};
fs.writeFileSync(path.join(dir,'mechanic-and-position-probes.json'),JSON.stringify(out,null,2));
console.log(JSON.stringify({mageMoves:mageMoves.length,newKnownLethalMoves:out.mageNewKnownLethalMoves.length,killedByKnownNextTurn:out.mageNewKnownLethalMoves.filter(m=>m.killedByKnownThreatNextTurn).length,withSafeAttack:out.mageNewKnownLethalMoves.filter(m=>m.safeAttackAlternative).length,bannerCasts:bannerPositions.length,castsBeforeMove:bannerPositions.filter(c=>!c.movedBeforeCast).length,zeroOtherCombatRecipients:bannerPositions.filter(c=>c.otherCombatRecipients===0).length,legalImprovedCoverage:bannerPositions.filter(c=>c.alternative).length,matchups:matchups.length,holySkillChecks}));
