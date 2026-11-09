import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url)),read=(root,n)=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const ref=fs.existsSync(path.join(dir,'reference/original/protocol.json'))?path.join(dir,'reference/original'):path.resolve(dir,'../unit-benchmark-20261108');
const priorReviewDir=fs.existsSync(path.join(dir,'reference/original/replay-review.json'))?path.join(dir,'reference/original'):path.resolve(dir,'../unit-mismatch-review-20261108');
const combo=fs.existsSync(path.join(dir,'reference/combined/protocol.json'))?path.join(dir,'reference/combined'):path.resolve(dir,'../unit-strategy-optimization-20261108');
const p=read(dir,'protocol.json'),seal=read(dir,'seal.json'),original=read(ref,'protocol.json'),prior=read(priorReviewDir,'replay-review.json'),combined=read(combo,'replay-review.json'),now=read(dir,'replay-review.json');
const probes=read(dir,'mechanic-and-position-probes.json'),oldProbes=read(priorReviewDir,'mechanic-and-position-probes.json'),comboProbes=read(combo,'mechanic-and-position-probes.json');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const {createMatch}=await import(pathToFileURL(path.join(dir,'snapshot/core/setup.ts')).href);
const {prepareSimulation,applyAction}=await import(pathToFileURL(path.join(dir,'snapshot/core/rules.ts')).href);
const {playerView}=await import(pathToFileURL(path.join(dir,'snapshot/core/fog.ts')).href);
const sum=(rows,key)=>rows.reduce((n,r)=>n+(r[key]??0),0);
const median=a=>{const x=a.filter(x=>x!==null).sort((a,b)=>a-b);return x.length?(x[Math.floor((x.length-1)/2)]+x[Math.ceil((x.length-1)/2)])/2:null;};
const replay=(root,id)=>JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root,'games',id+'.replay.json.gz'))));
for(const [file,sha]of Object.entries(seal.harness))assert.equal(hash(fs.readFileSync(path.join(dir,file))),sha,'Sealed file '+file);
assert.deepEqual(p.config,original.config);for(const k of ['cap','maxActions','budget','aiArmyCap','seeds'])assert.deepEqual(p[k],original[k]);
for(const [file,sha]of Object.entries(p.fingerprints))assert.equal(hash(fs.readFileSync(path.join(dir,'snapshot/core',file))),sha);
for(const group of p.groups){
 const fp=p.variantFingerprints[group.id];assert.equal(hash(JSON.stringify(fp.files)),fp.fingerprint);assert.equal(seal.variants[group.id],fp.fingerprint);
 for(const [file,sha]of Object.entries(fp.files))assert.equal(hash(fs.readFileSync(path.join(dir,'variants',group.id,'core',file))),sha);
 for(const [file,sha]of Object.entries(p.fingerprints))if(file!=='ai.ts')assert.equal(fp.files[file],sha);
}
assert.equal(p.jobs.length,12);assert.equal(new Set(p.jobs.map(j=>j.id)).size,12);
const records=[];
function verifyRaw(raw,g,r){
 assert.equal(raw.terminalError,null);assert.equal(raw.outcome==='error',false);assert.equal(g.finalVerified,true);
 assert.equal(g.actionHash,raw.actionHash);assert.equal(hash(JSON.stringify(r.actions)),raw.actionHash);
 assert.equal(g.winner,raw.winner);assert.equal(g.turns,raw.turns);assert.equal(g.lives.length,raw.focus.recruited);
 assert.equal(sum(g.lives,'damage')+sum(g.lives,'counterDamage'),raw.focus.unitDamage+raw.focus.counterDamage);
 assert.equal(sum(g.lives,'cost'),raw.focus.spent);assert.equal(g.initialBought,4);
 assert.ok(raw.budgetAudit.maxRecruit<=2&&raw.budgetAudit.maxUpgrade<=1&&raw.budgetAudit.maxActions<=50);
 assert.equal(r.fog,true);assert.equal(r.v,3);assert.equal(createMatch(r.config,r.seed).version,4);
}
function brief(raw,g,seat){
 return {outcome:raw.outcome,turnsConsumed:raw.turnsConsumed,paid:raw.focus.recruited,spend:raw.focus.spent,attacks:raw.focus.attacks,
  damage:raw.focus.unitDamage+raw.focus.counterDamage,cityDamage:raw.focus.cityDamage,quotaDamage:g.lives.slice(0,4).reduce((n,l)=>n+l.damage+l.counterDamage,0),
  firstEra4:g.upgrades.find(u=>u.owner===seat&&u.era===4)?.turn??null,firstMage:raw.focus.firstRecruitTurn,quotaComplete:g.quotaCompleteTurn,
  firstFourPurchaseTurns:g.lives.slice(0,4).map(l=>l.bornTurn),deaths:g.lives.filter(l=>l.death&&!l.death.wasDisband).length,
  otherRecruitsBeforeQuota:g.purchases.filter(x=>x.owner===seat&&x.type!=='mage'&&x.turn<=g.quotaCompleteTurn).map(x=>({turn:x.turn,type:x.type,cost:x.cost})),
  rejected:raw.rejected.A+raw.rejected.B,ownRecruitSpend:raw.spend[seat]};
}
for(const job of p.jobs){
 const before=read(ref,'games/'+job.referenceId+'.json'),after=read(dir,'games/'+job.id+'.json');
 const a=prior.games.find(g=>g.id===job.referenceId),b=now.games.find(g=>g.id===job.id);assert.ok(a&&b);
 const ra=replay(ref,job.referenceId),rb=replay(dir,job.id);verifyRaw(before,a,ra);verifyRaw(after,b,rb);
 assert.equal(after.group,job.group);assert.equal(after.testedController,job.group);assert.equal(after.opponentController,'baseline');
 assert.equal(after.variantFingerprint,p.variantFingerprints[job.group].fingerprint);
 assert.equal(after.prefixHash,before.prefixHash);assert.equal(after.startStateHash,before.startStateHash);assert.deepEqual(ra.config,rb.config);
 assert.ok(after.turnDecisions.every(d=>d.decisions<=50));
 if(job.group==='batch')assert.equal(new Set(b.lives.slice(0,4).map(l=>l.bornTurn)).size,4,'Initial batch cap');
 let index=0;while(index<Math.min(ra.actions.length,rb.actions.length)&&JSON.stringify(ra.actions[index])===JSON.stringify(rb.actions[index]))index++;
 let firstDivergence=null;
 if(index<Math.max(ra.actions.length,rb.actions.length)){
  let s=prepareSimulation(createMatch(ra.config,ra.seed));for(let i=0;i<index;i++){const a=applyAction(s,ra.actions[i]);assert.ok(a.ok);s=a.state;}
  const view=playerView(s,s.current).state;
  firstDivergence={step:index,turn:s.turn,current:s.current,gold:s.players[s.current].gold,before:ra.actions[index]??null,after:rb.actions[index]??null,
   ownCombat:view.units.filter(u=>u.owner===s.current&&view.unitTypes[u.type].category==='combat').map(u=>({id:u.id,type:u.type,x:u.x,y:u.y,hp:u.hp})),
   visibleEnemyCombat:view.units.filter(u=>u.owner!==s.current&&view.unitTypes[u.type].category==='combat').map(u=>({id:u.id,type:u.type,x:u.x,y:u.y,hp:u.hp}))};
 }
 records.push({...job,before:brief(before,a,job.seat),after:brief(after,b,job.seat),sameActionHash:before.actionHash===after.actionHash,firstDivergence,
  forcedUpgrades:after.strategyDecisions.filter(d=>d.reason==='upgrade-first'&&d.action.type==='UPGRADE').map(d=>({turn:d.turn,action:d.action,gold:d.gold}))});
}
const historicJobs=p.jobs.filter(j=>j.group==='upgrade');
for(const j of historicJobs){const raw=read(combo,'games/'+j.referenceId+'.json'),g=combined.games.find(g=>g.id===j.referenceId);verifyRaw(raw,g,replay(combo,j.referenceId));}
const killers=lives=>{const r={};for(const l of lives.filter(l=>l.death&&!l.death.wasDisband)){const k=l.death.attacker?.type??l.death.action;r[k]=(r[k]??0)+1;}return r;};
function aggregate(id,name,games,rawRoot,probe){
 const g=games.filter(g=>g.target==='mage'),lives=g.flatMap(g=>g.lives),cohort=g.flatMap(g=>g.lives.slice(0,4));
 const rows=g.map(x=>read(rawRoot,'games/'+x.id+'.json'));
 const unused=g.flatMap(x=>x.unused),moves=probe.mageMoves.filter(m=>g.some(x=>x.id===m.game));
 const known=probe.mageNewKnownLethalMoves.filter(m=>g.some(x=>x.id===m.game));
 return {id,name,games:g.length,outcomes:{win:g.filter(x=>x.outcome==='win').length,loss:g.filter(x=>x.outcome==='loss').length,capped:g.filter(x=>x.outcome==='capped').length},
  paid:lives.length,recruitSpend:sum(lives,'cost'),damage:sum(lives,'damage')+sum(lives,'counterDamage'),activeDamage:sum(lives,'damage'),counterDamage:sum(lives,'counterDamage'),cityDamage:sum(lives,'cityDamage'),attacks:sum(lives,'attacks'),
  damagePer100Gold:(sum(lives,'damage')+sum(lives,'counterDamage'))/sum(lives,'cost')*100,
  quotaCohort:{paid:cohort.length,spend:sum(cohort,'cost'),damage:sum(cohort,'damage')+sum(cohort,'counterDamage'),attacks:sum(cohort,'attacks'),deaths:cohort.filter(l=>l.death&&!l.death.wasDisband).length},
  deaths:lives.filter(l=>l.death&&!l.death.wasDisband).length,zeroAttackDeaths:lives.filter(l=>l.death&&!l.death.wasDisband&&!l.attacks).length,
  fullHpAttackDeaths:lives.filter(l=>l.death?.action==='ATTACK'&&l.death.lastHp===24).length,killers:killers(lives),
  medianOwnTurnsToFirstAttack:median(lives.filter(l=>l.firstAttackTurn!==null).map(l=>(l.firstAttackTurn-l.bornTurn)/2)),
  firstEra4:g.map(x=>x.upgrades.find(u=>u.owner===x.seat&&u.era===4)?.turn??null),firstMages:g.map(x=>x.lives[0]?.bornTurn??null),quotaComplete:g.map(x=>x.quotaCompleteTurn),
  unusedPositiveShots:unused.length,unusedCombatOrCity:unused.filter(u=>u.cities.length||u.targets.some(t=>t.unit.category==='combat')).length,
  moves:moves.length,newKnownStationaryLethalMoves:known.length,killedByKnownNextTurn:known.filter(m=>m.killedByKnownThreatNextTurn).length,
  rejections:rows.reduce((n,x)=>n+x.rejected.A+x.rejected.B,0)};
}
const originalGames=prior.games.filter(g=>g.target==='mage'),comboGames=combined.games.filter(g=>g.target==='mage');
const totals=[aggregate('original','原始策略',originalGames,ref,oldProbes),...p.groups.map(g=>aggregate(g.id,g.name,now.games.filter(x=>x.group===g.id),dir,probes)),aggregate('combined_reference','上一轮组合（参考）',comboGames,combo,comboProbes)];
assert.ok(totals.every(t=>t.games===4&&t.quotaCohort.paid===16&&t.quotaCohort.spend===2400));
const paired=historicJobs.map(j=>({seed:j.seed,seat:j.seat,original:brief(read(ref,'games/'+j.referenceId+'.json'),originalGames.find(g=>g.id===j.referenceId),j.seat),
 ...Object.fromEntries(p.groups.map(g=>[g.id,records.find(r=>r.group===g.id&&r.referenceId===j.referenceId).after])),
 combined_reference:brief(read(combo,'games/'+j.referenceId+'.json'),comboGames.find(g=>g.id===j.referenceId),j.seat)}));
function armySummary(game){
 const rows=Object.entries(game.armyOutput[game.seat]).map(([type,x])=>({type,damage:x.unitDamage+x.counterDamage,cityDamage:x.cityDamage})).sort((a,b)=>b.damage-a.damage);
 return {totalImmediateUnitDamage:sum(rows,'damage'),byType:rows,upgrades:game.upgrades.filter(u=>u.owner===game.seat)};
}
const comparison={scope:{newGames:12,reusedOriginal:4,reusedCombined:4,seeds:p.seeds,perGroup:4,nativeStateVersion:4,replaySchemaVersion:3,fog:true,cap:200},
 interpretation:p.interpretation,baselineFingerprint:p.sourceFingerprint,variantFingerprints:seal.variants,totals,cases:records,paired,
 mechanismCases:{batch218600B:{before:armySummary(originalGames.find(g=>g.id==='mage-218600-B')),after:armySummary(now.games.find(g=>g.id==='mage-batch-218600-B'))}},
 limits:['Three one-component comparisons against original; not a full factorial experiment and not an estimate of each contribution inside the previous combined policy.',
  'The batch component includes purchase frequency and a next-mage cash reserve; those two operations are not isolated from each other.',
  'Four seats on two maps do not establish population win rates. Capped is unresolved, not a formal draw.',
  'Only first-four cohort is equal mage spending across all arms. Whole-army budgets and later ordinary purchases are endogenous.',
  'Visible stationary-shot probes omit enemy movement, focus fire and hidden units; local alternatives are not whole-game counterfactual outcomes.']};
fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(comparison,null,2));
const validation={complete:true,newNativeReplays:12,reusedOriginal:4,reusedCombined:4,totalCompared:20,sealedFilesMatch:true,matchedInitialStates:true,matchedConfigs:true,
 ruleAndUnitFilesUnchanged:true,oneComponentPerGroup:read(dir,'isolation-validation.json').onlyOneComponentPerGroup,rejections:totals.filter(t=>!['original','combined_reference'].includes(t.id)).reduce((n,t)=>n+t.rejections,0),budgetViolations:0,initialQuotaCompleted:12,
 nativeStateVersion:4,replaySchemaVersion:3,variantFingerprints:seal.variants};
fs.writeFileSync(path.join(dir,'comparison-validation.json'),JSON.stringify(validation,null,2));
console.log(JSON.stringify({validation,totals},null,2));
