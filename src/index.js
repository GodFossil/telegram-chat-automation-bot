import 'dotenv/config';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Bot } from 'grammy';
import { generateReply } from './llm.js';
import { openStore } from './store.js';

const env = process.env;

function required(key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

const owner = required('TELEGRAM_OWNER_ID');
if (!/^\d+$/.test(owner)) {
  throw new Error('TELEGRAM_OWNER_ID must be a numeric user ID');
}

const allowed = new Set(
  (env.ALLOWED_CHAT_IDS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
);

const autoReply = env.AUTO_REPLY === 'true';
const cooldown = Number(env.TAKEOVER_COOLDOWN_MINUTES || 15) * 60_000;

if (!Number.isFinite(cooldown) || cooldown < 0) {
  throw new Error('Invalid TAKEOVER_COOLDOWN_MINUTES');
}

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

function revise(chatId) {
  const revision = (revisions.get(chatId) ?? 0) + 1;
  revisions.set(chatId, revision);
  return revision;
}

function remember(chat, role, text) {
  chat.history.push({ role, text: text.slice(0, 1500) });
  chat.history = chat.history.slice(-12);
}

function safeErrorDetails(error) {
  const llmStatus = /^LLM HTTP (\d{3})$/.exec(error?.message ?? '')?.[1];
  const code = error?.error_code ?? llmStatus ?? error?.code ?? error?.cause?.code;

  return {
    type: error?.name ?? 'UnknownError',
    code: code ?? 'n/a',
    ...(error?.message === 'Empty LLM reply'
      ? { reason: 'Empty LLM reply' }
      : {}),
  };
}

function isOwnerDM(ctx) {
  return ctx.chat?.type === 'private' && String(ctx.from?.id) === owner;
}

function logStartup(transport) {
  console.log(
    `${transport} as @${bot.botInfo.username}; ` +
    `auto-reply=${autoReply}; allowed chats=${allowed.size}`,
  );

  if (autoReply && allowed.size === 0) {
    console.warn('Auto-replies are enabled, but ALLOWED_CHAT_IDS is empty.');
  }
}

bot.catch(({ ctx, error }) => {
  console.error('Telegram update handler failed', {
    updateId: ctx.update.update_id,
    ...safeErrorDetails(error),
  });
});

bot.on('business_connection', ctx => {
  const conn = ctx.update.business_connection;
  if (String(conn.user.id) !== owner) return;

  connections.set(conn.id, conn);
  console.log('[Chat Automation] Connection updated', {
    enabled: conn.is_enabled,
    canReply: conn.rights?.can_reply === true,
  });
});

bot.command('start', async ctx => {
  if (!isOwnerDM(ctx)) return;

  const chatId = /^bizChat(\d+)$/.exec(ctx.match.trim())?.[1];

  await ctx.reply(
    chatId
      ? `Chat ID: ${chatId}\nControls: /pause ${chatId}, /resume ${chatId}, /reset ${chatId}`
      : `Your user ID: ${ctx.from.id}\nOpen Manage Bot in a connected chat to see its chat ID and controls.`,
  );
});

for (const command of ['pause', 'resume', 'reset']) {
  bot.command(command, async ctx => {
    if (!isOwnerDM(ctx)) return;

    const chatId = ctx.match.trim();
    if (!allowed.has(chatId)) {
      await ctx.reply('That chat is not on ALLOWED_CHAT_IDS.');
      return;
    }

    const chat = store.chat(chatId);
    revise(chatId);

    if (command === 'pause') chat.paused = true;

    if (command === 'resume') {
      chat.paused = false;
      chat.until = 0;
    }

    if (command === 'reset') chat.history = [];

    store.save();
    await ctx.reply(`${command}: done for ${chatId}.`);
  });
}

bot.on('business_message', async ctx => {
  const msg = ctx.update.business_message;

  // Ignore messages the secretary should never answer, including its own.
  if (
    msg.chat.type !== 'private' ||
    !msg.from ||
    msg.from.is_bot ||
    msg.sender_business_bot
  ) {
    return;
  }

  const updateId = ctx.update.update_id;
  const chatId = String(msg.chat.id);
  const skip = reason => {
    console.log(`[Chat Automation] Update ${updateId} skipped: ${reason}`);
  };

  if (!autoReply) return skip('AUTO_REPLY is off');
  if (!allowed.has(chatId)) return skip('chat is not in ALLOWED_CHAT_IDS');

  const connectionId = msg.business_connection_id;
  if (!connectionId) return skip('missing business connection ID');

  let stage = 'Telegram connection lookup';
  let delivered = false;

  try {
    let conn = connections.get(connectionId);

    if (!conn) {
      const fetched = await ctx.api.getBusinessConnection(connectionId);

      // Prefer a newer connection update if one arrived during the lookup.
      conn = connections.get(connectionId) ?? fetched;
      if (String(conn.user.id) === owner) {
        connections.set(connectionId, conn);
      }
    }

    if (String(conn.user.id) !== owner) {
      return skip('connection does not belong to TELEGRAM_OWNER_ID');
    }
    if (!conn.is_enabled) return skip('Chat Automation connection is disabled');

    stage = 'Save incoming history';
    const chat = store.chat(chatId);

    if (chat.seen.includes(msg.message_id)) {
      return skip('duplicate message');
    }

    chat.seen.push(msg.message_id);
    chat.seen = chat.seen.slice(-100);

    const revision = revise(chatId);
    const manual = String(msg.from.id) === owner;

    if (manual) {
      chat.until = Math.max(chat.until, msg.date * 1000 + cooldown);
    }

    if (msg.text) {
      remember(chat, manual ? 'owner' : 'contact', msg.text);
    }

    store.save();

    if (manual) return skip('owner sent a message; takeover cooldown updated');
    if (!msg.text?.trim()) return skip('message is not plain text');
    if (chat.paused) return skip('chat is paused');
    if (Date.now() < chat.until) {
      const seconds = Math.ceil((chat.until - Date.now()) / 1000);
      return skip(`manual takeover cooldown (${seconds}s remaining)`);
    }
    if (!conn.rights?.can_reply) {
      return skip('Telegram has not granted reply permission');
    }

    const isRecent = () => Date.now() - msg.date * 1000 < 300_000;
    if (!isRecent()) return skip('message is more than five minutes old');

    stage = 'FreeLLMAPI';
    const startedAt = Date.now();
    console.log(`[Chat Automation] Update ${updateId}: requesting reply`);

    const reply = await generateReply({ ...llm, history: [...chat.history] });

    if (!isRecent()) return skip('message aged out while generating a reply');
    if (revisions.get(chatId) !== revision || chat.paused || Date.now() < chat.until) {
      return skip('chat changed while generating a reply');
    }

    const current = connections.get(connectionId);
    if (!current?.is_enabled || !current.rights?.can_reply) {
      return skip('reply permission is no longer available');
    }

    stage = 'Telegram send';
    await ctx.api.sendMessage(msg.chat.id, `Automated reply: ${reply}`, {
      business_connection_id: connectionId,
    });
    delivered = true;

    console.log(
      `[Chat Automation] Update ${updateId}: reply delivered (${Date.now() - startedAt}ms)`,
    );

    stage = 'Save reply history';
    remember(chat, 'secretary', reply);
    store.save();
  } catch (error) {
    console.error(
      delivered
        ? 'Reply delivered, but saving its history failed'
        : 'Auto-reply failed; no automatic retry',
      { updateId, stage, ...safeErrorDetails(error) },
    );
  }
});

if (!env.WEBHOOK_URL) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => bot.stop());
  }

  await bot.start({
    allowed_updates: updates,
    onStart: () => logStartup('Polling'),
  });
} else {
  const url = new URL(env.WEBHOOK_URL);
  const secret = required('WEBHOOK_SECRET');

  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/telegram' ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{24,256}$/.test(secret)
  ) {
    throw new Error('Invalid webhook URL or secret');
  }

  const expectedSecret = Buffer.from(secret);
  await bot.init();

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.end('ok');
      return;
    }

    if (req.method !== 'POST' || req.url !== '/telegram') {
      res.writeHead(404).end();
      return;
    }

    const suppliedSecret = Buffer.from(
      String(req.headers['x-telegram-bot-api-secret-token'] ?? ''),
    );

    if (
      suppliedSecret.length !== expectedSecret.length ||
      !timingSafeEqual(suppliedSecret, expectedSecret)
    ) {
      res.writeHead(403).end();
      return;
    }

    try {
      const chunks = [];
      let size = 0;

      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256_000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }

      let update;
      try {
        update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }

      await bot.handleUpdate(update);
      res.end('ok');
    } catch (error) {
      console.error('Webhook update failed', safeErrorDetails(error));
      res.writeHead(500).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(env.PORT || 3000), '0.0.0.0', resolve);
  });

  try {
    await bot.api.setWebhook(url.href, {
      secret_token: secret,
      allowed_updates: updates,
    });
  } catch (error) {
    server.close();
    console.error('Webhook registration failed', safeErrorDetails(error));
    process.exitCode = 1;
  }

  if (!process.exitCode) logStartup('Webhook registered');
}
