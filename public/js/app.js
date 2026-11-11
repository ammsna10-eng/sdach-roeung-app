// Sdach Roeung - State & Logic
const { createApp, ref, computed, onMounted, nextTick } = Vue;

const app = createApp({
  setup() {
    const activeTab = ref('home');
    const user = ref({
      id: 924441299,
      first_name: 'SnA',
      username: 'AmmSnA',
      photo_url: '/storage/logo/logo.png',
      wallet_balance: 5.0,
      is_vip: false,
      vip_expires_at: null
    });

    const movies = ref([]);
    const sliderMovies = ref([]);
    const popularMovies = ref([]);
    const dubbedMovies = ref([]);
    const seriesMovies = ref([]);
    const currentSlide = ref(0);

    const searchQuery = ref('');
    const selectedGenre = ref('all');
    const selectedLanguage = ref('all');

    const genres = ref([
      { id: 'all', name: 'ទាំងអស់ (All)' },
      { id: 1, name: '💥 វាយប្រហារ' },
      { id: 2, name: '😂 កំប្លែង' },
      { id: 3, name: '❤️ មនោសញ្ចេតនា' },
      { id: 4, name: '🔍 អាថ៌កំបាំង' },
      { id: 6, name: '⚔️ ទេវកថា' }
    ]);

    const selectedMovie = ref(null);
    const isDetailOpen = ref(false);
    const isPlayerOpen = ref(false);
    const activeStreamUrl = ref('');
    const isVideoBlocked = ref(false);
    const videoErrorMessage = ref('');
    const currentEpisode = ref(null);
    const movieSeasons = ref([]);
    const isPurchased = ref(false);
    const isBuying = ref(false);
    const purchasedMovies = ref([]);
    const continueWatching = ref([]); // [{ movie, currentTime, duration, percent, lastWatched }]

    const loadWatchHistory = () => {
      try {
        const raw = localStorage.getItem('sdach_watch_history_' + (user.value?.id || 'guest'));
        if (raw) {
          const list = JSON.parse(raw);
          // Sort by lastWatched descending (most recent first)
          list.sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0));
          continueWatching.value = list;
        }
      } catch (e) {}
    };

    const saveWatchProgress = (movie, currentTime, duration) => {
      if (!movie || !duration || duration <= 0) return;
      const percent = Math.min(100, Math.max(1, Math.round((currentTime / duration) * 100)));
      try {
        const key = 'sdach_watch_history_' + (user.value?.id || 'guest');
        let list = [];
        const raw = localStorage.getItem(key);
        if (raw) list = JSON.parse(raw);
        // Remove existing entry for this movie if any
        list = list.filter(item => item.movie?.id !== movie.id);
        // Prepend new entry to the front
        list.unshift({
          movie: {
            id: movie.id,
            title_kh: movie.title_kh,
            title_en: movie.title_en,
            poster_path: movie.poster_path,
            backdrop_path: movie.backdrop_path,
            rating: movie.rating,
            release_year: movie.release_year,
            type: movie.type,
            price: movie.price,
            video_url: movie.video_url,
            is_dubbed: movie.is_dubbed
          },
          currentTime: Math.floor(currentTime),
          duration: Math.floor(duration),
          percent: percent,
          lastWatched: Date.now()
        });
        // Keep max 20 entries
        if (list.length > 20) list = list.slice(0, 20);
        localStorage.setItem(key, JSON.stringify(list));
        continueWatching.value = list;
      } catch (e) {}
    };

    const formatDuration = (seconds) => {
      if (!seconds || isNaN(seconds)) return '0:00';
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      const h = Math.floor(m / 60);
      if (h > 0) {
        return h + ':' + (m % 60 < 10 ? '0' : '') + (m % 60) + ':' + (s < 10 ? '0' : '') + s;
      }
      return m + ':' + (s < 10 ? '0' : '') + s;
    };

    const adminTelegramLink = ref('https://t.me/AmmSnA');

    const topupPackages = ref([]);
    const vipPlans = ref([]);
    const isQrModalOpen = ref(false);
    const qrModalData = ref({});
    const notification = ref({ show: false, message: '', type: 'success' });

    const showNotify = (msg, type = 'success') => {
      notification.value = { show: true, message: msg, type };
      setTimeout(() => { notification.value.show = false; }, 3000);
    };

    const initTelegram = async () => {
      let tg = window.Telegram?.WebApp;
      if (tg) {
        try { tg.ready(); tg.expand(); } catch (e) {}
      }
      try {
        const res = await axios.post('/api/telegram-login', { initData: tg?.initData || '' });
        if (res.data && res.data.user) {
          user.value = {
            ...res.data.user,
            wallet_balance: parseFloat(res.data.wallet_balance || res.data.user.wallet_balance || 0),
            is_vip: Boolean(res.data.is_vip || res.data.user.is_vip)
          };
          localStorage.setItem('auth_token', res.data.token);
          axios.defaults.headers.common['Authorization'] = 'Bearer ' + res.data.token;
        }
      } catch (err) {}
    };

    const loadData = async () => {
      try {
        const [mRes, topRes, vipRes] = await Promise.all([
          axios.get('/api/user/movies'),
          axios.get('/api/user/topup-packages'),
          axios.get('/api/user/vip-plans')
        ]);
        if (mRes.data) {
          movies.value = mRes.data.all || [];
          sliderMovies.value = (mRes.data.slider && mRes.data.slider.length > 0) ? mRes.data.slider : (mRes.data.all || []).slice(0, 5);
          popularMovies.value = (mRes.data.popular && mRes.data.popular.length > 0) ? mRes.data.popular : (mRes.data.all || []);
          dubbedMovies.value = mRes.data.dubbed || [];
          seriesMovies.value = mRes.data.series || [];
          if (Array.isArray(mRes.data.genres) && mRes.data.genres.length > 0) {
            genres.value = [
              { id: 'all', name: 'ទាំងអស់ (All)' },
              ...mRes.data.genres.map(g => ({ id: g.id, name: g.name }))
            ];
          }
        }
        if (topRes.data) topupPackages.value = topRes.data;
        if (vipRes.data) vipPlans.value = vipRes.data;
        try {
          const meRes = await axios.get('/api/me');
          if (meRes.data && meRes.data.purchased_movies) {
            purchasedMovies.value = meRes.data.purchased_movies;
          }
        } catch (e) {}
      } catch (e) {}
    };

    const filteredMovies = computed(() => {
      return movies.value.filter(m => {
        const matchSearch = !searchQuery.value || 
          m.title_kh.toLowerCase().includes(searchQuery.value.toLowerCase()) ||
          (m.title_en && m.title_en.toLowerCase().includes(searchQuery.value.toLowerCase()));
        const matchGenre = selectedGenre.value === 'all' || 
          (Array.isArray(m.genres) && m.genres.some(g => g && (String(g.id) === String(selectedGenre.value) || String(g) === String(selectedGenre.value))));
        const matchLang = selectedLanguage.value === 'all' || 
          (selectedLanguage.value === 'dubbed' && m.is_dubbed) ||
          (selectedLanguage.value === 'sub' && !m.is_dubbed);
        return matchSearch && matchGenre && matchLang;
      });
    });

    const openMovie = async (movie) => {
      try {
        const res = await axios.get('/api/user/movies/' + movie.id);
        selectedMovie.value = res.data.movie || movie;
        isPurchased.value = Boolean(res.data.has_purchased || res.data.is_vip || user.value.is_vip);
        movieSeasons.value = res.data.movie.seasons || [];
      } catch (err) {
        selectedMovie.value = movie;
        isPurchased.value = user.value.is_vip || movie.access_type === 'free';
      }
      isDetailOpen.value = true;
    };

    const closePlayer = () => {
      isPlayerOpen.value = false;
      activeStreamUrl.value = '';
      isVideoBlocked.value = false;
      videoErrorMessage.value = '';
      const v = document.getElementById('sdach-video-player');
      if (v) {
        try { v.pause(); v.src = ''; } catch (e) {}
      }
    };

    const resumePlayback = () => {
      const v = document.getElementById('sdach-video-player');
      if (v) {
        v.play().then(() => {
          isVideoBlocked.value = false;
        }).catch(err => {
          console.warn('Playback resume failed:', err);
        });
      }
    };

    const onVideoError = (e) => {
      console.error('Video error:', e);
      const v = document.getElementById('sdach-video-player');
      const errCode = v?.error?.code;
      if (errCode === 4 || errCode === 2) {
        videoErrorMessage.value = 'មិនអាចចាក់វីដេអូបានទេ (ប្រភពវីដេអូមានបញ្ហា ឬទម្រង់មិនគាំទ្រ)';
      } else {
        videoErrorMessage.value = 'មានបញ្ហាក្នុងការទាញយកវីដេអូ សូមព្យាយាមម្ដងទៀត';
      }
    };

    const retryPlay = () => {
      videoErrorMessage.value = '';
      if (selectedMovie.value) {
        playMovie(selectedMovie.value, currentEpisode.value);
      }
    };

    const playTrailer = (movie) => {
      if (movie && movie.trailer_url && movie.trailer_url.trim()) {
        playMovie(movie, null, movie.trailer_url.trim());
      } else {
        showNotify('មិនទាន់មានវីដេអូ Trailer សម្រាប់រឿងនេះនៅឡើយទេ', 'info');
      }
    };

    const playMovie = async (movie, ep = null, customUrl = null) => {
      if (!movie) return;
      currentEpisode.value = ep;
      videoErrorMessage.value = '';
      isVideoBlocked.value = false;

      let url = customUrl || (ep ? ep.video_url : movie.video_url);

      // If video_url is missing on client, resolve it from stream endpoint
      if (!url && movie.id) {
        try {
          const endpoint = ep ? `/api/stream/movies/${movie.id}?episode_id=${ep.id}` : `/api/stream/movies/${movie.id}`;
          const sRes = await axios.get(endpoint);
          if (sRes.data && sRes.data.stream_url) {
            url = sRes.data.stream_url;
            if (ep) ep.video_url = url;
            else movie.video_url = url;
            if (selectedMovie.value && String(selectedMovie.value.id) === String(movie.id)) {
              selectedMovie.value.video_url = url;
            }
          }
        } catch (err) {
          if (err.response?.status === 403) {
            showNotify('សូមទិញរឿង ឬជាវ VIP ជាមុនសិនដើម្បីទស្សនា!', 'error');
            return;
          }
        }
      }

      if (!url) {
        showNotify('មិនទាន់មានវីដេអូសម្រាប់រឿងនេះនៅឡើយទេ', 'error');
        return;
      }

      activeStreamUrl.value = url;
      isPlayerOpen.value = true;

      nextTick(() => {
        const v = document.getElementById('sdach-video-player');
        if (v) {
          if (v.src !== url) {
            v.src = url;
          }

          const hist = continueWatching.value.find(item => String(item.movie?.id) === String(movie.id));
          if (hist && hist.currentTime > 5 && hist.percent < 95) {
            try { v.currentTime = hist.currentTime; } catch (e) {}
          }

          let lastSave = 0;
          v.ontimeupdate = () => {
            const now = Date.now();
            if (now - lastSave > 2500 && v.duration) {
              lastSave = now;
              saveWatchProgress(movie, v.currentTime, v.duration);
            }
          };

          v.onpause = () => {
            if (v.duration) saveWatchProgress(movie, v.currentTime, v.duration);
          };
          v.onended = () => {
            if (v.duration) saveWatchProgress(movie, v.duration, v.duration);
          };

          const playPromise = v.play();
          if (playPromise !== undefined) {
            playPromise.then(() => {
              isVideoBlocked.value = false;
            }).catch(err => {
              console.log('Autoplay deferred by browser policy:', err);
              isVideoBlocked.value = true;
            });
          }
        }
      });
    };

    const buyMovie = async (movie) => {
      if (user.value.wallet_balance < parseFloat(movie.price || 0.5)) {
        showNotify('សមតុល្យលុយមិនគ្រប់គ្រាន់ទេ! សូមបញ្ចូលប្រាក់។', 'error');
        return;
      }
      isBuying.value = true;
      try {
        const res = await axios.post('/api/user/movies/' + movie.id + '/purchase');
        user.value.wallet_balance = parseFloat(res.data.new_balance);
        isPurchased.value = true;

        const unlockedMovie = res.data.movie || { ...movie, video_url: res.data.video_url };
        if (res.data.video_url) {
          unlockedMovie.video_url = res.data.video_url;
        }

        // Update selectedMovie immediately with the unlocked movie object & video_url
        selectedMovie.value = { ...selectedMovie.value, ...unlockedMovie };
        if (unlockedMovie.seasons) {
          movieSeasons.value = unlockedMovie.seasons;
        }

        // Synchronize in-memory movies lists so any subsequent clicks don't miss video_url
        const syncList = (list) => {
          if (!Array.isArray(list)) return;
          const idx = list.findIndex(m => m && String(m.id) === String(movie.id));
          if (idx !== -1) {
            list[idx] = { ...list[idx], ...unlockedMovie };
          }
        };
        syncList(movies.value);
        syncList(sliderMovies.value);
        syncList(popularMovies.value);
        syncList(dubbedMovies.value);
        syncList(seriesMovies.value);

        if (!purchasedMovies.value.some(m => String(m.id) === String(movie.id))) {
          purchasedMovies.value.unshift(unlockedMovie);
        }

        showNotify(res.data.message || 'បានទិញជោគជ័យ! សូមរីករាយទស្សនា', 'success');

        // Immediately start playback without needing to clear app or reload
        playMovie(selectedMovie.value);
      } catch (e) {
        showNotify(e.response?.data?.message || 'មានបញ្ហាក្នុងការទិញ', 'error');
      } finally {
        isBuying.value = false;
      }
    };

    const openTopup = (pkg) => {
      qrModalData.value = {
        title: pkg.title,
        amount: pkg.price,
        getAmount: pkg.balance_amount,
        qr: pkg.qr_image || '/storage/logo/logo.png',
        isVip: false
      };
      isQrModalOpen.value = true;
    };

        const downloadQR = (url, filename) => {
      let tg = window.Telegram?.WebApp;
      let fullUrl = url.startsWith("http") ? url : window.location.origin + url;
      if (tg && typeof tg.downloadFile === "function") {
        tg.downloadFile({ url: fullUrl, file_name: filename }, (ok) => {
          if (!ok && tg.openLink) tg.openLink(fullUrl);
        });
        showNotify("បានទាញយករូបភាព QR រួចរាល់! 📥", "success");
        return;
      }
      const a = document.createElement("a");
      a.href = fullUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showNotify("បានទាញយករូបភាព QR រួចរាល់! 📥", "success");
    };

    const openVip = (plan) => {
      qrModalData.value = {
        title: plan.title,
        amount: plan.price,
        days: plan.duration_days,
        qr: plan.qr_image || '/storage/logo/logo.png',
        isVip: true
      };
      isQrModalOpen.value = true;
    };

    // Auto slide
    setInterval(() => {
      if (sliderMovies.value.length > 0) {
        currentSlide.value = (currentSlide.value + 1) % sliderMovies.value.length;
      }
    }, 4500);

    onMounted(async () => {
      await initTelegram();
      await loadData();
      loadWatchHistory();
    });

    return {
      activeTab, user, movies, sliderMovies, popularMovies, dubbedMovies, seriesMovies,
      currentSlide, searchQuery, selectedGenre, selectedLanguage, genres, filteredMovies,
      selectedMovie, isDetailOpen, isPlayerOpen, activeStreamUrl, isVideoBlocked, videoErrorMessage, currentEpisode, movieSeasons,
      isPurchased, isBuying, purchasedMovies, continueWatching, formatDuration, topupPackages, vipPlans, isQrModalOpen, qrModalData, notification,
      adminTelegramLink, showNotify, openMovie, playMovie, playTrailer, buyMovie, closePlayer, resumePlayback, retryPlay, onVideoError,
      openTopup, openVip, downloadQR, nextSlide, prevSlide, onTouchStart, onTouchEnd
    };
  }
});

app.mount('#app');
