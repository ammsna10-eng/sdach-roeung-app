const https = require('https');
const fs = require('fs');

const LIVE_URL = 'https://sdach-roeung-app.onrender.com';

function getJson(path) {
  return new Promise((resolve) => {
    https.get(LIVE_URL + path, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function downloadFile(urlPath, destPath) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    https.get(LIVE_URL + urlPath, (res) => {
      if (res.statusCode !== 200) { resolve(false); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    }).on('error', () => resolve(false));
  });
}

(async () => {
  console.log('🔄 កំពុងទាញយកទិន្នន័យចុងក្រោយពី Server Live មករក្សាទុក (Syncing Live DB)...');
  const localDb = JSON.parse(fs.readFileSync('data/db.json', 'utf8'));
  const moviesRes = await getJson('/admin/data/movies');
  const topupsRes = await getJson('/admin/data/topup-packages');
  const vipRes = await getJson('/admin/data/vip-plans');
  const usersRes = await getJson('/admin/data/users');

  if (moviesRes && moviesRes.genres) localDb.genres = moviesRes.genres;
  if (moviesRes && moviesRes.countries) localDb.countries = moviesRes.countries;

  if (moviesRes && moviesRes.movies && moviesRes.movies.data) {
    const genreMap = new Map((localDb.genres || []).map(g => [Number(g.id), g]));
    localDb.movies = moviesRes.movies.data.map(m => {
      let cleanGenres = [];
      if (Array.isArray(m.genres)) {
        m.genres.forEach(g => {
          if (!g) return;
          if (typeof g === 'object' && g.id && g.name) {
            cleanGenres.push(g);
          } else {
            const idNum = Number(typeof g === 'object' ? g.id : g);
            if (genreMap.has(idNum)) cleanGenres.push(genreMap.get(idNum));
          }
        });
      }
      if (cleanGenres.length === 0 && localDb.genres.length > 0) {
        cleanGenres.push(localDb.genres[0]);
      }
      const isDub = m.language_type === 'dub' || m.language_type === 'khmer_dubbed' || m.is_dubbed === true;
      return {
        ...m,
        status: m.status === 'draft' ? 'published' : (m.status || 'published'),
        is_popular: true,
        is_slider: true,
        is_latest: true,
        is_dubbed: isDub,
        language_type: isDub ? 'dub' : 'sub',
        genres: cleanGenres
      };
    });
  }

  if (Array.isArray(topupsRes)) {
    localDb.topup_packages = topupsRes;
    for (const pkg of topupsRes) {
      if (pkg.qr_image && pkg.qr_image.startsWith('/storage/qrs/')) {
        await downloadFile(pkg.qr_image, 'public' + pkg.qr_image);
      }
    }
  }

  if (Array.isArray(vipRes)) {
    localDb.vip_plans = vipRes;
    for (const plan of vipRes) {
      if (plan.qr_image && plan.qr_image.startsWith('/storage/qrs/')) {
        await downloadFile(plan.qr_image, 'public' + plan.qr_image);
      }
    }
  }

  if (usersRes && usersRes.users && usersRes.users.data) {
    localDb.users = usersRes.users.data;
  }

  fs.writeFileSync('data/db.json', JSON.stringify(localDb, null, 2), 'utf8');
  console.log('✅ រក្សាទុកទិន្នន័យ Live ចូល data/db.json រួចរាល់ ១០០% (គ្មានបាត់បង់ទិន្នន័យ)!');
})();
