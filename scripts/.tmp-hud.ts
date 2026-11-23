import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const r = await build({ entryPoints:['src/main.ts'], bundle:true, format:'iife', write:false, loader:{'.css':'text'}, target:'es2022', logLevel:'silent' });
const code = r.outputFiles[0]!.text;
const snap = JSON.parse(readFileSync('exams/S-000/snap.json','utf8'));
const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url:'http://localhost/?loadSave=1&debug=v4', pretendToBeVisual:true, runScripts:'outside-only',
}).window as any;
w.structuredClone ||= structuredClone;
w.localStorage.setItem('warchess:match:v1', JSON.stringify(snap));
w.eval(code);
const el = w.document.getElementById('v4-hud');
console.log('面板存在:', !!el);
const html = el?.innerHTML ?? '';
console.log('长度', html.length, '| svg', (html.match(/<svg/g)||[]).length, '| circle', (html.match(/<circle/g)||[]).length, '| rect', (html.match(/<rect/g)||[]).length);
console.log('文本:', (el?.textContent ?? '').replace(/\s+/g,' ').slice(0,220));
