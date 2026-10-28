import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { summarize } from './evaluate-ai.ts';
import { DEFAULT_CONFIG } from '../src/core/setup.ts';
type Result = Parameters<typeof summarize>[0][number];
function record(seed: number, newSide:'A'|'B',outcome:'win'|'loss'|'unresolved'): Result {
  return {profile:'fixture',seed,newSide,config:DEFAULT_CONFIG,version:4,outcome,
    winner:outcome==='unresolved'?null:outcome==='win'?newSide:newSide==='A'?'B':'A',
    turns:1,errors:{new:0,old:0},rejectionReasons:{},actions:{new:1,old:1},decisionMs:{new:1,old:1},capHits:0,
    doctrine:{rush:1,harass:0,boom:0},switches:0,largestWeightStep:0,abandonment:[],development:{economy:0,buildings:0,upgrades:0,heroes:0},final:[]};
}
let passed=0;
function test(name:string,run:()=>void){run();passed++;console.log(`✓ ${name}`);}
test('Identical A-favored controllers cannot claim a strength gain',()=>{
  const r=summarize(Array.from({length:32},(_,i)=>[record(i,'A','win'),record(i,'B','loss')]).flat());
  assert.equal(r.observedWinRate,0.5); assert.equal(r.clearlyBetter,false);
});
test('Unresolved games cannot become draws or inflate the acceptance result',()=>{
  const r=summarize(Array.from({length:32},(_,i)=>[record(i,'A','win'),record(i,'B','unresolved')]).flat());
  assert.equal(r.unresolved,32); assert.equal(r.decisiveWinRate,1); assert.equal(r.observedWinRate,0.5); assert.equal(r.clearlyBetter,false);
});
test('A tiny perfect sample is not accepted',()=>{
  const r=summarize([record(1,'A','win'),record(1,'B','win')]);
  assert.equal(r.clearlyBetter,false); assert.ok(r.pairedHoeffdingLower95<1);
});
test('A sufficiently large paired improvement passes the declared gate',()=>{
  const r=summarize(Array.from({length:64},(_,i)=>[record(i,'A',i<50?'win':'loss'),record(i,'B',i<50?'win':'loss')]).flat());
  assert.equal(r.clearlyBetter,true); assert.ok(r.pairedHoeffdingLower95>0.5);
});
test('Missing seats and duplicate seats are rejected',()=>{
  assert.throws(()=>summarize([record(1,'A','win')]));
  assert.throws(()=>summarize([record(1,'A','win'),record(1,'A','loss')]));
});
for (const id of ['004d48a','5fb8e5b']) test(`Frozen ${id} is byte-identical after reversing import rebasing`,()=>{
  const source=fs.readFileSync(new URL(`./baselines/ai-${id}.ts`,import.meta.url),'utf8').replaceAll('\r\n','\n').replaceAll("from '../../src/core/","from './");
  const meta=JSON.parse(fs.readFileSync(new URL(`./baselines/ai-${id}.json`,import.meta.url),'utf8')) as {sha256:string};
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),meta.sha256);
});
console.log(`${passed} evaluation tests passed`);
