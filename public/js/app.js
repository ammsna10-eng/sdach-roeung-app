// Sdach Roeung - State & Logic
const { createApp, ref, computed, onMounted, nextTick } = Vue;

const app = createApp({
  setup() {
    let plyrInstance = null;
    
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
            is_vip: Boolean(res.data.is_vip || res.data.user.is_vip),
            vip_expires_at: res.data.vip_expires_at || res.data.user.vip_expires_at || null
          };
          localStorage.setItem('auth_token', res.data.token);
          axios.defaults.headers.common['Authorization'] = 'Bearer ' + res.data.token;
        }
      } catch (err) {}
    };

    const formatVipExpire = (dateStr) => {
      if (!dateStr) return '';
      try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        const khmerMonths = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
        const day = String(d.getDate()).padStart(2, '0');
        const month = khmerMonths[d.getMonth()];
        const year = d.getFullYear();
        return `${day} ${month} ${year}`;
      } catch (e) {
        return dateStr;
      }
    };

    const getVipRemainingDays = (dateStr) => {
      if (!dateStr) return null;
      try {
        const diff = new Date(dateStr).getTime() - Date.now();
        if (diff <= 0) return 0;
        return Math.ceil(diff / (1000 * 60 * 60 * 24));
      } catch (e) {
        return null;
      }
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
          if (meRes.data) {
            if (meRes.data.user) {
              user.value = {
                ...user.value,
                ...meRes.data.user,
                wallet_balance: parseFloat(meRes.data.user.wallet_balance || 0),
                is_vip: Boolean(meRes.data.user.is_vip),
                vip_expires_at: meRes.data.user.vip_expires_at || null
              };
            }
            if (meRes.data.purchased_movies) {
              purchasedMovies.value = meRes.data.purchased_movies;
            }
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
      if (isMobileFullscreen.value) {
        exitMobileFullscreen();
      }
      if (plyrInstance) {
        if (plyrInstance.fullscreen && plyrInstance.fullscreen.active) {
          try { plyrInstance.fullscreen.exit(); } catch(e) {}
        }
        try { plyrInstance.stop(); } catch(e) {}
      }
      clearMobileFullscreenClasses();
      fitMode.value = 'cover';
      if (screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch (e) {}
      }
      isPlayerOpen.value = false;
      activeStreamUrl.value = '';
      videoErrorMessage.value = '';
      const tg = window.Telegram?.WebApp;
      if (tg?.exitFullscreen) {
        try { tg.exitFullscreen(); } catch (e) {}
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

    // ==========================================
    // Fullscreen Cross-Platform Logic (PC, Android, iOS)
    // ==========================================
    const isFullscreenLandscape = ref(false);
    const isMobileFullscreen = ref(false);
    const fitMode = ref('cover');

    const isMobileDevice = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const clearMobileFullscreenClasses = () => {
      const wrapper = document.getElementById('sdach-player-wrapper');
      if (wrapper) {
        wrapper.classList.remove('sdach-force-landscape', 'sdach-edge-fullscreen', 'sdach-fit-contain');
      }
    };

    const enterMobileFullscreen = () => {
      const wrapper = document.getElementById('sdach-player-wrapper');
      if (!wrapper) return;
      fitMode.value = 'cover';
      wrapper.classList.remove('sdach-fit-contain');
      if (window.innerHeight > window.innerWidth) {
        // Portrait: CSS 90-degree rotation fallback (system Auto-Rotate may be OFF in Telegram WebView)
        wrapper.classList.add('sdach-force-landscape');
        wrapper.classList.remove('sdach-edge-fullscreen');
      } else {
        // Already landscape: pure edge-to-edge expansion (zero black bars)
        wrapper.classList.add('sdach-edge-fullscreen');
        wrapper.classList.remove('sdach-force-landscape');
      }
      isMobileFullscreen.value = true;
      isFullscreenLandscape.value = true;
      const tg = window.Telegram?.WebApp;
      if (tg?.requestFullscreen) {
        try { tg.requestFullscreen(); } catch (e) {}
      }
      // Best-effort only: fails silently when system Auto-Rotate is OFF
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    };

    const exitMobileFullscreen = () => {
      isMobileFullscreen.value = false;
      isFullscreenLandscape.value = false;
      clearMobileFullscreenClasses();
      const tg = window.Telegram?.WebApp;
      if (tg?.exitFullscreen) {
        try { tg.exitFullscreen(); } catch (e) {}
      }
      if (screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch (e) {}
      }
    };

    const toggleMobileFullscreen = () => {
      if (isMobileFullscreen.value) {
        exitMobileFullscreen();
      } else {
        enterMobileFullscreen();
      }
    };

    const toggleFitMode = () => {
      const wrapper = document.getElementById('sdach-player-wrapper');
      fitMode.value = fitMode.value === 'cover' ? 'contain' : 'cover';
      if (wrapper) {
        wrapper.classList.toggle('sdach-fit-contain', fitMode.value === 'contain');
      }
    };

    // Alias kept for window.vueApp backward compatibility
    const toggleFullscreen = toggleMobileFullscreen;

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
        if (!v) return;

        if (!plyrInstance) {
          plyrInstance = new Plyr(v, {
            controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'fullscreen'],
            fullscreen: { enabled: true, fallback: 'force', iosNative: false },
            seekTime: 5,
            keyboard: { focused: true, global: true },
            tooltips: { controls: false, seek: true }
          });

          // Fullscreen state sync (safety net if Plyr's own fullscreen ever engages)
          plyrInstance.on('enterfullscreen', () => {
            if (isMobileDevice()) {
              enterMobileFullscreen();
            } else {
              isFullscreenLandscape.value = true;
            }
          });
          plyrInstance.on('exitfullscreen', () => {
            if (isMobileDevice()) {
              exitMobileFullscreen();
            } else {
              isFullscreenLandscape.value = false;
            }
          });

          // Watch history sync
          plyrInstance.on('timeupdate', () => {
            if (plyrInstance.currentTime && plyrInstance.duration) {
              saveWatchProgress(movie, plyrInstance.currentTime, plyrInstance.duration);
            }
          });

          // YouTube-Style Double Tap / Double Click Seek Handlers
          let seekBadgeTimer = null;
          const triggerSeekBadge = (dir) => {
            const el = document.getElementById(dir === 'backward' ? 'sdach-seek-left' : 'sdach-seek-right');
            const other = document.getElementById(dir === 'backward' ? 'sdach-seek-right' : 'sdach-seek-left');
            if (other) other.classList.remove('seek-badge-pop');
            if (el) {
              clearTimeout(seekBadgeTimer);
              el.classList.add('seek-badge-pop');
              seekBadgeTimer = setTimeout(() => {
                el.classList.remove('seek-badge-pop');
              }, 600);
            }
          };

          const handleSeekAction = (clientX, clientY) => {
            const wrapper = document.getElementById('sdach-player-wrapper');
            if (!wrapper || !plyrInstance) return;

            const isRotated = wrapper.classList.contains('sdach-force-landscape');
            let isLeft = false;

            if (isRotated) {
              // In 90deg clockwise rotation, top of viewport is the left side of the video
              isLeft = clientY < window.innerHeight / 2;
            } else {
              const rect = wrapper.getBoundingClientRect();
              isLeft = clientX < (rect.left + rect.width / 2);
            }

            if (isLeft) {
              plyrInstance.currentTime = Math.max(0, plyrInstance.currentTime - 5);
              triggerSeekBadge('backward');
            } else {
              plyrInstance.currentTime = Math.min(plyrInstance.duration || 999999, plyrInstance.currentTime + 5);
              triggerSeekBadge('forward');
            }
          };

          // Intercept double-click for desktop
          const wrapperEl = document.getElementById('sdach-player-wrapper');
          if (wrapperEl) {
            wrapperEl.addEventListener('dblclick', (e) => {
              if (e.target.closest('.plyr__controls') || e.target.closest('button')) return;
              e.stopPropagation();
              e.preventDefault();
              handleSeekAction(e.clientX, e.clientY);
            }, true);

            // Double-tap handler for touch devices (Mobile)
            let lastTap = 0;
            let tapX = 0;
            let tapY = 0;
            wrapperEl.addEventListener('touchend', (e) => {
              if (e.target.closest('.plyr__controls') || e.target.closest('button')) return;
              const touch = e.changedTouches ? e.changedTouches[0] : null;
              if (!touch) return;

              const now = Date.now();
              const timeDiff = now - lastTap;
              const dist = Math.hypot(touch.clientX - tapX, touch.clientY - tapY);

              if (timeDiff < 320 && dist < 45) {
                e.preventDefault();
                e.stopPropagation();
                lastTap = 0;
                handleSeekAction(touch.clientX, touch.clientY);
              } else {
                lastTap = now;
                tapX = touch.clientX;
                tapY = touch.clientY;
              }
            }, { passive: false });
          }
        }

        // Set the new video source
        plyrInstance.source = {
          type: 'video',
          sources: [{ src: url, type: 'video/mp4' }]
        };

        // Restore watch history position
        const hist = continueWatching.value.find(item => String(item.movie?.id) === String(movie.id));
        if (hist && hist.currentTime > 5 && hist.percent < 95) {
          plyrInstance.currentTime = hist.currentTime;
        }

        // Auto-play
        setTimeout(() => {
          plyrInstance.play().catch(e => console.log('Autoplay deferred:', e));
        }, 100);
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

        selectedMovie.value = { ...selectedMovie.value, ...unlockedMovie };
        if (unlockedMovie.seasons) {
          movieSeasons.value = unlockedMovie.seasons;
        }

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
        playMovie(selectedMovie.value);
      } catch (e) {
        showNotify(e.response?.data?.message || 'មានបញ្ហាក្នុងការទិញ', 'error');
      } finally {
        isBuying.value = false;
      }
    };

    let paymentPollingInterval = null;

    const clearPaymentPolling = () => {
      if (paymentPollingInterval) {
        clearInterval(paymentPollingInterval);
        paymentPollingInterval = null;
      }
    };

    const generateBakongQR = async (amount, type, targetId = null) => {
      qrModalData.value = { ...qrModalData.value, loading: true, qr_image: null, paymentStatus: null };
      isQrModalOpen.value = true;
      try {
        const res = await axios.post('/api/payment/bakong/create-qr', {
          amount: amount,
          type: type,
          target_id: targetId
        });
        if (res.data && res.data.success) {
          qrModalData.value = {
            ...qrModalData.value,
            loading: false,
            qr_image: res.data.qr_image,
            tran_id: res.data.tran_id,
            amount: amount,
            paymentStatus: 'checking'
          };
          clearPaymentPolling();
          paymentPollingInterval = setInterval(async () => {
            try {
              const checkRes = await axios.get('/api/payment/bakong/check-status?tran_id=' + res.data.tran_id);
              if (checkRes.data.status === 'completed') {
                clearPaymentPolling();
                qrModalData.value.paymentStatus = 'success';
                try {
                  const meRes = await axios.get('/api/me');
                  if (meRes.data && meRes.data.user) {
                    user.value = {
                      ...user.value,
                      ...meRes.data.user,
                      wallet_balance: parseFloat(meRes.data.user.wallet_balance || 0),
                      is_vip: Boolean(meRes.data.user.is_vip),
                      vip_expires_at: meRes.data.user.vip_expires_at || null
                    };
                  }
                } catch(e) {}
                showNotify('✅ ការទូទាត់ជោគជ័យ! គណនីបានធ្វើបច្ចុប្បន្នភាពហើយ!', 'success');
                setTimeout(() => { isQrModalOpen.value = false; }, 3000);
              } else if (checkRes.data.status === 'failed') {
                clearPaymentPolling();
                qrModalData.value.paymentStatus = 'failed';
                qrModalData.value.paymentError = 'ការទូទាត់បរាជ័យ ឬទឹកប្រាក់មិនត្រឹមត្រូវ!';
              }
            } catch(e) {}
          }, 4000);
        } else {
          qrModalData.value.loading = false;
          qrModalData.value.paymentStatus = 'failed';
          qrModalData.value.paymentError = res.data.message || 'មិនអាចបង្កើត QR បានទេ!';
        }
      } catch(err) {
        qrModalData.value.loading = false;
        qrModalData.value.paymentStatus = 'failed';
        qrModalData.value.paymentError = 'មានបញ្ហាក្នុងការភ្ជាប់ Server!';
      }
    };

    const downloadQR = () => {
      if (!qrModalData.value.qr_image) {
        showNotify('មិនមាន QR Code ដើម្បីរក្សាទុក!', 'error');
        return;
      }
      try {
        const link = document.createElement('a');
        link.href = qrModalData.value.qr_image;
        link.download = `KHQR_${qrModalData.value.amount || 0}USD_${Date.now()}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showNotify('រក្សាទុករូបភាព QR ជោគជ័យ!', 'success');
      } catch(err) {
        showNotify('មានបញ្ហាក្នុងការរក្សាទុករូបភាព!', 'error');
      }
    };

    const openTopup = (pkg) => {
      qrModalData.value = {
        title: pkg.title || 'បញ្ចូលប្រាក់',
        amount: pkg.price,
        loading: true,
        paymentStatus: null
      };
      generateBakongQR(pkg.price, 'topup');
    };

    const openVip = (plan) => {
      qrModalData.value = {
        title: plan.title || 'ជាវ VIP',
        amount: plan.price,
        days: plan.duration_days,
        loading: true,
        paymentStatus: null
      };
      generateBakongQR(plan.price, 'vip');
    };

    const nextSlide = () => {
      if (sliderMovies.value.length > 0) {
        currentSlide.value = (currentSlide.value + 1) % sliderMovies.value.length;
      }
    };

    const prevSlide = () => {
      if (sliderMovies.value.length > 0) {
        currentSlide.value = (currentSlide.value - 1 + sliderMovies.value.length) % sliderMovies.value.length;
      }
    };

    let touchStartX = 0;
    let touchEndX = 0;

    const onTouchStart = (e) => {
      touchStartX = e.changedTouches ? e.changedTouches[0].screenX : 0;
    };

    const onTouchEnd = (e) => {
      touchEndX = e.changedTouches ? e.changedTouches[0].screenX : 0;
      const swipeDistance = touchEndX - touchStartX;
      if (Math.abs(swipeDistance) > 40) {
        if (swipeDistance < 0) {
          nextSlide();
        } else {
          prevSlide();
        }
      }
    };

    // Auto slide
    setInterval(() => {
      nextSlide();
    }, 4500);

    onMounted(async () => {
      await initTelegram();
      await loadData();
      loadWatchHistory();

      // Listener សម្រាប់ auto-exit ពេល user ចុច Back Button លើ Mobile ឬចុច ESC លើ PC
      document.addEventListener('fullscreenchange', () => {
        isFullscreenLandscape.value = !!document.fullscreenElement;
        if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) {
          try { screen.orientation.unlock(); } catch (e) {}
        }
      });
      document.addEventListener('webkitfullscreenchange', () => {
        isFullscreenLandscape.value = !!document.webkitFullscreenElement;
        if (!document.webkitFullscreenElement && screen.orientation && screen.orientation.unlock) {
          try { screen.orientation.unlock(); } catch (e) {}
        }
      });

      // Orientation change handler: smoothly swap between CSS rotation and edge-to-edge
      // when the user physically tilts their phone (Mobile fullscreen only)
      window.addEventListener('resize', () => {
        if (!isMobileDevice() || !isMobileFullscreen.value) return;
        const wrapper = document.getElementById('sdach-player-wrapper');
        if (!wrapper) return;
        const isPortrait = window.innerHeight > window.innerWidth;
        wrapper.classList.toggle('sdach-force-landscape', isPortrait);
        wrapper.classList.toggle('sdach-edge-fullscreen', !isPortrait);
      });

      // Intercept Plyr's fullscreen button on Mobile: bypass native fullscreen and use
      // tg.requestFullscreen() + CSS edge-to-edge instead. Desktop clicks pass through untouched.
      document.addEventListener('click', (e) => {
        if (!isMobileDevice() || !isPlayerOpen.value) return;
        const btn = e.target.closest('[data-plyr="fullscreen"]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        toggleMobileFullscreen();
      }, true);

      // Deep link support from Telegram broadcast notifications
      try {
        const urlParams = new URLSearchParams(window.location.search);
        let targetMovieId = urlParams.get('movie');
        const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
        if (!targetMovieId && startParam && startParam.startsWith('movie_')) {
          targetMovieId = startParam.replace('movie_', '');
        }
        if (targetMovieId) {
          const m = movies.value.find(item => String(item.id) === String(targetMovieId));
          if (m) {
            openMovie(m);
          }
        }
      } catch (err) {
        console.warn('Deep link detection error:', err);
      }
    });

    return {
      activeTab, user, movies, sliderMovies, popularMovies, dubbedMovies, seriesMovies,
      currentSlide, searchQuery, selectedGenre, selectedLanguage, genres, filteredMovies,
      selectedMovie, isDetailOpen, isPlayerOpen, activeStreamUrl, isVideoBlocked, videoErrorMessage, currentEpisode, movieSeasons,
      isPurchased, isBuying, purchasedMovies, continueWatching, formatDuration, topupPackages, vipPlans, isQrModalOpen, qrModalData, notification,
      adminTelegramLink, showNotify, openMovie, playMovie, playTrailer, buyMovie, closePlayer, resumePlayback, retryPlay, onVideoError,
      openTopup, openVip, nextSlide, prevSlide, onTouchStart, onTouchEnd,
      formatVipExpire, getVipRemainingDays,
      isFullscreenLandscape, isMobileFullscreen, fitMode, toggleFitMode, toggleFullscreen, clearPaymentPolling, downloadQR
    };
  }
});

const mountedApp = app.mount('#app');

// Expose app methods to window for debugging and fallback inline handlers
window.vueApp = {
  toggleFullscreen: () => {
    console.log('[Window] toggleFullscreen called via window.vueApp');
    if (mountedApp && mountedApp.toggleFullscreen) {
      mountedApp.toggleFullscreen();
    } else {
      console.error('[Window] toggleFullscreen not found in Vue instance');
    }
  },
  isFullscreenLandscape: () => mountedApp?.isFullscreenLandscape || false
};

console.log('[Vue] App mounted successfully, window.vueApp exposed:', window.vueApp);