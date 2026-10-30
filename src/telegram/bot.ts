import { Bot, InlineKeyboard, InputFile } from 'grammy';
import type { Guardrails } from '../core/caps.js';
import type { Ledger } from '../core/ledger.js';
import { log } from '../core/logger.js';
import type { ApprovalRequest, Notifier } from '../core/notifier.js';

/**
 * Owner controls over Telegram. Only messages from TELEGRAM_CHAT_ID are obeyed.
 *   /pause /resume /status /jobs, and one-tap Approve / Reject buttons for new job types.
 */
export class TelegramNotifier implements Notifier {
  readonly bot: Bot;

  constructor(token: string, private chatId: string, private ledger: Ledger, private guard: Guardrails, private summary: () => string) {
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
    this.bot.command('jobs', async ctx => {
      if (!owner(ctx.chat?.id)) return;
      const rows = this.ledger.listJobTypes().map(j => `${j.status === 'approved' ? '✅' : j.status === 'rejected' ? '❌' : '⏳'} ${j.type} — ${j.protocol}`);
      await ctx.reply(rows.join('\n') || 'No job types yet.');
    });
    this.bot.on('callback_query:data', async ctx => {
      if (!owner(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id)) return ctx.answerCallbackQuery();
      const [action, type] = ctx.callbackQuery.data.split('|');
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
