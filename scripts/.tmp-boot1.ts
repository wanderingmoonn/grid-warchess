import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const r = await build({ entryPoints:['src/main.ts'], bundle:true, format:'iife', write:false, loader:{'.css':'text'}, target:'es2022', logLevel:'silent' });
const code = r.outputFiles[0]!.text;
function boot(search: string) {
  const w = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url:`http://localhost/${search}`, pretendToBeVisual:true, runScripts:'outside-only',
  }).window as any;
  w.structuredClone ||= structuredClone;
  w.eval(code);
  return w;
}
for (const q of ['?exam=lone-city&debug', '?exam=lone-city']) {
  const w = boot(q);
  const hud = w.document.getElementById('debug-hud')?.textContent ?? '(没有 HUD)';
  console.log('---', q);
  console.log(hud.split('\n').slice(0,4).join('\n'));
  console.log('首页在不在:', !!w.document.querySelector('.title-screen'));
}
