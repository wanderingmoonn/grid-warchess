/** Rules-backed presentation strings; all returned values are plain text. */
import { CONFIG } from '../core/config.ts';
import { productionOf } from '../core/rules/production.ts';
import { outcomeText } from '../core/rules/outcome.ts';
import type { GameState } from '../core/types.ts';

export function resultTitle(state: GameState): string {
  return state.winner === 'draw' ? '平局'
    : state.winner ? `${state.players[state.winner].name}获胜` : '对局进行中';
}

export function resultDescription(state: GameState): string {
  return outcomeText(state);
}

export function roundStatus(state: GameState): string {
  const round = Math.ceil(state.turn / 2);
  const completed = state.resultReason === 'turn-limit' ? Math.floor(state.turn / 2) : Math.floor((state.turn - 1) / 2);
  const label = round > CONFIG.maxRounds ? `第 ${round} 轮（上限 ${CONFIG.maxRounds} 轮）` : `第 ${round} / ${CONFIG.maxRounds} 轮`;
  if (state.winner) return `${label} · 已完成 ${completed} 轮 · 对局已结束`;
  return `${label} · 已完成 ${completed} 轮 · 剩余 ${Math.max(0, CONFIG.maxRounds - completed)} 轮`;
}

export function productionStatus(state: GameState): string {
  if (!state.config.commanderMode) return '';
  const used = productionOf(state);
  if (used.legacyLocked) return '旧存档本回合生产已封存，交接后恢复；建造者仍可正常建造。';
  return used.recruited + used.upgraded > 0
    ? `本回合产能已用：${used.recruited > 0 ? '已招募' : '已升级'}。城市和军营共享额度，下一回合恢复。`
    : '本回合产能可用：招募一个单位或升级一座城市，二选一；建造另按建造者行动结算。';
}
