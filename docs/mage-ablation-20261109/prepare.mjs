import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const original=path.resolve(dir,'../unit-benchmark-20261108'),combined=path.resolve(dir,'../unit-strategy-optimization-20261108');
const repo=path.resolve(dir,'../../grid-warchess-ai');
assert.ok(!fs.existsSync(path.join(dir,'seal.json')),'Experiment sealed; do not change its inputs.');
const read=(root,n)=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const prior=read(original,'protocol.json'),previous=read(combined,'protocol.json');
for(const [file,sha]of Object.entries(prior.fingerprints))assert.equal(hash(fs.readFileSync(path.join(original,'snapshot/core',file))),sha,file);
assert.equal(previous.sourceFingerprint,prior.sourceFingerprint);
const helper='ai-mage-experiment.ts';
fs.cpSync(path.join(original,'snapshot/core'),path.join(dir,'snapshot/core'),{recursive:true});
fs.copyFileSync(path.join(repo,'src/core',helper),path.join(dir,'snapshot/core',helper));
const groups=[
 {id:'upgrade',name:'仅先升级',flags:{upgrade:true,batch:false,position:false},policy:'Before the first target purchase, pay the native era4 upgrade if cash covers it plus one mage and no visible combat enemy is within5; then retain original packet procurement and original AI.'},
 {id:'batch',name:'仅分批采购',flags:{upgrade:false,batch:true,position:false},policy:'At most one of the initial four mages per own turn; reserve the next mage price from normal recruit/build/upgrade candidates while the goal remains legal and incomplete. No escort purchases, ordinary composition cap, early-upgrade rule or new positioning.'},
 {id:'position',name:'仅站位调整',flags:{upgrade:false,batch:false,position:true},policy:'Original first-four packet and ordinary procurement; only the exact prior mage movement/stay bias is enabled. Holy knight and other unit logic remains original.'},
];
const variantFingerprints={},sourceDeltas={};
const base=fs.readFileSync(path.join(original,'snapshot/core/ai.ts'),'utf8');
for(const group of groups){
 const core=path.join(dir,'variants',group.id,'core');fs.cpSync(path.join(dir,'snapshot/core'),core,{recursive:true});
 let ai=base;const patches=[];
 const change=(from,to)=>{assert.equal(ai.split(from).length,2,'Unexpected AI anchor');ai=ai.replace(from,to);patches.push({from,to});};
 if(group.id==='batch'){
  change("import { airDefenseFor, type AirDefense } from './ai-air-defense.ts';","import { airDefenseFor, type AirDefense } from './ai-air-defense.ts';\nimport { mageBatchActionAllowed } from './ai-mage-experiment.ts';");
  const anchor='    if (rejected.has(aiActionKey(action))) { candidates.splice(i,1); continue; }';
  change(anchor,anchor+'\n    if(depth===0&&!mageBatchActionAllowed(view,budget,action)){candidates.splice(i,1);continue;}');
 }
 if(group.id==='position'){
  change("import { airDefenseFor, type AirDefense } from './ai-air-defense.ts';","import { airDefenseFor, type AirDefense } from './ai-air-defense.ts';\nimport { magePositionBias } from './ai-mage-experiment.ts';");
  change('      const score = scoreMove(s, unit, x, y, all, traits);',"      const score = scoreMove(s, unit, x, y, all, traits)\n        + (aiLevelOf(s)==='advanced'?magePositionBias(s,unit,x,y,all.tactical):0);");
  change('    const stay = holdScore(s, unit, all, traits);',"    const stay = holdScore(s, unit, all, traits)\n      + (aiLevelOf(s)==='advanced'?magePositionBias(s,unit,unit.x,unit.y,all.tactical):0);");
 }
 fs.writeFileSync(path.join(core,'ai.ts'),ai);
 let reversed=ai;for(const p of [...patches].reverse())reversed=reversed.replace(p.to,p.from);assert.equal(reversed,base);
 const fingerprints=Object.fromEntries([...Object.keys(prior.fingerprints),helper].sort().map(f=>[f,hash(fs.readFileSync(path.join(core,f)))]));
 variantFingerprints[group.id]={files:fingerprints,fingerprint:hash(JSON.stringify(fingerprints))};sourceDeltas[group.id]=patches;
 for(const [f,h]of Object.entries(prior.fingerprints))if(f!=='ai.ts')assert.equal(fingerprints[f],h,group.id+' changed rule file '+f);
}
const target=prior.targets.find(t=>t.id==='mage');
const jobs=groups.flatMap(g=>prior.jobs.filter(j=>j.target==='mage').map(j=>({...j,id:'mage-'+g.id+'-'+j.seed+'-'+j.seat,referenceId:j.id,group:g.id})));
const protocol={version:1,createdAt:new Date().toISOString(),question:'Isolate mage upgrade-first, staged procurement and positioning against the frozen original AI.',
 config:prior.config,seeds:prior.seeds,cap:prior.cap,maxActions:prior.maxActions,budget:prior.budget,aiArmyCap:prior.aiArmyCap,
 targets:[target],jobs,groups,sourceFingerprint:prior.sourceFingerprint,fingerprints:prior.fingerprints,variantFingerprints,
 historical:{original:'../unit-benchmark-20261108',combined:'../unit-strategy-optimization-20261108',combinedFingerprint:previous.candidateFingerprint,combinedIncludesAdditionalRules:true},
 interpretation:'Three one-component changes versus original, four paired outcomes each. Previous combined arm is contextual and includes extra composition/holy-knight logic; no additivity or factorial interaction estimate.',
 controls:{opponent:'Frozen original advanced AI',testSide:'Only the selected component, no mage-stat or rule changes',noTuningAfterSeal:true},
 metricDefinitions:{outcome:'Native winner within200 single-side turns; capped separate from draw/loss.',damage:'Immediate clipped unit HP loss from paid mages, including counters; city HP separate.',batch:'One of the first four mages per own turn AND keep next-mage gold available; these two linked operations form one procurement component.'}};
fs.writeFileSync(path.join(dir,'protocol.json'),JSON.stringify(protocol,null,2));
fs.writeFileSync(path.join(dir,'source-deltas.json'),JSON.stringify(sourceDeltas,null,2));
let game=fs.readFileSync(path.join(original,'game-policy-original.mjs'),'utf8');
const originalGameHash=hash(game),patches=[];
const change=(from,to)=>{assert.equal(game.split(from).length,2,'Unexpected harness anchor '+from.slice(0,55));game=game.replace(from,to);patches.push({from,to});};
change("import {aiNextAction,aiActionKey,AI_MAX_STEPS,DEFAULT_BUDGET} from './snapshot/core/ai.ts';","import {aiNextAction as baselineAiNextAction,aiActionKey,AI_MAX_STEPS,DEFAULT_BUDGET} from './snapshot/core/ai.ts';\nimport {mageOpeningUpgrade} from './snapshot/core/ai-mage-experiment.ts';");
change("if(!job)throw Error('Unknown job '+requested);", "if(!job)throw Error('Unknown job '+requested);\nif(!protocol.groups.some(g=>g.id===job.group))throw Error('Unknown variant');\nconst variantAiNextAction=(await import('./variants/'+job.group+'/core/ai.ts')).aiNextAction;");
change('const badActions=[];', 'const badActions=[];\nconst strategyDecisions=[],turnDecisions=[];let focusBoughtThisTurn=0;');
change("if(action.type==='RECRUIT'){", "if(action.type==='RECRUIT'){\n  if(actor===side&&action.unitType===focus?.id)focusBoughtThisTurn++;");
change('function exposureAction(budget){', "function exposureAction(budget){\n if(focus&&s.current===side&&focusStats.recruited<focus.quota){\n  if(job.group==='upgrade'){const upgrade=mageOpeningUpgrade(playerView(s,side).state,budget,focusStats.recruited);if(upgrade)return {action:upgrade,hold:false,reason:'upgrade-first'};}\n  if(job.group==='batch'&&focusBoughtThisTurn>=1)return {action:null,hold:false,reason:'batch-limit'};\n }");
change('const actor=s.current,budget={...DEFAULT_BUDGET},denied=new Set();','const actor=s.current,budget={...DEFAULT_BUDGET},denied=new Set();focusBoughtThisTurn=0;let decisionCount=0;');
change('  const ex=exposureAction(budget);\n  const adjusted=', '  decisionCount++;\n  const ex=exposureAction(budget);\n  const adjusted=');
change('  const action=ex.action??aiNextAction(s,adjusted,denied);', "  const currentBudget=actor===side&&job.group==='batch'&&focusStats.recruited<focus.quota\n   ? {...adjusted,mageBatch:{purchased:focusStats.recruited,quota:focus.quota,purchasedThisTurn:focusBoughtThisTurn,armyCap:protocol.aiArmyCap}}:adjusted;\n  const controller=actor===side?variantAiNextAction:baselineAiNextAction;\n  const action=ex.action??controller(s,currentBudget,denied);\n  if(actor===side&&action)strategyDecisions.push({turn:s.turn,decision:k,action,reason:ex.reason??null,bought:focusStats.recruited,boughtThisTurn:focusBoughtThisTurn,gold:s.players[actor].gold});");
change(" if(s.winner)break;\n const res=step({type:'END_TURN'});", " turnDecisions.push({turn:s.turn,actor,decisions:decisionCount});\n if(s.winner)break;\n const res=step({type:'END_TURN'});");
change('const result={...job,','const result={...job,variantFingerprint:protocol.variantFingerprints[job.group].fingerprint,testedController:job.group,opponentController:"baseline",strategyDecisions,turnDecisions,');
change("new Date('2026-11-08T00:00:00Z')",'new Date()');
let reversed=game;for(const p of [...patches].reverse())reversed=reversed.replace(p.to,p.from);assert.equal(hash(reversed),originalGameHash);
fs.writeFileSync(path.join(dir,'game.mjs'),game);
fs.writeFileSync(path.join(dir,'adapter-changes.json'),JSON.stringify({originalGameHash,patches,metricsAndRulesRestoredExactly:true},null,2));
fs.writeFileSync(path.join(dir,'task-state.json'),JSON.stringify({status:'active',objective:'Three sealed mage component arms,12 paired games, replay audit and GitHub publication.',jobs:jobs.length,remaining:['Pass strategy checks and seal.','Complete12 outcomes.','Replay, compare and publish.']},null,2));
console.log(JSON.stringify({jobs:jobs.length,groups:groups.map(g=>g.id),sourceFingerprint:prior.sourceFingerprint,variantFingerprints:Object.fromEntries(groups.map(g=>[g.id,variantFingerprints[g.id].fingerprint]))}));
