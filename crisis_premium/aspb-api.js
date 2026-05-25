(function () {
  const API = window.location.protocol === 'file:' ? 'http://127.0.0.1:5174/api' : '/api';
  const urlToken = new URLSearchParams(window.location.search).get('token') || '';
  const allowLocalTokenStorage = window.location.protocol === 'file:' || ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const storage = {
    get(key) {
      try {
        if (key === 'crisisPremiumToken' && !allowLocalTokenStorage) return '';
        return window.localStorage.getItem(key);
      } catch {
        return '';
      }
    },
    set(key, value) {
      try {
        if (key === 'crisisPremiumToken' && !allowLocalTokenStorage) return;
        window.localStorage.setItem(key, value);
      } catch {
        // File previews can block storage; registration still works through the API response.
      }
    }
  };
  const storedToken = storage.get('crisisPremiumToken') || '';
  const token = urlToken || storedToken;
  let serverTimeOffset = 0;
  let webinarConfig = null;

  if (urlToken) {
    storage.set('crisisPremiumToken', urlToken);
  }

  function utm() {
    const params = new URLSearchParams(window.location.search);
    return {
      source: params.get('source') || document.referrer || 'direct',
      utmSource: params.get('utm_source') || '',
      utmMedium: params.get('utm_medium') || '',
      utmCampaign: params.get('utm_campaign') || '',
      utmContent: params.get('utm_content') || '',
      utmTerm: params.get('utm_term') || ''
    };
  }

  async function post(path, body) {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Ошибка запроса');
    }

    return response.json();
  }

  async function getJson(path) {
    const response = await fetch(`${API}${path}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Ошибка запроса');
    }
    return payload;
  }

  function track(eventName, metadata) {
    post('/events', {
      eventName,
      token,
      page: window.location.pathname,
      metadata,
      ...utm()
    }).catch(() => {});
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

	  function startCountdown(scheduledAt) {
	    const target = new Date(scheduledAt).getTime();
    const nodes = {
      days: document.querySelector('[data-countdown-days]'),
      hours: document.querySelector('[data-countdown-hours]'),
      minutes: document.querySelector('[data-countdown-minutes]'),
      seconds: document.querySelector('[data-countdown-seconds]')
    };

    if (!nodes.days && !document.getElementById('countdown')) {
      return;
    }

    function tick() {
	      const diff = Math.max(0, target - (Date.now() + serverTimeOffset));
      const total = Math.floor(diff / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;

      if (nodes.days) nodes.days.textContent = pad(days);
      if (nodes.hours) nodes.hours.textContent = pad(hours);
      if (nodes.minutes) nodes.minutes.textContent = pad(minutes);
      if (nodes.seconds) nodes.seconds.textContent = pad(seconds);

      const compact = document.getElementById('countdown');
      if (compact) {
        compact.innerHTML = `<span>${pad(hours + days * 24)}</span>:<span>${pad(minutes)}</span>:<span>${pad(seconds)}</span>`;
      }
    }

    tick();
    window.setInterval(tick, 1000);
  }

  async function hydrateCurrentWebinar() {
    try {
      const data = await getJson('/webinar/current');
      if (!data.ok) return;
      serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
      startCountdown(data.scheduledAt);
      updateTelegramLinks(data.telegramUrl);
    } catch {
      // Static preview still works without backend.
    }
  }

  function updateTelegramLinks(url) {
    if (!url) return;
    document.querySelectorAll('a[href*="t.me"]').forEach(link => {
      if (link.dataset.telegramBotLink === 'true') return;
      link.setAttribute('href', url);
    });
  }

  function bindTelegramTracking() {
    document.querySelectorAll('a[href*="t.me"]').forEach(link => {
      link.addEventListener('click', () => {
        post('/telegram-click', { token, page: window.location.pathname }).catch(() => {});
      });
    });
  }

  function bindRegistrationClicks() {
    document.querySelectorAll('a[href*="register.html"]').forEach(link => {
      link.addEventListener('click', () => track('registration_click'));
    });
  }

  async function handleRegistrationSubmit(event, formOverride) {
    if (event && event.__aspbHandled) return false;
    if (event) {
      event.__aspbHandled = true;
      event.preventDefault();
    }

    const form = formOverride || document.getElementById('registrationForm');
    if (!form) return false;

    const button = form.querySelector('button[type="submit"]');
    const originalText = button ? button.textContent : '';
    const data = new FormData(form);
    const clients = form.querySelector('input[name="clients"]:checked');
    const consent = form.querySelector('input[name="consent"]');

    if (consent && !consent.checked) {
      alert('Пожалуйста, подтвердите согласие на обработку персональных данных.');
      return false;
    }

    if (button) {
      button.textContent = 'Отправляем...';
      button.disabled = true;
    }

    try {
      track('registration_form_open');
      const result = await post('/register', {
        name: data.get('name'),
        phone: data.get('phone'),
        email: data.get('email'),
        city: data.get('city') || '',
        professionalStatus: data.get('professionalStatus'),
        clientsProblem: clients ? clients.value : '',
        consent: data.get('consent') === 'true' || data.get('consent') === 'on',
        ...utm()
      });

      storage.set('crisisPremiumRegistered', 'true');
      if (result.token) {
        storage.set('crisisPremiumToken', result.token);
      }
      window.location.href = result.successUrl;
    } catch (error) {
      alert(error.message || 'Не удалось отправить регистрацию');
      if (button) {
        button.textContent = originalText;
        button.disabled = false;
      }
    }
    return false;
  }

  window.ASPBRegisterSubmit = handleRegistrationSubmit;

  function bindRegistrationForm() {
    const form = document.getElementById('registrationForm');
    if (!form || form.dataset.aspbBound === 'true') return;

    form.dataset.aspbBound = 'true';
    form.addEventListener('submit', event => {
      handleRegistrationSubmit(event, form);
    });
  }

  function registrationStatePath(view) {
    const query = view ? `?view=${encodeURIComponent(view)}` : '';
    if (token) {
      return `/registration/${encodeURIComponent(token)}${query}`;
    }
    return `/registration/session/current${query}`;
  }

  function timelinePath() {
    if (token) {
      return `/webinar/timeline/${encodeURIComponent(token)}`;
    }
    return '/webinar/timeline/session/current';
  }

  function getRegistrationState(view) {
    return getJson(registrationStatePath(view));
  }

  async function hydrateSuccessPage() {
    if (!window.location.pathname.endsWith('success.html')) return;

    try {
      const data = await getRegistrationState('success');
      if (!data.ok) return;
      serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
      updateTelegramLinks(data.telegramUrl);
      const telegramLink = document.getElementById('successTelegramLink');
      if (telegramLink) {
        telegramLink.setAttribute('href', data.telegramBotUrl || data.telegramUrl);
      }
      const roomLink = document.getElementById('successRoomLink') || document.querySelector('a[href*="webinar.html"]');
      if (roomLink) roomLink.setAttribute('href', token ? `webinar.html?token=${encodeURIComponent(token)}` : 'webinar.html');
      const dateNode = document.getElementById('successWebinarDate');
      if (dateNode) {
        dateNode.textContent = new Intl.DateTimeFormat('ru-RU', {
          timeZone: 'Europe/Moscow',
          day: '2-digit',
          month: 'long',
          hour: '2-digit',
          minute: '2-digit'
        }).format(new Date(data.webinar.scheduledAt));
      }
    } catch {
      // Keep static success page readable.
    }
  }

  function renderLockedRoom(message) {
    document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;background:#f8f9fa;color:#041627;font-family:Manrope,Arial,sans-serif;padding:24px">
        <section style="max-width:560px;background:#fff;border:1px solid #d2e4fb;border-radius:24px;padding:36px;text-align:center;box-shadow:0 24px 70px rgba(4,22,39,.08)">
          <h1 style="font-size:32px;margin:0 0 12px">Вход в комнату по персональной ссылке</h1>
          <p style="font-size:18px;color:#44474c;line-height:1.55">${message}</p>
          <a href="register.html" style="display:inline-flex;margin-top:20px;background:#041627;color:#fff;text-decoration:none;padding:16px 24px;border-radius:14px;font-weight:700">Зарегистрироваться</a>
        </section>
	      </main>`;
	  }

  function formatMoscowDateTime(value) {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  }

  function renderWaitingRoom(data) {
    const title = data.accessStatus === 'expired' ? 'Доступ к записи завершен' : 'Эфир еще не начался';
    const text =
      data.accessStatus === 'expired'
        ? 'Срок доступа к записи по этой персональной ссылке истек. Если вам нужна помощь, оставьте новую заявку через регистрацию.'
        : `Вы зарегистрированы. Комната откроется автоматически к началу эфира: ${formatMoscowDateTime(data.webinar.scheduledAt)} МСК.`;
    const action =
      data.accessStatus === 'expired'
        ? '<a href="register.html" style="display:inline-flex;margin-top:20px;background:#041627;color:#fff;text-decoration:none;padding:16px 24px;border-radius:14px;font-weight:700">Зарегистрироваться заново</a>'
        : '<a href="success.html" style="display:inline-flex;margin-top:20px;background:#d2e4fb;color:#041627;text-decoration:none;padding:16px 24px;border-radius:14px;font-weight:800">Проверить регистрацию</a>';

    document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;background:#f8f9fa;color:#041627;font-family:Manrope,Arial,sans-serif;padding:24px">
        <section style="max-width:640px;background:#fff;border:1px solid #d2e4fb;border-radius:24px;padding:36px;text-align:center;box-shadow:0 24px 70px rgba(4,22,39,.08)">
          <p style="margin:0 0 10px;color:#4f6073;font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:12px">АСПБ автовебинар</p>
          <h1 style="font-size:34px;margin:0 0 12px">${title}</h1>
          <p style="font-size:18px;color:#44474c;line-height:1.55;margin:0">${text}</p>
          ${
            data.accessStatus === 'waiting'
              ? '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:24px"><div style="background:#f3f4f5;border-radius:16px;padding:14px"><strong data-countdown-days style="font-size:28px">00</strong><br><span>дней</span></div><div style="background:#f3f4f5;border-radius:16px;padding:14px"><strong data-countdown-hours style="font-size:28px">00</strong><br><span>часов</span></div><div style="background:#f3f4f5;border-radius:16px;padding:14px"><strong data-countdown-minutes style="font-size:28px">00</strong><br><span>минут</span></div><div style="background:#f3f4f5;border-radius:16px;padding:14px"><strong data-countdown-seconds style="font-size:28px">00</strong><br><span>секунд</span></div></div>'
              : ''
          }
          ${action}
        </section>
      </main>`;

    if (data.accessStatus === 'waiting') {
      startCountdown(data.webinar.scheduledAt);
    }
  }

  async function hydrateWebinarRoom() {
    if (!window.location.pathname.endsWith('webinar.html')) return;

    try {
      const data = await getRegistrationState('room');
      if (!data.ok || !data.canEnterRoom) {
        if (data.accessStatus === 'waiting' || data.accessStatus === 'expired') {
          serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
          renderWaitingRoom(data);
          return;
        }
        renderLockedRoom('Доступ к этой комнате закрыт или ссылка недействительна.');
        return;
      }

      // Calculate server time offset to sync playback accurately
      const serverTime = new Date(data.serverTime).getTime();
      serverTimeOffset = serverTime - Date.now();

      webinarConfig = {
	        scheduledAt: new Date(data.webinar.scheduledAt).getTime(),
	        status: data.accessStatus === 'replay' ? 'replay' : data.webinar.status,
	        durationMinutes: data.webinar.durationMinutes
	      };

      updateTelegramLinks(data.telegramUrl);
      startCountdown(data.webinar.scheduledAt);
	      updateRoomStatus({ ...data.webinar, accessStatus: data.accessStatus, replayExpiresAt: data.replayExpiresAt });
	      await hydrateTimeline();
    } catch {
      renderLockedRoom('Не удалось проверить доступ. Попробуйте открыть ссылку из письма еще раз.');
    }
  }

  function updateRoomStatus(webinar) {
    const node = document.getElementById('webinarStatusText');
    if (!node || !webinar) return;
	    if (webinar.accessStatus === 'live' || webinar.status === 'live') {
	      node.textContent = 'Эфир идет. Включайте запись и следите за подсказками АСПБ.';
	    } else if (webinar.accessStatus === 'replay' || webinar.status === 'finished') {
	      const expires = webinar.replayExpiresAt ? ` Доступ к записи открыт до ${formatMoscowDateTime(webinar.replayExpiresAt)} МСК.` : '';
	      node.textContent = `Эфир завершен, но запись доступна по вашей персональной ссылке.${expires} Посмотрите ключевые блоки и оставьте заявку, если узнали своих клиентов.`;
    } else {
      const date = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(webinar.scheduledAt));
      node.textContent = `Вы зарегистрированы. Эфир начнется ${date} МСК.`;
    }
  }

  async function hydrateTimeline() {
    const video = document.getElementById('webinarVideo');
    const fallback = document.getElementById('videoFallback');
    const list = document.getElementById('webinarTimeline');
    const active = document.getElementById('timelineActive');
    const overlay = document.getElementById('videoPlayOverlay');
    if (!list || !active) return;

	    const data = await getJson(timelinePath());
    if (!data.ok) return;

    const videoDuration = data.video && data.video.durationSeconds ? Number(data.video.durationSeconds) : 568;

    if (video && data.video && data.video.src) {
      const source = video.querySelector('source');
      if (source) source.setAttribute('src', data.video.src);
      video.load();
      video.addEventListener('error', () => {
        if (fallback) fallback.classList.remove('hidden');
      });
      video.addEventListener('contextmenu', e => e.preventDefault());
    }

    const liveBadge = document.getElementById('videoLiveBadge');
    if (liveBadge && webinarConfig) {
      if (webinarConfig.status === 'live') {
        liveBadge.className = 'absolute bottom-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
        liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-ping"></span>🔴 ПРЯМОЙ ЭФИР';
      } else {
        liveBadge.className = 'absolute bottom-4 right-4 bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full text-white text-label-sm z-10';
        liveBadge.textContent = '🔴 ЗАПИСЬ ТРАНСЛЯЦИИ';
      }
    }

    renderTimeline(data.timeline || []);

    if (video) {
      // Helper function to get current live position based on synchronized server time
      function getLivePosition() {
        if (!webinarConfig || webinarConfig.status !== 'live') {
          return 0;
        }
        const nowServer = Date.now() + serverTimeOffset;
        const elapsedSeconds = (nowServer - webinarConfig.scheduledAt) / 1000;
        return elapsedSeconds;
      }

      // Sync player to current position in direct live stream mode
      const initialPos = getLivePosition();
      if (webinarConfig && webinarConfig.status === 'live') {
        if (initialPos < videoDuration) {
          video.currentTime = initialPos;
        } else {
          // If video ended but session is live, show completion screen
          if (overlay) {
            const title = overlay.querySelector('p');
            if (title) title.textContent = '🏁 Трансляция завершена';
            const desc = overlay.querySelector('p:last-of-type');
            if (desc) desc.textContent = 'Основная часть эфира завершена. Оставьте вопрос или заявку ниже.';
            const playButton = overlay.querySelector('.w-20');
            if (playButton) playButton.innerHTML = '<span class="material-symbols-outlined text-[40px] text-on-secondary-fixed">check_circle</span>';
          }
        }
      }

      video.addEventListener('timeupdate', () => activateTimelineEvent(video.currentTime, data.timeline || []));
      activateTimelineEvent(video.currentTime, data.timeline || []);

      if (overlay) {
        overlay.addEventListener('click', () => {
          if (webinarConfig && webinarConfig.status === 'live') {
            const currentPos = getLivePosition();
            if (currentPos >= videoDuration) {
              return; // Already completed
            }
            video.currentTime = currentPos;
          }

          if (video.muted) {
            video.muted = false;
            overlay.classList.add('opacity-0');
            setTimeout(() => overlay.classList.add('hidden'), 300);
          } else {
            video.play()
              .then(() => {
                overlay.classList.add('opacity-0');
                setTimeout(() => overlay.classList.add('hidden'), 300);
              })
              .catch(err => {
                console.error('Play failed:', err);
                video.muted = true;
                video.play().then(() => {
                  const title = overlay.querySelector('p');
                  if (title) title.textContent = '🔊 Включить звук трансляции';
                  const desc = overlay.querySelector('p:last-of-type');
                  if (desc) desc.textContent = 'Трансляция идет без звука из-за правил вашего браузера';
                });
              });
          }
        });

        // Toggle play/pause or force sync on live stream
        video.addEventListener('click', () => {
          if (webinarConfig && webinarConfig.status === 'live') {
            if (video.paused) {
              const currentPos = getLivePosition();
              if (currentPos < videoDuration) {
                video.currentTime = currentPos;
                video.play();
                overlay.classList.add('opacity-0');
                setTimeout(() => overlay.classList.add('hidden'), 300);
              }
            } else {
              video.pause();
              overlay.classList.remove('hidden');
              setTimeout(() => overlay.classList.remove('opacity-0'), 10);
              const title = overlay.querySelector('p');
              if (title) title.textContent = '🔴 Трансляция приостановлена';
              const desc = overlay.querySelector('p:last-of-type');
              if (desc) desc.textContent = 'Нажмите в любой точке для возврата в прямой эфир';
            }
          } else {
            // Standard VOD replay playback controls
            if (video.paused) {
              video.play();
              overlay.classList.add('opacity-0');
              setTimeout(() => overlay.classList.add('hidden'), 300);
            } else {
              video.pause();
              overlay.classList.remove('hidden');
              setTimeout(() => overlay.classList.remove('opacity-0'), 10);
              const title = overlay.querySelector('p');
              if (title) title.textContent = 'Просмотр приостановлен';
              const desc = overlay.querySelector('p:last-of-type');
              if (desc) desc.textContent = 'Нажмите для возобновления';
            }
          }
        });

        // Prevent seeking in live broadcast mode
        video.addEventListener('seeking', () => {
          if (webinarConfig && webinarConfig.status === 'live') {
            const currentPos = getLivePosition();
            if (Math.abs(video.currentTime - currentPos) > 2) {
              video.currentTime = currentPos;
            }
          }
        });
      }
    }
  }

  function renderTimeline(events) {
    const list = document.getElementById('webinarTimeline');
    if (!list) return;
    list.textContent = '';
    events.forEach((event, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'w-full text-left rounded-xl border border-outline-variant/30 p-4 hover:border-primary/40 hover:bg-surface-container-low transition-all';
      item.dataset.offset = String(event.offsetSeconds);
      const time = document.createElement('div');
      time.className = 'inline-flex items-center rounded-full bg-primary-fixed px-3 py-1 text-label-sm font-label-sm text-on-primary-fixed';
      time.textContent = formatTimelineTime(event.offsetSeconds);
      const title = document.createElement('div');
      title.className = 'font-label-md text-primary mt-1';
      title.textContent = event.title;
      const text = document.createElement('p');
      text.className = 'text-body-md text-on-surface-variant mt-1';
      text.textContent = event.text;
      const type = document.createElement('span');
      type.className = 'ml-2 text-label-sm font-label-sm text-on-surface-variant';
      type.textContent = getTimelineTypeLabel(event.type);
      const meta = document.createElement('div');
      meta.className = 'flex items-center gap-2';
      meta.append(time, type);
      item.append(meta, title, text);
      item.addEventListener('click', () => {
        if (webinarConfig && webinarConfig.status === 'live') {
          alert('Это прямой эфир. Перемотка невозможна.');
          return;
        }
        const video = document.getElementById('webinarVideo');
        if (video) {
          video.currentTime = event.offsetSeconds;
          video.play().catch(() => {});
        }
        activateTimelineEvent(event.offsetSeconds, events);
      });
      list.appendChild(item);
      if (index === 0) item.setAttribute('aria-current', 'true');
    });
  }

  function activateTimelineEvent(seconds, events) {
    if (!events.length) return;
    const activeEvent = events.reduce((current, event) => {
      return seconds >= event.offsetSeconds ? event : current;
    }, events[0]);
    const panel = document.getElementById('timelineActive');
    if (!panel) return;
    panel.textContent = '';
    const label = document.createElement('p');
    label.className = 'text-label-sm font-label-sm text-on-surface-variant uppercase tracking-wider mb-2';
    label.textContent = activeEvent.type === 'final' ? 'Финальный CTA' : getTimelineTypeLabel(activeEvent.type);
    const title = document.createElement('h3');
    title.className = 'text-headline-md font-headline-md text-primary';
    title.textContent = activeEvent.title;
    const text = document.createElement('p');
    text.className = 'text-body-md text-on-surface-variant mt-2';
    text.textContent = activeEvent.text;
    panel.append(label, title, text);
    if (activeEvent.ctaLabel && activeEvent.ctaUrl) {
      const link = document.createElement('a');
      link.className = 'inline-flex mt-4 bg-primary text-on-primary rounded-xl px-5 py-3 font-label-md';
      link.href = activeEvent.ctaUrl;
      link.textContent = activeEvent.ctaLabel;
      panel.appendChild(link);
    }

    document.querySelectorAll('#webinarTimeline [data-offset]').forEach(item => {
      const isCurrent = Number(item.dataset.offset) === activeEvent.offsetSeconds;
      item.setAttribute('aria-current', isCurrent ? 'true' : 'false');
      item.classList.toggle('border-primary', isCurrent);
      item.classList.toggle('bg-surface-container-low', isCurrent);
      item.classList.toggle('shadow-sm', isCurrent);
    });
  }

  function formatTimelineTime(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function getTimelineTypeLabel(type) {
    if (type === 'cta') return 'действие';
    if (type === 'chat_prompt') return 'вопрос';
    if (type === 'final') return 'финал';
    return 'ключевой момент';
  }

  function bindQuestionForm() {
    const input = document.getElementById('questionInput');
    const button = document.getElementById('questionSubmit');
    const list = document.getElementById('questionList');
    if (!input || !button) return;

    button.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;

      button.disabled = true;
      try {
        await post('/questions', { token, text });
        const item = document.createElement('div');
        item.className = 'flex gap-3';
        item.innerHTML = `
          <div class="w-8 h-8 rounded-full bg-primary-fixed-dim flex-shrink-0 flex items-center justify-center text-primary text-label-sm font-bold">Вы</div>
          <div class="space-y-1">
            <div class="text-label-sm font-bold text-on-surface">Ваш вопрос</div>
            <div class="bg-surface-container p-3 rounded-xl rounded-tl-none text-body-md text-on-surface-variant"></div>
          </div>`;
        item.querySelector('.bg-surface-container').textContent = text;
        if (list) list.appendChild(item);
        input.value = '';
      } catch (error) {
        alert(error.message || 'Не удалось отправить вопрос');
      } finally {
        button.disabled = false;
      }
    });
  }

  function bindPartnerApplicationForm() {
    const form = document.getElementById('partnerApplicationForm');
    const status = document.getElementById('partnerApplicationStatus');
    if (!form) return;

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const originalText = button ? button.textContent : '';
      const data = new FormData(form);
      if (button) {
        button.disabled = true;
        button.textContent = 'Отправляем...';
      }

      try {
        await post('/partner-application', {
          token,
          sphere: data.get('sphere'),
          city: data.get('city'),
          clientFlow: data.get('clientFlow'),
          experience: data.get('experience'),
          preferredFormat: data.get('preferredFormat'),
          comment: data.get('comment')
        });
        if (status) status.textContent = 'Заявка отправлена. Менеджер АСПБ увидит ее в CRM и свяжется с вами.';
        form.reset();
      } catch (error) {
        if (status) status.textContent = error.message || 'Не удалось отправить заявку.';
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    hydrateCurrentWebinar();
    hydrateSuccessPage();
    hydrateWebinarRoom();
    bindRegistrationForm();
    bindQuestionForm();
    bindPartnerApplicationForm();
    bindTelegramTracking();
    bindRegistrationClicks();
    track('page_view');
  });
})();
