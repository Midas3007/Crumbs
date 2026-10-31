/**
 * Instructions Crumbs already runs through a dedicated adapter. Discovery marks these "covered"
 * instead of proposing them again (and skips validating them, saving RPC calls).
 */
export const COVERED: Record<string, string> = {
  'tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA:run_task_v0': 'tuktuk.run_task',
  'oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv:checkpoint': 'ore.checkpoint',
};

export function coveredBy(programId: string, instruction: string): string | undefined {
  return COVERED[`${programId}:${instruction}`];
}

/**
 * Where to build adapters next: expected reward × how often it's called ÷ how many bots already do it.
 * Lamports per hour we might win, assuming we take an equal share of the calls against each competitor.
 */
export function opportunityScore(avgRewardLamports: number, callsPerHour: number, competitors: number): number {
  return Math.round((avgRewardLamports * callsPerHour) / Math.max(1, competitors));
}
