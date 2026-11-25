/**
 * v4 的**调试面板**（右下角）：把三层的输出画出来，而不是只打在终端里。
 *
 * ── 为什么要画 ──────────────────────────────────────────────
 *
 * 终端那版（`scripts/probe-v4.ts`）只能看"这一刻"。调试真正要回答的是
 * "它为什么这么走"——而这句话里包含**位置**：哪几格被标成"必须空"、哪几个兵归哪队、
 * 目标城在哪。这些用文字说不清，一眼图能省十分钟。
 *
 * ── 面板里有什么 ────────────────────────────────────────────
 *
 * ① 决定（做什么 / 管到第几手 / 为什么）—— 约束层的输入
 * ② 队伍（任务 + 人数 + 目标）—— 约束层的输出
 * ③ 迷你地图 —— 单位、城、必须空的格子，全画在同一张图上
 *
 * 只读：它不改任何状态，也不替 AI 做决定。关掉它，行为必须一模一样。
 */
import type { GameState, PlayerId } from '../core/types.ts';
import { v4Snapshot } from '../core/v4/ai-v4.ts';
import { utype } from '../core/rules.ts';

const ROLE_LABEL: Record<string, string> = { press: '推', defend: '守', expand: '发展' };
/** 钱怎么花（D1）：四种模式各一句人话，面板上直接读 */
const SPEND_LABEL: Record<string, string> = {
  save: '攒钱',
  econOnly: '只补经济',
  econThenArmy: '经济优先',
  army: '只造兵',
};
const ORDER_LABEL: Record<string, string> = {
  march: '推进',
  siege: '攻城',
  assemble: '集结',
  hold: '驻守',
};

const CELL = 5;

/**
 * 迷你地图：一格一个方块，上面叠单位、城、"必须空"的格子。
 *
 * 颜色：我方战斗青、我方经济琥珀、敌方红；敌城深红、我城蓝；
 * "必须空"的格子用橙色描边（它就是这个面板最该被看见的东西——约束在哪）。
 */
function miniMap(s: GameState, me: PlayerId, keepClear: number[]): string {
  const W = s.w * CELL;
  const H = s.h * CELL;
  const parts: string[] = [];

  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const t = s.tiles[y * s.w + x]?.terrain ?? 'plain';
      const fill =
        t === 'water' || t === 'deep' ? '#1B3A4B'
        : t === 'mountain' ? '#3A3A38'
        : t === 'forest' ? '#2A3A2A'
        : '#2C2C2A';
      parts.push(`<rect x="${x * CELL}" y="${y * CELL}" width="${CELL - 1}" height="${CELL - 1}" fill="${fill}"/>`);
    }
  }

  for (const c of s.cities) {
    const foe = c.owner !== me;
    parts.push(
      `<rect x="${c.x * CELL}" y="${c.y * CELL}" width="${CELL * (c.size ?? 2) - 1}" height="${CELL * (c.size ?? 2) - 1}" ` +
        `fill="${c.ruined ? '#4A2A2A' : foe ? '#A32D2D' : '#185FA5'}" stroke="${foe ? '#F09595' : '#85B7EB'}" stroke-width="0.8"/>`,
    );
  }

  /* "必须空"的格子：橙色空心方框。`keepClear` 是下标，换回坐标再画 */
  for (const k of keepClear) {
    const x = k % s.w;
    const y = Math.floor(k / s.w);
    parts.push(
      `<rect x="${x * CELL + 0.5}" y="${y * CELL + 0.5}" width="${CELL - 2}" height="${CELL - 2}" fill="none" stroke="#EF9F27" stroke-width="0.9"/>`,
    );
  }

  for (const u of s.units) {
    const mine = u.owner === me;
    const cat = utype(s, u.type).category;
    const fill = mine ? (cat === 'economy' ? '#FAC775' : '#5DCAA5') : '#E24B4A';
    parts.push(`<circle cx="${u.x * CELL + CELL / 2}" cy="${u.y * CELL + CELL / 2}" r="1.7" fill="${fill}"/>`);
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">${parts.join('')}</svg>`;
}

/**
 * **升级那一行**（D6）：决定层要不要、计划层执不执行、被否时为什么。
 *
 * 三种状态各一句话，不合并：
 *   · 不升   → 决定层没这个念头（没在救城、钱也不算花不完）；
 *   · 要升   → 哪座城、升到第几代、多少钱；
 *   · 被否   → 决定层要升，计划层说不行，**原因写在这儿**。
 */
function upgradeLine(
  d: { upgrade?: { kind: string; candidates: Array<{ cityId: string; targetEra: number; why: string }> } },
  exec: { cityId: string; cost: number; why: string } | undefined,
  blocked: string | undefined,
): string {
  const plan = d.upgrade;
  if (!plan || plan.candidates.length === 0) {
    return '<span style="color:#888780">升级 · 这一期不升</span>';
  }
  const first = plan.candidates[0]!;
  const tag = plan.kind === 'rescue' ? '救城' : '升代';
  if (exec) {
    return `<span style="color:#FAC775">升级 · ${tag} ${first.cityId}→第${first.targetEra}代 · ${exec.cost} 金</span>`;
  }
  return `<span style="color:#F09595">升级 · ${tag} ${first.cityId}→第${first.targetEra}代被否 · ${blocked ?? '原因未知'}</span>`;
}

/** 整块面板。每回合重建一次就够（调用方按回合号缓存），别放进每帧渲染 */
export function v4HudHtml(s: GameState, me: PlayerId): string {
  const snap = v4Snapshot(s, me);
  const d = snap.decision;

  const rows = snap.squads
    .map(
      (q) => `<div style="display:flex;gap:6px;align-items:center;font-size:11px;color:#C9C7BE;line-height:1.8">
        <span style="width:6px;height:6px;border-radius:50%;background:#5DCAA5;flex:none"></span>
        <span style="flex:1">${q.id}</span>
        <span style="color:#888780">${ORDER_LABEL[q.order] ?? q.order}</span>
        <span style="font-variant-numeric:tabular-nums">${q.n}</span>
      </div>`,
    )
    .join('');

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:11px;color:#888780">v4 · 第 ${s.turn} 手</span>
      <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:#085041;color:#9FE1CB">${ROLE_LABEL[d.kind] ?? d.kind}</span>
    </div>
    <div style="font-size:11px;color:#B4B2A9;line-height:1.5;margin-bottom:8px">
      管到第 ${d.untilTurn} 手${d.cityId ? ` · 目标 ${d.cityId}` : ''}<br>
      <span style="color:#888780">${d.reason}</span><br>
      <span style="color:#9FE1CB">钱 ${SPEND_LABEL[d.spend.mode] ?? d.spend.mode}${d.spend.cap !== undefined ? `（上限 ${d.spend.cap}）` : ''}</span>
      <span style="color:#888780"> · ${d.spend.why}</span><br>
      ${upgradeLine(d, snap.upgrade, snap.upgradeBlocked)}
    </div>
    <div style="border-top:1px solid #3A3A38;padding-top:6px;margin-bottom:8px">
      ${rows || '<span style="font-size:11px;color:#888780">没有队伍（都闲着）</span>'}
    </div>
    <div style="display:flex;gap:10px;align-items:flex-start">
      ${miniMap(s, me, snap.keepClearList)}
      <div style="font-size:10px;color:#888780;line-height:1.8;white-space:nowrap">
        <div><span style="color:#5DCAA5">●</span> 我方战斗</div>
        <div><span style="color:#FAC775">●</span> 我方经济</div>
        <div><span style="color:#E24B4A">●</span> 敌方</div>
        <div><span style="color:#EF9F27">▢</span> 必须空 ${snap.keepClearList.length}</div>
      </div>
    </div>`;
}

/** 面板外壳：只建一次节点，之后只换 innerHTML */
export function ensureV4Hud(): HTMLElement {
  let el = document.getElementById('v4-hud');
  if (!el) {
    el = document.createElement('div');
    el.id = 'v4-hud';
    el.style.cssText = [
      'position:fixed',
      'right:12px',
      'bottom:12px',
      'width:248px',
      'padding:10px 12px',
      'border-radius:10px',
      'background:rgba(24,24,22,0.94)',
      'border:1px solid #3A3A38',
      'box-shadow:0 6px 24px rgba(0,0,0,0.45)',
      'font-family:system-ui,sans-serif',
      'z-index:60',
      'pointer-events:none',
      'backdrop-filter:blur(6px)',
    ].join(';');
    document.body.append(el);
  }
  return el;
}

/** 关掉面板（换局 / 离开 v4 模式时） */
export function removeV4Hud(): void {
  document.getElementById('v4-hud')?.remove();
}
