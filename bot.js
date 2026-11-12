require('./db').initCloudDB().catch(() => {});
// Force IPv4-first DNS: Node.js v24 tries IPv6 first on Render, causing ETIMEDOUT to api.telegram.org
require('dns').setDefaultResultOrder('ipv4first');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const dotenv = require('dotenv');
const { readDB, writeDB } = require('./db');
const bakongPayment = require('./routes/bakong_payment');

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://sdach-roeung-app.onrender.com';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_ID || '';
const SYNC_SECRET = process.env.SYNC_SECRET || '';

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

// 💳 Admin 1-Tap Payment Approve (callback_data: approve_pay_<billNo>)
bot.action(/^approve_pay_(.+)$/, async (ctx) => {
  const billNo = ctx.match[1];

  // Only the configured Admin may approve
  const adminIds = String(ADMIN_CHAT_ID).split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.length || !adminIds.includes(String(ctx.from?.id))) {
    return ctx.answerCbQuery('⛔ មិនអនុញ្ញាត! មានតែ Admin ប៉ុណ្ណោះ។').catch(() => {});
  }

  // Render runs `node server.js & node bot.js` as two OS processes sharing data/db.json.
  // Call the web service on localhost FIRST so server.js updates its own DB view and
  // credits the user's live balance immediately; only write the file directly as fallback.
  let result = { ok: false, reason: 'UNKNOWN' };
  try {
    const localPort = process.env.PORT || 10000;
    const r = await axios.post(`http://127.0.0.1:${localPort}/api/payment/bakong/admin-approve`,
      { bill_no: billNo },
      { headers: { 'x-sync-secret': SYNC_SECRET }, timeout: 8000 });
    if (r.data && r.data.ok) result = r.data;
    else if (r.data && r.data.reason) result = r.data;
  } catch (e) {
    console.warn('[Bot Approve] Local HTTP approve failed, trying direct DB write:', e.message);
  }

  if (!result.ok || result.reason === 'NOT_FOUND') {
    try {
      result = await bakongPayment.approvePaymentByBillNo(billNo);
    } catch (e) {
      console.error('[Bot Approve] Direct DB approve failed:', e.message);
    }
  }

  // Last resort: remote web service URL (separate containers)
  if (!result.ok || result.reason === 'NOT_FOUND') {
    try {
      const r = await axios.post(`${WEBAPP_URL}/api/payment/bakong/admin-approve`,
        { bill_no: billNo },
        { headers: { 'x-sync-secret': SYNC_SECRET }, timeout: 10000 });
      if (r.data && r.data.ok) result = r.data;
    } catch (e) {
      console.warn('[Bot Approve] Remote fallback failed:', e.message);
    }
  }

  if (result.ok && result.already) {
    await ctx.answerCbQuery('⚠️ បានអនុម័តរួចហើយ!').catch(() => {});
    await ctx.editMessageText(
      `⚠️ Transaction <code>${billNo}</code> ត្រូវបានអនុម័តរួចហើយ!`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } else if (result.ok) {
    await ctx.answerCbQuery(`✅ អនុម័តរួចរាល់! +$${parseFloat(result.amount).toFixed(2)}`).catch(() => {});
    await ctx.editMessageText(
      `✅ <b>បានអនុម័តការបង់ប្រាក់រួចរាល់!</b>\n` +
      `🧾 Bill No: <code>${billNo}</code>\n` +
      `💰 បានបន្ថែម: $${parseFloat(result.amount).toFixed(2)}\n` +
      `👤 User ID: ${result.user_id}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } else {
    await ctx.answerCbQuery('❌ រកមិនឃើញ Transaction!').catch(() => {});
  }
});

// Resilient launch: during Render zero-downtime deploys, old and new containers
// briefly overlap (409 Conflict) and transient network errors (ETIMEDOUT, ECONNRESET,
// ENOTFOUND, FetchError) can occur — catch ALL of them and retry, never crash the process.
const launchBotWithRetry = async (attempt = 1) => {
  // Clear any leftover webhook/polling state from the old instance
  await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  try {
    await bot.launch();
    console.log('🤖 Telegram Bot is running successfully!');
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn(`⚠️ Telegram launch failed (attempt ${attempt}): ${msg} — retrying in 5s...`);
    setTimeout(launchBotWithRetry, 5000);
  }
};

// A transient Telegram network timeout must never take down the whole Render process
process.on('unhandledRejection', (err) => console.error('⚠️ Unhandled Rejection in bot:', err?.message || err));

launchBotWithRetry();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

