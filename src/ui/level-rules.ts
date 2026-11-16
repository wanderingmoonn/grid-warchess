/**
 * 规则面板：扩展包三档 + 关卡专属 AI 三旋钮。
 *
 * 这两样在数据上是两件事（`expansions` / `ai`），但对作者来说是同一类操作——
 * "这一关的环境要什么样"。放在一个面板里，也省得工具栏再长一个按钮。
 *
 * 三档的语义（`LevelExpansionRules`）：
 *   · 必须开 = 这一关的玩法依赖它，玩家没得选；
 *   · 禁用   = 它会抹掉这一关的设计前提；
 *   · 会变难 = 不破坏设计，只是把难度推到没调过的区间——**提醒，不锁**。
 * 没提到的 = 归玩家，这是有意的：换一套包重打同一张关是重玩价值。
 *
 * AI 三个旋钮的边界来自 `LevelAiTuning`：写超了会被夹回区间，不会让整张图被拒。
 */

import { EXPANSIONS } from '../core/expansions.ts';
import type { LevelDef, LevelAiTuning } from '../core/level.ts';
import { toast } from './toast.ts';

type Tier = 'none' | 'require' | 'forbid' | 'warn';

const TIER_NAME: Record<Tier, string> = {
  none: '无',
  require: '必选',
  forbid: '禁用',
  warn: '警告',
};

/** 三个旋钮：名字 / 区间 / 默认 / 一句话解释 */
const KNOBS: Array<{
  key: keyof LevelAiTuning;
  name: string;
  min: number;
  max: number;
  hint: string;
}> = [
  {
    key: 'riskAversion',
    name: '风险厌恶',
    min: 0,
    max: 2,
    hint: '0 = 完全不计伤亡；小 = 敢用伤亡换推进；大 = 惜命。默认 1。',
  },
  {
    key: 'cohesion',
    name: '战线收拢',
    min: 0,
    max: 2,
    hint: '0 = 谁快谁先上；2 = 停下来等队友。默认 1。',
  },
  {
    key: 'appetite',
    name: '战意',
    min: 0.2,
    max: 3,
    hint: '放大或缩小「朝目标推进」的分。默认 1。',
  },
];

export interface LevelRulesOptions {
  level: LevelDef;
  onApply: (level: LevelDef) => void;
  onClose?: () => void;
}

const esc = (t: string) =>
  t.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : ''));

export function openLevelRules(opts: LevelRulesOptions): void {
  const level = opts.level;

  /** 每个包当前属于哪一档 */
  const tiers: Record<string, Tier> = {};
  for (const id of level.expansions?.require ?? []) tiers[id] = 'require';
  for (const id of level.expansions?.forbid ?? []) tiers[id] = 'forbid';
  for (const id of level.expansions?.warn ?? []) if (!tiers[id]) tiers[id] = 'warn';

  const ai: Required<LevelAiTuning> = {
    riskAversion: level.ai?.riskAversion ?? 1,
    cohesion: level.ai?.cohesion ?? 1,
    appetite: level.ai?.appetite ?? 1,
  };

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-head">
        <h2>规则：扩展包与 AI</h2>
      </div>
      <div class="modal-body">
        <div class="field-label">扩展包 <span class="field-hint" data-exp-count></span></div>
        <div class="level-rules-filter">
          <input class="level-say-input" data-filter placeholder="按名字筛选">
          <button class="btn btn-sm" data-act="clear-exp">全部重置</button>
        </div>
        <div class="level-rules-list" data-exp></div>
        <div class="field-label level-rules-ai-title">这一关的 AI</div>
        <div class="level-rules-ai" data-ai></div>
        <div class="field-hint" data-foot>改完点「保存」。</div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-sm" data-act="reset-ai">AI 恢复默认</button>
        <button class="btn btn-primary" data-act="apply">保存</button>
        <button class="btn" data-act="cancel">取消</button>
      </div>
    </div>`;

  const q = <T extends Element>(sel: string): T => mask.querySelector(sel) as T;
  const expEl = q<HTMLDivElement>('[data-exp]');
  const aiEl = q<HTMLDivElement>('[data-ai]');
  const countEl = q<HTMLSpanElement>('[data-exp-count]');
  const footEl = q<HTMLDivElement>('[data-foot]');
  const filterEl = q<HTMLInputElement>('[data-filter]');

  const renderExpansions = (): void => {
    const word = filterEl.value.trim().toLowerCase();
    const list = EXPANSIONS.filter(
      (e) => !word || e.name.toLowerCase().includes(word) || e.id.includes(word),
    );
    expEl.innerHTML = list
      .map((e) => {
        const tier = tiers[e.id] ?? 'none';
        return `<div class="level-rule-row ${tier !== 'none' ? 'is-set' : ''}">
            <span class="level-rule-name">${esc(e.name)}<i>${esc(e.blurb ?? '')}</i></span>
            <select class="level-mini-select" data-exp-id="${esc(e.id)}">
              ${(['none', 'require', 'forbid', 'warn'] as Tier[])
                .map((t) => `<option value="${t}" ${tier === t ? 'selected' : ''}>${TIER_NAME[t]}</option>`)
                .join('')}
            </select>
          </div>`;
      })
      .join('');

    const req = Object.values(tiers).filter((t) => t === 'require').length;
    const forb = Object.values(tiers).filter((t) => t === 'forbid').length;
    const warn = Object.values(tiers).filter((t) => t === 'warn').length;
    countEl.textContent =
      req + forb + warn === 0
        ? '无要求，扩展归玩家选'
        : `必选 ${req} · 禁用 ${forb} · 警告 ${warn}`;
  };

  const renderAi = (): void => {
    aiEl.innerHTML = KNOBS.map(
      (k) => `<div class="level-rule-row level-rule-ai">
          <span class="level-rule-name">${esc(k.name)}<i>${esc(k.hint)}</i></span>
          <span class="level-rule-knob">
            <input type="range" min="${k.min}" max="${k.max}" step="0.1" value="${ai[k.key]}" data-knob="${k.key}">
            <b data-knob-val="${k.key}">${ai[k.key].toFixed(1)}</b>
          </span>
        </div>`,
    ).join('');
  };

  mask.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement;
    if (el === filterEl) {
      renderExpansions();
      return;
    }
    const knob = el.getAttribute('data-knob') as keyof LevelAiTuning | null;
    if (knob) {
      ai[knob] = Number((el as HTMLInputElement).value);
      const out = mask.querySelector<HTMLElement>(`[data-knob-val="${knob}"]`);
      if (out) out.textContent = ai[knob].toFixed(1);
    }
  });

  mask.addEventListener('change', (ev) => {
    const id = (ev.target as HTMLElement).getAttribute('data-exp-id');
    if (!id) return;
    const val = (ev.target as HTMLSelectElement).value as Tier;
    if (val === 'none') delete tiers[id];
    else tiers[id] = val;
    renderExpansions();
  });

  mask.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'clear-exp') {
      for (const k of Object.keys(tiers)) delete tiers[k];
      renderExpansions();
      footEl.textContent = '扩展要求已清空。';
      return;
    }
    if (act === 'reset-ai') {
      ai.riskAversion = 1;
      ai.cohesion = 1;
      ai.appetite = 1;
      renderAi();
      footEl.textContent = 'AI 回到默认（三个都是 1）。';
      return;
    }
    if (act === 'cancel') {
      mask.remove();
      opts.onClose?.();
      return;
    }
    if (act === 'apply') {
      const next: LevelDef = { ...level };
      const require = Object.entries(tiers).filter(([, v]) => v === 'require').map(([k]) => k);
      const forbid = Object.entries(tiers).filter(([, v]) => v === 'forbid').map(([k]) => k);
      const warn = Object.entries(tiers)
        .filter(([, v]) => v === 'warn')
        .map(([k]) => k)
        // 同时被要求和禁用的没有意义，静默剔掉（校验那边也会报）
        .filter((id) => !require.includes(id) && !forbid.includes(id));

      if (require.length === 0 && forbid.length === 0 && warn.length === 0) {
        delete (next as { expansions?: unknown }).expansions;
      } else {
        next.expansions = {
          ...(require.length > 0 ? { require } : {}),
          ...(forbid.length > 0 ? { forbid } : {}),
          ...(warn.length > 0 ? { warn } : {}),
        };
      }

      // 三个都是默认值就不写 `ai`：少一个字段，JSON 也少一句要解释的话
      const isDefault = ai.riskAversion === 1 && ai.cohesion === 1 && ai.appetite === 1;
      if (isDefault) delete (next as { ai?: unknown }).ai;
      else next.ai = { ...ai };

      opts.onApply(next);
      mask.remove();
      toast('规则已更新，别忘了点「保存到我的关卡」');
    }
  });

  renderExpansions();
  renderAi();
  document.body.appendChild(mask);
}
