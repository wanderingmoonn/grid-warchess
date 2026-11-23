/**
 * 把手摆局面（`scenes/*.json`）转成**关卡**（`LevelDef`），好让它在游戏里被画布打开、改动、试打。
 *
 * ── 为什么是关卡，不是又一个新格式 ────────────────────────────
 *
 * 关卡格式本来就能表达一个完整局面：ASCII 地图（`map.rows`）、城的坐标
 * （`map.citiesA/B`）、开局部署（`deploy`）、起始时代（`setup.startEra`）、
 * 谁交给电脑（`seats.ai`）。而**关卡编辑器已经做完了**：画布（`level-canvas`）、
 * 摆兵（`level-army`）、校验（`level-lint`）、草稿箱、另存为副本。
 *
 * 所以"自定义局面"这件事不用新做功能，只要把脚本造的局面塞进这条既有管道。
 *
 * ── 两个已经存在的"挡板"（这就是"别让玩家看见"的答案）──────────
 *
 * 1. `dev: true`：关卡菜单三处过滤都排除它（`core/level.ts` 的 `allLevels` 等），
 *    玩家永远看不到这张图；
 * 2. `?debug`：main.ts 里已经有这个 URL 参数门（`renderDebugHud`），
 *    同类还有 `?fresh` / `?aihud` / `?roguedebug`——开发者入口一律走参数，不进菜单。
 *
 * ── 关卡表达不了的东西（要老实说）────────────────────────────
 *
 * `deploy` 只有 `type/x/y`，**没有血量**。所以"残血局面"（城只剩 28 血、
 * 某个兵只剩 2 血）过不去关卡这条路，只能用 `make-scene` 直接产快照。
 * 这类题照样能出，只是不能进编辑器改。
 *
 * 用法：
 *   node --experimental-strip-types scripts/scene-to-level.ts --scene scenes/S-001.json
 *   ... --out levels-out/S-001.level.json   写出文件（不给就只打印）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LEVEL_VERSION } from '../src/core/level.ts';
import { lintLevel } from '../src/core/level-lint.ts';
import type { LevelDef } from '../src/core/level.ts';
import type { PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const SCENE = argOf('scene');
const OUT = argOf('out');
if (!SCENE) {
  console.error('用法：scene-to-level.ts --scene scenes/S-001.json [--out levels-out/S-001.level.json]');
  process.exit(1);
}

interface Scene {
  id: string;
  ask?: string;
  size?: number;
  startEra?: number;
  fog?: boolean;
  me?: 'A' | 'B';
  gold?: Partial<Record<PlayerId, number>>;
  map?: string[];
  cities?: Array<{ owner: PlayerId; x: number; y: number; era?: number; hp?: number }>;
  units?: Array<{ owner: PlayerId; type: string; x: number; y: number; hp?: number }>;
}

const scene = JSON.parse(readFileSync(resolve(SCENE), 'utf8')) as Scene;
const ID = scene.id ?? 'S-000';

if (!scene.map) {
  console.error('这个场景没有手写地图（`map`）。关卡要一张确定的图，随机图请直接用 make-scene 出快照。');
  process.exit(1);
}
if (scene.fog) {
  console.error('关卡开雾要塞进 expansions 规则，这一版不支持——先把场景的 fog 关掉再转。');
  process.exit(1);
}

/*
 * 关卡能补的：逐席时代（`seats.cityEra`）、起始金（第 1 手用 gold 事件抹平）。
 * 关卡补不了的：**城的血、兵的血**——`deploy` 只有 type/x/y，没有 hp 字段。
 * 所以残血局面过不了这条路，只能走 make-scene 直接产快照。
 */
const hurtUnits = (scene.units ?? []).filter((u) => u.hp !== undefined);
const hurtCities = (scene.cities ?? []).filter((c) => c.hp !== undefined);
if (hurtUnits.length > 0 || hurtCities.length > 0) {
  console.warn(
    `⚠️ 这个场景写了 ${hurtUnits.length + hurtCities.length} 处血量，关卡格式表达不了，**会被抹成满血**。\n` +
      '   残血局面请继续用 make-scene 产快照；只有满血局面才适合进关卡编辑器改。',
  );
}

const citiesA = (scene.cities ?? []).filter((c) => c.owner === 'A').map((c) => ({ x: c.x, y: c.y }));
const citiesB = (scene.cities ?? []).filter((c) => c.owner === 'B').map((c) => ({ x: c.x, y: c.y }));
for (const [name, list] of [['A', citiesA], ['B', citiesB]] as const) {
  if (list.length === 0) {
    console.error(`${name} 方一座城都没有。关卡要有城，否则开局就判出局。`);
    process.exit(1);
  }
}

const eraOf = (owner: PlayerId): number => {
  const mine = (scene.cities ?? []).filter((c) => c.owner === owner);
  return Math.max(scene.startEra ?? 2, ...mine.map((c) => c.era ?? scene.startEra ?? 2));
};
const eraA = eraOf('A');
const eraB = eraOf('B');

/*
 * 起始金：关卡开局金是 `startGoldFor(startEra)`（随时代涨），没有"直接指定"的入口。
 * 第 1 手用一条 gold 事件把差额扣掉/补上，就等于指定了。
 * `rules.ts` 那句是 `Math.max(0, p.gold + amount)`，所以负数是合法的。
 */
const goldEvents = (['A', 'B'] as PlayerId[])
  .filter((p) => scene.gold?.[p] !== undefined)
  .flatMap((p) => {
    const g = scene.gold?.[p] ?? 0;
    /*
     * 先清零再补上。不能用"实际值 - startGoldFor"：扩展开局还会加钱
     * （先后手补偿、血战……实测差 61 金），算不准。
     * `rules.ts` 是 `Math.max(0, gold + amount)`，所以 -9999 就是把钱清干净。
     * 两个限制来自校验器：单笔要在 ±9999 内、且不能是 0 —— 所以目标金为 0 时
     * 只发清零那一笔。金超过 9999 的局面走 snap 路线，别指望关卡。
     */
    const acts = [{ kind: 'gold' as const, seat: p, amount: -9999 }];
    if (g !== 0) acts.push({ kind: 'gold' as const, seat: p, amount: g });
    return acts;
  });
const events =
  goldEvents.length > 0
    ? [{ id: 'exam-setup', when: { kind: 'turn' as const, at: 1 }, do: goldEvents }]
    : undefined;

const level: LevelDef = {
  id: `level:${ID.toLowerCase()}`,
  version: LEVEL_VERSION,
  /* 不进玩家菜单：考卷混进选关列表只会让人以为是半成品 */
  dev: true,
  name: `${ID}（考卷）`,
  brief: scene.ask ?? '',
  map: {
    id: `levelmap:${ID.toLowerCase()}`,
    name: ID,
    w: scene.map[0]!.length,
    h: scene.map.length,
    rows: scene.map,
    citiesA,
    citiesB,
    source: 'builtin',
  },
  seats: { count: 2, ai: ['B'], cityEra: { A: eraA, B: eraB } },
  setup: { startEra: scene.startEra ?? 2, firstSide: scene.me === 'B' ? 'B' : 'A' },
  ...(events ? { events } : {}),
  deploy: {
    A: (scene.units ?? []).filter((u) => u.owner === 'A').map((u) => ({ type: u.type, x: u.x, y: u.y })),
    B: (scene.units ?? []).filter((u) => u.owner === 'B').map((u) => ({ type: u.type, x: u.x, y: u.y })),
  },
};

const issues = lintLevel(level);
const errors = issues.filter((i) => i.severity === 'error');
for (const i of issues) {
  const at = i.at ? ` @(${i.at.x},${i.at.y})` : '';
  console.log(`${i.severity === 'error' ? '✗' : '·'} ${i.text}${at}`);
}
if (errors.length > 0) {
  console.error(`\n关卡校验没过（${errors.length} 处错误），不能给编辑器用。`);
  process.exit(1);
}
console.log(errors.length === 0 ? '关卡校验通过。' : '');

const text = JSON.stringify(level, null, 2);
if (OUT) {
  const out = resolve(OUT);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`已写出：${out}`);
  console.log('下一步：游戏里打开「编辑器」→ 新建/粘贴这份 JSON → 画布上能看到并继续改。');
} else {
  console.log('\n--- 下面这段粘进关卡编辑器的 JSON 输入框 ---');
  console.log(text);
}
