import { Bot, InlineKeyboard, InputFile } from 'grammy';
import type { Guardrails } from '../core/caps.js';
import type { Features } from '../core/features.js';
import type { Ledger } from '../core/ledger.js';
import { log } from '../core/logger.js';
import { checklistText, type ModeSwitch } from '../core/mode.js';
import type { ApprovalRequest, Notifier } from '../core/notifier.js';

/**
 * Common setup mistake: TELEGRAM_CHAT_ID set to the bot's own id (the number before ':' in the token).
 * Telegram then answers 403 "bots can't send messages to bots".
 */
export function telegramConfigProblem(token: string, chatId: string): string | undefined {
  if (!/^-?\d+$/.test(chatId.trim())) return 'it must be a number (your chat id), not a username or link';
  if (chatId.trim() === token.split(':')[0]) return "that's the bot's own id (the first part of the token), not your chat id";
  return undefined;
}

/**
 * Owner controls over Telegram. Only messages from TELEGRAM_CHAT_ID are obeyed.
 *   /live /shadow /pause /resume /status /jobs /share, and one-tap Approve / Reject buttons for job types.
 */
export class TelegramNotifier implements Notifier {
  readonly bot: Bot;

  constructor(token: string, private chatId: string, private ledger: Ledger, private guard: Guardrails, private summary: () => string, private share: () => string = summary,
    private controls?: { mode: ModeSwitch; walletLamports: () => Promise<bigint>; features?: Features }) {
    this.bot = new Bot(token);
    const owner = (id: number | undefined) => String(id) === this.chatId;

    this.bot.command('pause', async ctx => {
      if (!owner(ctx.chat?.id)) return;
      this.guard.pause('paused from Telegram');
      await ctx.reply('⏸️ Paused. Nothing will be sent until /resume.');
    });
    this.bot.command('resume', async ctx => {
      if (!owner(ctx.chat?.id)) return;
      const ok = this.guard.resume();
      await ctx.reply(ok ? '▶️ Resumed.' : '🔒 Can’t resume: the CRUMBS_PAUSED env flag is set on the server.');
    });
    this.bot.command('status', async ctx => {
      if (!owner(ctx.chat?.id)) return;
      const s = this.guard.state();
      await ctx.reply(`${this.summary()}\n\n${s.paused ? `⏸️ Paused: ${s.reason}` : '▶️ Running'}`);
    });
    this.bot.command('share', async ctx => {
      if (!owner(ctx.chat?.id)) return;
      await ctx.reply(this.share());
    });
    this.bot.command('jobs', async ctx => {
      if (!owner(ctx.chat?.id)) return;
      const types = this.ledger.listJobTypes();
      const rows = types.map(j => `${j.status === 'approved' ? '✅' : j.status === 'rejected' ? '❌' : '⏳'} ${j.type} — ${j.protocol}`);
      const kb = new InlineKeyboard();
      for (const j of types.filter(t => t.status !== 'approved')) kb.text(`✅ Approve ${j.type}`, `approve|${j.type}`).row();
      await ctx.reply(rows.join('\n') || 'No job types yet.', types.some(t => t.status !== 'approved') ? { reply_markup: kb } : {});
    });
    this.bot.command('live', async ctx => {
      if (!owner(ctx.chat?.id) || !this.controls) return;
      if (this.controls.mode.mode === 'live') return void (await ctx.reply('🟢 Already live. /shadow to stop sending.'));
      const items = this.controls.mode.checklist(await this.controls.walletLamports(), this.guard.state());
      const ready = this.controls.mode.canGoLive(items);
      const text = `Go-live checklist\n\n${checklistText(items)}\n\n${ready ? 'Tap to start sending real transactions. /shadow switches back any time.' : 'Fix the ⛔ items first.'}`;
      await ctx.reply(text, ready ? { reply_markup: new InlineKeyboard().text('🟢 Go live', 'mode|live').text('Cancel', 'mode|cancel') } : {});
    });
    this.bot.command('shadow', async ctx => {
      if (!owner(ctx.chat?.id) || !this.controls) return;
      this.controls.mode.setShadow();
      await ctx.reply('◌ Shadow mode: simulating only, nothing will be sent. /live to go back.');
    });
    this.bot.command('features', async ctx => {
      if (!owner(ctx.chat?.id) || !this.controls?.features) return;
      await this.sendFeatures(ctx.reply.bind(ctx));
    });
    this.bot.on('callback_query:data', async ctx => {
      if (!owner(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id)) return ctx.answerCallbackQuery();
      const [action, type, value] = ctx.callbackQuery.data.split('|');
      if (action === 'feature' && this.controls?.features) {
        await ctx.answerCallbackQuery();
        this.controls.features.set(type, value === 'on');
        await ctx.editMessageReplyMarkup();
        return void (await this.sendFeatures(ctx.reply.bind(ctx)));
      }
      if (action === 'mode' && this.controls) {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup();
        if (type !== 'live') return void (await ctx.reply('Staying in shadow mode.'));
        // Re-check at the moment of the tap: balances and pauses may have changed since /live.
        const items = this.controls.mode.checklist(await this.controls.walletLamports(), this.guard.state());
        if (!this.controls.mode.canGoLive(items)) return void (await ctx.reply(`Can't go live:\n${checklistText(items.filter(i => !i.ok && i.blocker))}`));
        this.controls.mode.setLive();
        return void (await ctx.reply('🟢 Live. Crumbs now sends transactions that simulate as profitable, inside your caps. /shadow or /pause to stop.'));
      }
      if ((action === 'approve' || action === 'reject') && type) {
        this.ledger.setJobTypeStatus(type, action === 'approve' ? 'approved' : 'rejected');
        await ctx.answerCallbackQuery({ text: action === 'approve' ? 'Approved' : 'Rejected' });
        await ctx.editMessageReplyMarkup();
        await ctx.reply(action === 'approve' ? `✅ ${type} approved — it will run autonomously.` : `❌ ${type} rejected.`);
      } else {
        await ctx.answerCallbackQuery();
      }
    });
    this.bot.catch(err => log.warn('telegram error', { error: String(err.error) }));
  }

  start(): void {
    void this.bot.start({ drop_pending_updates: true, onStart: () => log.info('telegram bot online') });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  /** Every feature with its switch, P&L so far and, when off, why. */
  private async sendFeatures(reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown>) {
    const f = this.controls?.features;
    if (!f) return;
    const list = f.status();
    const kb = new InlineKeyboard();
    for (const x of list) kb.text(`${x.on ? '⏹ Switch off' : '▶️ Switch on'} ${x.name}`, `feature|${x.name}|${x.on ? 'off' : 'on'}`).row();
    const lines = list.map(x => `${x.on ? '🟢' : '⚪'} ${x.name}: ${x.description}
   ${x.sends} sends, net ${x.netLamports} lamports${x.on ? '' : `\n   off: ${x.offReason}`}`);
    await reply(lines.join('\n\n') || 'No features.', { reply_markup: kb });
  }

  async alert(text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.chatId, text);
    } catch (e) {
      log.warn('telegram alert failed', { error: String(e), text });
    }
  }

  async sendDocument(filename: string, content: string, caption: string): Promise<void> {
    try {
      await this.bot.api.sendDocument(this.chatId, new InputFile(Buffer.from(content, 'utf8'), filename), { caption: caption.slice(0, 1000) });
    } catch (e) {
      log.warn('telegram document failed', { error: String(e), filename });
    }
  }

  async requestApproval(req: ApprovalRequest): Promise<void> {
    const text = [
      '🆕 New job type wants to go live',
      `• ${req.jobType} (${req.protocol})`,
      `• ${req.description}`,
      `• Reward source: ${req.rewardSource}`,
      req.evidence ? `\n${req.evidence.slice(0, 3000)}` : '',
      '\nIt runs in shadow mode until you approve.',
    ].join('\n');
    const kb = new InlineKeyboard().text('✅ Approve', `approve|${req.jobType}`).text('❌ Reject', `reject|${req.jobType}`);
    try {
      await this.bot.api.sendMessage(this.chatId, text, { reply_markup: kb });
    } catch (e) {
      log.warn('telegram approval request failed', { error: String(e), jobType: req.jobType });
    }
  }
}
