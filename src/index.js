import 'dotenv/config';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Bot } from 'grammy';
import { generateReply } from './llm.js';
import { openStore } from './store.js';

const env = process.env;
const required = (key) => {
  if (!env[key]?.trim()) throw new Error(`Missing ${key}`);
  return env[key].trim();
};
const owner = required('TELEGRAM_OWNER_ID');
if (!/^\d+$/.test(owner)) throw new Error('TELEGRAM_OWNER_ID must be a numeric user ID');
const allowed = new Set((env.ALLOWED_CHAT_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean));
const autoReply = env.AUTO_REPLY === 'true';
const cooldown = Number(env.TAKEOVER_COOLDOWN_MINUTES ?? 15) * 60_000;
if (!Number.isFinite(cooldown) || cooldown < 0) throw new Error('Invalid takeover cooldown');
const llm = {
  baseUrl: env.LLM_BASE_URL || 'https://arbiter-mind.onrender.com/v1',
  key: autoReply ? required('LLM_API_KEY') : '',
  model: env.LLM_MODEL || 'auto',
  persona: readFileSync(new URL('../persona.md', import.meta.url), 'utf8'),
};
const bot = new Bot(required('BOT_TOKEN'));
const store = openStore(env.DATA_FILE || './data/state.json');
const updates = ['message', 'business_connection', 'business_message'];
const connections = new Map();
const revisions = new Map();
const revise = (key) => { const rev = (revisions.get(key) ?? 0) + 1; revisions.set(key, rev); return rev; };
const remember = (chat, role, text) => {
  chat.history.push({ role, text: text.slice(0, 1500) });
  chat.history = chat.history.slice(-12);
};
bot.catch(() => console.error('Telegram update handler failed'));
bot.on('business_connection', ctx => {
  const conn = ctx.update.business_connection;
  connections.set(conn.id, conn);
});
bot.command('start', async ctx => {
  if (ctx.chat.type !== 'private' || String(ctx.from.id) !== owner) return;
  const id = /^bizChat(\d+)$/.exec(ctx.match)?.[1];
  await ctx.reply(id
    ? `Chat ID: ${id}\nControls: /pause ${id}, /resume ${id}, /reset ${id}`
    : `Your user ID: ${ctx.from.id}\nOpen Manage Bot in a connected chat to see its chat ID and controls.`);
});
for (const command of ['pause', 'resume', 'reset']) {
  bot.command(command, async ctx => {
    if (ctx.chat.type !== 'private' || String(ctx.from.id) !== owner) return;
    const id = ctx.match.trim();
    if (!allowed.has(id)) return ctx.reply('That chat is not on ALLOWED_CHAT_IDS.');
    const chat = store.chat(id);
    revise(id);
    if (command === 'reset') chat.history = [];
    if (command === 'pause') chat.paused = true;
    if (command === 'resume') { chat.paused = false; chat.until = 0; }
    store.save();
    await ctx.reply(`${command}: done for ${id}.`);
  });
}
bot.on('business_message', async ctx => {
  const msg = ctx.update.business_message;
  const id = String(msg.chat.id);
  if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot || msg.sender_business_bot) return;
  const connectionId = msg.business_connection_id;
  const conn = connections.get(connectionId) ?? await ctx.api.getBusinessConnection(connectionId);
  if (!connections.has(connectionId)) connections.set(connectionId, conn);
  if (!conn.is_enabled || String(conn.user.id) !== owner) return;
  if (!autoReply || !allowed.has(id)) return;
  const chat = store.chat(id);
  if (chat.seen.includes(msg.message_id)) return;
  chat.seen = [...chat.seen, msg.message_id].slice(-100);
  const rev = revise(id);
  const manual = String(msg.from.id) === owner;
  if (manual) chat.until = Math.max(chat.until, msg.date * 1000 + cooldown);
  if (msg.text) remember(chat, manual ? 'owner' : 'contact', msg.text);
  store.save();
  const recent = () => Date.now() - msg.date * 1000 < 300_000;
  if (manual || !msg.text || chat.paused || Date.now() < chat.until || !conn.rights?.can_reply || !recent()) return;
  try {
    const reply = await generateReply({ ...llm, history: [...chat.history] });
    if (!recent() || revisions.get(id) !== rev || chat.paused || Date.now() < chat.until) return;
    const current = connections.get(connectionId);
    if (!current?.is_enabled || !current.rights?.can_reply) return;
    await ctx.api.sendMessage(msg.chat.id, `Automated reply: ${reply}`, { business_connection_id: connectionId });
    remember(chat, 'secretary', reply);
    store.save();
  } catch {
    console.error('Auto-reply failed; no automatic retry');
  }
});

if (!env.WEBHOOK_URL) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => bot.stop());
  await bot.start({ allowed_updates: updates, onStart: info => console.log(`Polling as @${info.username}; auto-reply=${autoReply}`) });
} else {
  const url = new URL(env.WEBHOOK_URL);
  const secret = required('WEBHOOK_SECRET');
  if (url.protocol !== 'https:' || url.pathname !== '/telegram' || url.search || url.hash || !/^[A-Za-z0-9_-]{24,256}$/.test(secret)) throw new Error('Invalid webhook URL or secret');
  const expected = Buffer.from(secret);
  await bot.init();
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    if (req.method !== 'POST' || req.url !== '/telegram') { res.writeHead(404).end(); return; }
    const actual = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(403).end(); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256_000) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      await bot.handleUpdate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end('ok');
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(env.PORT || 3000), '0.0.0.0', resolve);
  });
  await bot.api.setWebhook(url.href, { secret_token: secret, allowed_updates: updates });
  console.log(`Webhook registered; auto-reply=${autoReply}`);
}
