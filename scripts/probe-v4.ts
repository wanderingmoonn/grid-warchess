/**
 * 看 v4 这一手"打算干什么"。
 *
 * 出问题时第一眼看它，而不是读代码：决定是什么、几支队、每队几个人、
 * 哪几格被标成"必须空"。这三样对不上，问题就在约束层；对得上但行为怪，问题在打分层。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-v4.ts --exam exams/S-000
 *   ... --turns 12      # 往前推到第 12 手再看
 */
import { readFileSync } from 'node:fs';
import { applyAction } from '../src/core/rules.ts';
import { currentView, resetV4 } from '../src/core/v4/ai-v4.ts';
import { DEFAULT_BUDGET, AI_MAX_STEPS, aiActionKey } from '../src/core/ai.ts';
import type { GameState } from '../src/core/types.ts';

const argOf = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const EXAM = argOf('exam', 'exams/S-000');
const TURNS = Number(argOf('turns', '1'));
const ME = 'A';

const snap = JSON.parse(readFileSync(`${EXAM}/snap.json`, 'utf8')) as { state: GameState };
let s: GameState = JSON.parse(JSON.stringify(snap.state));
s.current = ME as GameState['current'];
resetV4();

const v1 = ((await import('./baselines/ai-9efb961.ts')) as {
  aiNextAction: (st: GameState, b: typeof DEFAULT_BUDGET, r: ReadonlySet<string>) => ReturnType<typeof import('../src/core/ai.ts')['aiNextAction']>;
}).aiNextAction;

/* 先把局面推到第 N 手（双方都用 v1 推，别让 v4 自己影响起点） */
for (let t = 1; t < TURNS && !s.winner; t++) {
  for (let side = 0; side < 2; side++) {
    const rejected = new Set<string>();
    const budget = { ...DEFAULT_BUDGET };
    for (let i = 0; i < AI_MAX_STEPS && !s.winner; i++) {
      const a = v1(s, budget, rejected);
      if (!a) break;
      const r = applyAction(s, a);
      if (!r.ok) { rejected.add(aiActionKey(a)); continue; }
      rejected.clear();
      s = r.state;
    }
    if (!s.winner) {
      const r = applyAction(s, { type: 'END_TURN' });
      if (!r.ok) break;
      s = r.state;
    }
  }
}

const v = currentView(s, ME as GameState['current']);
console.log(`\n=== ${EXAM} · 第 ${s.turn} 手 ===\n`);
console.log('决定：', v.decision.kind, `（管到第 ${v.decision.untilTurn} 手）`);
console.log('理由：', v.decision.reason);
/* 钱怎么花（D1）：四种模式 + 上限 + 一句话。这一行是"为什么这手没造兵"的唯一入口 */
console.log(
  '钱：',
  `${v.decision.spend.mode}${v.decision.spend.cap !== undefined ? `（上限 ${v.decision.spend.cap}）` : ''}`,
  '·',
  v.decision.spend.why,
);
console.log('目标城：', v.decision.cityId ?? '（无）');
/*
 * 升级（P3 闸 A/B）：这一手要不要升、升哪座城、为什么。
 * D2 之后 `why` 里的"×N 手"是**还能发展几手**（长度），不再是"第几手"。
 */
/*
 * 升级分两句话看（D4a）：
 *   · 决定层说"要不要、先升哪座"——`decision.upgrade`；
 *   · 计划层说"这一手执行得了吗"——`con.upgrade`（被否时决定层那句话仍然看得见，
 *     这正是"为什么没升"要能读出来的意思）。
 */
const plan = v.decision.upgrade;
console.log(
  '升级（决定）：',
  plan ? `${plan.kind} → ${plan.candidates.map((c) => `${c.cityId}/第${c.targetEra}代`).join('、')}` : '（不升）',
  plan ? `· ${plan.candidates[0]!.why}` : '',
);
console.log(
  '升级（执行）：',
  v.con.upgrade
    ? `${v.con.upgrade.cityId} · ${v.con.upgrade.cost} 金 · ${v.con.upgrade.why}`
    : `（这一手不升）${v.con.upgradeBlocked ? ` —— ${v.con.upgradeBlocked}` : ''}`,
);
console.log('\n队伍：');
for (const q of v.con.squads) {
  const at = q.at ? ` @(${q.at.x},${q.at.y})` : '';
  console.log(`  ${q.id.padEnd(12)} ${q.order.padEnd(9)} ${String(q.unitIds.length).padStart(2)} 人${at}${q.cityId ? ` → ${q.cityId}` : ''}`);
}
console.log(`\n必须空出来的格子：${v.con.keepClear.length} 格`);
console.log('  坐标：', v.con.keepClear.slice(0, 12).map((k) => `(${k % s.w},${Math.floor(k / s.w)})`).join(' '), v.con.keepClear.length > 12 ? '…' : '');
/*
 * **守得住吗**（D3）：不看"离敌人几格"，看"每一轮真能开火的人砸多少、还能撑几轮"。
 * `incoming` 的下标就是回合号 − 1，可以拿它和 criteria 里的手算逐轮核对。
 */
console.log('\n守得住吗：');
for (const c of v.world.myCities) {
  const st = v.world.cityStand(c);
  const r = (x: number): string => (Number.isFinite(x) ? `${x} 轮` : '塌不了');
  console.log(
    `  ${c.id} 血 ${c.hp}/${c.maxHp} 甲 ${c.armor} · 现在 ${r(st.rounds)}` +
      `${st.roundsAfterUpgrade !== undefined ? ` · 升一级后 ${r(st.roundsAfterUpgrade)}` : '（升不了）'}` +
      ` · 威胁 ${st.threats}（最早第 ${Number.isFinite(st.firstAt) ? st.firstAt : '-'} 回合开火）`,
  );
  if (st.incoming.length > 0) console.log(`     每轮齐射 ${st.incoming.join(' / ')}`);
}

/*
 * **兵线（W1 影子观测，2026-11-26）**：三存量 + 这一波 + 交换账。
 * 只打印，不参与任何判断。时间序列看 `V4_LANE_LOG=1` 跑整局。
 * 注意：探针用 v1 把局面推到第 N 手，所以 `波 / 交换` 是空的（那是 v4 自己记的），
 * 只有 `lane` 是当下算的。
 */
{
  const mem = (s.aiFocus?.[ME]?.v4 ?? {}) as { wave?: unknown; exchange?: Array<{ gain: number; loss: number }> };
  const lane = v.con.lane;
  const w = mem.wave as
    | { cityId: string; startedTurn: number; men: number; arrivedTurn?: number; arrivedMen?: number }
    | undefined;
  const ex = mem.exchange ?? [];
  console.log('\n兵线（只观测）：');
  console.log(`  前线 ${lane?.front ?? '-'} · 在途 ${lane?.road ?? '-'} · 这回合能造 ${lane?.make ?? '-'}`);
  console.log(
    `  波：${w ? `${w.cityId} 出发 T${w.startedTurn} ${w.men} 人${w.arrivedTurn ? ` → T${w.arrivedTurn} 到 ${w.arrivedMen} 人` : ' 在路上'}` : '（无）'}`,
  );
  console.log(
    `  交换（最近 ${ex.length} 手）：赚 ${ex.reduce((n, x) => n + x.gain, 0)} / 亏 ${ex.reduce((n, x) => n + x.loss, 0)}`,
  );
}

console.log('\n城的角色：');
for (const c of v.world.cities) {
  console.log(`  ${c.city.id} ${c.role.padEnd(11)} 离敌城 ${Number.isFinite(c.distToFoeCity) ? c.distToFoeCity + ' 回合' : '走不到'} · 守军潜力 ${c.defenders}`);
}
