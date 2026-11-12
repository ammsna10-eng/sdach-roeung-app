const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { readDB, writeDB, getCurrentUser, recordTransaction } = require('../db');

// Record a completed Bakong payment (topup or VIP) in the user's transaction history
function recordBakongTransaction(db, tx, userObj) {
  recordTransaction(db, {
    userId: tx.user_id,
    telegramId: userObj?.telegram_id || tx.user_id,
    type: tx.type === 'vip' ? 'VIP_PURCHASE' : 'TOPUP',
    title: tx.type === 'vip' ? 'ទិញកញ្ចប់ VIP ប្រចាំខែ' : 'បញ្ចូលទឹកប្រាក់ KHQR',
    amount: tx.type === 'vip' ? -Math.abs(parseFloat(tx.amount) || 0) : Math.abs(parseFloat(tx.amount) || 0),
    status: 'PAID',
    billNo: tx.bill_no || tx.tran_id
  });
}

const BAKONG_TOKEN = process.env.BAKONG_TOKEN || '';
const BAKONG_ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID || '002111782@abaa';
const BAKONG_MERCHANT_NAME = process.env.BAKONG_MERCHANT_NAME || 'VEASNA CHAN';
const BAKONG_MERCHANT_CITY = process.env.BAKONG_MERCHANT_CITY || 'Phnom Penh';
const BAKONG_API_URL = 'https://api-bakong.nbc.gov.kh';
// Optional Cambodia relay in case Render's foreign IP gets blocked by Bakong/Cloudflare
const BAKONG_CHECK_URL = process.env.BAKONG_PROXY_URL || 'https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_ID || '';
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';

// Send a raw Telegram message (optionally with an inline keyboard)
async function sendTelegram(chatId, text, replyMarkup) {
  if (!BOT_TOKEN || !chatId) return { ok: false, error: 'BOT_TOKEN/ADMIN_CHAT_ID missing' };
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: String(chatId),
      text: text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }, { timeout: 10000 });
    return { ok: true };
  } catch (err) {
    console.error('[Bakong] Telegram send failed:', err.response?.data?.description || err.message);
    return { ok: false, error: err.response?.data?.description || err.message };
  }
}

// 1-Tap Admin Approve fallback alert (Telegram)
async function notifyAdminPayment(tx, user, isReminder = false) {
  if (!ADMIN_CHAT_ID) {
    console.warn('[Bakong] ADMIN_CHAT_ID/TELEGRAM_ADMIN_ID not configured — admin payment alert skipped. Add ADMIN_CHAT_ID to .env');
    return { ok: false, error: 'ADMIN_CHAT_ID missing' };
  }
  const title = isReminder ? '🔁 អ្នកប្រើប្រាស់ថាបានបង់ប្រាក់រួចហើយ (I HAVE PAID)' : '🔔 ការបង់ប្រាក់ KHQR ថ្មី រង់ចាំផ្ទៀងផ្ទាត់';
  const text = `${title}\n━━━━━━━━━━━━━━━━\n` +
    `👤 User: ${user?.first_name || 'User'} (ID: ${user?.id || 'N/A'})\n` +
    `💰 ចំនួន៖ $${parseFloat(tx.amount).toFixed(2)}\n` +
    `🧾 Bill No: <code>${tx.bill_no}</code>\n` +
    `🆔 Tran ID: <code>${tx.tran_id}</code>\n` +
    `📅 ${new Date(tx.created_at).toLocaleString()}\n\n` +
    `👉 ចុចប៊ូតុងខាងក្រោមដើម្បីអនុម័តភ្លាមៗ៖`;
  const replyMarkup = { inline_keyboard: [[
    { text: `✅ អនុម័តការបង់ប្រាក់ ($${parseFloat(tx.amount).toFixed(2)})`, callback_data: `approve_pay_${tx.bill_no}` }
  ]] };
  return sendTelegram(ADMIN_CHAT_ID, text, replyMarkup);
}

// Mark a transaction as PAID, credit the user, and notify them (used by Admin 1-Tap approve)
async function approvePaymentByBillNo(billNo) {
  const db = readDB();
  const tx = (db.bakong_transactions || []).find(t => t.bill_no === billNo || t.tran_id === billNo);
  if (!tx) return { ok: false, reason: 'NOT_FOUND' };
  if (tx.status === 'completed' || tx.status === 'PAID') {
    return { ok: true, already: true, status: tx.status, amount: tx.amount, user_id: tx.user_id };
  }
  tx.status = 'PAID';
  tx.completed_at = new Date().toISOString();
  tx.approved_by = 'telegram_admin';
  const userObj = db.users.find(u => String(u.id) === String(tx.user_id));
  if (userObj) {
    if (tx.type === 'vip') {
      userObj.is_vip = true;
      const exp = new Date(); exp.setDate(exp.getDate() + 30);
      userObj.vip_expires_at = exp.toISOString();
    } else {
      userObj.wallet_balance = parseFloat((parseFloat(userObj.wallet_balance) || 0) + tx.amount);
    }
    try {
      const { broadcastToUser } = require('../services/telegram_notifier');
      if (userObj.telegram_id) {
        const msg = tx.type === 'vip'
          ? `✅ ការទូទាត់ VIP បានអនុម័តរួចរាល់!\n👑 សិទ្ធិ VIP 30 ថ្ងៃ ត្រូវបានបើក!\n💰 $${tx.amount.toFixed(2)}`
          : `✅ បញ្ចូលប្រាក់ជោគជ័យ (បានអនុម័តដោយ Admin)!\n💰 $${tx.amount.toFixed(2)} ត្រូវបានបន្ថែមទៅគណនីរបស់អ្នក!`;
        await broadcastToUser(userObj.telegram_id, msg);
      }
    } catch (e) {}
  }
  recordBakongTransaction(db, tx, userObj);
  writeDB(db);
  console.log(`[Bakong] ✅ Approved by Admin 1-Tap: bill=${tx.bill_no} amount=$${tx.amount} user=${tx.user_id}`);
  return { ok: true, status: 'PAID', amount: tx.amount, user_id: tx.user_id };
}

// CRC16 CCITT for KHQR EMV spec
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return ((crc & 0xFFFF).toString(16).toUpperCase()).padStart(4, '0');
}

// Sanitize to strict ASCII alphanumeric + spaces only (ABA enforces EMVCo/NBC rules)
const sanitizeASCII = (value, maxLen = 25) => {
  const cleaned = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLen);
};

// EMVCo TLV: length must be the BYTE length of the value
const tlv = (tag, value) => {
  const v = String(value);
  return tag + String(Buffer.byteLength(v, 'utf8')).padStart(2, '0') + v;
};

// Build KHQR string manually (EMV QR Code Spec - strict Dynamic KHQR, USD only,
// official ABA Bank Individual Account TLV structure so ABA Mobile + ACLEDA both recognize it)
function buildKHQRString(amount, billNo) {
  const name = sanitizeASCII(BAKONG_MERCHANT_NAME) || 'VEASNA CHAN';
  const city = sanitizeASCII(BAKONG_MERCHANT_CITY) || 'PHNOM PENH';
  const bill = sanitizeASCII(billNo);

  // USD (840) ONLY: max 2 decimal places
  const amtStr = (parseFloat(amount) || 0).toFixed(2);

  // Tag 99 Bakong Timestamp: creation + expiration (+15 min), 13-digit ms
  const created = Date.now();
  const expires = created + (15 * 60 * 1000);
  const tsSub = tlv('00', String(created)) + tlv('01', String(expires));

  // Tag 29 + top-level Tag 40: EXACT structure decoded from the official ABA QR card
  // (Tag 29: merchant ID + KHR account as issued; Tag 40: ABA "abaP2P" Dual template
  //  mapping KHR account 003802314 and USD account 002111782 — ABA apps resolve
  //  the correct account from this template by the scanned currency)
  const bakongTag =
    tlv('00', 'abaakhppxxx@abaa') +
    tlv('01', '003802314') +
    tlv('02', 'ABA Bank');
  const abaDualTemplate =
    tlv('00', 'abaP2P') +
    tlv('01', 'F1D8E17023ED') +
    tlv('02', '003802314') +
    tlv('03', '002111782') +
    tlv('04', 'Dual');

  const body =
    tlv('00', '01') +                                        // Payload Format Indicator
    tlv('01', '12') +                                        // Point of Initiation: 12 = DYNAMIC (Tag 54 present)
    tlv('29', bakongTag) +                                   // Merchant Account Info (EXACT ABA-issued structure)
    tlv('40', abaDualTemplate) +                             // ABA abaP2P Dual template (EXACT ABA-issued structure)
    tlv('52', '5999') +                                      // MCC: matches official ABA card
    tlv('53', '840') +                                       // Currency: USD only
    (amtStr ? tlv('54', amtStr) : '') +                      // Transaction Amount
    tlv('58', 'KH') +                                        // Country Code
    tlv('59', name) +                                        // Merchant Name (ASCII, <=25)
    tlv('60', city) +                                        // Merchant City (ASCII, <=25)
    tlv('62', tlv('01', bill)) +                             // Additional Data / Bill Number
    tlv('99', tsSub) +                                       // Bakong Timestamp (00 created / 01 expires)
    '6304';                                                  // CRC placeholder
  return body + crc16(body);
}

/**
 * POST /api/payment/bakong/create-qr
 */
router.post('/payment/bakong/create-qr', async (req, res) => {
  try {
    const db = readDB();
    const user = getCurrentUser(req, db) || { id: 0, first_name: 'Guest' };
    const { amount, type, target_id } = req.body;
    const amountVal = parseFloat(amount || 1.0).toFixed(2);
    const tranId = `TRX${Date.now()}${String(user.id).slice(-4)}`;
    const billNo = tranId.slice(0, 25);
    let qrString = null;

    if (BAKONG_TOKEN) {
      try {
        const r = await axios.post(`${BAKONG_API_URL}/v1/generate_qr`, {
          currency: 'USD', amount: parseFloat(amountVal),
          merchantName: BAKONG_MERCHANT_NAME, merchantCity: BAKONG_MERCHANT_CITY,
          merchantId: BAKONG_ACCOUNT_ID, billNumber: billNo,
          storeLabel: 'ស្ដេចរឿង'
        }, { headers: { 'Authorization': `Bearer ${BAKONG_TOKEN}` }, timeout: 8000 });
        if (r.data?.data?.qr) qrString = r.data.data.qr;
      } catch (e) { console.log('[Bakong] Fallback to manual KHQR'); }
    }
    if (!qrString) qrString = buildKHQRString(amountVal, billNo);

    const qrImageBase64 = await QRCode.toDataURL(qrString, {
      errorCorrectionLevel: 'M', type: 'image/png', width: 400, margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    const md5Hash = crypto.createHash('md5').update(qrString).digest('hex');

    db.bakong_transactions = db.bakong_transactions || [];
    const cutoff = Date.now() - 3600000;
    db.bakong_transactions = db.bakong_transactions.filter(t =>
      t.status !== 'pending' || new Date(t.created_at).getTime() > cutoff
    );
    db.bakong_transactions.push({
      tran_id: tranId, bill_no: billNo, user_id: user.id,
      amount: parseFloat(amountVal), type: type || 'topup',
      target_id: target_id || null, status: 'pending',
      qr_md5: md5Hash, created_at: new Date().toISOString()
    });
    writeDB(db);

    // 100% automatic verification: no admin alert — the Bakong Open API
    // (check_transaction_by_md5) verifies payment during polling.

    return res.json({ success: true, tran_id: tranId, amount: parseFloat(amountVal), qr_image: qrImageBase64, qr_md5: md5Hash });
  } catch (error) {
    console.error('Bakong QR Error:', error.message);
    res.status(500).json({ success: false, message: 'មានបញ្ហាក្នុងការបង្កើត KHQR' });
  }
});

/**
 * GET /api/payment/bakong/check-status?tran_id=xxx
 */
router.get('/payment/bakong/check-status', async (req, res) => {
  const { tran_id } = req.query;
  const db = readDB();
  const tx = (db.bakong_transactions || []).find(t => t.tran_id === tran_id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.status !== 'pending') return res.json({ tran_id: tx.tran_id, status: tx.status, amount: tx.amount });

  const result = await verifyPaymentWithBakong(db, tx);
  return res.json({ tran_id: tx.tran_id, amount: tx.amount, ...result });
});

/**
 * Shared 100% automatic Bakong Open API verification (used by GET + POST check-status)
 * Marks PAID only when responseCode === 0, currency is USD, and paid amount >= tx.amount
 */
async function verifyPaymentWithBakong(db, tx) {
  if (!BAKONG_TOKEN) {
    console.warn('[Bakong Check] BAKONG_TOKEN missing — cannot auto-verify, bill=' + tx.bill_no);
    return { status: 'pending', debugReason: 'MISSING_TOKEN' };
  }
  if (!tx.qr_md5) {
    console.warn('[Bakong Check] tx.qr_md5 missing, bill=' + tx.bill_no);
    return { status: 'pending', debugReason: 'MISSING_MD5' };
  }

  try {
    const cr = await axios.post(BAKONG_CHECK_URL,
      { md5: tx.qr_md5 },
      { headers: { 'Authorization': `Bearer ${BAKONG_TOKEN}` }, timeout: 8000 }
    );
    console.log(`[Bakong Check] HTTP ${cr.status} responseCode=${cr.data?.responseCode} message=${cr.data?.responseMessage || 'n/a'} bill=${tx.bill_no}`);
    if (cr.data?.responseCode === 0 && cr.data?.data) {
      // Bakong returns an array (or object) of matching transactions — sum USD payments
      const items = Array.isArray(cr.data.data) ? cr.data.data : [cr.data.data];
      const usdTotal = items.reduce((sum, it) => {
        const cur = String(it.currency ?? '').toUpperCase();
        const isUSD = cur === 'USD' || cur === '840' || Number(it.currency) === 840;
        return isUSD ? sum + (parseFloat(it.amount) || 0) : sum;
      }, 0);
      if (usdTotal + 0.001 >= tx.amount) {
        tx.status = 'PAID'; tx.completed_at = new Date().toISOString(); tx.bakong_verified = true;
        tx.paid_amount = usdTotal;
        const userObj = db.users.find(u => String(u.id) === String(tx.user_id));
        if (userObj) {
          if (tx.type === 'topup') {
            userObj.wallet_balance = parseFloat((parseFloat(userObj.wallet_balance) || 0) + tx.amount);
          } else if (tx.type === 'vip') {
            userObj.is_vip = true;
            const exp = new Date(); exp.setDate(exp.getDate() + 30);
            userObj.vip_expires_at = exp.toISOString();
          }
          // Send Telegram confirmation
          try {
            const { broadcastToUser } = require('../services/telegram_notifier');
            if (userObj.telegram_id) {
              const msg = tx.type === 'vip'
                ? `✅ ការទូទាត់ VIP ជោគជ័យ!\n👑 សិទ្ធិ VIP 30 ថ្ងៃ ត្រូវបានបើក!\n💰 $${tx.amount.toFixed(2)}`
                : `✅ បញ្ចូលប្រាក់ជោគជ័យ!\n💰 $${tx.amount.toFixed(2)} ត្រូវបានបន្ថែម!`;
              await broadcastToUser(userObj.telegram_id, msg);
            }
          } catch(e) {}
        }
        recordBakongTransaction(db, tx, userObj);
        writeDB(db);
        console.log(`[Bakong Check] ✅ AUTO-VERIFIED PAID bill=${tx.bill_no} paid=$${usdTotal} user=${tx.user_id}`);
        return { status: 'PAID', amount: tx.amount, paid_amount: usdTotal };
      }
      console.warn(`[Bakong Check] Amount mismatch: paid $${usdTotal} < required $${tx.amount} bill=${tx.bill_no}`);
      return { status: 'pending', debugReason: 'AMOUNT_MISMATCH', paid_amount: usdTotal };
    }
    console.log(`[Bakong Check] Not paid yet (responseCode ${cr.data?.responseCode}) bill=${tx.bill_no}`);
    return { status: 'pending', debugReason: 'NOT_PAID_YET' };
  } catch (e) {
    const httpStatus = e.response?.status || 'NO_RESPONSE';
    const body = typeof e.response?.data === 'object'
      ? JSON.stringify(e.response.data).slice(0, 300)
      : String(e.response?.data || e.message).slice(0, 300);
    console.error(`[Bakong Check] FAILED HTTP ${httpStatus} bill=${tx.bill_no} body=${body}`);
    let debugReason = 'BAKONG_API_ERROR';
    if (httpStatus === 401) debugReason = 'HTTP_401_UNAUTHORIZED';
    else if (httpStatus === 403) debugReason = 'HTTP_403_BLOCKED';
    else if (httpStatus === 429) debugReason = 'HTTP_429_RATE_LIMITED';
    else if (httpStatus === 'NO_RESPONSE') debugReason = 'NETWORK_ERROR';
    return { status: 'pending', debugReason };
  }
}

/**
 * POST /api/payment/bakong/check-status
 * Same auto-verification, invoked by the "ខ្ញុំបានបង់ប្រាក់រួចហើយ" button with { md5, billNo }
 */
router.post('/payment/bakong/check-status', async (req, res) => {
  const { md5, billNo } = req.body || {};
  const db = readDB();
  const tx = (db.bakong_transactions || []).find(t => t.bill_no === billNo || t.tran_id === billNo);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (md5 && tx.qr_md5 && md5 !== tx.qr_md5) {
    console.warn(`[Bakong Check] md5 mismatch vs stored (bill=${tx.bill_no}) — using stored md5`);
  }
  if (tx.status !== 'pending') return res.json({ tran_id: tx.tran_id, status: tx.status, amount: tx.amount });

  const result = await verifyPaymentWithBakong(db, tx);
  return res.json({ tran_id: tx.tran_id, amount: tx.amount, ...result });
});

/**
 * POST /api/payment/bakong/webhook
 */
router.post('/payment/bakong/webhook', async (req, res) => {
  try {
    const { tran_id, status } = req.body;
    const db = readDB();
    const tx = (db.bakong_transactions || []).find(t => t.tran_id === tran_id || t.bill_no === tran_id);
    if (tx && tx.status !== 'completed' && (status === '0' || status === 0 || status === 'SUCCESS')) {
      tx.status = 'completed'; tx.completed_at = new Date().toISOString();
      const userObj = db.users.find(u => String(u.id) === String(tx.user_id));
      if (userObj) {
        if (tx.type === 'topup') userObj.wallet_balance = parseFloat((parseFloat(userObj.wallet_balance) || 0) + tx.amount);
        else if (tx.type === 'vip') {
          userObj.is_vip = true;
          const exp = new Date(); exp.setDate(exp.getDate() + 30);
          userObj.vip_expires_at = exp.toISOString();
        }
      }
      recordBakongTransaction(db, tx, userObj);
      writeDB(db);
    }
    res.json({ status: 'received' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/payment/bakong/i-have-paid
 * User taps "ខ្ញុំបានបង់ប្រាក់រួចហើយ" → re-alert the Admin on Telegram
 */
router.post('/payment/bakong/i-have-paid', async (req, res) => {
  try {
    const { tran_id } = req.body || {};
    const db = readDB();
    const tx = (db.bakong_transactions || []).find(t => t.tran_id === tran_id);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
    const user = getCurrentUser(req, db) || { id: 0, first_name: 'Guest' };
    const r = await notifyAdminPayment(tx, user, true);
    res.json({ success: true, admin_notified: r.ok, message: 'សំណើផ្ទៀងផ្ទាត់ត្រូវបានផ្ញើទៅ Admin រួចរាល់!' });
  } catch (e) {
    console.error('I-Have-Paid Error:', e.message);
    res.status(500).json({ success: false, message: 'មានបញ្ហាក្នុងការផ្ញើសំណើ' });
  }
});

/**
 * POST /api/payment/bakong/admin-approve
 * Internal approve endpoint: bot.js calls it first (localhost bypass even without SYNC_SECRET),
 * then falls back to SYNC_SECRET auth for cross-container calls.
 */
router.post('/payment/bakong/admin-approve', async (req, res) => {
  const remote = req.ip || req.socket?.remoteAddress || '';
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  const secretOk = SYNC_SECRET && req.get('x-sync-secret') === SYNC_SECRET;
  if (!isLocal && !secretOk) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { bill_no } = req.body || {};
  if (!bill_no) return res.status(400).json({ error: 'bill_no required' });
  const result = await approvePaymentByBillNo(bill_no);
  res.json(result);
});

module.exports = router;
module.exports.approvePaymentByBillNo = approvePaymentByBillNo;

