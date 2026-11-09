/**
 * 气候调参器。
 *
 * ── 这个脚本在干什么 ──────────────────────────────────────
 *
 * `src/core/seasons/field.ts` 用温湿度场算天气，`TUNING` 里十几个参数
 * 决定"算出来像不像原来那张表"。
 *
 * 那张表（地形 × 海陆 × 季节，共 60 个有效格）已经不在运行时了，
 * 它是**设计者当初的编辑决定**，现在搬到这里当期望值。这个脚本：
 *
 *   1. `npm run tune:climate`           打印对照表 + 匹配率
 *   2. `npm run tune:climate -- --search`  坐标下降扫参，把匹配率顶上去
 *   3. `--apply`                        把扫出来的参数直接写回 field.ts
 *
 * ── 为什么是"坐标下降"而不是网格搜索 ──────────────────────
 *
 * 参数有二十来个，网格是组合爆炸。坐标下降（逐个参数扫一遍、选最好的、
 * 重复几轮）在这个规模下够用，而且结果可解释：每一轮只动一个数。
 *
 * ── 匹配率不是唯一的标准 ──────────────────────────────────
 *
 * 有些格子物理上就**不该**和原表一致，比如原表里"山地·近岸·夏 = 雷暴"，
 * 但山地夏天只有 16°C，打不了雷——新模型给"浓雾"更合理。
 * 所以脚本会把这些格子单独列出来，让人判断是"参数没调好"还是"表该改"。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  TUNING,
  climateAt,
  formatTemp,
  stepClimateField,
  tempAt,
  wetAt,
  type ClimateTuning,
} from '../src/core/seasons/field.ts';
import { seasonOf, type Climate, type Coast, type Season } from '../src/core/seasons/climate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIELD_PATH = join(HERE, '../src/core/seasons/field.ts');

/* ------------------------------------------------------------------ */
/* 1. 原表：设计者的编辑决定，现在只当期望值                           */
/* ------------------------------------------------------------------ */

type LandClass = 'plain' | 'hill' | 'mountain' | 'forest' | 'water';

const EXPECT: Record<LandClass, Record<string, Record<Season, Climate>>> = {
  plain: {
    coastal: { spring: 'dampCold', summer: 'mild', autumn: 'overcast', winter: 'mild' },
    nearshore: { spring: 'mild', summer: 'hot', autumn: 'mild', winter: 'cold' },
    inland: { spring: 'mild', summer: 'blazing', autumn: 'mild', winter: 'cold' },
    shore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shallow: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    deep: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
  },
  hill: {
    coastal: { spring: 'overcast', summer: 'downpour', autumn: 'mild', winter: 'dampCold' },
    nearshore: { spring: 'mild', summer: 'overcast', autumn: 'overcast', winter: 'cold' },
    inland: { spring: 'mild', summer: 'hot', autumn: 'fog', winter: 'cold' },
    shore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shallow: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    deep: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
  },
  mountain: {
    coastal: { spring: 'fog', summer: 'downpour', autumn: 'dampCold', winter: 'cold' },
    nearshore: { spring: 'overcast', summer: 'thunder', autumn: 'cold', winter: 'hardWinter' },
    inland: { spring: 'cold', summer: 'mild', autumn: 'cold', winter: 'hardWinter' },
    shore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shallow: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    deep: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
  },
  forest: {
    coastal: { spring: 'fog', summer: 'dampHeat', autumn: 'overcast', winter: 'dampCold' },
    nearshore: { spring: 'overcast', summer: 'dampHeat', autumn: 'fog', winter: 'cold' },
    inland: { spring: 'mild', summer: 'hot', autumn: 'fog', winter: 'cold' },
    shore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shallow: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    deep: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
  },
  water: {
    coastal: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    nearshore: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    inland: { spring: 'mild', summer: 'mild', autumn: 'mild', winter: 'mild' },
    shore: { spring: 'fog', summer: 'mild', autumn: 'overcast', winter: 'frozen' },
    shallow: { spring: 'driftIce', summer: 'storm', autumn: 'storm', winter: 'driftIce' },
    deep: { spring: 'storm', summer: 'thunder', autumn: 'storm', winter: 'mild' },
  },
};

/** 只比这些格：表里的"其他"三档（沿海/近岸/内陆）对水域全是温和，没有信息量 */
const LAND_COASTS: Coast[] = ['coastal', 'nearshore', 'inland'];
const WATER_COASTS: Coast[] = ['shore', 'shallow', 'deep'];
/** 原表里只有「温和」，没有凉爽 / 温暖——这两档是后来加的，算作温和的邻近档 */
const NEAR: Partial<Record<Climate, Climate[]>> = {
  mild: ['cool', 'warm'],
};

function verdictOf(actual: Climate, expect: Climate): 'ok' | 'near' | 'miss' {
  if (actual === expect) return 'ok';
  if (NEAR[expect]?.includes(actual)) return 'near';
  if (NEAR[actual]?.includes(expect)) return 'near';
  return 'miss';
}

const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];

/* ------------------------------------------------------------------ */
/* 2. 造场景                                                           */
/* ------------------------------------------------------------------ */

const SIZE = 16;
const CX = 8;
const CY = 8;

interface MiniState {
  w: number;
  h: number;
  tiles: Array<{ terrain: string; cityId: null; custom?: Record<string, unknown> }>;
  units: unknown[];
  turn: number;
  config: { expansionIds: string[] };
  unitTypes: Record<string, unknown>;
  players: Record<string, { gold: number; res: Record<string, number> }>;
}

/**
 * 造一个只够跑气候场的小局面。
 *
 * 不建整局：`coastClassOf` 只看 tiles，`seasonOf` 只看 turn，
 * 天气演化也只读写 tile.custom。所以最小 state 就够，跑得快二十倍。
 *
 * 目标格在正中 (8,8)，半径 5 格铺目标地形（水域就铺水），
 * 再按要测的海陆距离把水/陆放到合适的位置。
 */
function makeScene(terrain: string, coast: Coast): MiniState {
  const isWaterTarget = terrain === 'water';
  const fill = isWaterTarget ? 'water' : terrain;
  const tiles = Array.from({ length: SIZE * SIZE }, () => ({ terrain: fill, cityId: null as null }));
  const put = (x: number, y: number, t: string) => {
    tiles[y * SIZE + x]!.terrain = t;
  };

  // 「一片海」而不是「一格水」：单点水的扩散根本喂不出沿海的湿度
  // （湿气一到就散掉），真实海岸线是一大片水。放在右侧，与目标格隔着
  // 1 格（沿海）/ 4 格（近岸），内陆则整张图不出现水。
  if (isWaterTarget) {
    // 三种水面各自的地形：沿岸是普通 water，浅海要浅流，外海要 deep
    // （热容/蒸发都不一样，混成一种就分不出"封冻"和"浮冰"了）
    const waterTerrain = coast === 'deep' ? 'deep' : coast === 'shallow' ? 'shallow' : 'water';
    for (const t of tiles) t.terrain = waterTerrain;
    if (coast === 'shore') for (let y = 0; y < SIZE; y++) put(CX + 1, y, 'plain');
    if (coast === 'shallow') for (let y = 0; y < SIZE; y++) put(CX + 4, y, 'plain');
    // deep：整张图都是水
  } else {
    const shoreX = coast === 'coastal' ? CX + 1 : coast === 'nearshore' ? CX + 4 : -1;
    if (shoreX >= 0) {
      for (let y = 0; y < SIZE; y++) {
        for (let x = shoreX; x < SIZE; x++) put(x, y, 'water');
      }
    }
  }

  return {
    w: SIZE,
    h: SIZE,
    tiles,
    units: [],
    turn: 1,
    config: { expansionIds: ['seasons'] },
    unitTypes: {},
    players: { A: { gold: 0, res: {} }, B: { gold: 0, res: {} } },
  };
}

/**
 * 跑两年，统计**每个季节里出现最多的那种天气**。
 *
 * 不取"季中某一回合"：天气是会变的（下过雨就转晴），固定采样点等于
 * 拿骰子的一次结果当期望值。众数才是"这个季节的典型天气"，
 * 也是玩家实际感受到的那个。
 *
 * 第一年只为让场从缺省态走到稳定，第二年才统计。
 */
interface SeasonRead {
  climate: Climate;
  temp: number;
  wet: number;
  sat: number;
}

function runYear(terrain: string, coast: Coast): Record<Season, SeasonRead> {
  const s = makeScene(terrain, coast);
  const tally = {} as Record<Season, Map<Climate, number>>;
  const sum = {} as Record<Season, { t: number; w: number; n: number }>;
  for (const season of SEASONS) {
    tally[season] = new Map();
    sum[season] = { t: 0, w: 0, n: 0 };
  }
  for (let turn = 1; turn <= 80; turn++) {
    s.turn = turn;
    stepClimateField(s as never);
    if (turn <= 40) continue;
    const season = seasonOf(turn);
    const c = climateAt(s as never, CX, CY);
    tally[season].set(c, (tally[season].get(c) ?? 0) + 1);
    sum[season].t += tempAt(s as never, CX, CY);
    sum[season].w += wetAt(s as never, CX, CY);
    sum[season].n += 1;
  }
  const out = {} as Record<Season, SeasonRead>;
  for (const season of SEASONS) {
    let best: Climate = 'mild';
    let bestN = -1;
    for (const [c, n] of tally[season]) {
      if (n > bestN) { best = c; bestN = n; }
    }
    const n = Math.max(1, sum[season].n);
    const temp = Math.round(sum[season].t / n);
    out[season] = {
      climate: best,
      temp,
      wet: Math.round(sum[season].w / n),
      sat: satAt2(temp),
    };
  }
  return out;
}

/** 平均温度的饱和值（只给报告看，所以不复用 satOf 的取整逻辑也行） */
function satAt2(temp: number): number {
  return Math.max(10, 52 + Math.round((temp * 90) / 1000));
}

/* ------------------------------------------------------------------ */
/* 3. 评估                                                             */
/* ------------------------------------------------------------------ */

interface Sample {
  terrain: LandClass;
  coast: Coast;
  season: Season;
  actual: Climate;
  expect: Climate;
  verdict: 'ok' | 'near' | 'miss';
  temp: number;
  wet: number;
  sat: number;
}

function collect(): Sample[] {
  const out: Sample[] = [];
  for (const terrain of Object.keys(EXPECT) as LandClass[]) {
    const coasts = terrain === 'water' ? WATER_COASTS : LAND_COASTS;
    for (const coast of coasts) {
      const got = runYear(terrain, coast);
      for (const season of SEASONS) {
        const r = got[season]!;
        out.push({
          terrain,
          coast,
          season,
          actual: r.climate,
          expect: EXPECT[terrain]![coast]![season]!,
          verdict: verdictOf(r.climate, EXPECT[terrain]![coast]![season]!),
          temp: r.temp,
          wet: r.wet,
          sat: r.sat,
        });
      }
    }
  }
  return out;
}

function score(): number {
  const rows = collect();
  return rows.filter((r) => r.verdict !== 'miss').length / rows.length;
}

/* ------------------------------------------------------------------ */
/* 4. 报告                                                             */
/* ------------------------------------------------------------------ */

const W = (t: string, n: number) => {
  // 中文按两格宽算，简单补齐
  let width = 0;
  for (const ch of t) width += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1;
  return t + ' '.repeat(Math.max(0, n - width));
};

function report(): void {
  const rows = collect();
  let hit = 0;
  let near = 0;
  console.log('\n  地形      海陆       季节    期望        实际        温度      湿度/饱和');
  console.log('  ' + '─'.repeat(78));
  for (const r of rows) {
    if (r.verdict === 'ok') hit++;
    if (r.verdict === 'near') near++;
    const mark = r.verdict === 'ok' ? '✓' : r.verdict === 'near' ? '≈' : '✗';
    console.log(
      `  ${W(r.terrain, 10)}${W(r.coast, 11)}${W(r.season, 8)}` +
        `${W(r.expect, 12)}${W(r.actual, 12)}` +
        `${formatTemp(r.temp).padStart(8)}   ${String(r.wet).padStart(3)}/${String(r.sat).padStart(3)}` +
        `  ${mark}`,
    );
  }

  const pct = ((hit / rows.length) * 100).toFixed(1);
  const nearPct = (((hit + near) / rows.length) * 100).toFixed(1);
  console.log(`\n  精确 ${hit} / ${rows.length} = ${pct}%` +
    `　邻近 ${near} 格（凉爽 / 温暖算温和的邻居）　合计 ${nearPct}%\n`);

  const miss = rows.filter((r) => r.verdict === 'miss');
  if (miss.length > 0) {
    console.log('  不一致的格子：');
    for (const r of miss) {
      console.log(`    ${W(r.terrain, 10)}${W(r.coast, 11)}${W(r.season, 8)}期望 ${W(r.expect, 12)}实际 ${r.actual}`);
    }
    console.log('');
  }
}

/* ------------------------------------------------------------------ */
/* 5. 扫参（坐标下降）                                                 */
/* ------------------------------------------------------------------ */

interface Knob {
  label: string;
  get: () => number;
  set: (v: number) => void;
  values: number[];
}

/** 只扫那些"一改就影响一大片"的参数；地形表逐个改太容易过拟合 */
function knobs(): Knob[] {
  const t = TUNING as unknown as Record<string, unknown>;
  const num = (path: string[]) => ({
    get: () => path.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], t) as number,
    set: (v: number) => {
      const last = path[path.length - 1]!;
      const box = path.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], t) as Record<string, number>;
      box[last] = v;
    },
  });

  const mk = (path: string[], values: number[], label?: string): Knob => ({
    label: label ?? path.join('.'),
    ...num(path),
    values,
  });

  return [
    mk(['fogLine'], [0.84, 0.88, 0.92, 0.95], '起雾线（相对湿度）'),
    mk(['dampWet'], [0.65, 0.7, 0.75, 0.8, 0.85, 0.9], '湿冷/湿热线'),
    mk(['hotAt'], [180, 200, 220, 240], '炎热阈值'),
    mk(['blazingAt'], [295, 305, 315], '酷暑阈值'),
    mk(['coldAt'], [-20, 0, 20, 40], '寒冷阈值'),
    mk(['hardWinterAt'], [-160, -130, -100], '严冬阈值'),
    mk(['satBase'], [44, 48, 52, 56], '饱和线基数'),
    mk(['satPerTemp'], [60, 75, 90, 105], '饱和线斜率'),
    mk(['coastWet', 'coastal'], [8, 16, 24, 32], '沿海湿度'),
    mk(['coastWet', 'nearshore'], [0, 7, 14, 20], '近岸湿度'),
    mk(['seasonWet', 'spring'], [-4, 0, 6, 12], '春天湿度偏移'),
    mk(['seasonWet', 'autumn'], [-10, -3, 3], '秋天湿度偏移'),
    mk(['seasonWet', 'winter'], [-24, -18, -10, 0], '冬天湿度偏移'),
    mk(['wetDecay'], [0.04, 0.05, 0.06, 0.07, 0.08], '湿度损耗'),
    mk(['wetDiffuse'], [0.08, 0.12, 0.16, 0.2], '湿度扩散'),
    mk(['heavyMargin'], [3, 5, 8, 12], '大雨门槛'),
    mk(['rainDrain'], [0.3, 0.4, 0.5], '凝结比例'),
    mk(['terrain', 'plain', 'wet'], [54, 58, 62, 66, 70], '平原润度'),
    mk(['terrain', 'hill', 'wet'], [62, 68, 72, 78], '丘陵润度'),
    mk(['terrain', 'mountain', 'wet'], [56, 62, 66, 72], '山地润度'),
    mk(['terrain', 'forest', 'wet'], [68, 74, 78, 84], '森林润度'),
  ];
}

function search(rounds: number): void {
  const ks = knobs();
  let best = score();
  console.log(`\n  初始匹配率 ${(best * 100).toFixed(1)}%\n`);

  for (let round = 1; round <= rounds; round++) {
    let improved = false;
    for (const k of ks) {
      const before = k.get();
      let bestV = before;
      for (const v of k.values) {
        if (v === before) continue;
        k.set(v);
        const s = score();
        if (s > best) {
          best = s;
          bestV = v;
          improved = true;
        }
      }
      k.set(bestV);
      if (bestV !== before) {
        console.log(
          `  第 ${round} 轮  ${W(k.label, 22)} ${String(before).padStart(6)} → ${String(bestV).padStart(6)}` +
            `   匹配率 ${(best * 100).toFixed(1)}%`,
        );
      }
    }
    if (!improved) {
      console.log(`  第 ${round} 轮没有改进，停止。`);
      break;
    }
  }

  console.log(`\n  最终匹配率 ${(best * 100).toFixed(1)}%\n`);
}

/* ------------------------------------------------------------------ */
/* 6. 写回源码                                                         */
/* ------------------------------------------------------------------ */

/**
 * 把 `TUNING` 的当前值写回 field.ts。
 *
 * ⚠️ 它只保留**数值**：`TUNING` 里那些逐条解释"这个数为什么是这个数"的注释
 * 会被重新生成的代码冲掉。所以正常流程是**看日志、手工抄值**，
 * `--apply` 只在"大改一轮、反正要重写注释"的时候用。
 */
function apply(): void {
  const src = readFileSync(FIELD_PATH, 'utf8');
  const start = src.indexOf('export const TUNING: ClimateTuning = {');
  if (start < 0) throw new Error('field.ts 里找不到 TUNING 定义');
  const endMark = '\n};\n';
  const end = src.indexOf(endMark, start);
  if (end < 0) throw new Error('TUNING 定义没有正常闭合');

  const body = serializeTuning(TUNING);
  const out = src.slice(0, start) + `export const TUNING: ClimateTuning = ${body};\n` + src.slice(end + endMark.length);
  writeFileSync(FIELD_PATH, out, 'utf8');
  console.log(`  已写回 ${FIELD_PATH}`);
}

/** 把参数对象序列化成源码，保持"一行一个"的手写风格 */
function serializeTuning(t: ClimateTuning): string {
  const lines: string[] = ['{'];
  const kv = (k: string, v: unknown, indent: string) => {
    if (typeof v === 'number') lines.push(`${indent}${k}: ${v},`);
    else if (typeof v === 'string') lines.push(`${indent}${k}: '${v}',`);
    else if (Array.isArray(v)) lines.push(`${indent}${k}: [${v.join(', ')}],`);
    else if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      const flat = entries.every(([, x]) => typeof x === 'number');
      if (flat) {
        lines.push(`${indent}${k}: { ${entries.map(([a, b]) => `${a}: ${b}`).join(', ')} },`);
      } else {
        lines.push(`${indent}${k}: {`);
        for (const [a, b] of entries) {
          if (b && typeof b === 'object') {
            const inner = Object.entries(b as Record<string, unknown>)
              .map(([c, d]) => `${c}: ${d}`)
              .join(', ');
            lines.push(`${indent}  ${a}: { ${inner} },`);
          } else {
            kv(a, b, `${indent}  `);
          }
        }
        lines.push(`${indent}},`);
      }
    }
  };
  for (const [k, v] of Object.entries(t)) kv(k, v, '  ');
  lines.push('}');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 7. 入口                                                             */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const doSearch = argv.includes('--search');
const doApply = argv.includes('--apply');
const roundsArg = argv.find((a) => a.startsWith('--rounds='));
const rounds = roundsArg ? Number(roundsArg.split('=')[1]) : 3;

console.log('气候调参器 —— 期望值来自 120 格原表，实测来自温湿度场');
if (doSearch) {
  search(rounds);
  if (doApply) apply();
}
report();
