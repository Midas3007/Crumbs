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

/** Shown in Telegram's "/" menu, in this order. */
export const COMMAND_LIST: [string, string][] = [
  ['menu', 'All controls as buttons'],
  ['status', 'Today so far and what the agent is doing'],
  ['share', 'A line to share'],
  ['jobs', 'Job types: approve or reject'],
  ['features', 'Switch speed and profit features on or off'],
  ['pause', 'Stop sending anything'],
  ['resume', 'Start again after a pause'],
  ['live', 'Go live (with checklist)'],
  ['shadow', 'Simulate only, send nothing'],
];

/** The /menu buttons: two per row. */
export function menuKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  const buttons: [string, string][] = [
    ['📊 Status', 'status'], ['📣 Share', 'share'],
    ['🧰 Jobs', 'jobs'], ['⚙️ Features', 'features'],
    ['⏸️ Pause', 'pause'], ['▶️ Resume', 'resume'],
    ['🟢 Live', 'live'], ['◌ Shadow', 'shadow'],
  ];
  buttons.forEach(([label, cmd], i) => { kb.text(label, `cmd|${cmd}`); if (i % 2) kb.row(); });
  return kb;
}

const menuButton = () => new InlineKeyboard().text('☰ Menu', 'cmd|menu');

/**
 * Owner controls over Telegram. Only messages from TELEGRAM_CHAT_ID are obeyed.
 *   Every command is in Telegram's "/" menu and on the /menu buttons; job types have one-tap Approve / Reject.
 */
export class TelegramNotifier implements Notifier {
  readonly bot: Bot;
  private commands: Record<string, (reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown>) => Promise<unknown>> = {};

  constructor(token: string, private chatId: string, private ledger: Ledger, private guard: Guardrails, private summary: () => string, private share: () => string = summary,
    private controls?: { mode: ModeSwitch; walletLamports: () => Promise<bigint>; features?: Features }) {
    this.bot = new Bot(token);
    const owner = (id: number | undefined) => String(id) === this.chatId;

    type Reply = (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown>;
    // Every command, usable by typing it or by tapping its button in /menu.
    const commands: Record<string, (reply: Reply) => Promise<unknown>> = {
      status: async reply => {
        const s = this.guard.state();
        return reply(`${this.summary()}\n\n${s.paused ? `⏸️ Paused: ${s.reason}` : '▶️ Running'}`, { reply_markup: menuButton() });
      },
      share: async reply => reply(this.share()),
      jobs: async reply => {
        const types = this.ledger.listJobTypes();
        const rows = types.map(j => `${j.status === 'approved' ? '✅' : j.status === 'rejected' ? '❌' : '⏳'} ${j.type} — ${j.protocol}`);
        const kb = new InlineKeyboard();
        for (const j of types) kb.text(j.status === 'approved' ? `❌ Reject ${j.type}` : `✅ Approve ${j.type}`, `${j.status === 'approved' ? 'reject' : 'approve'}|${j.type}`).row();
        return reply(rows.join('\n') || 'No job types yet.', types.length ? { reply_markup: kb } : undefined);
      },
      features: async reply => this.sendFeatures(reply),
      pause: async reply => {
        this.guard.pause('paused from Telegram');
        return reply('⏸️ Paused. Nothing will be sent until you resume.', { reply_markup: new InlineKeyboard().text('▶️ Resume', 'cmd|resume') });
      },
      resume: async reply => reply(this.guard.resume() ? '▶️ Resumed.' : '🔒 Can’t resume: the CRUMBS_PAUSED env flag is set on the server.'),
      live: async reply => {
        if (!this.controls) return;
        if (this.controls.mode.mode === 'live') return reply('🟢 Already live.', { reply_markup: new InlineKeyboard().text('◌ Switch to shadow', 'cmd|shadow') });
        const items = this.controls.mode.checklist(await this.controls.walletLamports(), this.guard.state());
        const ready = this.controls.mode.canGoLive(items);
        const text = `Go-live checklist\n\n${checklistText(items)}\n\n${ready ? 'Tap to start sending real transactions. Shadow mode is one tap away.' : 'Fix the ⛔ items first.'}`;
        return reply(text, ready ? { reply_markup: new InlineKeyboard().text('🟢 Go live', 'mode|live').text('Cancel', 'mode|cancel') } : undefined);
      },
      shadow: async reply => {
        if (!this.controls) return;
        this.controls.mode.setShadow();
        return reply('◌ Shadow mode: simulating only, nothing will be sent.', { reply_markup: new InlineKeyboard().text('🟢 Go live', 'cmd|live') });
      },
      menu: async reply => reply('🍞 Crumbs: what do you need?', { reply_markup: menuKeyboard() }),
    };
    commands.start = commands.menu;
    for (const [name, run] of Object.entries(commands)) {
      this.bot.command(name, async ctx => {
        if (!owner(ctx.chat?.id)) return;
        await run(ctx.reply.bind(ctx) as Reply);
      });
    }
    this.commands = commands;

    this.bot.on('callback_query:data', async ctx => {
      if (!owner(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id)) return ctx.answerCallbackQuery();
      const [action, type, value] = ctx.callbackQuery.data.split('|');
      if (action === 'cmd' && this.commands[type]) {
        await ctx.answerCallbackQuery();
        return void (await this.commands[type](ctx.reply.bind(ctx) as Parameters<typeof this.commands[string]>[0]));
      }
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
        await ctx.reply(action === 'approve' ? `✅ ${type} approved — it will run autonomously.` : `❌ ${type} rejected. It won't run; /jobs to approve it again.`);
      } else {
        await ctx.answerCallbackQuery();
      }
    });
    this.bot.catch(err => log.warn('telegram error', { error: String(err.error) }));
  }

  start(): void {
    // The "/" menu in Telegram: every command with a one-line description.
    void this.bot.api.setMyCommands(COMMAND_LIST.map(([command, description]) => ({ command, description })))
      .catch(e => log.warn('could not set the Telegram command menu', { error: String(e) }));
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
    kb.text('☰ Menu', 'cmd|menu');
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
    if (req.autoApproved) {
      const text = [
        '🆕 New job type is live (auto-approved)',
        `• ${req.jobType} (${req.protocol})`,
        `• ${req.description}`,
        `• Reward source: ${req.rewardSource}`,
        req.evidence ? `\n${req.evidence.slice(0, 3000)}` : '',
        '\nEvery send is still simulated and profit-checked, and its circuit breaker switches it off if it loses. Tap Reject to stop it now.',
      ].join('\n');
      try {
        await this.bot.api.sendMessage(this.chatId, text, { reply_markup: new InlineKeyboard().text('❌ Reject', `reject|${req.jobType}`) });
      } catch (e) {
        log.warn('telegram auto-approval notice failed', { error: String(e), jobType: req.jobType });
      }
      return;
    }
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
