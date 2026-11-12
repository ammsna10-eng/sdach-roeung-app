const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { readDB, writeDB, getCurrentUser, recordTransaction } = require('../db');

/**
 * 🏦 Helper: Generate ABA PayWay Hash (HMAC-SHA512 or Base64)
 */
function getAbaHash(str, key) {
  return crypto.createHmac('sha512', key || '').update(str).digest('base64');
}

/**
 * 1️⃣ Create ABA KHQR / Payment Transaction
 * POST /api/payment/aba/create-qr
 */
router.post('/payment/aba/create-qr', async (req, res) => {
  try {
    const db = readDB();
    const user = getCurrentUser(req, db) || { id: 924441299, first_name: 'SnA' };
    const { amount, type, target_id } = req.body; // type: 'topup' | 'vip' | 'movie'

    const reqTime = Math.floor(Date.now() / 1000).toString();
    const tranId = `TRX_${Date.now()}_${user.id}`;
    const amountVal = parseFloat(amount || 1.0).toFixed(2);

    const apiKey = process.env.ABA_PAYWAY_API_KEY;
    const merchantId = process.env.ABA_PAYWAY_MERCHANT_ID;
    const apiUrl = process.env.ABA_PAYWAY_API_URL || 'https://checkout-sandbox.payway.com.kh/api/merchant-portal';

    // Save pending transaction to DB
    const newTx = {
      tran_id: tranId,
      user_id: user.id,
      amount: parseFloat(amountVal),
      type: type || 'topup',
      target_id: target_id || null,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    db.aba_transactions = db.aba_transactions || [];
    db.aba_transactions.push(newTx);
    writeDB(db);

    // If API Key is configured from ABA Bank
    if (apiKey && merchantId) {
      // String to hash according to ABA PayWay V2 documentation
      const hashStr = reqTime + merchantId + tranId + amountVal;
      const hash = getAbaHash(hashStr, apiKey);

      const abaRes = await axios.post(`${apiUrl}/api/payment-gateway/v1/payments/purchase`, {
        req_time: reqTime,
        merchant_id: merchantId,
        tran_id: tranId,
        amount: amountVal,
        hash: hash,
        type: 'purchase',
        payment_option: 'abapay_khqr'
      });

      return res.json({
        success: true,
        tran_id: tranId,
        qr_string: abaRes.data?.qr_string || null,
        qr_image: abaRes.data?.qr_image || null,
        status: 'pending'
      });
    }

    // Fallback/Simulated QR while waiting for ABA Merchant Approval
    return res.json({
      success: true,
      tran_id: tranId,
      amount: amountVal,
      qr_image: '/storage/qrs/qr_default.png',
      is_mock: true,
      message: 'កំពុងរង់ចាំ ABA API Key។ បច្ចុប្បន្នអាចស្កេនតាមរូបភាព QR ធម្មតាបាន។'
    });

  } catch (error) {
    console.error('ABA Create QR Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'បរាជ័យក្នុងការបង្កើត ABA Payment QR' });
  }
});

/**
 * 2️⃣ ABA Instant Webhook Callback (Auto-Deposit)
 * POST /api/payment/aba/callback
 */
router.post('/payment/aba/callback', (req, res) => {
  try {
    const { tran_id, status } = req.body;
    const db = readDB();
    const tx = (db.aba_transactions || []).find(t => t.tran_id === tran_id);

    if (tx && (status === '0' || status === 'APPROVED' || status === 0)) {
      tx.status = 'completed';
      tx.completed_at = new Date().toISOString();

      // Find user and auto update balance or VIP
      const user = db.users.find(u => String(u.id) === String(tx.user_id));
      if (user) {
        if (tx.type === 'topup') {
          user.wallet_balance = (user.wallet_balance || 0) + tx.amount;
        } else if (tx.type === 'vip') {
          user.is_vip = true;
          const exp = new Date();
          exp.setDate(exp.getDate() + 30);
          user.vip_expires_at = exp.toISOString();
        }
        recordTransaction(db, {
          userId: tx.user_id,
          telegramId: user.telegram_id || tx.user_id,
          type: tx.type === 'vip' ? 'VIP_PURCHASE' : 'TOPUP',
          title: tx.type === 'vip' ? 'ទិញកញ្ចប់ VIP ប្រចាំខែ' : 'បញ្ចូលទឹកប្រាក់ ABA PayWay',
          amount: tx.type === 'vip' ? -Math.abs(parseFloat(tx.amount) || 0) : Math.abs(parseFloat(tx.amount) || 0),
          status: 'PAID',
          billNo: tx.bill_no || tx.tran_id
        });
      }
      writeDB(db);
    }

    res.json({ status: 'success' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 3️⃣ Check Payment Status from Client
 * GET /api/payment/aba/check-status?tran_id=xxx
 */
router.get('/payment/aba/check-status', (req, res) => {
  const { tran_id } = req.query;
  const db = readDB();
  const tx = (db.aba_transactions || []).find(t => t.tran_id === tran_id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ tran_id: tx.tran_id, status: tx.status, amount: tx.amount });
});

module.exports = router;
