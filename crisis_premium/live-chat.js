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
  var isHiddenAfterEnd = false;
  var COLORS = ['#1e40af', '#7c3aed', '#0f766e', '#b45309', '#be123c', '#4338ca'];

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
    if (msg.kind === 'ai_manager') return msg.authorName;
    if (msg.kind === 'agent_question') {
      return msg.authorRole ? msg.authorName + ', ' + msg.authorRole : msg.authorName;
    }
    return msg.authorRole ? msg.authorName + ', ' + msg.authorRole : msg.authorName;
  }

  function addMessage(msg) {
    if (!msg || renderedMessages.has(msg.id)) return;
    renderedMessages.add(msg.id);

    var isAgentQuestion = msg.kind === 'agent_question';

    var item = document.createElement('div');
    item.className = 'flex gap-2.5 chat-msg-enter';
    item.style.animation = 'chatMsgIn 0.3s ease forwards';
    if (isAgentQuestion) {
      item.style.background = 'rgba(30, 64, 175, 0.04)';
      item.style.borderLeft = '2px solid rgba(30, 64, 175, 0.25)';
      item.style.paddingLeft = '8px';
      item.style.paddingTop = '4px';
      item.style.paddingBottom = '4px';
      item.style.borderRadius = '0 6px 6px 0';
    }

    var avatarColor = msg.kind === 'ai_manager' ? '#041627' : getColor(msg.authorName);
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
    text.style.color = isAgentQuestion ? '#1e40af' : '#44474c';
    text.style.lineHeight = '1.4';
    text.style.margin = '2px 0 0';
    text.style.wordWrap = 'break-word';
    text.style.fontWeight = isAgentQuestion ? '500' : 'normal';
    text.textContent = msg.message;

    if (isAgentQuestion) {
      var badge = document.createElement('span');
      badge.style.display = 'inline-block';
      badge.style.fontSize = '9px';
      badge.style.fontWeight = '700';
      badge.style.color = '#1e40af';
      badge.style.background = 'rgba(30, 64, 175, 0.1)';
      badge.style.borderRadius = '4px';
      badge.style.padding = '1px 5px';
      badge.style.marginLeft = '6px';
      badge.style.verticalAlign = 'middle';
      badge.textContent = 'вопрос';
      text.append(badge);
    }

    body.append(author, text);
    item.append(avatar, body);
    chatContainer.appendChild(item);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function renderChatState(data) {
    var chatStatus = data.liveState && data.liveState.chatStatus;
    var demoLive = data.testMode === true;

    if (!demoLive && (chatStatus === 'ended' || data.accessStatus === 'replay')) {
      if (chatPanel) chatPanel.classList.remove('hidden');
      isHiddenAfterEnd = false;
      setInputState(false, 'Задайте вопрос после эфира...');
      setActivity('Вебинар окончен, чат открыт');
      setOnlineLabel('чат открыт');
      return;
    }

    if (isHiddenAfterEnd && chatPanel) {
      chatPanel.classList.remove('hidden');
      isHiddenAfterEnd = false;
    }

    if (!demoLive && chatStatus === 'locked') {
      setInputState(true, 'Чат откроется в момент старта эфира');
      setActivity('Чат откроется в момент старта эфира');
      setOnlineLabel('ожидание');
      return;
    }

    setInputState(false, 'Задайте вопрос...');
    setActivity('Чат идет в live-режиме');
    setOnlineLabel('онлайн');
  }

  async function refreshChat() {
    try {
      var response = await fetch(chatUrl(), { credentials: 'same-origin' });
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || !data.ok) throw new Error(data.error || 'Ошибка загрузки чата');

      renderChatState(data);
      if (Array.isArray(data.messages)) {
        var videoPos = window.__aspbVideoPosition || 0;
        var isTestMode = data.testMode === true;
        data.messages.forEach(function(msg) {
          if (isTestMode && typeof msg.offsetSeconds === 'number' && msg.isSynthetic) {
            if (msg.offsetSeconds > videoPos + 2) return;
          }
          addMessage(msg);
        });
      }
    } catch {
      setActivity('Чат временно недоступен, переподключаемся...');
    }
  }

  window.__liveChatRefresh = refreshChat;
  window.__liveChatAddMessage = addMessage;

  // --- smart polling: backoff on errors, pause when tab hidden ---
  var chatTimer = null;
  var chatPollInterval = 2500;
  var CHAT_POLL_MIN = 2500;
  var CHAT_POLL_MAX = 30000;

  function scheduleNextChatRefresh() {
    if (chatTimer) clearTimeout(chatTimer);
    if (document.visibilityState === 'hidden') {
      chatTimer = null;
      return;
    }
    chatTimer = setTimeout(async function() {
      var ok = false;
      try {
        var response = await fetch(chatUrl(), { credentials: 'same-origin' });
        var data = await response.json().catch(function() { return {}; });
        if (!response.ok || !data.ok) throw new Error(data.error || 'Ошибка загрузки чата');
        renderChatState(data);
        if (Array.isArray(data.messages)) {
          var videoPos = window.__aspbVideoPosition || 0;
          var isTestMode = data.testMode === true;
          data.messages.forEach(function(msg) {
            if (isTestMode && typeof msg.offsetSeconds === 'number' && msg.isSynthetic) {
              if (msg.offsetSeconds > videoPos + 2) return;
            }
            addMessage(msg);
          });
        }
        ok = true;
      } catch {
        setActivity('Чат временно недоступен, переподключаемся...');
      }
      chatPollInterval = ok
        ? CHAT_POLL_MIN
        : Math.min(chatPollInterval * 1.5, CHAT_POLL_MAX);
      scheduleNextChatRefresh();
    }, chatPollInterval);
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      chatPollInterval = CHAT_POLL_MIN;
      scheduleNextChatRefresh();
    } else if (chatTimer) {
      clearTimeout(chatTimer);
      chatTimer = null;
    }
  });

  refreshChat();
  scheduleNextChatRefresh();
})();
