/**
 * 季节与气候的「给人看的那一面」。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────
 *
 * 以前这三块散在两处：图标与效果文案在 `core/info.ts`，徽章与季节条在
 * `ui/panel.ts`。结果是**核心为了一个扩展开了两个洞**——`info.ts` 要
 * import 气候表，`panel.ts` 要 import 气候表 + 图标 + 季节函数。
 *
 * 把气候搬进扩展（`core/seasons/`）之后，这三块跟着一起搬过来，
 * 核心只通过两个钩子拿**成品**：
 *   · `getTilePanelHtml` —— 格子/单位卡上的天气块（带颜色徽标）
 *   · `topbarBadges`     —— 顶栏的季节常驻徽章
 *
 * ── 产出 HTML 是故意的 ────────────────────────────────────
 *
 * 天气块要带 `.weather-badge.w-cold` 这种按气候分色的徽标，纯文本行表达不了。
 * 扩展是代码不是用户输入，所以这里拼 HTML 不需要转义——但**只有这些常量**
 * 能进来，别把玩家可改的名字往模板里塞。
 */
import type { GameState } from '../types.ts';
import {
  CLIMATE_NAME,
  SEASON_NAME,
  SEASON_TURNS,
  climateEffect,
  seasonOf,
  type Climate,
} from './climate.ts';
import { climateAt, formatTemp, precipAt, precipLabel, satAt, tempAt, wetAt } from './field.ts';

/** 每个气候的图标。颜色只是辅助，名字和数值才是准的（色弱也得读得懂） */
export const CLIMATE_ICON: Record<Climate, string> = {
  mild: '☀',
  cool: '🍃',
  warm: '🌞',
  cold: '❄',
  hardWinter: '☃',
  hot: '☀',
  blazing: '🔥',
  dampCold: '🌧',
  dampHeat: '♨',
  overcast: '☁',
  downpour: '⛈',
  fog: '🌫',
  thunder: '⚡',
  frozen: '🧊',
  driftIce: '❆',
  storm: '🌪',
};

function signedPct(rate: number): string {
  const v = Math.round(rate * 100);
  return `${v > 0 ? '+' : '−'}${Math.abs(v)}%`;
}

/**
 * 这个气候到底改了什么，翻成人话。
 *
 * **从效果表派生**，不另写一份文案：表格改了、说明跟着改，
 * 不会出现"界面上写着 −25%、实际已经调成 −50%"这种最难查的错。
 */
export function climateEffectLines(c: Climate): string[] {
  const e = climateEffect(c);
  const out: string[] = [];

  if (e.moveMul !== undefined && e.moveMul !== 1) out.push(`移动力 ${signedPct(e.moveMul - 1)}`);
  if (e.moveAdd) out.push(`移动力 ${e.moveAdd > 0 ? '+' : '−'}${Math.abs(e.moveAdd)}`);
  if (e.moveCostAdd) out.push(`每格移动消耗 +${e.moveCostAdd}`);
  if (e.armorPenalty) {
    out.push(
      e.armorPenaltyOnlyField
        ? `不在城里的军队护甲 −${e.armorPenalty}`
        : `全军护甲 −${e.armorPenalty}`,
    );
  }
  if (e.incomeMul !== undefined && e.incomeMul !== 1) {
    out.push(`经济产出 ${signedPct(e.incomeMul - 1)}`);
  }
  if (e.rangeAdd) out.push(`攻击范围 ${e.rangeAdd > 0 ? '+' : '−'}${Math.abs(e.rangeAdd)}`);
  if (e.rangeMax) out.push(`攻击范围不超过 ${e.rangeMax}`);
  if (e.visionMax) out.push(`视野不超过 ${e.visionMax}`);
  if (e.endDamage) {
    const d = e.endDamage;
    const splash = d.splash ? `，周围 ${d.radius ?? 1} 格再吃一半` : '';
    out.push(
      d.hits > 1
        ? `回合末受 ${d.hits} 次 ${d.amount} 点伤害（吃护甲）`
        : `回合末受 ${d.amount} 点伤害${splash}`,
    );
  }
  if (e.upkeepRate) out.push(`回合末交 ${Math.round(e.upkeepRate * 100)}% 维护费`);
  if (e.upkeepHpRatio) out.push(`交不起则掉 ${Math.round(e.upkeepHpRatio * 100)}% 生命上限`);
  if (e.navyMoveZero) out.push('海军移动力归零');
  if (e.navyMoveMul !== undefined && e.navyMoveMul !== 1) {
    out.push(`海军移动力 ${signedPct(e.navyMoveMul - 1)}`);
  }
  if (e.landOnIce) out.push('陆军可以在冰面上行走');

  return out;
}

/** 天气徽标：图标 + 中文名。`w-<id>` 让每种气候有自己的底色 */
export function weatherBadge(c: Climate): string {
  return `<span class="weather-badge w-${c}">${CLIMATE_ICON[c]} ${CLIMATE_NAME[c]}</span>`;
}

/**
 * 天气说明块：徽标 + **气象读数** + 逐条效果。
 *
 * 效果文字从效果表派生，不维护第二份；读数从场上现取。
 * 单列一行温度/湿度是有用的：没有它，玩家只能看到"浓雾"这个结论，
 * 看不到"14°C、湿度快满了"这个原因，也就没法理解为什么沿海先起雾。
 */
export function weatherBlock(
  s: GameState,
  x: number,
  y: number,
  c: Climate,
): string {
  const temp = tempAt(s, x, y);
  const wet = wetAt(s, x, y);
  const sat = satAt(s, x, y);
  const precip = precipAt(s, x, y);
  const lines = climateEffectLines(c);
  const body =
    lines.length === 0
      ? `<div class="weather-none">这一格没有额外影响。</div>`
      : `<div class="unit-notes">${lines.map((l) => `<div>· ${l}</div>`).join('')}</div>`;
  return (
    `<div class="weather-box">${weatherBadge(c)}` +
    `<div class="weather-readout">${formatTemp(temp)} · 相对湿度 ${Math.round((wet / sat) * 100)}%` +
    `${precip === 'none' ? '' : ` · ${precipLabel(precip)}`}</div>` +
    `${body}</div>`
  );
}

/**
 * 顶栏的季节徽章文案。
 *
 * 以前在 `ui/panel.ts` 里，靠 `TopbarState.season` 一个字段传进去——
 * 那是核心为这个扩展开的一个具名口子。现在走 `topbarBadges`，
 * 核心只认"一个 id 一段文字"。
 */
export function seasonLabel(turn: number): string {
  const season = seasonOf(turn);
  const left = SEASON_TURNS - ((Math.max(1, turn) - 1) % SEASON_TURNS);
  return `${SEASON_NAME[season]} · 剩 ${left} 回合`;
}

/**
 * 天气视图：整张图按"这一格是什么天气"染色。
 *
 * 和灵气视图的区别很实在——灵气是**连续的场**（同一支绿分五档），
 * 天气是**离散的标签**（十四种各一个色相）。所以这里不需要分档，
 * 一张表查到底。
 */
const CLIMATE_TINT: Record<Climate, string> = {
  mild: 'rgba(0, 0, 0, 0)',
  cool: 'rgba(110, 190, 190, 0.24)',
  warm: 'rgba(245, 200, 110, 0.26)',
  cold: 'rgba(120, 170, 220, 0.30)',
  hardWinter: 'rgba(90, 130, 200, 0.46)',
  hot: 'rgba(240, 160, 80, 0.28)',
  blazing: 'rgba(230, 110, 60, 0.44)',
  dampCold: 'rgba(90, 160, 170, 0.34)',
  dampHeat: 'rgba(200, 110, 150, 0.34)',
  overcast: 'rgba(140, 145, 155, 0.34)',
  downpour: 'rgba(80, 110, 160, 0.48)',
  fog: 'rgba(200, 205, 210, 0.46)',
  thunder: 'rgba(180, 150, 60, 0.44)',
  frozen: 'rgba(150, 215, 235, 0.50)',
  driftIce: 'rgba(175, 220, 240, 0.36)',
  storm: 'rgba(110, 90, 160, 0.48)',
};

/**
 * 每格的天气染色。**"温和"不画**——它占了绝大多数格子，
 * 画一层透明色只会让整张图看起来什么都没发生；留白反而是"这里没事"。
 *
 * 返回全图，**不裁视野**：遮蔽统一由 `fog.ts` 的 `onlyVisibleCells` 在渲染前做。
 * 天气场是按全图算的，不裁就等于把对面的地形和建筑分布摊开给你看。
 */
export function climateOverlayCells(
  s: GameState,
): Array<{ x: number; y: number; color: string }> {
  const out: Array<{ x: number; y: number; color: string }> = [];
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const c = climateAt(s, x, y);
      if (c === 'mild') continue;
      out.push({ x, y, color: CLIMATE_TINT[c] });
    }
  }
  return out;
}
