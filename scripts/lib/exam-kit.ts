/**
 * 出题工具箱：把"一格局面"写成一套题（snap / card / answer / author）+ 打印面板。
 *
 * 两个调用方共用它，所以题卡长相永远一致：
 *   · `scripts/make-exam.ts`  —— 从回放里切一格（真实局面）
 *   · `scripts/make-scene.ts` —— 手摆一格（单机制题）
 *
 * ── 为什么题卡和作者面板要分开 ────────────────────────────────
 *
 * `card.md` 会发给测试员，所以只能有**他在游戏里看得见的东西**；
 * 被雾挡住的真敌人、以及"v3 这一回合做了什么"，只进 `author.md`。
 * 两份都从同一个 state 生成，避免"给人看的"和"给机器判的"不是同一盘棋。
 *
 * ── 编号规则 ──────────────────────────────────────────────────
 *
 * 单位没有独立名字（`Unit` 只有兵种），所以面板用编号：`w1` 经济、`s1` 战斗、
 * `b1` 建造、`c1` 建筑，按"兵种 → 坐标"排。一律按**真局面**编号——
 * 否则雾里藏一个兵，后面全体挪位，"敌s3"在面板和动作表里指的不是同一个。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { maxHpOf, utype } from '../../src/core/rules.ts';
import { playerView } from '../../src/core/fog.ts';
import { buildSnapshot } from '../../src/core/snapshot.ts';
import type { GameState, PlayerId, Unit } from '../../src/core/types.ts';

export interface ExamWriteOpts {
  state: GameState;
  me: PlayerId;
  id: string;
  /** 输出目录 */
  out: string;
  /** 题卡上的问句 */
  ask: string;
  /** 来源一句话（写进题卡顶部） */
  source: string;
  /** 快照的备注 */
  note?: string;
  /** 出题人参考：这一回合某个 AI 实际做了什么（只有切回放时有） */
  thenActions?: Array<Record<string, unknown>>;
  /** 这一局是不是开了雾（缺省读 `state.fog`） */
  fog?: boolean;
  /** 只打印面板、不写文件 */
  dry?: boolean;
}

const tagOf = (s: GameState, u: Unit): string => {
  const cat = utype(s, u.type).category;
  return cat === 'economy' ? 'w' : cat === 'combat' ? 's' : cat === 'builder' ? 'b' : 'c';
};

export function writeExam(opts: ExamWriteOpts): { panelFull: string; panelSafe: string } {
  const at = opts.state;
  const ME = opts.me;
  const FOE: PlayerId = ME === 'A' ? 'B' : 'A';
  const fog = opts.fog ?? at.fog === true;

  /* 编号：一律按真局面 */
  const numbering = (owner: PlayerId): Array<{ no: string; u: Unit }> => {
    const list = at.units
      .filter((u) => u.owner === owner)
      .sort((a, b) => (a.type === b.type ? a.y - b.y || a.x - b.x : a.type < b.type ? -1 : 1));
    const count = new Map<string, number>();
    return list.map((u) => {
      const t = tagOf(at, u);
      const n = (count.get(t) ?? 0) + 1;
      count.set(t, n);
      return { no: `${t}${n}`, u };
    });
  };

  const label = new Map<string, string>();
  for (const p of ['A', 'B'] as PlayerId[]) {
    for (const { no, u } of numbering(p)) label.set(u.id, p === ME ? no : `敌${no}`);
  }
  const who = (id: unknown): string => label.get(String(id)) ?? String(id);
  const cityAt = (id: unknown): string => {
    const c = at.cities.find((x) => x.id === id);
    return c ? `(${c.x},${c.y})` : String(id);
  };

  const view = playerView(at, ME, false, false);
  const ghosts = view.ghosts ?? [];
  const visibleIds = new Set(view.state.units.map((u) => u.id));
  const visibleCityIds = new Set(view.state.cities.map((c) => c.id));
  const hidden = at.units.filter((u) => u.owner !== ME && !visibleIds.has(u.id));

  const describe = (a: Record<string, unknown>): string => {
    const t = String(a.type);
    if (t === 'MOVE') return `走：${who(a.unitId)} → (${a.x},${a.y})`;
    if (t === 'ATTACK') return `打：${who(a.unitId)} → ${who(a.targetId)}`;
    if (t === 'SIEGE') return `攻城：${who(a.unitId)} → ${cityAt(a.cityId)}`;
    if (t === 'RECRUIT') return `造兵：${utype(at, String(a.unitType))?.name ?? a.unitType} @${cityAt(a.cityId ?? a.unitId)}`;
    if (t === 'BUILD') return `建造：${utype(at, String(a.unitType))?.name ?? a.unitType} @(${a.x},${a.y})`;
    if (t === 'UPGRADE') return `升代：${cityAt(a.cityId)}`;
    if (t === 'DISBAND') return `拆掉：${who(a.unitId)}`;
    return `${t} ${JSON.stringify(a)}`;
  };

  /** 只数个数：题卡给测试员看的是"有多少什么"，站位让他自己在游戏里看 */
  const summary = (owner: PlayerId, onlyVisible: boolean): string[] => {
    const rows = numbering(owner).filter(({ u }) => !onlyVisible || visibleIds.has(u.id));
    if (rows.length === 0) return [];
    const by = new Map<string, number>();
    for (const { u } of rows) {
      const n = utype(at, u.type).name;
      by.set(n, (by.get(n) ?? 0) + 1);
    }
    const parts = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [`  ${rows.length} 个：` + parts.map(([n, c]) => `${n}×${c}`).join('　')];
  };

  const unitLines = (owner: PlayerId, onlyVisible: boolean): string[] => {
    const all = numbering(owner);
    const shown = onlyVisible ? all.filter(({ u }) => visibleIds.has(u.id)) : all;
    return shown.map(({ no, u }) => {
      const d = utype(at, u.type);
      const flags = [u.moved ? '已走' : '', u.acted ? '已打' : ''].filter(Boolean).join(' ');
      return (
        `  ${no.padEnd(4)} ${d.name.padEnd(6)} (${String(u.x).padStart(2)},${String(u.y).padStart(2)})` +
        ` 血 ${u.hp}/${maxHpOf(at, u)}` +
        `${d.atk ? ` 攻 ${d.atk}` : ''}${d.range && d.range > 1 ? ` 射 ${d.range}` : ''}` +
        `${flags ? ` ${flags}` : ''}`
      );
    });
  };

  const panel = (full: boolean): string => {
    const L: string[] = [];
    const p = (x = '') => L.push(x);

    p(`# ${opts.id}　${ME} 方 · 第 ${at.turn} 手（我方还没动手）`);
    p();
    p(
      `地图 ${at.w}×${at.h} · 起始时代 ${at.config.startEra ?? '?'} · 雾：${fog ? '开' : '关'} · ` +
        (['A', 'B'] as PlayerId[]).map((q) => `${q === ME ? '我' : '敌'}金 ${at.players[q]?.gold ?? 0}`).join(' / '),
    );
    p();

    for (const q of ['A', 'B'] as PlayerId[]) {
      const cs = at.cities.filter((c) => c.owner === q && (!full && q !== ME ? visibleCityIds.has(c.id) : true));
      p(
        `${q === ME ? '我方' : '敌方'}城 ${cs.length} 座：` +
          cs.map((c) => `[${c.id}](${c.x},${c.y}) 血 ${c.hp}/${c.maxHp}${c.ruined ? ' 废墟' : ''} 时代 ${c.era}`).join('　'),
      );
    }
    p();

    if (full) {
      const mine = unitLines(ME, false);
      p(`## 我方单位（${mine.length} 个）`);
      L.push(...mine);
      p();
      const foeShown = unitLines(FOE, true);
      p(`## 我看得见的敌方单位（${foeShown.length} 个）`);
      if (foeShown.length === 0) p('（一个都没看见）');
      L.push(...foeShown);
      p();
    } else {
      p('## 我方兵力');
      L.push(...summary(ME, false));
      p();
      p('## 看得见的敌方兵力');
      const foe = summary(FOE, true);
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

    if (opts.thenActions) {
      p('## 这一回合 v3 实际做了什么（对照用，不是标准答案）');
      if (opts.thenActions.length === 0) p('（这一回合它什么都没做，直接结束了回合）');
      for (const a of opts.thenActions) p(`  ${describe(a)}`);
      p();
    }
    return L.join('\n');
  };

  const panelFull = panel(true);
  const panelSafe = panel(false);

  if (opts.dry) return { panelFull, panelSafe };

  /* ── 写文件 ───────────────────────────────────────────────── */
  mkdirSync(opts.out, { recursive: true });

  /* 快照：显式关掉两个席位的 AI。
   * 回放来源的 config 里 `aiSeats` 通常是空数组，本来就不会自己走；
   * 但"本来就对"不能当依赖——手摆的局面里这条更容易漏。 */
  const snapState = structuredClone(at);
  snapState.aiControl = { A: false, B: false } as Record<PlayerId, boolean>;
  const snap = buildSnapshot(snapState, {
    note: opts.note || `${opts.id} 出题局面（${ME} 方第 ${at.turn} 手）`,
    now: new Date(0),
    logLines: 40,
  });
  writeFileSync(resolve(opts.out, 'snap.json'), JSON.stringify(snap));

  writeFileSync(
    resolve(opts.out, 'card.md'),
    `# ${opts.id}

> 局面文件：\`snap.json\`——把整个文件内容粘进游戏首页「导入对局」，就站在这一格上。
> ${opts.source}

## 局面

\`\`\`
${panelSafe}
\`\`\`

## 问题

${opts.ask}

## 请回三件事

1. 你的做法（按顺序，每步一句"为什么"）；
2. 局面里有没有一件"必须马上处理"的事？是哪件？
3. 这题你觉得简单还是不公平？为什么。
`,
  );

  writeFileSync(
    resolve(opts.out, 'answer.md'),
    `# ${opts.id} 答案

> 这张表由出题人填。**判据写在 criteria.json，不写在这里**——
> 这里只留"人会怎么做"以及为什么，判分器不读这份。

## 标准答案（人写的，可有多解）

| 谁 | 做什么 | 到哪儿（人话） | 机器 | 为什么 |
|---|---|---|---|---|
|  |  |  |  |  |

替代解法：

## 红线（算错，哪怕判据通过）

-

## 为什么这题值得出

（对应 v3 的哪个病；它在原局里造成了什么后果）
`,
  );

  writeFileSync(
    resolve(opts.out, 'author.md'),
    `# ${opts.id} 出题人参考

> ⚠️ 这份含**测试员看不见的信息**与 AI 的实际走法，只给出题人看。
> 测试员那份是 \`card.md\`。判据请写进 \`criteria.json\`。

\`\`\`
${panelFull}
\`\`\`
`,
  );

  return { panelFull, panelSafe };
}
