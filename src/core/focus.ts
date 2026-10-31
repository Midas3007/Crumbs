/**
 * Focus: stop racing kinds of job we never win, keep going after the ones we do.
 *
 * Measured Oct 31: Helium's crank bot won ~140 of 140 races for ordinary TukTuk tasks at their due second,
 * while 5 of our 8 wins were "remote" tasks and 1 a stale task. Lost races are free in SOL (Jito) but each
 * costs Helius credits (simulation, status polls). Focus keeps a 24 h record per kind of job; a kind with
 * at least `minLosses` losses and no win is skipped, except for one probe every `probeMs` in case the
 * incumbent changes. Any win switches the kind back on at once.
 */
export class Focus {
  private history = new Map<string, { ts: number; won: boolean }[]>();
  private lastProbe = new Map<string, number>();

  constructor(private minLosses = 20, private windowMs = 86_400_000, private probeMs = 30 * 60_000, private now: () => number = Date.now) {}

  record(kind: string, won: boolean): void {
    const h = (this.history.get(kind) ?? []).filter(x => this.now() - x.ts < this.windowMs);
    h.push({ ts: this.now(), won });
    this.history.set(kind, h);
  }

  /** Is this kind of job worth trying now? */
  worthTrying(kind: string): boolean {
    const h = (this.history.get(kind) ?? []).filter(x => this.now() - x.ts < this.windowMs);
    if (h.some(x => x.won) || h.length < this.minLosses) return true;
    if (this.now() - (this.lastProbe.get(kind) ?? -Infinity) >= this.probeMs) {
      this.lastProbe.set(kind, this.now());
      return true;
    }
    return false;
  }

  summary(): { kind: string; won: number; lost: number; skipping: boolean }[] {
    return [...this.history].map(([kind, h]) => {
      const recent = h.filter(x => this.now() - x.ts < this.windowMs);
      const won = recent.filter(x => x.won).length;
      return { kind, won, lost: recent.length - won, skipping: won === 0 && recent.length >= this.minLosses };
    });
  }
}
