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
    const marketingConsent = form.querySelector('input[name="marketingConsent"]');

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
        consent: consent ? consent.checked : false,
        marketingConsent: marketingConsent ? marketingConsent.checked : false,
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

  function formatUtcIcsDate(value) {
    return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function bindSuccessCalendar(data) {
    const button = document.getElementById('successCalendarButton');
    if (!button || button.dataset.bound === 'true') return;

    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      const start = new Date(data.webinar.scheduledAt);
      const end = new Date(start.getTime() + Number(data.webinar.durationMinutes || 120) * 60 * 1000);
      const webinarUrl = data.webinarUrl || (token ? `${window.location.origin}/crisis_premium/webinar.html?token=${encodeURIComponent(token)}` : `${window.location.origin}/crisis_premium/webinar.html`);
      const title = 'Вебинар АСПБ: Экономика кризиса';
      const description = [
        'Автовебинар АСПБ для юристов и партнеров.',
        `Персональная комната: ${webinarUrl}`
      ].join('\\n');
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//ASPB//Autowebinar//RU',
        'BEGIN:VEVENT',
        `UID:${data.registration.id || Date.now()}@aspb-autowebinar`,
        `DTSTAMP:${formatUtcIcsDate(new Date())}`,
        `DTSTART:${formatUtcIcsDate(start)}`,
        `DTEND:${formatUtcIcsDate(end)}`,
        `SUMMARY:${title}`,
        `DESCRIPTION:${description.replace(/\n/g, '\\\\n')}`,
        `URL:${webinarUrl}`,
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\\r\\n');
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'aspb-webinar.ics';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      button.innerHTML = '<span class="material-symbols-outlined text-xl">event_available</span>Добавлено в календарь';
    });
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
      bindSuccessCalendar(data);
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

      const supportBtn = document.getElementById('successSupportBtn');
      if (supportBtn) {
        supportBtn.addEventListener('click', () => {
          window.open(data.telegramBotUrl || data.telegramUrl || 'mailto:partners@aspb.ru', '_blank');
        });
      }

      const copyBtn = document.getElementById('successCopyLinkBtn');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          try {
            const shareUrl = window.location.origin + '/crisis_premium/index.html';
            await navigator.clipboard.writeText(shareUrl);
            const originalHTML = copyBtn.innerHTML;
            copyBtn.innerHTML = 'Ссылка скопирована! <span class="material-symbols-outlined" style="margin-left:4px">done</span>';
            copyBtn.style.color = '#4caf50';
            setTimeout(() => {
              copyBtn.innerHTML = originalHTML;
              copyBtn.style.color = '';
            }, 2000);
          } catch (err) {
            console.error('Failed to copy text: ', err);
          }
        });
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
    const title = data.accessStatus === 'closed'
      ? 'Доступ к записи завершен'
      : data.accessStatus === 'pre_live'
        ? 'Комната скоро откроется'
        : 'Эфир еще не начался';
    const text =
      data.accessStatus === 'closed'
        ? 'Срок доступа к записи по этой персональной ссылке истек. Если вам нужна помощь, оставьте новую заявку через регистрацию.'
        : data.accessStatus === 'pre_live'
          ? `Вы пришли вовремя. Эфир стартует ${formatMoscowDateTime(data.webinar.scheduledAt)} МСК, страница обновится автоматически ближе к старту.`
        : `Вы зарегистрированы. Комната откроется автоматически к началу эфира: ${formatMoscowDateTime(data.webinar.scheduledAt)} МСК.`;
    const action =
      data.accessStatus === 'closed'
        ? '<a href="register.html" style="display:inline-flex;margin-top:20px;background:#041627;color:#fff;text-decoration:none;padding:16px 24px;border-radius:14px;font-weight:700">Зарегистрироваться заново</a>'
        : '<a href="success.html" style="display:inline-flex;margin-top:20px;background:#d2e4fb;color:#041627;text-decoration:none;padding:16px 24px;border-radius:14px;font-weight:800">Проверить регистрацию</a>';

    document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;background:#f8f9fa;color:#041627;font-family:Manrope,Arial,sans-serif;padding:24px">
        <section style="max-width:640px;background:#fff;border:1px solid #d2e4fb;border-radius:24px;padding:36px;text-align:center;box-shadow:0 24px 70px rgba(4,22,39,.08)">
          <p style="margin:0 0 10px;color:#4f6073;font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:12px">АСПБ автовебинар</p>
          <h1 style="font-size:34px;margin:0 0 12px">${title}</h1>
          <p style="font-size:18px;color:#44474c;line-height:1.55;margin:0">${text}</p>
          ${
            data.accessStatus === 'waiting' || data.accessStatus === 'pre_live'
              ? '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:24px"><div style="background:#f3f4f5;border-radius:16px;padding:14px"><strong data-countdown-days style="font-size:28px">00</strong><br><span>дней</span></div><div style="background:#f3f4f5;border-radius:16px;padding:14px"><strong data-countdown-hours style="font-size:28px">00</strong><br><span>часов</span></div><div style="background:#f3f4f5;border-radius:16px;padding:14px"><strong data-countdown-minutes style="font-size:28px">00</strong><br><span>минут</span></div><div style="background:#f3f4f5;border-radius:16px;padding:14px"><strong data-countdown-seconds style="font-size:28px">00</strong><br><span>секунд</span></div></div>'
              : ''
          }
          ${action}
        </section>
      </main>`;

    if (data.accessStatus === 'waiting' || data.accessStatus === 'pre_live') {
      startCountdown(data.webinar.scheduledAt);
      window.setTimeout(() => window.location.reload(), 30 * 1000);
    }
  }

  async function hydrateWebinarRoom() {
    if (!window.location.pathname.endsWith('webinar.html')) return;

    try {
      const data = await getRegistrationState('room');
      if (!data.ok || !data.canEnterRoom) {
        if (data.accessStatus === 'waiting' || data.accessStatus === 'pre_live' || data.accessStatus === 'closed') {
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
		        status: data.testMode ? 'test' : data.accessStatus === 'replay' ? 'replay' : data.webinar.status,
		        durationMinutes: data.webinar.durationMinutes
		      };

      updateTelegramLinks(data.telegramUrl);
      startCountdown(data.webinar.scheduledAt);
	      updateRoomStatus({ ...data.webinar, accessStatus: data.accessStatus, replayExpiresAt: data.replayExpiresAt, testMode: data.testMode });
	      await hydrateTimeline();
    } catch {
      renderLockedRoom('Не удалось проверить доступ. Попробуйте открыть ссылку из письма еще раз.');
    }
  }

  function updateRoomStatus(webinar) {
    const node = document.getElementById('webinarStatusText');
    const countdownContainer = document.getElementById('countdownContainer');
    if (!node || !webinar) return;
    if (webinar.testMode) {
      node.textContent = 'Тестовый режим: трансляция доступна всегда и после обновления начинается с начала.';
      if (countdownContainer) countdownContainer.classList.add('hidden');
    } else if (webinar.accessStatus === 'live' || webinar.status === 'live') {
      node.textContent = 'Эфир идет. Включайте запись и следите за подсказками АСПБ.';
      if (countdownContainer) countdownContainer.classList.add('hidden');
    } else if (webinar.accessStatus === 'replay' || webinar.status === 'finished') {
      const expires = webinar.replayExpiresAt ? ` Доступ к записи открыт до ${formatMoscowDateTime(webinar.replayExpiresAt)} МСК.` : '';
      node.textContent = `Эфир завершен, но запись доступна по вашей персональной ссылке.${expires} Посмотрите ключевые блоки и оставьте заявку, если узнали своих клиентов.`;
      if (countdownContainer) countdownContainer.classList.add('hidden');
    } else {
      const date = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(webinar.scheduledAt));
      node.textContent = `Вы зарегистрированы. Эфир начнется ${date} МСК.`;
      if (countdownContainer) countdownContainer.classList.remove('hidden');
    }
  }

  const WEBINAR_INSIGHTS = [
    {
      time: 8,
      icon: 'flag',
      title: 'Старт эфира',
      text: 'Сразу отметьте: вебинар не про теорию, а про то, как юристу увидеть долговой кейс и не отпустить клиента без маршрута.'
    },
    {
      time: 45,
      icon: 'warning',
      title: 'Первый сигнал клиента',
      text: 'Если клиент говорит про долги, взыскания, блокировки, ФНС или кассовый разрыв — это уже повод предложить диагностику АСПБ.'
    },
    {
      time: 105,
      icon: 'psychology',
      title: 'Не давите словом "банкротство"',
      text: 'Начинайте с безопасной формулировки: "Давайте посмотрим законный маршрут выхода из долговой нагрузки".'
    },
    {
      time: 165,
      icon: 'handshake',
      title: 'Роль партнера',
      text: 'Вы не ведете процедуру сами. Ваша задача — заметить сигнал, передать клиента и сохранить доверие.'
    },
    {
      time: 230,
      icon: 'edit_note',
      title: 'Задайте вопрос',
      text: 'Вспомните одного реального клиента и отправьте вопрос в поле ниже. Такой участник автоматически становится приоритетным для менеджера.'
    },
    {
      time: 315,
      icon: 'route',
      title: 'Что берет АСПБ',
      text: 'Диагностика, документы, суд, кредиторы и сопровождение процедуры остаются на стороне команды АСПБ.'
    },
    {
      time: 430,
      icon: 'description',
      title: 'Условия фиксируются договором',
      text: 'Партнерская модель работает только через прозрачную фиксацию источника клиента и условий в договоре.'
    },
    {
      time: 520,
      icon: 'rocket_launch',
      title: 'Финальный шаг',
      text: 'Если узнали своих клиентов в примерах, оставьте заявку на партнерский договор после эфира.'
    }
  ];

  let renderedInsightTimes = new Set();

  function setChatActivity(text) {
    const node = document.getElementById('chatActivity');
    if (node) node.textContent = text;
  }

  function updateInsightHeader(currentTime) {
    const label = document.getElementById('chatOnlineLabel');
    if (!label) return;
    const next = WEBINAR_INSIGHTS.find(item => item.time > currentTime);
    label.textContent = next ? `следующий: ${formatTimelineTime(next.time)}` : 'финальный CTA';
  }

  function updateWebinarInsights(currentTime, isSyncing = false) {
    const list = document.getElementById('questionList');
    if (!list) return;
    updateInsightHeader(currentTime);

    const visibleItems = WEBINAR_INSIGHTS.filter(item => item.time <= currentTime);
    const currentInsightElements = list.querySelectorAll('.webinar-insight-msg');

    if (visibleItems.length < renderedInsightTimes.size || isSyncing) {
      currentInsightElements.forEach(el => el.remove());
      renderedInsightTimes.clear();
    }

    setChatActivity('Сценарные подсказки синхронизированы с записью');

    let appendedNew = false;
    visibleItems.forEach(insight => {
      if (!renderedInsightTimes.has(insight.time)) {
        renderedInsightTimes.add(insight.time);
        const item = document.createElement('div');
        item.className = 'flex gap-3 webinar-insight-msg transition-all duration-500 ease-out opacity-0 translate-y-2';

        const icon = document.createElement('div');
        icon.className = 'w-8 h-8 rounded-full bg-primary text-on-primary flex-shrink-0 flex items-center justify-center';
        const iconSymbol = document.createElement('span');
        iconSymbol.className = 'material-symbols-outlined text-[18px]';
        iconSymbol.textContent = insight.icon;
        icon.append(iconSymbol);

        const body = document.createElement('div');
        body.className = 'space-y-1';
        const title = document.createElement('div');
        title.className = 'text-label-sm font-bold text-primary flex items-center gap-2';
        title.textContent = insight.title;
        const time = document.createElement('span');
        time.className = 'text-[11px] font-medium text-on-surface-variant';
        time.textContent = formatTimelineTime(insight.time);
        title.append(time);

        const bubble = document.createElement('div');
        bubble.className = 'bg-surface-container p-3 rounded-xl rounded-tl-none text-body-md text-on-surface-variant border border-outline-variant/20';
        bubble.textContent = insight.text;

        body.append(title, bubble);
        item.append(icon, body);
        list.appendChild(item);
        appendedNew = true;

        setTimeout(() => {
          item.classList.remove('opacity-0', 'translate-y-2');
        }, 50);
      }
    });

    if (appendedNew) {
      list.scrollTop = list.scrollHeight;
    }
  }

  async function hydrateTimeline() {
    const container = document.getElementById('videoPlayerContainer');
    const video = document.getElementById('webinarVideo');
    const fallback = document.getElementById('videoFallback');
    const active = document.getElementById('timelineActive');
    const playOverlay = document.getElementById('videoPlayOverlay');
    const pauseOverlay = document.getElementById('videoPauseOverlay');

    // Custom controls components
    const customControls = document.getElementById('customPlayerControls');
    const playPauseBtn = document.getElementById('customPlayPauseBtn');
    const liveIndicator = document.getElementById('customLiveIndicator');
    const viewerCountValue = document.getElementById('viewerCountValue');
    const customTimeDisplay = document.getElementById('customTimeDisplay');
    const currentTimeText = document.getElementById('currentTimeText');
    const durationTimeText = document.getElementById('durationTimeText');
    const muteBtn = document.getElementById('customMuteBtn');
    const volumeSlider = document.getElementById('customVolumeSlider');
    const fullscreenBtn = document.getElementById('customFullscreenBtn');
    const seekContainer = document.getElementById('customSeekBarContainer');
    const seekProgress = document.getElementById('customSeekBarProgress');

    if (!active || !video) return;

    const data = await getJson(timelinePath());
    if (!data.ok) return;

    const videoDuration = data.video && data.video.durationSeconds ? Number(data.video.durationSeconds) : 568;

    if (data.video && data.video.src) {
      const source = video.querySelector('source');
      if (source) source.setAttribute('src', data.video.src);
      if (data.video.poster) video.setAttribute('poster', data.video.poster);
      video.load();
      video.addEventListener('error', () => {
        if (fallback) fallback.classList.remove('hidden');
      });
      video.addEventListener('contextmenu', e => e.preventDefault());
    }

    const liveBadge = document.getElementById('videoLiveBadge');
    if (liveBadge && webinarConfig) {
      if (webinarConfig.status === 'test') {
        liveBadge.className = 'absolute top-4 right-4 bg-primary/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
        liveBadge.textContent = 'ТЕСТОВАЯ ТРАНСЛЯЦИЯ';
      } else if (webinarConfig.status === 'live') {
        liveBadge.className = 'absolute top-4 right-4 bg-red-600/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-white text-[11px] font-bold tracking-wider z-10 flex items-center gap-1.5 shadow-md';
        liveBadge.innerHTML = '<span class="w-1.5 h-1.5 bg-white rounded-full animate-ping"></span>🔴 ПРЯМОЙ ЭФИР';
      } else {
        liveBadge.className = 'absolute top-4 right-4 bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full text-white text-label-sm z-10';
        liveBadge.textContent = '🔴 ЗАПИСЬ ТРАНСЛЯЦИИ';
      }
    }

    // Helper function to get current live position based on synchronized server time
    function getLivePosition() {
      if (!webinarConfig || webinarConfig.status !== 'live') {
        return 0;
      }
      const nowServer = Date.now() + serverTimeOffset;
      const elapsedSeconds = (nowServer - webinarConfig.scheduledAt) / 1000;
      return elapsedSeconds;
    }

    const isLive = webinarConfig && webinarConfig.status === 'live';
    const isTestMode = webinarConfig && webinarConfig.status === 'test';
    let broadcastStarted = false;

    // No locked timeline list is rendered under the video (removed to prevent exposing autowebinar timing)

    // 1. Initial player setup (Start playing muted in background for live simulation)
    video.muted = true;
    if (volumeSlider) volumeSlider.value = 0;
    if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_off';

    if (isTestMode) {
      video.pause();
      video.currentTime = 0;
    } else {
      video.play().catch(err => {
        console.log('Muted autoplay was prevented by browser, waiting for user click.', err);
      });
    }

    if (isLive) {
      // Setup live layout
      if (liveIndicator) liveIndicator.classList.remove('hidden');
      if (liveIndicator) liveIndicator.querySelector('span:last-child').textContent = 'Идет эфир';
      if (customTimeDisplay) customTimeDisplay.classList.add('hidden');
      if (playPauseBtn) playPauseBtn.classList.add('hidden'); // Hide play/pause toggle in live stream
      if (seekContainer) seekContainer.classList.add('hidden'); // Completely hide seekbar in Live mode

      // Fluctuating viewers count simulation
      let viewers = Math.floor(Math.random() * (165 - 145) + 145);
      if (viewerCountValue) viewerCountValue.textContent = String(viewers);
      setChatActivity('Подсказки будут появляться по мере просмотра');

      setInterval(() => {
        const change = Math.floor(Math.random() * 7) - 3; // -3 to +3
        viewers = Math.max(130, Math.min(190, viewers + change));
        if (viewerCountValue) viewerCountValue.textContent = String(viewers);
      }, 8000);
    } else {
      // Replay mode setup
      if (liveIndicator) liveIndicator.classList.add('hidden');
      const viewerBadge = document.getElementById('customViewerCount');
      if (viewerBadge) viewerBadge.classList.add('hidden');
      if (customTimeDisplay) customTimeDisplay.classList.remove('hidden');
      if (liveBadge && webinarConfig?.status !== 'test') liveBadge.classList.add('hidden');
    }

    // Sync player position immediately
    const initialPos = getLivePosition();
    if (isLive) {
      if (initialPos < videoDuration) {
        video.currentTime = initialPos;
      } else {
        // Video finished
        if (playOverlay) {
          playOverlay.innerHTML = `
            <div class="w-20 h-20 bg-green-600/90 rounded-full flex items-center justify-center mb-4 border border-white/20">
              <span class="material-symbols-outlined text-white text-4xl">check_circle</span>
            </div>
            <p class="text-headline-md text-white font-bold tracking-wide uppercase">🏁 Трансляция завершена</p>
            <p class="text-body-lg text-white/80 mt-1">Основная часть эфира завершена. Оставьте вопрос или заявку ниже.</p>
          `;
        }
      }
    }

    // 2. Playback State Synchronization & Timeupdate
    video.addEventListener('timeupdate', () => {
      const current = video.currentTime;
      activateTimelineEvent(current, data.timeline || []);
      updateWebinarInsights(current);

      if (!isLive) {
        // Update seek progress & time text in Replay mode
        if (seekProgress && video.duration) {
          seekProgress.style.width = (current / video.duration) * 100 + '%';
        }
        if (currentTimeText) currentTimeText.textContent = formatTimelineTime(current);
        if (durationTimeText && video.duration) durationTimeText.textContent = formatTimelineTime(video.duration);
      }
    });

    activateTimelineEvent(video.currentTime, data.timeline || []);
    updateWebinarInsights(video.currentTime, true);

    function startBroadcastFromClick() {
      if (isLive) {
        const currentPos = getLivePosition();
        if (currentPos >= videoDuration) {
          return; // Live ended
        }
        video.currentTime = currentPos;
      }

      video.muted = false;
      video.volume = 1;
      if (volumeSlider) volumeSlider.value = 1;
      if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_up';

      video.play().then(() => {
        broadcastStarted = true;
        if (playOverlay) {
          playOverlay.classList.add('opacity-0');
          setTimeout(() => playOverlay.classList.add('hidden'), 300);
        }
        if (pauseOverlay) pauseOverlay.classList.add('hidden');
      }).catch(err => {
        console.error('Play unmuted failed:', err);
        video.muted = true;
        video.play().then(() => {
          broadcastStarted = true;
          if (playOverlay) {
            const title = playOverlay.querySelector('p');
            if (title) title.textContent = '🔊 Включить звук трансляции';
            const desc = playOverlay.querySelector('p:last-of-type');
            if (desc) desc.textContent = 'Трансляция идет без звука. Нажмите еще раз для включения.';
          }
        });
      });
    }

    // 3. Unmute / Start Playback Overlay Handler
    if (playOverlay) {
      playOverlay.addEventListener('click', event => {
        event.stopPropagation();
        startBroadcastFromClick();
      });
    }

    // 4. Pause Overlay Handler (resuming syncs in Live mode)
    if (pauseOverlay) {
      pauseOverlay.addEventListener('click', () => {
        if (isLive) {
          const currentPos = getLivePosition();
          if (currentPos < videoDuration) {
            video.currentTime = currentPos;
            video.play().then(() => {
              pauseOverlay.classList.add('hidden');
            });
          }
        } else {
          video.play().then(() => {
            pauseOverlay.classList.add('hidden');
          });
        }
      });
    }

    // 5. Video Player Container Click Event (toggles Mute in Live, toggles Play in Replay)
    if (container) {
      container.addEventListener('click', (e) => {
        // Prevent action if clicked on controls or pause overlay buttons
        if (e.target.closest('#customPlayerControls') || e.target.closest('#videoPauseOverlay')) {
          return;
        }

        if (!broadcastStarted || video.paused) {
          startBroadcastFromClick();
        } else if (isLive) {
          toggleMuteState();
        } else {
          togglePlayState();
        }
      });
    }

    // Spacebar control (Mutes in Live, Plays/Pauses in Replay)
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
          return;
        }
        e.preventDefault();
        if (isLive) {
          toggleMuteState();
        } else {
          togglePlayState();
        }
      }
    });

    // VisibiltyChange listener to sync live broadcast when user switches back to the tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isLive) {
        const currentPos = getLivePosition();
        if (currentPos < videoDuration) {
          video.currentTime = currentPos;
          video.play().catch(err => console.log('Visibility change auto-play failed:', err));
        }
      }
    });

    // Custom controls Play/Pause Button (Replay mode only)
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', () => {
        togglePlayState();
      });
    }

    function toggleMuteState() {
      if (video.muted) {
        video.muted = false;
        video.volume = volumeSlider.value || 1;
        if (volumeSlider && volumeSlider.value === '0') {
          volumeSlider.value = 1;
          video.volume = 1;
        }
        if (muteBtn) muteBtn.querySelector('span').textContent = video.volume < 0.5 ? 'volume_down' : 'volume_up';
      } else {
        video.muted = true;
        if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_off';
      }
    }

    function togglePlayState() {
      if (video.paused) {
        video.play();
        pauseOverlay.classList.add('hidden');
        if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'pause';
      } else {
        video.pause();
        const p1 = pauseOverlay.querySelector('p');
        if (p1) p1.textContent = 'Просмотр приостановлен';
        const p2 = pauseOverlay.querySelector('p:last-of-type');
        if (p2) p2.textContent = 'Нажмите в любой точке для продолжения';
        pauseOverlay.classList.remove('hidden');
        if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'play_arrow';
      }
    }

    // Sync Play/Pause button icons on video events
    video.addEventListener('play', () => {
      if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'pause';
      pauseOverlay.classList.add('hidden');
    });

    video.addEventListener('pause', () => {
      if (playPauseBtn) playPauseBtn.querySelector('span').textContent = 'play_arrow';
    });

    // 6. Prevent Seeking in Live mode
    video.addEventListener('seeking', () => {
      if (isLive) {
        const currentPos = getLivePosition();
        if (Math.abs(video.currentTime - currentPos) > 2) {
          video.currentTime = currentPos;
        }
      }
    });

    // 7. Volume and Mute Handlers
    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        toggleMuteState();
      });
    }

    if (volumeSlider) {
      volumeSlider.addEventListener('input', () => {
        video.volume = volumeSlider.value;
        video.muted = (video.volume === 0);
        if (video.muted) {
          if (muteBtn) muteBtn.querySelector('span').textContent = 'volume_off';
        } else {
          if (muteBtn) muteBtn.querySelector('span').textContent = video.volume < 0.5 ? 'volume_down' : 'volume_up';
        }
      });
    }

    // 8. Fullscreen toggle logic (requested on container to keep custom UI overlay)
    if (fullscreenBtn && container) {
      fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          container.requestFullscreen().then(() => {
            fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
          }).catch(err => {
            console.error('Fullscreen entering failed:', err);
          });
        } else {
          document.exitFullscreen().then(() => {
            fullscreenBtn.querySelector('span').textContent = 'fullscreen';
          });
        }
      });

      document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement === container) {
          fullscreenBtn.querySelector('span').textContent = 'fullscreen_exit';
          container.classList.add('p-0'); // Optimize layout in fullscreen
        } else {
          fullscreenBtn.querySelector('span').textContent = 'fullscreen';
          container.classList.remove('p-0');
        }
      });
    }

    // 9. Interactive Seekbar in Replay mode
    if (seekContainer && !isLive) {
      seekContainer.addEventListener('click', (e) => {
        const rect = seekContainer.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        if (videoDuration) {
          video.currentTime = pos * videoDuration;
          if (seekProgress) seekProgress.style.width = (pos * 100) + '%';
        }
      });
    }

    // 10. Hide/Show Controls Inactivity Timer
    let controlsTimeout = null;
    function showControlsBriefly() {
      if (customControls) {
        customControls.classList.remove('opacity-0', 'pointer-events-none');
        customControls.classList.add('opacity-100', 'pointer-events-auto');
      }
      if (controlsTimeout) clearTimeout(controlsTimeout);
      if (!video.paused) {
        controlsTimeout = setTimeout(() => {
          if (customControls) {
            customControls.classList.remove('opacity-100', 'pointer-events-auto');
            customControls.classList.add('opacity-0', 'pointer-events-none');
          }
        }, 3000);
      }
    }

    container.addEventListener('mousemove', showControlsBriefly);
    container.addEventListener('mouseenter', showControlsBriefly);
    container.addEventListener('mouseleave', () => {
      if (!video.paused && customControls) {
        if (controlsTimeout) clearTimeout(controlsTimeout);
        customControls.classList.remove('opacity-100', 'pointer-events-auto');
        customControls.classList.add('opacity-0', 'pointer-events-none');
      }
    });
  }

  function activateTimelineEvent(seconds, events) {
    if (!events.length) return;
    const activeEvent = events.reduce((current, event) => {
      return seconds >= event.offsetSeconds ? event : current;
    }, events[0]);
    const panel = document.getElementById('timelineActive');
    if (!panel) return;

    // Show panel only if current event is a CTA or final offer, or contains a button link
    const shouldShow = activeEvent && (activeEvent.type === 'cta' || activeEvent.type === 'final' || (activeEvent.ctaLabel && activeEvent.ctaUrl));

    if (!shouldShow) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    panel.textContent = '';

    // Style the panel beautifully like a dynamic call-to-action banner
    panel.className = "bg-secondary-container border border-secondary rounded-lg p-5 shadow-md flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 animate-fade-in";

    const contentDiv = document.createElement('div');
    contentDiv.className = "flex-grow";

    const label = document.createElement('p');
    label.className = 'text-label-sm font-label-sm text-on-secondary-fixed-variant uppercase tracking-wider mb-1';
    label.textContent = activeEvent.type === 'final' ? 'Специальное предложение' : 'Интерактивное действие';

    const title = document.createElement('h3');
    title.className = 'text-headline-sm font-headline-sm text-primary font-bold';
    title.textContent = activeEvent.title;

    const text = document.createElement('p');
    text.className = 'text-body-md text-on-surface-variant mt-1 leading-snug';
    text.textContent = activeEvent.text;

    contentDiv.append(label, title, text);
    panel.append(contentDiv);

    if (activeEvent.ctaLabel && activeEvent.ctaUrl) {
      const link = document.createElement('a');
      link.className = 'bg-primary text-on-primary rounded-xl px-6 py-3.5 font-label-md hover:bg-opacity-90 transition-all text-center whitespace-nowrap scale-95 hover:scale-100 duration-300';
      link.href = activeEvent.ctaUrl;
      link.textContent = activeEvent.ctaLabel;
      panel.appendChild(link);
    }
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
