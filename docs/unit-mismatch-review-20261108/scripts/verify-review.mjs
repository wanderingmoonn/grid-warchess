import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),index=args.indexOf('--benchmark');
const benchmark=path.resolve(index>=0?args[index+1]:fs.existsSync(path.join(dir,'benchmark/protocol.json'))?path.join(dir,'benchmark'):path.join(dir,'../unit-benchmark-20261108'));
const read=f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
const summary=read('review-summary.json'),review=read('replay-review.json'),probes=read('mechanic-and-position-probes.json');
const protocol=JSON.parse(fs.readFileSync(path.join(benchmark,'protocol.json'),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const [name,hash] of Object.entries(protocol.fingerprints))assert.equal(sha(fs.readFileSync(path.join(benchmark,'snapshot/core',name))),hash,name);
assert.equal(summary.scope.totalGames,16);assert.equal(summary.cases.length,12);
for(const g of review.games){
 const original=JSON.parse(fs.readFileSync(path.join(benchmark,'games',g.id+'.json'),'utf8'));
 assert.equal(g.actionHash,original.actionHash);assert.equal(g.winner,original.winner);assert.equal(g.turns,original.turns);assert.equal(g.finalVerified,true);
 assert.equal(original.rejected.A+original.rejected.B,0);
 if(!g.target)continue;
 const c=summary.cases.find(c=>c.id===g.id);assert.ok(c);
 assert.equal(c.observedDamage,original.focus.unitDamage+original.focus.counterDamage);assert.equal(c.cityDamage,original.focus.cityDamage);assert.equal(c.totalPaidBodies,original.focus.recruited);
}
const byId=new Map(summary.totals.map(t=>[t.target,t]));
assert.deepEqual([byId.get('ge').observedDamage,byId.get('mage').observedDamage,byId.get('holy-knight-lord').observedDamage],[160,1260,161]);
assert.deepEqual([byId.get('ge').actualRecruitSpend,byId.get('mage').actualRecruitSpend,byId.get('holy-knight-lord').actualRecruitSpend],[510,2850,3700]);
assert.equal(byId.get('mage').fullHpAttackDeaths,15);assert.equal(byId.get('mage').deaths,19);
assert.deepEqual(byId.get('mage').killers,{'night-necromancer':14,phoenix:5});
for(const pair of summary.openingPairs){assert.equal(pair.geAfterTwo-pair.mageAfterTwo,240);assert.ok(pair.geAfterTwo>=540);assert.ok(pair.mageAfterTwo<540);}
const holyGames=review.games.filter(g=>g.target==='holy-knight-lord');
assert.equal(holyGames.reduce((n,g)=>n+g.bannerCasts.length,0),45);assert.equal(holyGames.reduce((n,g)=>n+g.bannerHpSaved,0),102);
for(const g of holyGames){assert.equal(g.heldOwnTurns.length,4);assert.equal(g.quotaCompleteTurn,g.seat==='A'?11:12);}
assert.equal(probes.bannerPositions.filter(c=>c.alternative).length,18);
for(const p of probes.bannerPositions.filter(c=>c.alternative)){assert.equal(p.alternative.legallyVerified,true);assert.ok(p.alternative.coverage>p.otherCombatRecipients);assert.ok(p.alternative.risk<=p.currentRisk);}
assert.equal(probes.mageMoves.length,87);assert.equal(probes.mageNewKnownLethalMoves.filter(m=>m.killedByKnownThreatNextTurn).length,0);
for(const check of probes.holySkillChecks){assert.equal(check.lordCanMoveAfterCast,true);assert.equal(check.lordCanAttackAfterCast,true);assert.ok(check.reduction>0);}
const result={complete:true,replays:16,unitCases:12,sourceFiles:Object.keys(protocol.fingerprints).length,sourceFilesMatch:true,rawOutcomesAndDamageMatch:true,ruleRejections:0,openingBudgetPairs:4,bannerLocalHpDifference:102,legalCoverageAlternatives:18,unitDefinitionsUnchanged:true,newFullMatches:0};
fs.writeFileSync(path.join(dir,'review-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
