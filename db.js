const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const localDb = require('./db.local');

const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = 'sdach_roeung';
const COLLECTION = 'app_state';
const DOC_ID = 'main_state';

let collection = null;
let lastCloudUpdatedAt = 0;
let syncTimer = null;
let pendingPayload = null;
let isSyncing = false;

function inlinePackageQrs(data) {
  if (!data || typeof data !== 'object') return data;
  const lists = [data.topup_packages, data.vip_plans];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item.qr_image === 'string' && item.qr_image.startsWith('/storage/')) {
        const rel = item.qr_image.replace(/^\/+/, '');
        const fullPath = path.join(__dirname, rel);
        try {
          if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            if (stat.size < 600 * 1024) {
              const ext = path.extname(fullPath).toLowerCase();
              const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
              const b64 = fs.readFileSync(fullPath).toString('base64');
              item.qr_image = 'data:' + mime + ';base64,' + b64;
            }
          }
        } catch (e) {}
      }
    }
  }
  return data;
}

async function flushToCloud() {
  if (!collection || !pendingPayload || isSyncing) return;
  isSyncing = true;
  const snapshot = pendingPayload;
  pendingPayload = null;
  try {
    const now = Date.now();
    await collection.updateOne(
      { _id: DOC_ID },
      { $set: { state: snapshot, updatedAt: now } },
      { upsert: true }
    );
    lastCloudUpdatedAt = now;
  } catch (err) {
    console.error('[MongoDB] Sync write error:', err.message);
    pendingPayload = snapshot;
  } finally {
    isSyncing = false;
    if (pendingPayload) scheduleCloudSync(pendingPayload);
  }
}

function scheduleCloudSync(data) {
  if (!MONGODB_URI) return;
  pendingPayload = JSON.parse(JSON.stringify(data));
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { flushToCloud(); }, 150);
}

function readDB() {
  return localDb.readDB();
}

function writeDB(data) {
  inlinePackageQrs(data);
  const res = localDb.writeDB(data);
  scheduleCloudSync(data);
  return res;
}

async function initCloudDB() {
  if (!MONGODB_URI) {
    console.log('[MongoDB] MONGODB_URI not set, using local data/db.json');
    return false;
  }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    collection = client.db(DB_NAME).collection(COLLECTION);
    const doc = await collection.findOne({ _id: DOC_ID });
    if (doc && doc.state && typeof doc.state === 'object') {
      inlinePackageQrs(doc.state);
      localDb.writeDB(doc.state);
      lastCloudUpdatedAt = doc.updatedAt || Date.now();
      console.log('[MongoDB] Loaded live cloud database into local cache');
    } else {
      const seed = inlinePackageQrs(localDb.readDB());
      localDb.writeDB(seed);
      const now = Date.now();
      await collection.updateOne(
        { _id: DOC_ID },
        { $set: { state: seed, updatedAt: now } },
        { upsert: true }
      );
      lastCloudUpdatedAt = now;
      console.log('[MongoDB] Seeded cloud database from local data/db.json');
    }

    // Keep multi-process (server.js & bot.js) synchronized every 10s
    setInterval(async () => {
      if (!collection || isSyncing || pendingPayload) return;
      try {
        const latest = await collection.findOne({ _id: DOC_ID }, { projection: { updatedAt: 1, state: 1 } });
        if (latest && latest.state && (latest.updatedAt || 0) > lastCloudUpdatedAt) {
          localDb.writeDB(latest.state);
          lastCloudUpdatedAt = latest.updatedAt;
        }
      } catch (e) {}
    }, 10000).unref();

    return true;
  } catch (err) {
    console.error('[MongoDB] Connection failed (using local fallback):', err.message);
    return false;
  }
}

module.exports = {
  ...localDb,
  readDB,
  writeDB,
  initCloudDB
};
