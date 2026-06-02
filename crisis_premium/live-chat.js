/**
 * Server-backed live chat for the autowebinar room.
 * Chat state follows webinar server time, not local video playback.
 */
(function() {
  var API = window.location.protocol === 'file:' ? 'http://127.0.0.1:5174/api' : '/api';
  var allowLocalTokenStorage = window.location.protocol === 'file:' ||
    ['localhost', '127.0.0.1', ''].indexOf(window.location.hostname) !== -1;
  var urlToken = new URLSearchParams(window.location.search).get('token') || '';
  var storedToken = '';

  try {
    storedToken = allowLocalTokenStorage ? window.localStorage.getItem('crisisPremiumToken') || '' : '';
  } catch {
    storedToken = '';
  }

  var token = urlToken || storedToken;
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
    return token
      ? API + '/webinar/chat/' + encodeURIComponent(token)
      : API + '/webinar/chat/session/current';
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
    return msg.authorRole ? msg.authorName + ', ' + msg.authorRole : msg.authorName;
  }

  function addMessage(msg) {
    if (!msg || renderedMessages.has(msg.id)) return;
    renderedMessages.add(msg.id);

    var item = document.createElement('div');
    item.className = 'flex gap-2.5 chat-msg-enter';
    item.style.animation = 'chatMsgIn 0.3s ease forwards';

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
    text.style.color = '#44474c';
    text.style.lineHeight = '1.4';
    text.style.margin = '2px 0 0';
    text.style.wordWrap = 'break-word';
    text.textContent = msg.message;

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
      setInputState(true, 'Эфир завершен');
      setActivity('Эфир завершен');
      setOnlineLabel('завершен');
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
        data.messages.forEach(addMessage);
      }
    } catch {
      setActivity('Чат временно недоступен, переподключаемся...');
    }
  }

  window.__liveChatRefresh = refreshChat;
  window.__liveChatAddMessage = addMessage;

  refreshChat();
  window.setInterval(refreshChat, 2500);
})();
