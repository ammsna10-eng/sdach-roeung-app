const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const { readDB, writeDB } = require('./db');

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://sdach-roeung-app.onrender.com';

if (!BOT_TOKEN) {
  console.log('⚠️  Notice: BOT_TOKEN is not set in .env file.');
  console.log('👉 Please add your BOT_TOKEN from @BotFather into .env to start the Telegram Bot.');
  process.exit(0);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const firstName = ctx.from?.first_name || 'មិត្តភក្តិ';
  const tgUser = ctx.from;

  // Auto register Telegram user in database for broadcasts & Mini App sync
  if (tgUser && tgUser.id) {
    try {
      const db = readDB();
      db.users = db.users || [];
      const exists = db.users.some(u => String(u.telegram_id) === String(tgUser.id) || String(u.id) === String(tgUser.id));
      if (!exists) {
        db.users.push({
          id: tgUser.id,
          telegram_id: String(tgUser.id),
          first_name: tgUser.first_name || 'User',
          last_name: tgUser.last_name || '',
          username: tgUser.username || '',
          photo_url: null,
          wallet_balance: 0.0,
          is_vip: false,
          vip_expires_at: null,
          role: 'user',
          created_at: new Date().toISOString()
        });
        writeDB(db);
        console.log(`👤 New Telegram user registered via bot /start: ${tgUser.first_name} (${tgUser.id})`);
      }
    } catch (err) {
      console.warn('Error registering user from /start:', err.message);
    }
  }

  // Handle deep-link start payload (e.g., /start movie_12345)
  const payload = ctx.startPayload;
  let targetUrl = WEBAPP_URL;
  if (payload && payload.startsWith('movie_')) {
    const movieId = payload.replace('movie_', '');
    targetUrl = `${WEBAPP_URL}/?movie=${movieId}`;
  }

  const welcomeText = `👑 <b>សូមស្វាគមន៍មកកាន់ ស្ដេចរឿង (Sdach Roeung)</b>\n\n` +
    `ជម្រាបសួរលោកអ្នក <b>${firstName}</b>! 👋\n` +
    `រីករាយទស្សនាភាពយន្តល្បីៗ រឿងភាគ និងរឿងបញ្ចូលសំឡេងខ្មែរជាច្រើនរាប់មិនអស់ ដោយសេរីនៅលើ Telegram Mini App ស្ដេចរឿង!\n\n` +
    `🍿 គុណភាពកម្រិត HD / 4K\n` +
    `⚡️ ដំណើរការលឿន ងាយស្រួលប្រើប្រាស់\n` +
    `💳 បញ្ចូលលុយ និងជាវ VIP យ៉ាងរហ័សតាម KHQR\n\n` +
    `👇 សូមចុចប៊ូតុងខាងក្រោមដើម្បីបើកកម្មវិធី៖`;

  return ctx.replyWithHTML(
    welcomeText,
    Markup.inlineKeyboard([
      [Markup.button.webApp('🍿 បើកទស្សនារឿង (Open App)', targetUrl)],
      [Markup.button.url('📢 ចូលរួម Channel ផ្លូវការ', 'https://t.me/Sdach_Roeung')]
    ])
  );
});

bot.help((ctx) => {
  ctx.reply('សូមចុចប៊ូតុងខាងក្រោមដើម្បីបើកទស្សនារឿង!',
    Markup.inlineKeyboard([
      [Markup.button.webApp('🍿 បើកទស្សនារឿង ស្ដេចរឿង', WEBAPP_URL)]
    ])
  );
});

// Resilient launch: during Render zero-downtime deploys, old and new containers
// briefly overlap and Telegram throws 409 Conflict — retry instead of crashing.
const launchBotWithRetry = async (attempt = 1) => {
  // Clear any leftover webhook/polling state from the old instance
  await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  try {
    await bot.launch();
    console.log('🤖 Telegram Bot is running successfully!');
  } catch (err) {
    if (err && /409/.test(err.message || '')) {
      console.warn(`Telegram 409 conflict (waiting for old instance to stop), retrying in 5s... (attempt ${attempt})`);
      setTimeout(() => launchBotWithRetry(attempt + 1), 5000);
    } else {
      console.error('❌ Failed to launch Telegram Bot:', err.message);
      throw err;
    }
  }
};

launchBotWithRetry();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

