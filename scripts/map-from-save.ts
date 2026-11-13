/**
 * 把一份**对局存档**（`{"kind":"warchess-match", state:{...}}`）转成地图文本。
 *
 * 为什么需要：存档和地图是两个东西——
 *   · 存档是"这一局"，带兵、带钱、带回合，只有本机能打开；
 *   · 地图是"这张脸"，只有地形和城位，别人能选。
 * 上帝模式画完存下来的是**第 1 回合的存档**，所以"能不能上传到玩家上传地图"
 * 的答案是"不能直接传，但一转就是一张图"。
 *
 * 转换走的正是游戏内「导出地图」用的同一个函数 `stateToFixedMap`，
 * 所以这里的校验结果和界面上按那个按钮的结果**逐字一致**——不存在两套口径。
 *
 * 用法：
 *   node --experimental-strip-types scripts/map-from-save.ts 存档.json
 *   ... --name 红树林 --out .tmp/maps/红树林.txt
 *
 * 输出：校验结论（能不能传）、地形提醒（用了哪些扩展地形）、地图文本。
 */

import fs from 'node:fs';
import path from 'node:path';
import { stateToFixedMap } from '../src/core/map-export.ts';
import { mapToText, parseMapFile, validateFixedMap } from '../src/core/fixed-maps.ts';
import type { GameState } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const src = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!src) {
  console.error('用法：node --experimental-strip-types scripts/map-from-save.ts <存档.json> [--name 名字] [--out 输出.txt]');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(src, 'utf8')) as {
  kind?: string;
  state?: GameState;
} & Partial<GameState>;

// 两种情况都收：完整存档（有 kind/state）和裸 state
const state = (raw.kind ? raw.state : raw) as GameState | undefined;
if (!state || !state.tiles || !state.w || !state.h) {
  console.error(`✗ ${src} 里没有找到局面（需要 tiles/w/h）`);
  process.exit(1);
}

const fallbackName = path.basename(src).replace(/\.(json|txt)$/i, '');
const name = argOf('name', fallbackName);

console.log(`来源：${path.basename(src)}`);
console.log(`类型：${raw.kind ?? '(裸 state)'}　尺寸 ${state.w}×${state.h}　`
  + `城 ${state.cities?.length ?? 0} 座　兵 ${state.units?.length ?? 0} 个　回合 ${state.turn ?? '?'}`);

if (raw.kind && raw.kind !== 'warchess-match') {
  console.log(`注意：kind 是 "${raw.kind}"，不是对局存档。也照 state 处理了。`);
}
if ((state.units?.length ?? 0) > 0) {
  console.log('注意：这一局里已经有兵了。地图只导出地形和城位，兵会被丢掉——'
    + '如果那些兵是你用来标记出生点的，记住它们不会跟着走。');
}

const res = stateToFixedMap(state, name);
if (!res.ok) {
  console.log('\n✗ 不能作为地图上传：');
  for (const e of res.errors) console.log(`   · ${e}`);
  process.exit(1);
}

const map = res.map!;
console.log(`\n✓ 可以上传（过的是游戏内「导出地图」同一套校验：${validateFixedMap(map).ok ? '通过' : '异常'}）`);
console.log(`  尺寸 ${map.w}×${map.h}　A 方 ${map.citiesA.length} 城　B 方 ${map.citiesB.length} 城`);
if (res.note) console.log(`  提醒：${res.note}`);

const text = mapToText(map);

// 自检：把刚生成的文本再解析一遍，确认"导出的东西能被自己读回来"
// （这是能发现"地形字符表两处不一致"这类问题的唯一便宜办法）
const back = parseMapFile(text);
if (!back.ok) {
  console.log(`\n✗ 自检失败：导出的文本自己解析不回来 —— ${back.errors.join('；')}`);
  console.log('  这通常意味着地形字符表和 parseMapFile 又不一致了。');
  process.exit(1);
}
const rt = back.map;
const same =
  rt.w === map.w &&
  rt.h === map.h &&
  rt.rows.join('\n') === map.rows.join('\n') &&
  rt.citiesA.length === map.citiesA.length &&
  rt.citiesB.length === map.citiesB.length;
console.log(`  自检：文本 → 解析 ${same ? '一致' : '**不一致**'}（${rt.w}×${rt.h}，`
  + `A ${rt.citiesA.length} / B ${rt.citiesB.length}）`);
if (!same) {
  console.log('  ✗ 往返不一致：导出的图和读回来的图不是同一张，先别传。');
  process.exit(1);
}

const out = argOf('out', '');
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, 'utf8');
  console.log(`\n地图文本 → ${out}（${text.split('\n').length} 行）`);
}

console.log('\n──── 地图文本 ────');
console.log(text);
