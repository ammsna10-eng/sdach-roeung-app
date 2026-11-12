const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Tesseract = require('tesseract.js');

// Shared Tesseract worker: initialized once, reused for every receipt (fast + no RAM spikes)
let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker('eng').then((worker) => {
      // Undecodable images make the worker emit 'error' — swallow it so a bad
      // receipt screenshot can never crash the whole Render process.
      if (typeof worker.on === 'function') {
        worker.on('error', (e) => console.error('[OCR] worker error:', e?.message || e));
      }
      return worker;
    }).catch((e) => {
      ocrWorkerPromise = null; // allow a fresh init on the next request
      throw e;
    });
  }
  return ocrWorkerPromise;
}
const { readDB, writeDB, getCurrentUser, recordTransaction } = require('../db');

// Record a completed Bakong payment (topup or VIP) in the user's transaction history
// Topups record the package's ទឹកប្រាក់ទទួលបាន ($): tx.creditAmount || tx.amount
function recordBakongTransaction(db, tx, userObj) {
  const credited = tx.type === 'vip'
    ? -Math.abs(parseFloat(tx.amount) || 0)
    : Math.abs(parseFloat(tx.creditAmount || tx.amount) || 0);
  recordTransaction(db, {
    userId: tx.user_id,
    telegramId: userObj?.telegram_id || tx.user_id,
    type: tx.type === 'vip' ? 'VIP_PURCHASE' : 'TOPUP',
    title: tx.type === 'vip' ? 'ទិញកញ្ចប់ VIP ប្រចាំខែ' : 'បញ្ចូលទឹកប្រាក់ KHQR',
    amount: credited,
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
const BAKONG_API_BASE = process.env.BAKONG_API_BASE || 'https://api-bakong.nbc.gov.kh/v1';
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

// Send a receipt photo + caption + inline keyboard to the Admin on Telegram (emergency fallback)
async function sendReceiptToAdmin(imgBuffer, filename, caption, replyMarkup) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return { ok: false, error: 'BOT_TOKEN/ADMIN_CHAT_ID missing' };
  try {
    const fd = new FormData();
    fd.append('chat_id', String(ADMIN_CHAT_ID));
    fd.append('caption', caption);
    fd.append('photo', new Blob([imgBuffer]), filename);
    if (replyMarkup) fd.append('reply_markup', JSON.stringify(replyMarkup));
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[Bakong] Telegram sendPhoto failed:', r.status, body.slice(0, 200));
      return { ok: false, error: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[Bakong] Telegram sendPhoto failed:', err.message);
    return { ok: false, error: err.message };
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
  const credited = tx.type === 'vip' ? tx.amount : (tx.creditAmount || tx.amount);
  const userObj = db.users.find(u => String(u.id) === String(tx.user_id));
  if (userObj) {
    if (tx.type === 'vip') {
      userObj.is_vip = true;
      const exp = new Date(); exp.setDate(exp.getDate() + 30);
      userObj.vip_expires_at = exp.toISOString();
    } else {
      userObj.wallet_balance = parseFloat((parseFloat(userObj.wallet_balance) || 0) + credited);
    }
    try {
      const { broadcastToUser } = require('../services/telegram_notifier');
      if (userObj.telegram_id) {
        const msg = tx.type === 'vip'
          ? `✅ ការទូទាត់ VIP បានអនុម័តរួចរាល់!\n👑 សិទ្ធិ VIP 30 ថ្ងៃ ត្រូវបានបើក!\n💰 $${tx.amount.toFixed(2)}`
          : `✅ បញ្ចូលប្រាក់ជោគជ័យ (បានអនុម័តដោយ Admin)!\n💰 $${credited.toFixed(2)} ត្រូវបានបន្ថែមទៅគណនីរបស់អ្នក!`;
        await broadcastToUser(userObj.telegram_id, msg);
      }
    } catch (e) {}
  }
  recordBakongTransaction(db, tx, userObj);
  writeDB(db);
  console.log(`[Bakong] ✅ Approved by Admin 1-Tap: bill=${tx.bill_no} amount=$${tx.amount} credited=$${credited} user=${tx.user_id}`);
  return { ok: true, status: 'PAID', amount: tx.amount, creditedAmount: credited, user_id: tx.user_id };
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
    const packageId = req.body.packageId ?? req.body.package_id ?? null;
    const tranId = `TRX${Date.now()}${String(user.id).slice(-4)}`;
    const billNo = tranId.slice(0, 25);
    let qrString = null;
    let packageQrImage = null;

    // Admin-uploaded Top-Up Package (topup_packages) or VIP plan (vip_plans):
    // payAmount = តម្លៃត្រូវបង់ ($), creditAmount = ទឹកប្រាក់ទទួលបាន ($) credited to wallet
    let pkg = null;
    const pkgId = parseInt(packageId) || parseInt(target_id);
    if (type === 'vip') {
      pkg = (db.vip_plans || []).find(p => p.id === pkgId && p.is_active) || null;
    }
    if (!pkg && pkgId) {
      pkg = (db.topup_packages || []).find(p => p.id === pkgId && p.is_active) || null;
    }
    if (!pkg && pkgId === undefined && type !== 'vip') {
      // Fallback: match package by តម្លៃត្រូវបង់ (pay_amount / price)
      pkg = (db.topup_packages || []).find(p => p.is_active && Math.abs(parseFloat(p.price) - parseFloat(amount || 0)) < 0.001) || null;
    }

    const payAmount = pkg ? parseFloat(pkg.price) : parseFloat(amount || 1.0);
    const payAmountVal = payAmount.toFixed(2);
    const creditAmount = pkg && type !== 'vip' ? parseFloat(pkg.balance_amount || pkg.credit_amount || pkg.price) : null;

    if (pkg && pkg.qr_image) {
      // Use the EXACT Admin-uploaded fixed QR image for this package — no QR generation
      packageQrImage = pkg.qr_image;
    } else {
      // Fallback: generate dynamic KHQR (only when the package has no uploaded QR image)
      if (BAKONG_TOKEN) {
        try {
          const r = await axios.post(`${BAKONG_API_URL}/v1/generate_qr`, {
            currency: 'USD', amount: parseFloat(payAmountVal),
            merchantName: BAKONG_MERCHANT_NAME, merchantCity: BAKONG_MERCHANT_CITY,
            merchantId: BAKONG_ACCOUNT_ID, billNumber: billNo,
            storeLabel: 'ស្ដេចរឿង'
          }, { headers: { 'Authorization': `Bearer ${BAKONG_TOKEN}` }, timeout: 8000 });
          if (r.data?.data?.qr) qrString = r.data.data.qr;
        } catch (e) { console.log('[Bakong] Fallback to manual KHQR'); }
      }
      if (!qrString) qrString = buildKHQRString(payAmountVal, billNo);
    }

    const qrImageBase64 = packageQrImage ? null : await QRCode.toDataURL(qrString, {
      errorCorrectionLevel: 'M', type: 'image/png', width: 400, margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    const md5Hash = qrString ? crypto.createHash('md5').update(qrString).digest('hex') : null;

    db.bakong_transactions = db.bakong_transactions || [];
    const cutoff = Date.now() - 3600000;
    db.bakong_transactions = db.bakong_transactions.filter(t =>
      t.status !== 'pending' || new Date(t.created_at).getTime() > cutoff
    );
    db.bakong_transactions.push({
      tran_id: tranId, bill_no: billNo, user_id: user.id,
      amount: parseFloat(payAmountVal),
      payAmount: parseFloat(payAmountVal),
      creditAmount: creditAmount !== null ? parseFloat(creditAmount) : null,
      package_id: pkg ? pkg.id : null,
      package_name: pkg ? (pkg.name || pkg.title) : null,
      type: type || 'topup',
      target_id: target_id || null, status: 'pending',
      qr_md5: md5Hash, created_at: new Date().toISOString()
    });
    writeDB(db);

    return res.json({
      success: true, tran_id: tranId,
      amount: parseFloat(payAmountVal), payAmount: parseFloat(payAmountVal), creditAmount,
      qr_image: qrImageBase64, packageQrImage: packageQrImage, qr_md5: md5Hash
    });
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
      const requiredPay = parseFloat(tx.payAmount || tx.amount) || 0;
      // Bakong returns an array (or object) of matching transactions — sum USD payments
      const items = Array.isArray(cr.data.data) ? cr.data.data : [cr.data.data];
      const usdTotal = items.reduce((sum, it) => {
        const cur = String(it.currency ?? '').toUpperCase();
        const isUSD = cur === 'USD' || cur === '840' || Number(it.currency) === 840;
        return isUSD ? sum + (parseFloat(it.amount) || 0) : sum;
      }, 0);
      if (usdTotal + 0.001 >= requiredPay) {
        tx.status = 'PAID'; tx.completed_at = new Date().toISOString(); tx.bakong_verified = true;
        tx.paid_amount = usdTotal;
        const credited = tx.type === 'vip' ? tx.amount : (tx.creditAmount || tx.amount);
        const userObj = db.users.find(u => String(u.id) === String(tx.user_id));
        if (userObj) {
          if (tx.type === 'vip') {
            userObj.is_vip = true;
            const exp = new Date(); exp.setDate(exp.getDate() + 30);
            userObj.vip_expires_at = exp.toISOString();
          } else {
            userObj.wallet_balance = parseFloat((parseFloat(userObj.wallet_balance) || 0) + credited);
          }
          // Send Telegram confirmation
          try {
            const { broadcastToUser } = require('../services/telegram_notifier');
            if (userObj.telegram_id) {
              const msg = tx.type === 'vip'
                ? `✅ ការទូទាត់ VIP ជោគជ័យ!\n👑 សិទ្ធិ VIP 30 ថ្ងៃ ត្រូវបានបើក!\n💰 $${tx.amount.toFixed(2)}`
                : `✅ បញ្ចូលប្រាក់ជោគជ័យ!\n💰 $${credited.toFixed(2)} ត្រូវបានបន្ថែម!`;
              await broadcastToUser(userObj.telegram_id, msg);
            }
          } catch(e) {}
        }
        recordBakongTransaction(db, tx, userObj);
        writeDB(db);
        console.log(`[Bakong Check] ✅ AUTO-VERIFIED PAID bill=${tx.bill_no} paid=$${usdTotal} credited=$${credited} user=${tx.user_id}`);
        return { status: 'PAID', amount: tx.amount, creditedAmount: credited, paid_amount: usdTotal };
      }
      console.warn(`[Bakong Check] Amount mismatch: paid $${usdTotal} < required $${requiredPay} bill=${tx.bill_no}`);
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
 * POST /api/payment/bakong/verify-receipt
 * 100% Free Local Server OCR (tesseract.js) + optional manual 8-char Hash input + Bakong Open API.
 * Body: { billNo, receiptImageBase64, manualHash } — credits tx.creditAmount (ទឹកប្រាក់ទទួលបាន) on success.
 */
router.post('/payment/bakong/verify-receipt', async (req, res) => {
  try {
    const { billNo } = req.body || {};
    const receiptImageBase64 = req.body?.receiptImageBase64 || null;
    const manualHash = req.body?.manualHash || null;
    if (!billNo || (!receiptImageBase64 && !manualHash)) {
      return res.json({ ok: false, error: 'សូមភ្ជាប់រូបភាពវិក្កយបត្រ ឬវាយលេខកូដ Hash ជាមុនសិន!' });
    }
    const db = readDB();
    const tx = (db.bakong_transactions || []).find(t => t.bill_no === billNo || t.tran_id === billNo);
    if (!tx) return res.status(404).json({ ok: false, error: 'Transaction not found' });
    if (tx.status === 'completed' || tx.status === 'PAID') {
      return res.json({ ok: true, status: 'PAID', creditedAmount: tx.creditAmount || tx.amount });
    }
    const requiredPay = parseFloat(tx.payAmount || tx.amount) || 0;

    // ── Step 1: Local OCR extraction (shared Tesseract worker) + Manual Hash override ─
    let ocrHash = '', fullHash = '', bankTrxId = '', ftRef = '', ocrUSD = 0, ocrText = '', recipientMatch = false;
    if (receiptImageBase64) {
      const m = String(receiptImageBase64).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
      const imgBuffer = Buffer.from(m ? m[2] : String(receiptImageBase64), 'base64');
      try {
        const worker = await getOcrWorker();
        const { data: { text } } = await worker.recognize(imgBuffer);
        ocrText = String(text || '');
        // 8-char Bakong Hash near "Hash:" label
        const h8 = ocrText.match(/hash\s*[:#-]*\s*([a-f0-9]{8})\b/i);
        if (h8) ocrHash = h8[1];
        // 64-char full transaction hash fallback
        const h64 = ocrText.match(/\b[a-f0-9]{64}\b/i);
        if (h64) fullHash = h64[0];
        // generic 8-char hex token containing both a letter and a digit
        if (!ocrHash && !fullHash) {
          const hAny = ocrText.match(/\b(?=[a-f0-9]*[a-f])(?=[a-f0-9]*[0-9])[a-f0-9]{8}\b/i);
          if (hAny) ocrHash = hAny[0];
        }
        // ABA transaction number near ប្រតិបត្តិការ / Trx / Transaction label, else first 10-14 digit token
        const trxLabeled = ocrText.match(/(?:ប្រតិបត្តិការ|trx|trans(?:action)?)\s*[.:#-]?\s*(?:no\.?\s*)?([a-z0-9-]*\d[\d-]{9,})/i);
        if (trxLabeled) bankTrxId = trxLabeled[1].replace(/[^a-zA-Z0-9-]/g, '');
        if (!bankTrxId) {
          const trxGen = ocrText.match(/\b(\d{10,14})\b/);
          if (trxGen) bankTrxId = trxGen[1];
        }
        // ABA FT Reference (e.g. 100FT40351825305)
        const ft = ocrText.match(/\b(100FT[A-Z0-9]{8,20})\b/i);
        if (ft) ftRef = ft[1].toUpperCase();
        // Recipient check: account 002111782 (spaces stripped) or CHAN VEASNA
        const stripped = ocrText.replace(/[\s.-]/g, '');
        recipientMatch = stripped.includes('002111782') || /chan\s*veasna/i.test(ocrText);
        // Paid USD amount: "-0.50 USD" top line or "$0.50" / "0.50 USD" original amount — take the max
        const usdMatches = [];
        for (const um of ocrText.matchAll(/(?:-|\$|USD\s*)(\d+\.\d{2})/gi)) usdMatches.push(parseFloat(um[1]) || 0);
        for (const um of ocrText.matchAll(/(\d+\.\d{2})\s*USD/gi)) usdMatches.push(parseFloat(um[1]) || 0);
        if (usdMatches.length) ocrUSD = Math.max(...usdMatches);
        console.log(`[Verify Receipt] OCR: hash=${ocrHash} h64=${fullHash ? 'yes' : 'no'} trxId=${bankTrxId} ftRef=${ftRef} recipient=${recipientMatch} amount=$${ocrUSD} bill=${tx.bill_no}`);
      } catch (ocrErr) {
        console.error('[Verify Receipt] OCR failed:', ocrErr.message);
      }
    }

    // Manual Hash Override: prioritize a valid 8-char / 64-char hash
    const manualClean = manualHash ? String(manualHash).replace(/[^a-zA-Z0-9]/g, '') : '';
    let cleanHash = '';
    if (manualClean.length === 8 || manualClean.length === 64) cleanHash = manualClean;
    else if (ocrHash) cleanHash = ocrHash;
    else if (fullHash) cleanHash = fullHash;

    // OCR amount sanity check (only when a USD amount is clearly detected)
    if (ocrUSD > 0 && ocrUSD + 0.001 < requiredPay) {
      return res.json({ ok: false, error: 'ចំនួនទឹកប្រាក់លើវិក្កយបត្រមិនគ្រប់តាមតម្លៃកញ្ចប់ទេ!' });
    }

    // ── Path A: Bakong Hash present → Bakong Open API cross-verification (BAKONG_TOKEN) ──
    if (cleanHash && (cleanHash.length === 8 || cleanHash.length === 64)) {
      if (!BAKONG_TOKEN) {
        return res.json({ ok: false, error: 'MISSING_BAKONG_TOKEN: ប្រព័ន្ធ Bakong មិនបានកំណត់រួចរាល់ទេ!' });
      }
      // Anti-replay / duplicate lock (hash)
      const hLow = cleanHash.toLowerCase();
      const poolsA = [db.bakong_transactions || [], db.aba_transactions || []];
      for (const pool of poolsA) {
        for (const t of pool) {
          if (t === tx) continue;
          if (!['PAID', 'completed'].includes(t.status)) continue;
          if (t.bakongHash && String(t.bakongHash).toLowerCase() === hLow) {
            return res.json({ ok: false, error: 'វិក្កយបត្រនេះត្រូវបានប្រើប្រាស់រួចហើយ (Duplicate Receipt)!' });
          }
        }
      }
      let verifyRes = null;
      if (cleanHash.length === 8) {
        verifyRes = await axios.post(`${BAKONG_API_BASE}/check_transaction_by_short_hash`,
          { hash: cleanHash, amount: requiredPay, currency: 'USD' },
          { headers: { 'Authorization': `Bearer ${BAKONG_TOKEN}` }, timeout: 10000 });
      } else {
        verifyRes = await axios.post(`${BAKONG_API_BASE}/check_transaction_by_hash`,
          { hash: cleanHash },
          { headers: { 'Authorization': `Bearer ${BAKONG_TOKEN}` }, timeout: 10000 });
      }
      console.log(`[Verify Receipt] Bakong HTTP ${verifyRes.status} responseCode=${verifyRes.data?.responseCode} message=${verifyRes.data?.responseMessage || 'n/a'} bill=${tx.bill_no}`);
      if (verifyRes.data?.responseCode === 0 && verifyRes.data?.data) {
        const items = Array.isArray(verifyRes.data.data) ? verifyRes.data.data : [verifyRes.data.data];
        const usdPaid = items.reduce((sum, it) => {
          const cur = String(it.currency ?? '').toUpperCase();
          const isUSD = cur === 'USD' || cur === '840' || Number(it.currency) === 840;
          return isUSD ? sum + (parseFloat(it.amount) || 0) : sum;
        }, 0);
        if (usdPaid + 0.001 >= requiredPay) {
          tx.bakongHash = cleanHash;
          tx.bankTrxId = bankTrxId;
          tx.paid_amount = usdPaid;
          tx.ocr_text = ocrText.slice(0, 500);
          const approved = await approvePaymentByBillNo(tx.bill_no);
          if (approved.ok) {
            console.log(`[Verify Receipt] ✅ PAID via Bakong API (Path A) bill=${tx.bill_no} credited=$${approved.creditedAmount}`);
            return res.json({ ok: true, status: 'PAID', creditedAmount: approved.creditedAmount });
          }
          return res.json({ ok: false, error: 'មានបញ្ហាក្នុងការអនុម័តការទូទាត់!' });
        }
        return res.json({ ok: false, error: 'ចំនួនទឹកប្រាក់ Bakong រកឃើញមិនគ្រប់តាមតម្លៃកញ្ចប់ទេ!' });
      }
      return res.json({ ok: false, error: 'ប្រព័ន្ធ Bakong មិនទាន់រកឃើញប្រតិបត្តិការនេះទេ សូមពិនិត្យរូបភាពវិក្កយបត្រ ឬសាកល្បងម្ដងទៀត!' });
    }

    // ── Path B: ABA-to-ABA interbank KHQR receipt (no Bakong Hash, paid to 002 111 782 / CHAN VEASNA) ──
    if (recipientMatch && ocrUSD + 0.001 >= requiredPay && (bankTrxId || ftRef)) {
      // Anti-replay: this bankTrxId / ftRef must NEVER have been used on a prior PAID/completed tx
      const refLow = String(bankTrxId || '').toLowerCase();
      const ftLow = String(ftRef || '').toLowerCase();
      const poolsB = [db.bakong_transactions || [], db.aba_transactions || []];
      for (const pool of poolsB) {
        for (const t of pool) {
          if (t === tx) continue;
          if (!['PAID', 'completed'].includes(t.status)) continue;
          if ((bankTrxId && ((t.bankTrxId && String(t.bankTrxId).toLowerCase() === refLow) ||
                             (t.bakongHash && String(t.bakongHash).toLowerCase() === refLow))) ||
              (ftRef && t.ftRef && String(t.ftRef).toLowerCase() === ftLow)) {
            return res.json({ ok: false, error: 'វិក្កយបត្រនេះត្រូវបានប្រើប្រាស់រួចហើយ (Duplicate Receipt)!' });
          }
        }
      }
      tx.bankTrxId = bankTrxId;
      tx.ftRef = ftRef;
      tx.paid_amount = ocrUSD;
      tx.recipient_verified = true;
      tx.ocr_text = ocrText.slice(0, 500);
      const approvedB = await approvePaymentByBillNo(tx.bill_no);
      if (approvedB.ok) {
        console.log(`[Verify Receipt] ✅ PAID via ABA receipt (Path B) bill=${tx.bill_no} trxId=${bankTrxId} ftRef=${ftRef} credited=$${approvedB.creditedAmount}`);
        return res.json({ ok: true, status: 'PAID', creditedAmount: approvedB.creditedAmount });
      }
      return res.json({ ok: false, error: 'មានបញ្ហាក្នុងការអនុម័តការទូទាត់!' });
    }

    // ── Emergency Admin Fallback: neither Path A nor Path B could verify the image ──
    if (receiptImageBase64) {
      try {
        const m2 = String(receiptImageBase64).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
        const imgBuffer = Buffer.from(m2 ? m2[2] : String(receiptImageBase64), 'base64');
        const user = db.users.find(u => String(u.id) === String(tx.user_id));
        const caption = `🆘 វិក្កយបត្រមិនច្បាស់ (OCR ផ្ទៀងផ្ទាត់មិនបាន)\n━━━━━━━━━━━━━━━━\n👤 User: ${user?.first_name || 'User'} (ID: ${tx.user_id})\n💰 តម្លៃត្រូវបង់៖ $${requiredPay.toFixed(2)}\n🧾 Bill No: <code>${tx.bill_no}</code>\n\n👉 សូមពិនិត្យរូបភាព រួចអនុម័ត៖`;
        await sendReceiptToAdmin(imgBuffer, `receipt_${tx.bill_no}.jpg`, caption, { inline_keyboard: [[
          { text: `✅ អនុម័តការបង់ប្រាក់ ($${requiredPay.toFixed(2)})`, callback_data: `approve_pay_${tx.bill_no}` }
        ]] });
      } catch (e) { console.error('[Verify Receipt] Admin fallback send failed:', e.message); }
    }
    return res.json({ ok: false, error: 'រូបភាពវិក្កយបត្រមិនច្បាស់លេខ Hash! សូមវាយលេខកូដ Hash ៨ ខ្ទង់ខាងក្រោម ឬរង់ចាំ Admin ពិនិត្យបន្តិច។' });
  } catch (e) {
    const httpStatus = e.response?.status || 'NO_RESPONSE';
    console.error(`[Verify Receipt] FAILED HTTP ${httpStatus}:`, e.message);
    return res.json({ ok: false, error: 'ប្រព័ន្ធ Bakong មិនទាន់រកឃើញប្រតិបត្តិការនេះទេ សូមពិនិត្យរូបភាពវិក្កយបត្រ ឬសាកល្បងម្ដងទៀត!' });
  }
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
      const credited = tx.type === 'vip' ? tx.amount : (tx.creditAmount || tx.amount);
      const userObj = db.users.find(u => String(u.id) === String(tx.user_id));
      if (userObj) {
        if (tx.type === 'topup') userObj.wallet_balance = parseFloat((parseFloat(userObj.wallet_balance) || 0) + credited);
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

