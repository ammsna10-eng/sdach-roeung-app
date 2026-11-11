const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { readDB, writeDB, getCurrentUser } = require('../db');

const BAKONG_TOKEN = process.env.BAKONG_TOKEN || '';
const BAKONG_ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID || '002111782@abaa';
const BAKONG_MERCHANT_NAME = process.env.BAKONG_MERCHANT_NAME || 'VEASNA CHAN';
const BAKONG_MERCHANT_CITY = process.env.BAKONG_MERCHANT_CITY || 'Phnom Penh';
const BAKONG_API_URL = 'https://api-bakong.nbc.gov.kh';

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

// Build KHQR string manually (EMV QR Code Spec - works with all Cambodian banking apps)
function buildKHQRString(amount, billNo) {
  const acct = BAKONG_ACCOUNT_ID;
  const name = BAKONG_MERCHANT_NAME;
  const city = BAKONG_MERCHANT_CITY;
  const amtStr = parseFloat(amount).toFixed(2);

  const bakongTag = '0010A000000440' + '0112' + acct;
  const merchantAcct = '29' + String(bakongTag.length).padStart(2, '0') + bakongTag;
  const billField = '01' + String(billNo.length).padStart(2, '0') + billNo;
  const addData = '62' + String(billField.length).padStart(2, '0') + billField;
  const nameField = '59' + String(name.length).padStart(2, '0') + name;
  const cityField = '60' + String(city.length).padStart(2, '0') + city;
  const amtField = '54' + String(amtStr.length).padStart(2, '0') + amtStr;

  const body = '000201' + merchantAcct + '52040000' + '5303840' + amtField +
    '5802KH' + nameField + cityField + addData + '6304';
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

    return res.json({ success: true, tran_id: tranId, amount: parseFloat(amountVal), qr_image: qrImageBase64 });
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

  if (BAKONG_TOKEN && tx.qr_md5) {
    try {
      const cr = await axios.post(`${BAKONG_API_URL}/v1/check_transaction_by_md5`,
        { md5: tx.qr_md5 },
        { headers: { 'Authorization': `Bearer ${BAKONG_TOKEN}` }, timeout: 8000 }
      );
      if (cr.data?.responseCode === 0 && cr.data?.data) {
        tx.status = 'completed'; tx.completed_at = new Date().toISOString();
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
        writeDB(db);
        return res.json({ tran_id: tx.tran_id, status: 'completed', amount: tx.amount });
      }
    } catch (e) { console.log('[Bakong Check]', e.message); }
  }
  return res.json({ tran_id: tx.tran_id, status: 'pending', amount: tx.amount });
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
      writeDB(db);
    }
    res.json({ status: 'received' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

