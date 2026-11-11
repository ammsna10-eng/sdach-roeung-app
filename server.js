const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Disable aggressive caching for API requests (especially critical for iOS Safari WebKit)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Client API routes
app.use('/api', require('./routes/client_user'));
app.use('/api', require('./routes/client_movies'));
app.use('/api', require('./routes/client_comments'));

app.use('/api', require('./routes/aba_payment'));
app.use('/api', require('./routes/bakong_payment'));

// Secure Database Export / Pre-flight Sync API
app.get('/api/export-db', (req, res) => {
  const secret = req.query.secret || req.headers['x-sync-secret'];
  const expectedSecret = process.env.SYNC_SECRET || 'sdach_db_sync_secret_2026_x9k2';
  const isAdmin = req.session && req.session.admin;
  if (!isAdmin && secret !== expectedSecret) {
    return res.status(403).json({ error: 'Unauthorized: Invalid sync secret' });
  }
  const { readDB } = require('./db');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="db_backup_${Date.now()}.json"`);
  res.send(JSON.stringify(readDB(), null, 2));
});

// Admin API routes
app.use('/admin', require('./routes/admin'));

// Admin Panel Web App (Vue bundle)
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path.startsWith('/admin') || req.path.startsWith('/super_admin'))) {
    // If it's an API request, let it pass to router
    if (req.path.startsWith('/admin/data')) {
      return next();
    }
    return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
  next();
});

// SPA catch-all route: any unhandled web request serves index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`👑 Sdach Roeung (ស្ដេចរឿង) Mini App & Admin Server Running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`📱 Mini App Preview: http://localhost:${PORT}/`);
  console.log(`⚙️  Admin Dashboard: http://localhost:${PORT}/admin/login`);
  console.log(`🔑 Admin Credentials:`);
  console.log(`   Email: admin@phsarroeung.com`);
  console.log(`   Password: admin123`);
  console.log(`===============================================`);
});
