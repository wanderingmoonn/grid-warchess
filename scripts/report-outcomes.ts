import type { MatchWinner } from '../src/core/types.ts';

/** A formal draw is finished; a runner stopped before adjudication is unresolved. */
export function summarizeOutcomes(results: ReadonlyArray<{ winner: MatchWinner }>) {
  const aWins = results.filter((game) => game.winner === 'A').length;
  const bWins = results.filter((game) => game.winner === 'B').length;
  const draws = results.filter((game) => game.winner === 'draw').length;
  const unresolved = results.filter((game) => game.winner === null).length;
  const total = results.length;
  return {
    aWins, bWins, draws, unresolved,
    aRate: total ? aWins / total : 0,
    bRate: total ? bWins / total : 0,
    drawRate: total ? draws / total : 0,
    unresolvedRate: total ? unresolved / total : 0,
  };
}

/** Older reports stored unfinished games under draws; aggregate without relabeling them wins. */
export function nonWinCount(summary: { draws: number; unresolved?: number }): number {
  return summary.draws + (summary.unresolved ?? 0);
}

export function nonWinRate(summary: { drawRate: number; unresolvedRate?: number }): number {
  return summary.drawRate + (summary.unresolvedRate ?? 0);
}
