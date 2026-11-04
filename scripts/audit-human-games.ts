/**
 * 复盘真实人机对局：从导出的 `warchess_reports.payload` 里读出"AI 到底造了什么、死了什么、
 * 伤害是谁打的"，按胜负分组对比。
 *
 * 为什么需要它：本地对局台（`ai-duel`）能用同一颗种子跑 A/B，但它测的是"AI 打 AI"。
 * 真人对局是第三条尺子——不能用来算胜率（记录的人类动作是针对**旧 AI** 选的，
 * 局面一分叉就非法），但用来**诊断**极好：它直接告诉你"输的那批局里，AI 的军队长什么样"。
 *
 * 输入（两种都吃）：
 *   · 一个 JSON 数组：`[{...payload}, ...]`
 *   · 或者 Supabase 导出的行：`[{ payload: {...} }, ...]`
 *   · 或者 NDJSON：一行一个 payload
 *
 * 用法：
 *   node --experimental-strip-types scripts/audit-human-games.ts reports.json
 *   node --experimental-strip-types scripts/audit-human-games.ts reports.json --since v0.3.1
 *
 * 输出：
 *   ① 分层：按构建版本 / 人数 / AI 档位 / AI 坐哪一席
 *   ② AI 侧：每局平均造兵、阵亡、伤害产出、承伤——**按胜负分组**
 *   ③ AI 侧编制：五档职能的实际占比（赢的局 vs 输的局）
 *   ④ 一句话结论：差异最大的那几项按效应量排序
 */
import { readFileSync } from 'node:fs';

interface Side {
  side: string;
  cities: number;
  units: number;
  roster: Record<string, number>;
  eras: number[];
  hp: number;
}

interface Report {
  v?: number;
  build?: string;
  seed?: number;
  playerCount?: number;
  ai?: { level?: string; opponent?: boolean; ally?: boolean };
  aiSides?: string[];
  turns?: number;
  winner?: string | null;
  sides?: Side[];
  timeline?: {
    made?: Record<string, Record<string, number>>;
    lostByType?: Record<string, Record<string, number>>;
    dealtByType?: Record<string, Record<string, number>>;
    takenByType?: Record<string, Record<string, number>>;
  };
}

const path = process.argv[2];
if (!path) {
  console.error('用法：audit-human-games.ts <reports.json> [--since <build 前缀>]');
  process.exit(1);
}
const sinceIdx = process.argv.indexOf('--since');
const since = sinceIdx > 0 ? process.argv[sinceIdx + 1] : undefined;

function load(file: string): Report[] {
  const raw = readFileSync(file, 'utf8').trim();
  const out: Report[] = [];
  if (raw.startsWith('[')) {
    for (const row of JSON.parse(raw) as Array<Record<string, unknown>>) {
      // Supabase 导出的是行；本地保存的是 payload 本身
      out.push((row.payload as Report) ?? (row as unknown as Report));
    }
    return out;
  }
  // NDJSON
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    out.push((row.payload as Report) ?? (row as unknown as Report));
  }
  return out;
}

const all = load(path).filter((r) => r && Array.isArray(r.sides));
const reports = since ? all.filter((r) => (r.build ?? '').includes(since.replace(/^v/, ''))) : all;

if (reports.length === 0) {
  console.error(`没有可用报告（文件里 ${all.length} 条，--since 过滤后 0 条）`);
  process.exit(1);
}

const sum = (m?: Record<string, number>): number => (m ? Object.values(m).reduce((a, b) => a + b, 0) : 0);

/** 一个兵种 id → 职能：报告里没有 unitTypes，所以只能按"造了哪些 id"原样看 */
const topN = (m: Map<string, number>, n = 8): Array<[string, number]> =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

interface Bucket {
  games: number;
  turns: number;
  made: number;
  lost: number;
  dealt: number;
  taken: number;
  cities: number;
  units: number;
  roster: Map<string, number>;
  madeByType: Map<string, number>;
  lostByType: Map<string, number>;
}

const empty = (): Bucket => ({
  games: 0, turns: 0, made: 0, lost: 0, dealt: 0, taken: 0, cities: 0, units: 0,
  roster: new Map(), madeByType: new Map(), lostByType: new Map(),
});

const win = empty();
const lose = empty();
const draw = empty();
const builds = new Map<string, number>();
let skipped = 0;

for (const r of reports) {
  const aiSides = r.aiSides ?? [];
  if (aiSides.length === 0) { skipped++; continue; }   // 双人对人局：没有 AI 可分析
  if (!r.timeline?.made) { skipped++; continue; }      // 没勾"上传详细数据"
  builds.set(r.build ?? 'dev', (builds.get(r.build ?? 'dev') ?? 0) + 1);

  // 一个 AI 席位算一条样本；双 AI 观战局两侧都算
  for (const side of aiSides) {
    const b = r.winner == null ? draw : r.winner === side ? win : lose;
    b.games += 1;
    b.turns += r.turns ?? 0;
    const made = r.timeline.made?.[side];
    const lost = r.timeline.lostByType?.[side];
    const dealt = r.timeline.dealtByType?.[side];
    const taken = r.timeline.takenByType?.[side];
    b.made += sum(made);
    b.lost += sum(lost);
    b.dealt += sum(dealt);
    b.taken += sum(taken);
    for (const [k, v] of Object.entries(made ?? {})) b.madeByType.set(k, (b.madeByType.get(k) ?? 0) + v);
    for (const [k, v] of Object.entries(lost ?? {})) b.lostByType.set(k, (b.lostByType.get(k) ?? 0) + v);
    const sideData = (r.sides ?? []).find((x) => x.side === side);
    if (sideData) {
      b.cities += sideData.cities;
      b.units += sideData.units;
      for (const [k, v] of Object.entries(sideData.roster ?? {})) {
        b.roster.set(k, (b.roster.get(k) ?? 0) + v);
      }
    }
  }
}

const per = (b: Bucket, v: number): string => (b.games ? (v / b.games).toFixed(1) : '—');

console.log(`报告 ${reports.length} 条（可分析 ${win.games + lose.games + draw.games} 个 AI 席位，`
  + `跳过 ${skipped} 条：无 AI 席位或没上传详细数据）`);
console.log(`构建版本：${[...builds.entries()].map(([k, n]) => `${k}×${n}`).join('  ')}`);
console.log('');

for (const [name, b] of [['AI 赢', win], ['AI 输', lose], ['平局', draw]] as Array<[string, Bucket]>) {
  if (b.games === 0) continue;
  console.log(`【${name}】${b.games} 局，均 ${per(b, b.turns)} 次行动`);
  console.log(`  每局：造兵 ${per(b, b.made)} / 阵亡 ${per(b, b.lost)}`
    + ` / 打出伤害 ${per(b, b.dealt)} / 承伤 ${per(b, b.taken)}`);
  console.log(`  交换比（伤害÷承伤）：${b.taken > 0 ? (b.dealt / b.taken).toFixed(2) : '—'}`);
  console.log(`  终局：城 ${per(b, b.cities)} 座 / 存活单位 ${per(b, b.units)}`);
  const made = [...b.madeByType.entries()].sort((a, c) => c[1] - a[1]).slice(0, 6);
  console.log(`  造得最多的：${made.map(([k, n]) => `${k}×${(n / b.games).toFixed(1)}`).join('  ')}`);
  const lostTop = [...b.lostByType.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4);
  console.log(`  死得最多的：${lostTop.map(([k, n]) => `${k}×${(n / b.games).toFixed(1)}`).join('  ')}`);
  const roster = topN(b.roster, 6);
  console.log(`  终局编制：${roster.map(([k, n]) => `${k}×${(n / b.games).toFixed(1)}`).join('  ')}`);
  console.log('');
}

if (win.games > 0 && lose.games > 0) {
  const rate = (b: Bucket, v: number) => (b.made ? v / b.made : 0);
  console.log('【赢的局 vs 输的局，差异最大几项】');
  const rows: Array<[string, string, string]> = [
    ['每局造兵', per(win, win.made), per(lose, lose.made)],
    ['每局阵亡', per(win, win.lost), per(lose, lose.lost)],
    ['阵亡÷造兵', rate(win, win.lost).toFixed(2), rate(lose, lose.lost).toFixed(2)],
    ['伤害÷承伤', (win.dealt / Math.max(1, win.taken)).toFixed(2), (lose.dealt / Math.max(1, lose.taken)).toFixed(2)],
  ];
  for (const [k, a, b] of rows) console.log(`  ${k.padEnd(10)} 赢 ${a.padStart(6)}　输 ${b.padStart(6)}`);
  console.log('');
  console.log('怎么读：只看"赢的局里 AI 造了什么"是幸存者偏差——赢的局它本来就有钱造。');
  console.log('真正有用的是"输的局里它造了什么却死光了"：那才是买错兵。');
}
