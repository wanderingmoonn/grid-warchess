/**
 * 判分器：拿一道题，让某个"答题者"从那一格往下走 N 手，看判据红还是绿。
 *
 * ── 它不认识 AI ───────────────────────────────────────────────
 *
 * 答题者只有三种：
 *   · `--answers a.json`：人写的动作，按回合分组（见下）
 *   · `--me-ai v3|v1|none`：现成的 AI，或"什么都不做"的空壳
 * 换一个答题者不用改一行判分逻辑。这就是题库能独立于 v4 存在的原因。
 *
 * ── 判据是"结果"，不是"动作" ──────────────────────────────────
 *
 * `criteria.json` 里写的是"到第几手时，某座城血要 ≥ 多少 / 某个兵种要 ≥ 几个"。
 * 它不检查"你是不是走了那一步"——那是抄答案，不是判据。
 *
 * ── 一个坑：两条边要用同一个答题者 ────────────────────────────
 *
 * 我方用 v3、对方用空壳，等于"打一个不还手的人"，判据全绿也没意义。
 * 所以 `--foe-ai` 默认也是 v1（原局就是这么打的），要换成别的得显式指定。
 *
 * 用法：
 *   node --experimental-strip-types scripts/exam-grade.ts --exam exams/Y-002 --me-ai v3
 *   node --experimental-strip-types scripts/exam-grade.ts --exam exams/Y-002 --me-ai none
 *   node --experimental-strip-types scripts/exam-grade.ts --exam exams/Y-002 --answers my-answer.json
 *   ... --verbose      打印每一手的局面摘要
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyAction, utype } from '../src/core/rules.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiActionKey } from '../src/core/ai.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const EXAM = argOf('exam');
const ME_AI = argOf('me-ai', 'v3');
const FOE_AI = argOf('foe-ai', 'v1');
const ANSWERS = argOf('answers');
const VERBOSE = process.argv.includes('--verbose');

if (!EXAM) {
  console.error('用法：exam-grade.ts --exam exams/Y-001 [--me-ai v3|v1|none] [--foe-ai v1|none] [--answers a.json]');
  process.exit(1);
}

const DIR = resolve(EXAM);
const snapPath = resolve(DIR, 'snap.json');
const critPath = resolve(DIR, 'criteria.json');
if (!existsSync(snapPath)) {
  console.error(`没有 ${snapPath}——先用 scripts/make-exam.ts 出一道题`);
  process.exit(1);
}
if (!existsSync(critPath)) {
  console.error(`没有 ${critPath}——这题还没出完（判据没写，就等于没人会去执行它）`);
  process.exit(1);
}

/* ── 判据 ───────────────────────────────────────────────────── */
type Criterion = {
  /** 第几手（相对出题局面；1 手 = 一方的一个回合） */
  in: number;
  kind: string;
  city?: string;
  category?: string;
  type?: string;
  owner?: 'me' | 'foe';
  x?: number;
  y?: number;
  r?: number;
  min?: number;
  max?: number;
  /** 为什么有这一条（写给人看，判分时会一起打印） */
  note?: string;
};
const criteria = JSON.parse(readFileSync(critPath, 'utf8')) as {
  me: PlayerId;
  /** 判分跑多少手；缺省 = 最晚的判据 */
  window?: number;
  must?: Criterion[];
  mustNot?: Criterion[];
  /** 只记录、不判：用来留下"某个测试员点名的做法"，它不该决定红绿 */
  soft?: Criterion[];
  /** 说明这题的答案来自哪份人类策略（可空） */
  from?: string;
  /**
   * `unusable` = 判据还没被证明可行（见每道题自己的 review.md）。
   * 这种人也能跑，但结果不能当结论——所以要显式 --force 才继续。
   */
  status?: 'ok' | 'unusable';
};
if (criteria.status === 'unusable' && !process.argv.includes('--force')) {
  console.error(
    `这题的判据标了「不可用」：还没有任何执行者把它跑绿，所以"红"不代表答题者差。\n` +
      `先看 ${resolve(DIR, 'review.md')}，要硬跑加 --force。`,
  );
  process.exit(2);
}
const ME: PlayerId = criteria.me;
const FOE: PlayerId = ME === 'A' ? 'B' : 'A';
const must = criteria.must ?? [];
const mustNot = criteria.mustNot ?? [];
const soft = criteria.soft ?? [];
/** `--window N`：临时改跑多少手（探"到底要多久"，不改判据文件） */
const window = Number(argOf('window', '0')) || criteria.window || Math.max(0, ...[...must, ...mustNot].map((c) => c.in));

/* ── 局面 ───────────────────────────────────────────────────── */
const raw = JSON.parse(readFileSync(snapPath, 'utf8')) as { state: GameState };
let s0 = structuredClone(raw.state);
s0.aiControl = { [ME]: false, [FOE]: false } as Record<PlayerId, boolean>;
const START = s0.turn;
const ME_CITIES0 = s0.cities.filter((c) => c.owner === ME && !c.ruined).length;

/* ── 答题者 ─────────────────────────────────────────────────── */
type AiFn = (s: GameState, b: typeof DEFAULT_BUDGET, r: ReadonlySet<string>) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;
let meAi: AiFn | null = null;
let foeAi: AiFn | null = null;

async function loadAi(kind: string, who: string): Promise<AiFn | null> {
  if (kind === 'none') return null;
  if (kind === 'v3') return ((await import('../src/core/ai-v3.ts')) as { aiNextAction: AiFn }).aiNextAction;
  if (kind === 'v1') return ((await import('./baselines/ai-9efb961.ts')) as { aiNextAction: AiFn }).aiNextAction;
  if (kind === 'auto') return ((await import('../src/core/ai.ts')) as { aiNextAction: AiFn }).aiNextAction;
  throw new Error(`${who} 不认识这个答题者：${kind}（只有 v3/v1/auto/none）`);
}

/** 人手答案：按回合分组，`{ "turns": [[{...}, {...}], [{...}]] }` */
type AnswerBook = { turns?: Array<Array<Record<string, unknown>>> };
let book: AnswerBook | null = null;
if (ANSWERS) book = JSON.parse(readFileSync(resolve(ANSWERS), 'utf8')) as AnswerBook;

if (!book) {
  if (ME_AI !== 'answers') meAi = await loadAi(ME_AI, '--me-ai');
} 
foeAi = await loadAi(FOE_AI, '--foe-ai');

/* ── 记录 ───────────────────────────────────────────────────── */
type Stat = {
  turn: number;
  gold: Record<string, number>;
  /** 城的当前状态（按 id） */
  city: Record<string, { owner: PlayerId; hp: number; era: number; x: number; y: number }>;
  /** 该城在本局里的最低血量（= 被打掉过多少） */
  cityMinHp: Record<string, number>;
  count: Record<string, number>;
  /** 我方单位的位置与分类：`unitsNear` 要按当期的记录算，不能用终局 */
  mine: Array<{ x: number; y: number; category: string }>;
  alive: number;
  meCities: number;
  /** 敌方还剩几座活城（废墟不算）。「把对方打到没有城」才是收尾的终点 */
  foeCities: number;
};
const record = new Map<number, Stat>();
const cityMinHp: Record<string, number> = {};
for (const c of s0.cities) cityMinHp[c.id] = c.hp;
let lostMe = 0;
let lostFoe = 0;
const disbanded = new Set<string>();
let prevIds = new Set(s0.units.map((u) => u.id));

function capture(s: GameState): void {
  const city: Stat['city'] = {};
  for (const c of s.cities) {
    city[c.id] = { owner: c.owner, hp: c.hp, era: c.era, x: c.x, y: c.y };
    cityMinHp[c.id] = Math.min(cityMinHp[c.id] ?? c.hp, c.hp);
  }
  const count: Record<string, number> = {};
  const mine: Stat['mine'] = [];
  for (const u of s.units) {
    const d = utype(s, u.type);
    count[`cat:${d.category}`] = (count[`cat:${d.category}`] ?? 0) + 1;
    count[`type:${u.type}`] = (count[`type:${u.type}`] ?? 0) + 1;
    if (u.owner === ME) {
      count['me:total'] = (count['me:total'] ?? 0) + 1;
      mine.push({ x: u.x, y: u.y, category: d.category });
    }
  }
  record.set(s.turn, {
    turn: s.turn,
    gold: { [ME]: s.players[ME]?.gold ?? 0, [FOE]: s.players[FOE]?.gold ?? 0 },
    city,
    cityMinHp: { ...cityMinHp },
    count,
    mine,
    alive: s.units.length,
    meCities: s.cities.filter((c) => c.owner === ME && !c.ruined).length,
    foeCities: s.cities.filter((c) => c.owner === FOE && !c.ruined).length,
  });

  // 损失：消失的单位里，剔掉自己拆掉的（拆单位是回收，不是伤亡）
  const ids = new Set(s.units.map((u) => u.id));
  const gone = [...prevIds].filter((id) => !ids.has(id) && !disbanded.has(id));
  for (const id of gone) {
    // 归属从开局那一份里查——单位已经不在了
    const owner = s0.units.find((u) => u.id === id)?.owner;
    if (owner === ME) lostMe += 1;
    else if (owner === FOE) lostFoe += 1;
  }
  prevIds = ids;
}

/** 一方走一回合（AI 或空壳） */
function aiTurn(s: GameState, ai: AiFn | null): GameState {
  const budget = { ...DEFAULT_BUDGET };
  const rejected = new Set<string>();
  const moveTries = new Map<string, number>();
  let cur = s;
  if (ai) {
    for (let i = 0; i < AI_MAX_STEPS && !cur.winner; i++) {
      const a = ai(cur, budget, rejected);
      if (!a) break;
      const r = applyAction(cur, a);
      if (!r.ok) {
        if (a.type === 'MOVE' && 'unitId' in a) {
          const uid = String((a as { unitId?: string }).unitId ?? '');
          const n = (moveTries.get(uid) ?? 0) + 1;
          moveTries.set(uid, n);
          if (n < 2) continue;
        }
        rejected.add(aiActionKey(a));
        continue;
      }
      rejected.clear();
      if (a.type === 'DISBAND' && 'unitId' in a) disbanded.add(String((a as { unitId?: string }).unitId));
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
      cur = r.state;
    }
  }
  if (cur.winner) return cur;
  const r = applyAction(cur, { type: 'END_TURN' });
  return r.ok ? r.state : cur;
}

/** 我走一回合（人手答案） */
function answerTurn(s: GameState, acts: Array<Record<string, unknown>>): GameState {
  let cur = s;
  for (const a of acts) {
    const r = applyAction(cur, a as never);
    if (!r.ok) {
      console.log(`  ⚠️ 答案里的这个动作被引擎拒了：${JSON.stringify(a)}（${r.reason ?? ''}）`);
      continue;
    }
    if (a.type === 'DISBAND' && 'unitId' in a) disbanded.add(String(a.unitId));
    cur = r.state;
  }
  if (cur.winner) return cur;
  const r = applyAction(cur, { type: 'END_TURN' });
  return r.ok ? r.state : cur;
}

/* ── 跑 ─────────────────────────────────────────────────────── */
let s = structuredClone(s0);
capture(s);
const cap = START + window;
let meTurnIdx = 0;
while (!s.winner && s.turn < cap) {
  const who = s.current;
  const before = s.turn;
  if (book && who === ME) {
    const acts = book.turns?.[meTurnIdx] ?? [];
    meTurnIdx += 1;
    s = answerTurn(s, acts);
  } else {
    s = aiTurn(s, who === ME ? meAi : foeAi);
  }
  capture(s);
  if (VERBOSE) {
    const st = record.get(s.turn)!;
    console.log(
      `T${String(s.turn).padStart(3)} ${who === ME ? '我' : '敌'} 走完 · ` +
        `金 ${st.gold[ME]}/${st.gold[FOE]} · 我城 ${st.meCities} · 我兵 ${st.count['me:total'] ?? 0}`,
    );
  }
  if (s.turn === before) break; // 保险：不该发生
}

/* ── 判 ─────────────────────────────────────────────────────── */
function evalOne(c: Criterion, st: Stat | undefined): { ok: boolean | null; got: string } {
  if (!st) return { ok: null, got: '没有这一手的记录（判据写在了窗口外？）' };
  const cityOf = (id?: string) => (id ? st.city[id] : undefined);
  switch (c.kind) {
    case 'cityOwner': {
      const cv = cityOf(c.city);
      if (!cv) return { ok: false, got: `找不到城 ${c.city}` };
      const want = c.owner === 'me' ? ME : FOE;
      return { ok: cv.owner === want, got: `归属 ${cv.owner}` };
    }
    case 'cityHp': {
      const cv = cityOf(c.city);
      if (!cv) return { ok: false, got: `找不到城 ${c.city}` };
      const lowOk = c.min === undefined || cv.hp >= c.min;
      const highOk = c.max === undefined || cv.hp <= c.max;
      return { ok: lowOk && highOk, got: `血 ${cv.hp}` };
    }
    case 'cityDamaged': {
      const init = s0.cities.find((x) => x.id === c.city)?.hp;
      const low = st.cityMinHp[c.city ?? ''];
      if (init === undefined || low === undefined) return { ok: false, got: `找不到城 ${c.city}` };
      const hit = init - low;
      return { ok: c.min === undefined || hit >= c.min, got: `最多打掉 ${hit} 血` };
    }
    case 'cityEra': {
      const cv = cityOf(c.city);
      if (!cv) return { ok: false, got: `找不到城 ${c.city}` };
      return { ok: c.min === undefined || cv.era >= c.min, got: `时代 ${cv.era}` };
    }
    case 'unitCount': {
      const key = c.type ? `type:${c.type}` : `cat:${c.category}`;
      const n = st.count[key] ?? 0;
      const lowOk = c.min === undefined || n >= c.min;
      const highOk = c.max === undefined || n <= c.max;
      return { ok: lowOk && highOk, got: `${key.split(':')[1]} ${n} 个` };
    }
    case 'unitsNear': {
      const n = st.mine.filter(
        (u) =>
          Math.max(Math.abs(u.x - (c.x ?? 0)), Math.abs(u.y - (c.y ?? 1))) <= (c.r ?? 1) &&
          (!c.category || u.category === c.category),
      ).length;
      return { ok: c.min === undefined || n >= c.min, got: `(${c.x},${c.y}) 半径 ${c.r} 内 ${n} 个` };
    }
    case 'gold': {
      const g = st.gold[ME] ?? 0;
      const lowOk = c.min === undefined || g >= c.min;
      const highOk = c.max === undefined || g <= c.max;
      return { ok: lowOk && highOk, got: `${g} 金` };
    }
    case 'lostUnits':
      return { ok: c.max === undefined || lostMe <= c.max, got: `我损失 ${lostMe} 个` };
    case 'foeLost':
      return { ok: c.min === undefined || lostFoe >= c.min, got: `敌损失 ${lostFoe} 个` };
    case 'noCityLost':
      return { ok: st.meCities >= ME_CITIES0, got: `我城 ${st.meCities}/${ME_CITIES0}` };
    case 'capturedCity':
      return { ok: st.meCities > ME_CITIES0, got: `我城 ${st.meCities}/${ME_CITIES0}` };
    case 'foeCities': {
      // 「拿下」和「打塌」都算收尾：编成一条，免得"赢了却判红"（S-001 第一版就是这么翻的）
      const lowOk = c.min === undefined || st.foeCities >= c.min;
      const highOk = c.max === undefined || st.foeCities <= c.max;
      return { ok: lowOk && highOk, got: `敌城 ${st.foeCities}` };
    }
    default:
      return { ok: null, got: `不认识的判据 ${c.kind}` };
  }
}

/**
 * 取"第 N 手那一刻的记录"。局面可能在 N 之前就分胜负（提前打赢是好结果），
 * 那时候没有第 N 手的记录——退到**最后一次记录**才是对的，否则"赢太快"会被判成失败。
 */
const statAt = (turn: number): Stat | undefined => {
  let best: Stat | undefined;
  for (const [t, st] of record) if (t <= turn && (!best || t > best.turn)) best = st;
  return best;
};

const rows: Array<{ c: Criterion; mustNot: boolean; ok: boolean | null; got: string }> = [];
for (const c of must) rows.push({ c, mustNot: false, ...evalOne(c, statAt(START + c.in)) });
for (const c of mustNot) rows.push({ c, mustNot: true, ...evalOne(c, statAt(START + c.in)) });
/* soft 只进报表，不进结论——见 README「判据不许写成必须走这一步」 */
const softRows = soft.map((c) => ({ c, ...evalOne(c, statAt(START + c.in)) }));

/* `ok` 在两种判据里语义一致：true = 这条要求满足了（must 是"做到"，mustNot 是"没犯"） */
const pass = rows.every((r) => r.ok === true);

const who = book ? `人手答案` : ME_AI;
console.log(`\n=== ${EXAM} · 答题者 ${who}（对手 ${FOE_AI}）· 跑 ${window} 手 ===`);
console.log(`出题局面：第 ${START} 手 · 我城 ${ME_CITIES0} 座 · 兵 ${s0.units.filter((u) => u.owner === ME).length} 个`);
console.log(`跑完：${s.winner ? `${s.winner === ME ? '我胜' : '我负'}` : '未分胜负'}（第 ${s.turn} 手）`);
console.log('');
for (const r of rows) {
  const mark = r.ok === null ? '？' : r.ok ? '✅' : '❌';
  const tag = r.mustNot ? '不许' : '必须';
  console.log(`  ${mark} [第 ${r.c.in} 手 · ${tag}] ${r.c.kind} ${r.c.city ?? r.c.type ?? r.c.category ?? ''} → ${r.got}`);
  if (r.c.note) console.log(`      ${r.c.note}`);
}
if (softRows.length > 0) {
  console.log('');
  console.log('  只记录、不判（测试员点名的做法，不决定红绿）：');
  for (const r of softRows) {
    console.log(`    · ${r.c.kind} ${r.c.type ?? r.c.city ?? ''} → ${r.got}`);
  }
}
console.log(`\n结论：${pass ? '绿（这题过了）' : '红（这题没过）'}`);
if (criteria.from) console.log(`答案来源：${criteria.from}`);
console.log('');
console.log('提醒：红只说明"这个答题者没过"，不说明题好。题好不好看两件事——');
console.log('  ① 空壳必须红（否则题会白送）；② 人手答案必须绿（否则判据写错了）。');

process.exit(pass ? 0 : 1);
