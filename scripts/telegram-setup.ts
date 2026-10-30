// Find your Telegram chat id and send a test message.
//   1. Stop Crumbs if it's running (Telegram allows only one reader of the bot's messages).
//   2. Open your bot in Telegram and send it any message, e.g. /start.
//   3. npm run telegram-setup
import { Bot } from 'grammy';
import { loadConfig } from '../src/config.js';
import { telegramConfigProblem } from '../src/telegram/bot.js';

if (process.env.TELEGRAM_BOT_TOKEN === undefined) loadConfig(); // loads .env
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Put TELEGRAM_BOT_TOKEN in .env first (from @BotFather).');

const bot = new Bot(token);
const me = await bot.api.getMe();
console.log(`Bot: @${me.username} (bot id ${me.id})`);

const updates = await bot.api.getUpdates({ timeout: 0 });
const chats = new Map<number, string>();
for (const u of updates) {
  const chat = u.message?.chat ?? u.callback_query?.message?.chat;
  if (chat && chat.type === 'private') chats.set(chat.id, [chat.first_name, chat.last_name, chat.username && `@${chat.username}`].filter(Boolean).join(' '));
}

if (chats.size === 0) {
  console.log(`\nNo messages found. Open https://t.me/${me.username} in Telegram, press Start (or send "hi"), then run this again.`);
  process.exit(1);
}
for (const [id, who] of chats) console.log(`Chat from ${who}: TELEGRAM_CHAT_ID=${id}`);

const current = process.env.TELEGRAM_CHAT_ID;
const problem = current ? telegramConfigProblem(token, current) : 'TELEGRAM_CHAT_ID is not set';
const [firstId] = chats.keys();
if (problem || !chats.has(Number(current))) {
  console.log(`\nYour .env has TELEGRAM_CHAT_ID=${current ?? '(empty)'}${problem ? ` — ${problem}` : ''}.`);
  console.log(`Change it to: TELEGRAM_CHAT_ID=${firstId}`);
}
const target = chats.has(Number(current)) ? current! : String(firstId);
await bot.api.sendMessage(target, '🍞 Crumbs can reach you here. Alerts, approvals and /pause will work in this chat.');
console.log(`\nSent a test message to chat ${target}. If you see it in Telegram, you're set.`);
