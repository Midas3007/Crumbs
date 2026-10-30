import Anthropic from '@anthropic-ai/sdk';
import { log } from './logger.js';

export type PaidService = 'claude' | 'rpc';

const HOW_TO_FIX: Record<PaidService, string> = {
  claude: 'Top up at console.anthropic.com → Settings → Billing. Discovery is paused until then; earning jobs keep running.',
  rpc: 'Check your plan at dashboard.helius.dev (or your RPC provider). Crumbs can’t see the chain properly until it’s fixed, so it may miss jobs.',
};

/**
 * Tells the owner when a paid API runs out of credits or quota. One alert per service per cooldown,
 * plus an "all good again" message once it recovers.
 */
export class CreditWatch {
  private down = new Map<PaidService, number>();

  constructor(private notify: (text: string) => Promise<void>, private cooldownMs = 6 * 3_600_000, private now: () => number = Date.now) {}

  isOut(service: PaidService): boolean {
    return this.down.has(service);
  }

  async report(service: PaidService, detail: string): Promise<void> {
    const last = this.down.get(service);
    if (last !== undefined && this.now() - last < this.cooldownMs) return;
    this.down.set(service, this.now());
    log.error('paid API out of credits', { service, detail });
    const name = service === 'claude' ? 'Claude API' : 'RPC (Helius)';
    await this.notify(`💳 ${name} credits/quota ran out.\n${detail.slice(0, 300)}\n${HOW_TO_FIX[service]}`);
  }

  async recovered(service: PaidService): Promise<void> {
    if (!this.down.delete(service)) return;
    await this.notify(`✅ ${service === 'claude' ? 'Claude API' : 'RPC (Helius)'} is working again.`);
  }
}

/** Anthropic answers a request from an account without credits with a 400 "credit balance is too low" (or 402). */
export function isClaudeCreditError(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  if (e.status === 402) return true;
  return (e.status === 400 || e.status === 403) && /credit balance|billing|purchase credits|quota/i.test(e.message);
}

const RPC_CREDIT_TEXT = /credit|quota|max usage|usage limit|plan limit|upgrade your plan|exceeded/i;

/**
 * A fetch for web3.js' Connection that spots an RPC provider running out of credits:
 * 401/402/403, or a 429 whose body talks about credits/quota (a plain 429 is just rate limiting).
 */
export function creditWatchingFetch(watch: CreditWatch, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    if (res.ok) {
      if (watch.isOut('rpc')) void watch.recovered('rpc');
      return res;
    }
    if ([401, 402, 403, 429].includes(res.status)) {
      const body = await res.clone().text().catch(() => '');
      if (res.status !== 429 || RPC_CREDIT_TEXT.test(body)) {
        void watch.report('rpc', `HTTP ${res.status}: ${body}`);
      }
    }
    return res;
  };
}
