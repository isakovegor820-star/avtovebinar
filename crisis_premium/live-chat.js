/**
 * Server-backed live chat for the autowebinar room.
 * Chat state follows webinar server time, not local video playback.
 */
(function() {
  var API = window.location.protocol === 'file:' ? 'http://127.0.0.1:5174/api' : '/api';
  var chatContainer = document.getElementById('liveChatMessages');
  var chatPanel = document.getElementById('webinarChatPanel');
  var input = document.getElementById('questionInput');
  var submit = document.getElementById('questionSubmit');
  var activity = document.getElementById('chatActivity');
  var onlineLabel = document.getElementById('chatOnlineLabel');
  if (!chatContainer) return;

  var renderedMessages = new Set();
  var currentLead = null;
  var isHiddenAfterEnd = false;
  var roomReady = false;
  // Палитра аватаров участников и агентов. Без фиолетового/индиго (вызывали недоверие)
  // и без бирюзового #0f766e — он зарезервирован за модераторами.
  var COLORS = ['#1e40af', '#0369a1', '#b45309', '#be123c', '#15803d', '#475569'];

  function setChatContentState(state, text) {
    chatContainer.dataset.state = state;
    var existing = document.getElementById('chatListState');
    if (!text) {
      if (existing) existing.remove();
      return;
    }
    var status = existing || document.createElement('p');
    status.id = 'chatListState';
    status.className = 'text-body-sm text-on-surface-variant leading-relaxed p-2';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = text;
    if (!existing) chatContainer.appendChild(status);
  }

  setChatContentState('loading', 'Загружаем сообщения комнаты…');

  // --- Полноэкранный чат-оверлей (YouTube-style), синхронный с основным чатом ---
  var recentMsgs = [];            // буфер последних отрендеренных сообщений (для seed при входе в fullscreen)
  var RECENT_CAP = 40;
  var FS_VISIBLE_CAP = 9;         // сколько сообщений держим в оверлее одновременно
  var fsActive = false;
  var fsOverlay = null;
  var fsList = null;

  function chatUrl() {
    return API + '/webinar/chat/session/current';
  }

  function setActivity(text) {
    if (activity) activity.textContent = text;
  }

  function setOnlineLabel(text) {
    if (onlineLabel) onlineLabel.textContent = text;
  }

  function setInputState(disabled, placeholder) {
    if (input) {
      input.disabled = disabled;
      input.placeholder = placeholder || 'Задайте вопрос...';
    }
    if (submit) {
      submit.disabled = disabled;
      submit.classList.toggle('opacity-40', disabled);
      submit.classList.toggle('pointer-events-none', disabled);
    }
  }

  function getInitials(name) {
    return String(name || '?')
      .split(/[\s,]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function(part) { return part[0]; })
      .join('')
      .toUpperCase();
  }

  function getColor(name) {
    var hash = 0;
    var value = String(name || '');
    for (var i = 0; i < value.length; i++) hash = value.charCodeAt(i) + ((hash << 5) - hash);
    return COLORS[Math.abs(hash) % COLORS.length];
  }

  function authorLabel(msg) {
    // Имя модератора уже содержит роль (напр. «Юлия, модератор АСПБ») — не дублируем authorRole.
    if (msg.kind === 'ai_moderator' || msg.kind === 'moderator' || msg.kind === 'system') return msg.authorName;
    if (msg.kind === 'prepared_question' || msg.kind === 'agent_question') {
      return msg.authorRole ? msg.authorName + ', ' + msg.authorRole : msg.authorName;
    }
    return msg.authorRole ? msg.authorName + ', ' + msg.authorRole : msg.authorName;
  }

  function syntheticDisclosure(msg) {
    if (msg.isSynthetic !== true) return '';
    return msg.kind === 'ai_moderator' ? 'AI-модератор' : 'Подготовленный вопрос';
  }

  function buildGroundingControl(msg) {
    var grounding = msg && msg.grounding;
    if (!grounding || (grounding.type !== 'transcript' && grounding.type !== 'source')) return null;
    if (grounding.type === 'transcript') {
      var seconds = Number(grounding.timestampSeconds);
      if (!Number.isFinite(seconds) || seconds < 0) return null;
      var seek = document.createElement('button');
      seek.type = 'button';
      seek.className = 'chat-grounding-link';
      seek.textContent = 'Фрагмент ' + String(grounding.label || '');
      seek.setAttribute('aria-label', 'Перейти к основанию ответа на таймкоде ' + String(grounding.label || ''));
      seek.addEventListener('click', function() {
        document.dispatchEvent(
          new CustomEvent('aspb:room-seek-request', {
            detail: { seconds: Math.floor(seconds), source: 'chat_grounding' },
          }),
        );
      });
      return seek;
    }
    if (typeof grounding.url !== 'string' || !grounding.url.startsWith('https://')) return null;
    var source = document.createElement('a');
    source.className = 'chat-grounding-link';
    source.href = grounding.url;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = 'Открыть источник';
    source.setAttribute('aria-label', 'Открыть основание ответа: ' + String(grounding.title || 'источник'));
    return source;
  }

  function ensureFsOverlay() {
    if (fsOverlay) return fsOverlay;
    var container = document.getElementById('videoPlayerContainer');
    if (!container) return null;
    fsOverlay = document.createElement('div');
    fsOverlay.id = 'fsChatOverlay';
    fsOverlay.setAttribute('aria-hidden', 'true');
    fsOverlay.setAttribute('role', 'log');
    fsOverlay.setAttribute('aria-live', 'polite');
    fsOverlay.setAttribute('aria-relevant', 'additions');
    fsOverlay.setAttribute('aria-label', 'Сообщения вебинара в полноэкранном режиме');
    fsList = document.createElement('div');
    fsList.id = 'fsChatOverlayList';
    fsOverlay.appendChild(fsList);
    container.appendChild(fsOverlay);
    return fsOverlay;
  }

  function buildFsMessage(msg) {
    var row = document.createElement('div');
    row.className = 'fs-chat-msg';
    if (msg.kind === 'moderator') row.classList.add('fs-chat-msg-mod');

    var avatar = document.createElement('span');
    avatar.className = 'fs-chat-avatar';
    avatar.style.background = msg.kind === 'moderator' ? '#0f766e' : getColor(msg.authorName);
    avatar.textContent = getInitials(msg.authorName);

    var body = document.createElement('div');
    body.className = 'fs-chat-body';
    var author = document.createElement('span');
    author.className = 'fs-chat-author';
    author.textContent = authorLabel(msg);
    var text = document.createElement('span');
    text.className = 'fs-chat-text';
    text.textContent = msg.message;
    var disclosure = syntheticDisclosure(msg);
    if (disclosure) row.setAttribute('aria-label', disclosure + '. ' + msg.message);
    body.append(author, document.createTextNode(' '), text);

    row.append(avatar, body);
    return row;
  }

  // prepend=true → новое сообщение сверху (старые сдвигаются вниз и затухают по mask-градиенту)
  function renderFsMessage(msg, prepend) {
    if (!fsList) return;
    var row = buildFsMessage(msg);
    if (prepend && fsList.firstChild) {
      fsList.insertBefore(row, fsList.firstChild);
    } else {
      fsList.appendChild(row);
    }
    while (fsList.children.length > FS_VISIBLE_CAP) {
      fsList.removeChild(fsList.lastChild);
    }
  }

  function seedFsOverlay() {
    if (!fsList) return;
    fsList.textContent = '';
    var slice = recentMsgs.slice(-FS_VISIBLE_CAP); // oldest..newest
    // самое новое сверху: идём от новых к старым и добавляем в конец
    for (var i = slice.length - 1; i >= 0; i--) {
      renderFsMessage(slice[i], false);
    }
  }

  function enterFsChat() {
    if (!ensureFsOverlay()) return;
    fsActive = true;
    seedFsOverlay();
    fsOverlay.classList.add('fs-chat-visible');
    fsOverlay.setAttribute('aria-hidden', 'false');
    document.getElementById('liveChatMessages')?.setAttribute('aria-hidden', 'true');
  }

  function exitFsChat() {
    fsActive = false;
    if (fsOverlay) {
      fsOverlay.classList.remove('fs-chat-visible');
      fsOverlay.setAttribute('aria-hidden', 'true');
    }
    document.getElementById('liveChatMessages')?.removeAttribute('aria-hidden');
  }

  function addMessage(msg) {
    if (!msg) return;
    var renderKey = msg.questionId ? 'question:' + msg.questionId : msg.id;
    if (!renderKey || renderedMessages.has(renderKey)) return;
    renderedMessages.add(renderKey);
    setChatContentState('content', '');

    var isModerator = msg.kind === 'moderator';

    var item = document.createElement('div');
    item.className = 'flex gap-2.5 chat-msg-enter';
    item.style.animation = 'chatMsgIn 0.3s ease forwards';
    if (isModerator) {
      // Особый вид — ТОЛЬКО у модераторов: бирюзовая подложка с левым акцентом.
      // Участники и наши агенты идут единым нейтральным форматом (без подложки).
      item.style.background = 'rgba(15, 118, 110, 0.07)';
      item.style.borderLeft = '3px solid #0f766e';
      item.style.paddingLeft = '9px';
      item.style.paddingRight = '8px';
      item.style.paddingTop = '6px';
      item.style.paddingBottom = '6px';
      item.style.borderRadius = '6px';
    }
    var disclosure = syntheticDisclosure(msg);
    if (disclosure) item.setAttribute('aria-label', disclosure + '. ' + msg.message);

    var avatarColor = isModerator ? '#0f766e' : getColor(msg.authorName);
    var avatar = document.createElement('div');
    avatar.style.width = '28px';
    avatar.style.height = '28px';
    avatar.style.borderRadius = '50%';
    avatar.style.background = avatarColor;
    avatar.style.color = '#fff';
    avatar.style.display = 'flex';
    avatar.style.alignItems = 'center';
    avatar.style.justifyContent = 'center';
    avatar.style.flexShrink = '0';
    avatar.style.fontSize = '11px';
    avatar.style.fontWeight = '700';
    avatar.textContent = getInitials(msg.authorName);

    var body = document.createElement('div');
    body.style.flex = '1';
    body.style.minWidth = '0';

    var author = document.createElement('span');
    author.style.fontSize = '11px';
    author.style.fontWeight = '700';
    author.style.color = avatarColor;
    author.textContent = authorLabel(msg);

    var text = document.createElement('p');
    text.style.fontSize = '13px';
    text.style.color = isModerator ? '#0f3d38' : '#44474c';
    text.style.lineHeight = '1.4';
    text.style.margin = '2px 0 0';
    text.style.wordWrap = 'break-word';
    text.style.fontWeight = isModerator ? '500' : 'normal';
    text.textContent = msg.message;

    body.append(author);
    if (disclosure) {
      var badge = document.createElement('span');
      badge.className = 'chat-synthetic-label';
      badge.textContent = disclosure;
      body.append(badge);
    }
    body.append(text);
    var groundingControl = buildGroundingControl(msg);
    if (groundingControl) body.append(groundingControl);
    item.append(avatar, body);
    chatContainer.appendChild(item);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // Синхронизация с полноэкранным оверлеем
    recentMsgs.push(msg);
    if (recentMsgs.length > RECENT_CAP) recentMsgs.shift();
    if (fsActive) renderFsMessage(msg, true);
  }

  function renderChatState(data) {
    var chatStatus = data.liveState && data.liveState.chatStatus;
    var demoLive = data.testMode === true;

    if (!demoLive && data.accessStatus === 'replay') {
      if (chatPanel) chatPanel.classList.remove('hidden');
      isHiddenAfterEnd = false;
      setInputState(false, 'Задайте вопрос после премьеры...');
      setActivity('Запись открыта, чат доступен для вопросов');
      setOnlineLabel('чат открыт');
      return;
    }

    if (!demoLive && chatStatus === 'ended') {
      if (chatPanel) chatPanel.classList.remove('hidden');
      isHiddenAfterEnd = false;
      setInputState(false, 'Задайте вопрос после премьеры...');
      setActivity('Вебинар окончен, чат открыт');
      setOnlineLabel('чат открыт');
      return;
    }

    if (isHiddenAfterEnd && chatPanel) {
      chatPanel.classList.remove('hidden');
      isHiddenAfterEnd = false;
    }

    if (!demoLive && chatStatus === 'locked') {
      setInputState(true, 'Вопросы откроются в момент старта премьеры');
      setActivity('Подготовленное обсуждение и форма вопросов откроются в момент старта премьеры');
      setOnlineLabel('ожидание');
      setChatContentState('unavailable', 'Сообщения откроются вместе с премьерой записи.');
      return;
    }

    setInputState(false, 'Задайте вопрос...');
    setActivity('Подготовленные сообщения синхронизированы с записью; вопросы отправляются команде');
    setOnlineLabel('синхронно');
  }

  async function refreshChat() {
    if (!roomReady) {
      setActivity('Чат подключится после входа в комнату');
      return false;
    }

    try {
      var response = await fetch(chatUrl(), { credentials: 'same-origin' });
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || !data.ok) throw new Error(data.error || 'Ошибка загрузки чата');

      if (data.lead) currentLead = data.lead;
      renderChatState(data);
      if (Array.isArray(data.messages)) {
        var videoPos = window.__aspbVideoPosition || 0;
        var isTestMode = data.testMode === true;
        data.messages.forEach(function(msg) {
          // Гейт по позиции видео зрителя (не показываем сообщения «из будущего»).
          // Раньше зависел от msg.isSynthetic — поле больше не отдаётся сервером,
          // поэтому гейтим по offsetSeconds (есть и у сценарных, и у реальных сообщений).
          if ((isTestMode || data.accessStatus === 'replay') && typeof msg.offsetSeconds === 'number') {
            if (msg.offsetSeconds > videoPos + 2) return;
          }
          addMessage(msg);
        });
      }
      if (renderedMessages.size === 0 && data.liveState?.chatStatus !== 'locked') {
        setChatContentState('empty', 'Сообщений пока нет. Вы можете первым задать вопрос команде АСПБ.');
      }
      return true;
    } catch {
      setActivity('Не удалось обновить чат. Повторяем подключение автоматически…');
      if (renderedMessages.size === 0) {
        setChatContentState('error', 'Не удалось загрузить сообщения. Проверяем соединение и повторим автоматически.');
      }
      return false;
    }
  }

  window.__liveChatRefresh = refreshChat;
  window.__liveChatAddMessage = addMessage;
  window.__liveChatSetState = setChatContentState;

  // --- smart polling: backoff on errors, pause when tab hidden ---
  var chatTimer = null;
  var chatPollInterval = 4000;
  var CHAT_POLL_MIN = 4000;
  var CHAT_POLL_MAX = 15000;

  function scheduleNextChatRefresh() {
    if (chatTimer) clearTimeout(chatTimer);
    if (document.visibilityState === 'hidden') {
      chatTimer = null;
      return;
    }
    chatTimer = setTimeout(async function() {
      var ok = await refreshChat();
      chatPollInterval = ok
        ? CHAT_POLL_MIN
        : Math.min(chatPollInterval * 1.5, CHAT_POLL_MAX);
      scheduleNextChatRefresh();
    }, chatPollInterval);
  }

  async function requestImmediateChatRefresh() {
    chatPollInterval = CHAT_POLL_MIN;
    if (chatTimer) {
      clearTimeout(chatTimer);
      chatTimer = null;
    }
    await refreshChat();
    scheduleNextChatRefresh();
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      requestImmediateChatRefresh();
    } else if (chatTimer) {
      clearTimeout(chatTimer);
      chatTimer = null;
    }
  });

  document.addEventListener('aspb:room-token-exchanged', requestImmediateChatRefresh);
  document.addEventListener('aspb:room-ready', function() {
    roomReady = true;
    requestImmediateChatRefresh();
  });
  document.addEventListener('aspb:chat-refresh-request', requestImmediateChatRefresh);

  document.addEventListener('aspb:chat-question-submitted', function(event) {
    var detail = event.detail || {};
    if (!detail.text) return;
    addMessage({
      id: detail.chatMessageId || ('local_' + Date.now()),
      questionId: detail.questionId,
      kind: 'participant',
      authorName: currentLead && currentLead.name ? currentLead.name : 'Вы',
      authorRole: currentLead && currentLead.professionalStatus ? currentLead.professionalStatus : '',
      message: detail.text,
      isSynthetic: false,
    });
    window.setTimeout(refreshChat, 800);
  });

  function handleFsChange() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
    var container = document.getElementById('videoPlayerContainer');
    var insidePlayer = !!(fsEl && container && (fsEl === container || fsEl.contains(container) || container.contains(fsEl)));
    if (insidePlayer) {
      enterFsChat();
    } else {
      exitFsChat();
    }
  }
  document.addEventListener('fullscreenchange', handleFsChange);
  document.addEventListener('webkitfullscreenchange', handleFsChange);

  if (window.__ASPB_ROOM_READY__ === true) {
    roomReady = true;
    requestImmediateChatRefresh();
  } else {
    setActivity('Чат подключится после входа в комнату');
  }
})();
