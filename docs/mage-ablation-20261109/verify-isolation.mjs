import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url)),read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
const p=read('protocol.json'),deltas=read('source-deltas.json'),adapter=read('adapter-changes.json');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const baseline=fs.readFileSync(path.join(dir,'snapshot/core/ai.ts'),'utf8');
for(const [f,h]of Object.entries(p.fingerprints))assert.equal(hash(fs.readFileSync(path.join(dir,'snapshot/core',f))),h);
for(const g of p.groups){
 assert.equal(Object.values(g.flags).filter(Boolean).length,1);
 let ai=fs.readFileSync(path.join(dir,'variants',g.id,'core/ai.ts'),'utf8');
 if(g.id==='upgrade')assert.equal(ai,baseline);
 for(const d of [...deltas[g.id]].reverse()){assert.equal(ai.split(d.to).length,2);ai=ai.replace(d.to,d.from);}
 assert.equal(ai,baseline,g.id+' unrelated AI changes');
 for(const [f,h]of Object.entries(p.variantFingerprints[g.id].files))assert.equal(hash(fs.readFileSync(path.join(dir,'variants',g.id,'core',f))),h);
 for(const [f,h]of Object.entries(p.fingerprints))if(f!=='ai.ts')assert.equal(p.variantFingerprints[g.id].files[f],h,g.id+' changed rule '+f);
 assert.deepEqual(p.jobs.filter(j=>j.group===g.id).map(j=>j.seed+'/'+j.seat).sort(),['218600/A','218600/B','218601/A','218601/B']);
}
let game=fs.readFileSync(path.join(dir,'game.mjs'),'utf8');
for(const d of [...adapter.patches].reverse()){assert.equal(game.split(d.to).length,2);game=game.replace(d.to,d.from);}
assert.equal(hash(game),adapter.originalGameHash,'Primary metric/prefix/rule harness unexpectedly changed');
const result={complete:true,groups:3,jobs:12,onlyOneComponentPerGroup:true,allAiEditsReverseToOriginal:true,harnessEditsReverseToOriginal:true,changedRuleOrUnitFiles:[],originalSourceFingerprint:p.sourceFingerprint};
fs.writeFileSync(path.join(dir,'isolation-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
