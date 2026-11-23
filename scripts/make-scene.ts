/**
 * 手摆一格局面，做成一道题（单机制题的主力工具）。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────
 *
 * 从真实回放切出来的局面多是"综合判断"（`exams/Y-001`、`Y-002` 都是这么废的），
 * 因为 v3 的错是整体判断错，不是漏了某个动作。要考一个病，得把它**单独隔离**出来：
 * 一张小图、少量单位、一个明确的错误点。v3 的探针就是手工摆的
 * （`probe:bridge-block` 摆的是"桥头被自己人堵住"），那条路能把病钉死。
 *
 * ── 局面怎么摆 ────────────────────────────────────────────────
 *
 * 用一层 ASCII 写地图，单位/城用列表写。文件名 `scenes/S-001.json`：
 *
 * ```json
 * {
 *   "id": "S-001",
 *   "ask": "这一回合你会怎么做？",
 *   "size": 12, "startEra": 2, "fog": false, "me": "A",
 *   "gold": { "A": 300, "B": 300 },
 *   "map": [
 *     "............",
 *     "....~~~~~~..",
 *     "............"
 *   ],
 *   "cities": [{ "owner": "A", "x": 1, "y": 1, "era": 2 }, { "owner": "B", "x": 9, "y": 9 }],
 *   "units": [{ "owner": "A", "type": "militia", "x": 3, "y": 3, "hp": 20 }]
 * }
 * ```
 *
 * 地图字符（和游戏、关卡编辑器同一张表）：`.` 平原　`f` 森林　`h` 丘陵　`~` 水
 * 　　　　　　　　　　　　`^` 山　`=` 桥（架在水上）　`P` 台地　`v` 谷地　`w` 沼泽　`d` 沙丘
 *
 * `map` 省略时按 `size` 随机生成一张公平图（这时它和 `make-exam` 差不多，意义不大）。
 * 城和单位都不写 `hp` 就用默认满血；写了就按写的来（残血局面要靠它）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/make-scene.ts --scene scenes/S-001.json [--dry]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { placeCity, placeUnit } from '../src/core/sandbox.ts';
import { writeExam } from './lib/exam-kit.ts';
import type { GameState, PlayerId, Terrain } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const SCENE = argOf('scene');
const DRY = process.argv.includes('--dry');
if (!SCENE) {
  console.error('用法：make-scene.ts --scene scenes/S-001.json [--dry]');
  process.exit(1);
}

interface Scene {
  id: string;
  ask?: string;
  size?: number;
  startEra?: number;
  fog?: boolean;
  me?: 'A' | 'B';
  seed?: number;
  gold?: Partial<Record<PlayerId, number>>;
  map?: string[];
  cities?: Array<{ owner: PlayerId; x: number; y: number; era?: number; hp?: number; ruined?: boolean }>;
  units?: Array<{ owner: PlayerId; type: string; x: number; y: number; hp?: number }>;
}

const scene = JSON.parse(readFileSync(resolve(SCENE), 'utf8')) as Scene;
const ME: PlayerId = scene.me === 'B' ? 'B' : 'A';
const ID = scene.id ?? 'S-000';
const SIZE = scene.size ?? (scene.map ? scene.map.length : 12);

/*
 * 地图字符**和游戏自己的那张表一模一样**（`core/mapgen.ts` 的 `CHAR`）。
 * 一开始我用的是自己编的（`^` 丘陵、`M` 山、`,` 沼泽），后来发现关卡编辑器也用那张表——
 * 两套字符意味着"脚本造的地图进不了编辑器"，等于自己给自己修了一堵墙。
 */
const LEGEND: Record<string, Terrain> = {
  '.': 'plain',
  f: 'forest',
  h: 'hill',
  '~': 'water',
  '^': 'mountain',
  '=': 'bridge',
  P: 'plateau',
  v: 'valley',
  w: 'marsh',
  d: 'dune',
};

/* ── 底图 ─────────────────────────────────────────────────────
 * 用 createMatch 起一局，是为了拿到一份**所有字段都齐**的局面
 * （unitTypes / players / memory / config）。之后再整块盖掉地图与单位，
 * 比从零拼一个 GameState 可靠得多——少一个字段就是一处莫名其妙的崩溃。
 */
let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, size: SIZE, startEra: scene.startEra ?? 2, mapSymmetry: 'fair' },
  scene.seed ?? 1,
);
s.fog = scene.fog === true;
s.turn = 1;
s.current = ME;
s.winner = null;
s.log = [];
s.units = [];
s.cities = [];
s.mapBridges = [];
s.bridgeDeck = {};
/* 记忆要清空：createMatch 那份是从它的随机开局里攒的，留着会出现
 * "测试员在面板上看见三个从没见过的敌人幽灵"这种荒唐事。 */
for (const p of ['A', 'B', 'C', 'D'] as PlayerId[]) {
  if (s.memory[p]) s.memory[p] = { known: [] };
}

/* ── 地图 ─────────────────────────────────────────────────── */
if (scene.map) {
  if (scene.map.length !== s.h) {
    console.error(`map 有 ${scene.map.length} 行，但这局是 ${s.w}×${s.h}（size 写的是 ${SIZE}）`);
    process.exit(1);
  }
  for (let y = 0; y < s.h; y++) {
    const row = scene.map[y]!;
    if (row.length !== s.w) {
      console.error(`第 ${y} 行有 ${row.length} 格，应该是 ${s.w} 格：${row}`);
      process.exit(1);
    }
    for (let x = 0; x < s.w; x++) {
      const ch = row[x]!;
      const terrain = LEGEND[ch];
      if (!terrain) {
        console.error(`第 ${y} 行第 ${x} 格是不认识的字符「${ch}」。可用：${Object.keys(LEGEND).join(' ')}`);
        process.exit(1);
      }
      const i = y * s.w + x;
      s.tiles[i]!.terrain = terrain;
      s.tiles[i]!.cityId = null;
      if (terrain === 'bridge') {
        // 地图自带的桥：记进 mapBridges，否则 syncBridges 第一次对账就判它塌了
        s.mapBridges!.push(i);
        s.bridgeDeck![String(i)] = 'water';
      }
    }
  }
}

/* ── 城 ───────────────────────────────────────────────────────
 * 「每方至少一座城」不是审美要求：`s.cities` 里一方没有城，引擎直接判他出局，
 * 跑起来是"第 1 手就结束"，而且不报错。这条踩过三次。
 */
for (const c of scene.cities ?? []) {
  const r = placeCity(s, c.owner, c.x, c.y, c.era ?? scene.startEra ?? 2);
  if (!r.ok) {
    console.error(`摆城失败 (${c.x},${c.y}) ${c.owner}：${r.reason}`);
    process.exit(1);
  }
  s = r.state;
}
const placed = s.cities.find((c) => c.owner === ME);
for (const p of ['A', 'B'] as PlayerId[]) {
  if (!s.cities.some((c) => c.owner === p)) {
    console.error(
      `⚠️ ${p} 方一座城都没有 —— 引擎会当场判他出局，这局跑不起来。` +
        (placed ? '场景里请给两方各摆至少一座城。' : ''),
    );
    process.exit(1);
  }
}
/*
 * 城血与废墟：默认满血。
 *
 * `ruined: true` 用来摆"已经被打塌、还没被接管"的局面——这是 S-003 那种
 * 「打塌之后要不要派人进去」的题的唯一可行做法。**关卡格式表达不了废墟**
 * （只能摆一座满血城），所以这类局面只能走快照 + 「导入对局」。
 */
for (const c of scene.cities ?? []) {
  const target = s.cities.find((x) => x.x === c.x && x.y === c.y && x.owner === c.owner);
  if (!target) continue;
  if (c.ruined) {
    target.ruined = true;
    target.hp = 0;
    continue;
  }
  if (c.hp === undefined) continue;
  target.hp = Math.max(1, Math.min(c.hp, target.maxHp));
}

/* ── 单位 ─────────────────────────────────────────────────── */
for (const u of scene.units ?? []) {
  const r = placeUnit(s, u.owner, u.type, u.x, u.y);
  if (!r.ok) {
    console.error(`摆兵失败 ${u.type} (${u.x},${u.y}) ${u.owner}：${r.reason}`);
    process.exit(1);
  }
  s = r.state;
  if (u.hp !== undefined) {
    const target = s.units[s.units.length - 1]!;
    target.hp = Math.max(1, u.hp);
  }
}

/* ── 金 ───────────────────────────────────────────────────────
 * 顺手把「起始金随时代涨」那笔抹平：手摆的局面里金币必须就是写的那个数，
 * 不然同一份场景在不同时代下会跑出不同的开局。
 */
for (const p of ['A', 'B'] as PlayerId[]) {
  const g = scene.gold?.[p];
  s.players[p]!.gold = g ?? 200;
}

/* ── 冒烟测试 ─────────────────────────────────────────────────
 * 结束一次回合：能过就说明"两方都有城、有产线、局面自洽"。
 * 不过的在出题阶段就该炸，而不是等某人打开题卡发现第 1 手就结束。
 */
{
  const probe = structuredClone(s);
  const r = applyAction(probe, { type: 'END_TURN' });
  if (!r.ok) {
    console.error(`⚠️ 这个局面走不了一步（结束回合被拒：${r.reason}），先检查城和单位的摆法`);
    process.exit(1);
  }
  if (r.state.winner) {
    console.error(`⚠️ 结束一次回合就分出胜负了（${r.state.winner} 胜）——局面已经结束了，不能出题`);
    process.exit(1);
  }
}

const meUnits = s.units.filter((u) => u.owner === ME).length;
const foeUnits = s.units.filter((u) => u.owner !== ME).length;
const { panelFull } = writeExam({
  state: s,
  me: ME,
  id: ID,
  out: resolve(argOf('out', `exams/${ID}`)),
  ask: scene.ask ?? '这一回合你会怎么做？（最多 3 步，按顺序，每步一句为什么）',
  source: `手摆局面（\`${SCENE}\`）· ${ME} 方 · 我 ${meUnits} 兵 / 敌 ${foeUnits} 兵`,
  note: `${ID}（手摆）：${scene.ask ?? ''}`,
  fog: s.fog,
  dry: DRY,
});

if (DRY) {
  console.log(panelFull);
  process.exit(0);
}
console.log(`\n已写出：exams/${ID}/{snap.json, card.md, answer.md, author.md}`);
console.log(`局面：${s.w}×${s.h} · 我 ${meUnits} 兵 / 敌 ${foeUnits} 兵 · 金 ${s.players.A!.gold}/${s.players.B!.gold}`);
console.log('下一步：手写 criteria.json（判据），再跑 exam-grade 看空壳/v1/v3 是红是绿。');
