const axios = require('axios');
const { readDB } = require('../db');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function buildMovieCaption(movie, webAppUrl) {
  const titleKh = escapeHtml(movie.title_kh || 'ភាពយន្តថ្មី');
  const titleEn = movie.title_en ? escapeHtml(movie.title_en) : '';
  const isDub = movie.language_type === 'dub' || movie.is_dubbed === true;
  const voiceType = isDub ? '🔊 បញ្ចូលសំឡេងខ្មែរ (Khmer Dubbed)' : '🤖 បញ្ចូលសំឡេង AI (Khmer AI)';
  const year = movie.release_year || new Date().getFullYear();
  const price = (movie.price !== undefined ? parseFloat(movie.price) : 0.5).toFixed(2);

  let genreNames = 'ភាពយន្តទូទៅ';
  if (Array.isArray(movie.genres) && movie.genres.length > 0) {
    genreNames = movie.genres
      .map(g => (typeof g === 'object' ? (g.name_kh || g.name) : g))
      .filter(Boolean)
      .join(', ');
  }
  genreNames = escapeHtml(genreNames);

  let rawOverview = (movie.overview || '').trim();
  if (rawOverview.length > 250) {
    rawOverview = rawOverview.slice(0, 247) + '...';
  }
  const cleanOverview = escapeHtml(rawOverview);

  let caption = `🎬 <b>ភាពយន្តថ្មីទើបតែបញ្ចេញ! [NEW RELEASE]</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 <b>${titleKh}</b>\n` +
    (titleEn ? `<i>(${titleEn})</i>\n\n` : `\n`) +
    `🎙 <b>សំឡេង៖</b> ${voiceType}\n` +
    `🎭 <b>ប្រភេទ៖</b> ${genreNames}\n` +
    `⭐️ <b>កម្រិត៖</b> Full HD 1080p\n` +
    `📅 <b>ឆ្នាំផលិត៖</b> ${year}\n` +
    `💎 <b>តម្លៃ៖</b> $${price} <i>(ឥតគិតថ្លៃសម្រាប់ VIP 👑)</i>\n\n`;

  if (cleanOverview) {
    caption += `📖 <b>សេចក្តីសង្ខេប៖</b>\n${cleanOverview}\n\n`;
  }

  caption += `✨ <i>ជាវ VIP ត្រឹមតែ $1/ខែ ទស្សនាបានគ្រប់រឿងដោយសេរី!</i>\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  return caption;
}

async function sendToChat(botToken, chatId, photoUrl, caption, inlineKeyboard) {
  const telegramApi = `https://api.telegram.org/bot${botToken}`;

  if (photoUrl) {
    try {
      await axios.post(`${telegramApi}/sendPhoto`, {
        chat_id: chatId,
        photo: photoUrl,
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      }, { timeout: 10000 });
      return { ok: true, type: 'photo' };
    } catch (err) {
      console.warn(`⚠️ sendPhoto failed for chat ${chatId}, falling back to sendMessage...`);
    }
  }

  try {
    await axios.post(`${telegramApi}/sendMessage`, {
      chat_id: chatId,
      text: caption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    }, { timeout: 10000 });
    return { ok: true, type: 'text' };
  } catch (err) {
    return { ok: false, error: err.response?.data?.description || err.message };
  }
}

async function broadcastNewMovie(movie) {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    console.warn('⚠️ BOT_TOKEN is not set. Telegram broadcast aborted.');
    return { success: false, reason: 'BOT_TOKEN missing' };
  }

  const webAppUrl = process.env.WEBAPP_URL || 'https://sdach-roeung-app.onrender.com';
  const botUsername = process.env.BOT_USERNAME || 'Sdach_Roeung_Mini_App_bot';
  const channelUsername = process.env.TELEGRAM_CHANNEL || '@Sdach_Roeung';

  const caption = buildMovieCaption(movie, webAppUrl);

  let photoUrl = movie.poster_path || movie.backdrop_path || '';
  if (photoUrl && photoUrl.startsWith('/')) {
    photoUrl = `${webAppUrl}${photoUrl}`;
  }

  const userKeyboard = [
    [{ text: '🍿 បើកទស្សនារឿងនេះ (Watch Now)', web_app: { url: `${webAppUrl}/?movie=${movie.id}` } }],
    [
      { text: '👑 ជាវ VIP ត្រឹមតែ $1/ខែ', web_app: { url: `${webAppUrl}/#profile` } },
      { text: '📢 Channel ផ្លូវការ', url: 'https://t.me/Sdach_Roeung' }
    ]
  ];

  const channelKeyboard = [
    [{ text: '🍿 បើកទស្សនារឿងនេះ (Watch Now)', url: `https://t.me/${botUsername}?startapp=movie_${movie.id}` }],
    [
      { text: '👑 ជាវ VIP ត្រឹមតែ $1/ខែ', url: `https://t.me/${botUsername}?startapp=profile` },
      { text: '📢 Channel ផ្លូវការ', url: 'https://t.me/Sdach_Roeung' }
    ]
  ];

  const db = readDB();
  const users = db.users || [];

  const chatIds = new Set();
  users.forEach(u => {
    const rawId = u.telegram_id || u.id;
    if (rawId && /^\d+$/.test(String(rawId).trim())) {
      chatIds.add(String(rawId).trim());
    }
  });

  console.log(`🚀 Starting Telegram broadcast for "${movie.title_kh}" to ${chatIds.size} users...`);

  let sentCount = 0;
  let failedCount = 0;

  for (const chatId of chatIds) {
    const result = await sendToChat(botToken, chatId, photoUrl, caption, userKeyboard);
    if (result.ok) {
      sentCount++;
    } else {
      failedCount++;
    }
    await sleep(50);
  }

  let channelSent = false;
  try {
    const channelRes = await sendToChat(botToken, channelUsername, photoUrl, caption, channelKeyboard);
    channelSent = channelRes.ok;
  } catch (err) {
    console.warn(`⚠️ Channel broadcast note:`, err.message);
  }

  console.log(`✅ Broadcast done! Sent: ${sentCount}, Failed: ${failedCount}, Channel: ${channelSent}`);

  return {
    success: true,
    sent_count: sentCount,
    failed_count: failedCount,
    channel_sent: channelSent
  };
}

module.exports = {
  broadcastNewMovie,
  buildMovieCaption
};
