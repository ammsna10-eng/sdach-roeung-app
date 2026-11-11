const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Load environment variables if .env exists
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.substring(0, idx).trim();
        const val = trimmed.substring(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  });
}

const SERVER_URL = process.env.LIVE_APP_URL || process.env.WEBAPP_URL || 'https://sdach-roeung-app.onrender.com';
const SYNC_SECRET = process.env.SYNC_SECRET || 'sdach_db_sync_secret_2026_x9k2';
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');

async function syncDatabase() {
  console.log(`[SYNC] Connecting to live server: ${SERVER_URL} ...`);
  
  const targetUrl = new URL(`/api/export-db?secret=${SYNC_SECRET}`, SERVER_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;

  const data = await new Promise((resolve, reject) => {
    client.get(targetUrl.href, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Server responded with status HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve(raw));
    }).on('error', reject);
  });

  let liveDB;
  try {
    liveDB = JSON.parse(data);
  } catch (err) {
    throw new Error(`Failed to parse live server response as JSON: ${err.message}`);
  }

  if (!liveDB.movies || !Array.isArray(liveDB.movies)) {
    throw new Error('Invalid database format received from live server: missing movies array');
  }

  // Backup current local DB first
  if (fs.existsSync(DB_PATH)) {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const backupFile = path.join(BACKUP_DIR, `db_backup_${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, backupFile);
    console.log(`[SYNC] Local database safely backed up to: ${path.relative(process.cwd(), backupFile)}`);
  }

  // Read local DB to compare
  let localMovieCount = 0;
  if (fs.existsSync(DB_PATH)) {
    try {
      const local = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      localMovieCount = (local.movies || []).length;
    } catch (_) {}
  }

  // Write new live DB to data/db.json
  fs.writeFileSync(DB_PATH, JSON.stringify(liveDB, null, 2), 'utf8');
  
  console.log(`[SYNC] SUCCESS! Database synced from production server.`);
  console.log(`[SYNC] Movies on Live: ${liveDB.movies.length} (Previous local: ${localMovieCount})`);
  console.log(`[SYNC] Users count: ${(liveDB.users || []).length}, Admins: ${(liveDB.admins || []).length}`);
  console.log(`[SYNC] Movies list:`);
  liveDB.movies.forEach((m, idx) => {
    console.log(`   ${idx + 1}. [ID: ${m.id}] ${m.title_kh} (${m.title_en || 'No English Title'})`);
  });
}

syncDatabase().catch(err => {
  console.error(`[SYNC WARNING] Could not sync with live server: ${err.message}`);
  console.error(`[SYNC WARNING] Keeping existing local database.`);
  process.exit(0); // Exit smoothly without failing build if server is sleeping
});
