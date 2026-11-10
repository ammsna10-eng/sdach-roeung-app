const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');

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
      [Markup.button.webApp('🍿 បើកទស្សនារឿង (Open App)', WEBAPP_URL)],
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

bot.launch().then(() => {
  console.log('🤖 Telegram Bot is running successfully!');
}).catch((err) => {
  console.error('❌ Failed to launch Telegram Bot:', err.message);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

