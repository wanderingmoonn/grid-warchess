/**
 * 出题器：从一局回放里切出"轮到某一方、还没动手"的那一格，产出
 *   ① 可以导入游戏的快照（`snap.json`）
 *   ② 给测试员看的题卡骨架（`card.md`）
 *   ③ 终端上的可读面板 + "v3 这一回合实际做了什么"
 *
 * ── 为什么要有它 ──────────────────────────────────────────────
 *
 * 题库的原料是 v3 的失败局，但回放里只有"做了什么"，没有"当时该做什么"。
 * 出题人要看着真实局面问自己"人这时候会怎么做"——所以先把那一格摆出来，
 * 而且要摆成**游戏能直接渲染**的样子（字符表格没法让人认出地形和兵）。
 *
 * ── 为什么 --turn 是"半回合" ──────────────────────────────────
 *
 * 引擎每次 `END_TURN` 都把 `s.turn += 1`，所以这个数是**半回合**：
 * A 的 T15 之后是 B 的 T16。`analyze-replay` 打出来的 T16/T31 也是这个口径，
 * 两边对得上，不用换号。
 *
 * 用法：
 *   node --experimental-strip-types scripts/make-exam.ts \
 *     --replay results/replays/v4src-Q3-49-A.json \
 *     --turn 151 --me A --id Y-003 --out exams/Y-003
 *
 * 参数：
 *   --replay   回放文件（export-bench-replay 产出的那种）
 *   --turn     切在哪半回合（该方**还没动手**）
 *   --me       以哪一方出题（默认 A）
 *   --id       题号（写进题卡）
 *   --out      输出目录（默认 exams/<id>）
 *   --note     给快照加一句备注（可选）
 *   --dry      只打印面板，不写文件
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction } from '../src/core/rules.ts';
import { utype, maxHpOf } from '../src/core/rules.ts';
import { playerView } from '../src/core/fog.ts';
import { buildSnapshot } from '../src/core/snapshot.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const REPLAY = argOf('replay');
const TURN = Number(argOf('turn', '0'));
const ME = (argOf('me', 'A').toUpperCase() === 'B' ? 'B' : 'A') as PlayerId;
const ID = argOf('id', 'Y-000');
const OUT = resolve(argOf('out', `exams/${ID}`));
const NOTE = argOf('note', '');
const DRY = process.argv.includes('--dry');

if (!REPLAY || !TURN) {
  console.error('用法：make-exam.ts --replay <回放.json> --turn <半回合> [--me A] [--id Y-001] [--out dir] [--dry]');
  process.exit(1);
}

/* ── 重放 ───────────────────────────────────────────────────────
 * 和 analyze-replay / diag-replay 同一套重建方式：参数少抄一项就不是同一局。
 * 重放到"该方还没动手的那一格"，把那一份局面拷下来，然后继续跑到终局做自检。
 */
const r = JSON.parse(readFileSync(resolve(REPLAY), 'utf8')) as {
  seed: number;
  config?: Record<string, unknown>;
  actions?: Array<Record<string, unknown> & { by?: PlayerId }>;
  winner?: PlayerId | null;
  turns?: number;
  fog?: boolean;
};
const cfg = r.config ?? {};
let s: GameState = createMatch(
  {
    ...DEFAULT_CONFIG,
    size: Number(cfg.size ?? 12),
    startEra: Number(cfg.startEra ?? 2),
    mapSymmetry: (cfg.mapSymmetry as 'fair') ?? 'fair',
    citySize: cfg.citySize as number | undefined,
  },
  r.seed,
);

const actions = r.actions ?? [];
let cut: GameState | null = null;
/** 切点之后、该方这一回合里的动作（用来告诉出题人"v3 干了什么"） */
const then: Array<Record<string, unknown> & { by?: PlayerId }> = [];
let passed = false;

for (const a of actions) {
  if (!cut && s.current === ME && s.turn >= TURN) {
    cut = structuredClone(s);
    passed = true;
  }
  if (passed) {
    // 该方一结束回合就停收，否则会把后面几十回合的动作也算进"这一回合"
    if (a.type === 'END_TURN') passed = false;
    else then.push(a);
  }
  const res = applyAction(s, a as never);
  if (!res.ok) {
    console.error(`第 ${s.turn} 半回合的这个动作被引擎拒了：${JSON.stringify(a)}（${res.reason ?? ''}）`);
    break;
  }
  s = res.state;
}

if (!cut) {
  console.error(`没找到 ${ME} 方第 ${TURN} 半回合。这局最后停在 ${s.turn}（终局 ${s.winner ?? '平'}）。`);
  process.exit(1);
}

const at = cut;
const fog = r.fog === true;

/* ── 可读面板 ───────────────────────────────────────────────────
 * 分两块：测试员看得见的（过 playerView，和游戏内一致）、以及被雾挡住的。
 * 出题人两块都能看，但要分清——"人看得见什么"本身就是考点。
 */
const view = playerView(at, ME, false, true);

const tag = (u: Unit): string => {
  const cat = utype(at, u.type).category;
  return cat === 'economy' ? 'w' : cat === 'combat' ? 's' : cat === 'builder' ? 'b' : 'c';
};

/**
 * 编号按"兵种 → 坐标"排，同一局同一格永远拿同一个号，出题人不会记错。
 *
 * 一律按**真局面**编号（不是按"看得见的那些"）：否则雾里藏一个兵，
 * 后面所有编号都会挪一位，"敌s3"在面板和动作表里指的不是同一个东西。
 * 看得见 / 看不见只决定**印不印**，不决定编号。
 */
function numbering(owner: PlayerId): Array<{ no: string; u: Unit }> {
  const list = at.units
    .filter((u) => u.owner === owner)
    .sort((a, b) => (a.type === b.type ? a.y - b.y || a.x - b.x : a.type < b.type ? -1 : 1));
  const count = new Map<string, number>();
  return list.map((u) => {
    const t = tag(u);
    const n = (count.get(t) ?? 0) + 1;
    count.set(t, n);
    return { no: `${t}${n}`, u };
  });
}

/*
 * 引擎里的单位 id（`u82`）对人没有意义，面板上的编号（`s3` / `敌s1`）才有。
 */
const label = new Map<string, string>();
for (const q of ['A', 'B'] as PlayerId[]) {
  for (const { no, u } of numbering(q)) label.set(u.id, q === ME ? no : `敌${no}`);
}
const who = (id: unknown): string => label.get(String(id)) ?? String(id);

/** 城的 id（`c1`）同样对人没意义，一律换成坐标 */
const cityAt = (id: unknown): string => {
  const c = at.cities.find((x) => x.id === id);
  return c ? `(${c.x},${c.y})` : String(id);
};

/** 题卡上的问句。判断题用 --ask 换掉，别在模板里改。 */
const ASK = argOf('ask', '这一回合你会怎么做？（最多 3 步，按顺序，每步一句为什么）');

/* ── 两份面板 ───────────────────────────────────────────────────
 * `card.md` 会发给测试员，所以只能有"测试员在游戏里看得见的东西"；
 * 被雾挡住的真敌人、以及 v3 这一回合做了什么，只进 `author.md`。
 * 两份都从同一个局面生成，避免"给人看的和给机器看的不是同一个盘面"。
 */
const ghosts = view.ghosts ?? [];
const visibleIds = new Set(view.state.units.map((u) => u.id));
const hidden = at.units.filter((u) => u.owner !== ME && !visibleIds.has(u.id));
const visibleCityIds = new Set(view.state.cities.map((c) => c.id));

/** 我方的兵全都在自己视野里，敌方只有 part 部分可见 */
function unitLines(owner: PlayerId, onlyVisible: boolean): string[] {
  const all = numbering(owner);
  const shown = onlyVisible ? all.filter(({ u }) => visibleIds.has(u.id)) : all;
  const out: string[] = [];
  for (const { no, u } of shown) {
    const d = utype(at, u.type);
    const flags = [u.moved ? '已走' : '', u.acted ? '已打' : ''].filter(Boolean).join(' ');
    out.push(
      `  ${no.padEnd(4)} ${d.name.padEnd(6)} (${String(u.x).padStart(2)},${String(u.y).padStart(2)})` +
        ` 血 ${u.hp}/${maxHpOf(at, u)}` +
        `${d.atk ? ` 攻 ${d.atk}` : ''}${d.range && d.range > 1 ? ` 射 ${d.range}` : ''}` +
        `${flags ? ` ${flags}` : ''}`,
    );
  }
  return out;
}

/** 只按兵种数个数：题卡给测试员看的是"有多少什么"，站位让他自己在游戏里看 */
function summary(owner: PlayerId, onlyVisible: boolean): string[] {
  const rows = numbering(owner).filter(({ u }) => !onlyVisible || visibleIds.has(u.id));
  if (rows.length === 0) return [];
  const by = new Map<string, number>();
  for (const { u } of rows) {
    const n = utype(at, u.type).name;
    by.set(n, (by.get(n) ?? 0) + 1);
  }
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return [`  ${rows.length} 个：` + parts.map(([n, c]) => `${n}×${c}`).join('　')];
}

function panel(full: boolean): string {
  const L: string[] = [];
  const p = (x = '') => L.push(x);

  p(`# ${ID}　${ME} 方 · 第 ${at.turn} 手（我方还没动手）`);
  p();
  p(`地图 ${at.w}×${at.h} · 起始时代 ${cfg.startEra ?? '?'} · 雾：${fog ? '开' : '关'} · ` +
    (['A', 'B'] as PlayerId[]).map((q) => `${q === ME ? '我' : '敌'}金 ${at.players[q]?.gold ?? 0}`).join(' / '));
  p();

  for (const q of ['A', 'B'] as PlayerId[]) {
    const cs = at.cities.filter((c) => c.owner === q && (!full && q !== ME ? visibleCityIds.has(c.id) : true));
    p(`${q === ME ? '我方' : '敌方'}城 ${cs.length} 座：` +
      cs.map((c) => `(${c.x},${c.y}) 血 ${c.hp}${c.ruined ? ' 废墟' : ''} 时代 ${c.era}`).join('　'));
  }
  p();

  if (full) {
    const mine = unitLines(ME, false);
    p(`## 我方单位（${mine.length} 个）`);
    L.push(...mine);
    p();

    const foeShown = unitLines(ME === 'A' ? 'B' : 'A', true);
    p(`## 我看得见的敌方单位（${foeShown.length} 个）`);
    if (foeShown.length === 0) p('（一个都没看见）');
    L.push(...foeShown);
    p();
  } else {
    p('## 我方兵力');
    L.push(...summary(ME, false));
    p();
    p('## 看得见的敌方兵力');
    const foe = summary(ME === 'A' ? 'B' : 'A', true);
    L.push(...(foe.length > 0 ? foe : ['  （一个都没看见）']));
    p();
    p('> 站位、地形、能不能走过去，都在游戏里看——这份文字只回答"有多少什么"。');
    p();
  }

  if (ghosts.length > 0) {
    p(`## 记忆里的敌人（此刻看不见，${ghosts.length} 个）`);
    for (const g of ghosts) p(`  ${utype(at, g.type)?.name ?? g.type} @(${g.x},${g.y})`);
    p();
  }

  if (!full) return L.join('\n');

  if (hidden.length > 0) {
    p(`## ⚠️ 被雾挡住、测试员看不见的敌人（${hidden.length} 个 —— 不许进题卡）`);
    for (const u of hidden) p(`  ${who(u.id)} ${utype(at, u.type).name} (${u.x},${u.y}) 血 ${u.hp}`);
    p();
  }

  p('## 这一回合 v3 实际做了什么（对照用，不是标准答案）');
  if (then.length === 0) p('（这一回合它什么都没做，直接结束了回合）');
  for (const a of then) p(`  ${describeAction(a)}`);
  p();
  return L.join('\n');
}

function describeAction(a: Record<string, unknown>): string {
  const t = String(a.type);
  if (t === 'MOVE') return `走：${who(a.unitId)} → (${a.x},${a.y})`;
  if (t === 'ATTACK') return `打：${who(a.unitId)} → ${who(a.targetId)}`;
  if (t === 'SIEGE') return `攻城：${who(a.unitId)} → ${cityAt(a.cityId)}`;
  if (t === 'RECRUIT') return `造兵：${recruitName(a.unitType)} @${cityAt(a.cityId ?? a.unitId)}`;
  if (t === 'BUILD') return `建造：${recruitName(a.unitType)} @(${a.x},${a.y})`;
  if (t === 'UPGRADE') return `升代：${cityAt(a.cityId)}`;
  return `${t} ${JSON.stringify(a)}`;
}

function recruitName(type: unknown): string {
  const d = utype(at, String(type));
  return d?.name ?? String(type);
}

const fullPanel = panel(true);
const safePanel = panel(false);
console.log(fullPanel);
if (DRY) process.exit(0);

/* ── 写文件 ─────────────────────────────────────────────────── */
mkdirSync(OUT, { recursive: true });

/* 快照：显式关掉两个席位的 AI。
 * 这几局回放的 config 里 `aiSeats` 本来就是空数组，所以导出后 AI 不会自己走；
 * 但这条不能靠"本来就对"——换个来源（比如从 AI 对局里截图）就会自己动起来。 */
const snapState = structuredClone(at);
snapState.aiControl = { A: false, B: false };
const snap = buildSnapshot(snapState, {
  note: NOTE || `${ID} 出题局面（${ME} 方第 ${TURN} 半回合）`,
  now: new Date(0),
  logLines: 40,
});
writeFileSync(resolve(OUT, 'snap.json'), JSON.stringify(snap));

/* card.md：发给测试员的那一份。只有他能看见的东西 + 问题，没有答案也没有隐藏敌人。 */
writeFileSync(
  resolve(OUT, 'card.md'),
  `# ${ID}

> 局面文件：\`snap.json\`——把整个文件内容粘进游戏首页「导入对局」，就站在这一格上。
> 来源：\`${REPLAY}\` · 从第 ${TURN} 手起切，实际落在第 ${at.turn} 手 · ${ME} 方

## 局面

\`\`\`
${safePanel}
\`\`\`

## 问题

${ASK}

## 请回三件事

1. 你的做法（按顺序，每步一句"为什么"）；
2. 局面里有没有一件"必须马上处理"的事？是哪件？
3. 这题你觉得简单还是不公平？为什么？
`,
);

/* answer.md：标准答案 + 判据 + 红线。出题人填，机器只读这一份。 */
writeFileSync(
  resolve(OUT, 'answer.md'),
  `# ${ID} 答案与判据

> 这张表由出题人填。**判据看结果，答案只是示范**——答案写"三回合内桥点空出来"
> 是判据，写"s1 必须走到 (5,3)"就是把答案当判据了（手册第七节）。

## 标准答案（人写的，可有多解）

| 谁 | 做什么 | 到哪儿（人话） | 机器 | 为什么 |
|---|---|---|---|---|
|  |  |  |  |  |

替代解法：

## 判据（机器判）

- 做到了什么（带时间窗）：
- 没破坏什么：
- 时间窗：　回合
- 不看什么：

## 红线（算错，哪怕判据通过）

-

## 为什么这题值得出

（对应 v3 的哪个病；它在原局里造成了什么后果）

## 自检

- [ ] 导入游戏后棋盘静止（没人自己动）
- [ ] 照答案走一遍，每步都被接受
- [ ] 走完判据满足
- [ ] 跑判分器，v3 是红的
`,
);

/* author.md：出题人核对用。含隐藏敌人与 v3 实际动作——不要发给测试员。 */
writeFileSync(
  resolve(OUT, 'author.md'),
  `# ${ID} 出题人参考

> ⚠️ 这份含**测试员看不见的信息**与 v3 的实际走法，只给出题人看。
> 测试员那份是 \`card.md\`。

\`\`\`
${fullPanel}
\`\`\`
`,
);

console.log(`\n已写出：${OUT}/{snap.json, card.md, answer.md, author.md}`);
console.log(`自检：重放到终局 = ${s.winner ?? '平'}（第 ${s.turn} 半回合） · 回放记录 = ${r.winner ?? '平'}（第 ${r.turns}）`);
