/**
 * Server-backed live chat for the autowebinar room.
 * Chat state follows webinar server time, not local video playback.
 */
(function() {
  var API = window.location.protocol === 'file:' ? 'http://127.0.0.1:5174/api' : '/api';

  var renderedMessages = new Set();
  var activeContainer = null;
  var COLORS = ['#1e40af', '#7c3aed', '#0f766e', '#b45309', '#be123c', '#4338ca'];

  function getElements() {
    return {
      chatContainer: document.getElementById('liveChatMessages'),
      chatPanel: document.getElementById('webinarChatPanel'),
      input: document.getElementById('questionInput'),
      submit: document.getElementById('questionSubmit'),
      activity: document.getElementById('chatActivity'),
      onlineLabel: document.getElementById('chatOnlineLabel')
    };
  }

  function readCookie(name) {
    var prefix = name + '=';
    var item = document.cookie
      .split(';')
      .map(function(value) { return value.trim(); })
      .find(function(value) { return value.indexOf(prefix) === 0; });
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
  }

  function csrfHeaders() {
    var token = readCookie('aspb_csrf_token');
    return token ? { 'x-csrf-token': token } : {};
  }

  function chatUrl() {
    return API + '/webinar/chat/session/current';
  }

  function questionUrl() {
    return API + '/questions';
  }

  function setActivity(text) {
    var activity = getElements().activity;
    if (activity) activity.textContent = text;
  }

  function setOnlineLabel(text) {
    var onlineLabel = getElements().onlineLabel;
    if (onlineLabel) onlineLabel.textContent = text;
  }

  function setInputState(disabled, placeholder) {
    var elements = getElements();
    var input = elements.input;
    var submit = elements.submit;
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
    var chatContainer = getElements().chatContainer;
    if (!chatContainer) return;
    if (activeContainer !== chatContainer) {
      activeContainer = chatContainer;
      renderedMessages.clear();
    }
    if (!msg || renderedMessages.has(msg.id)) return;
    renderedMessages.add(msg.id);

    var item = document.createElement('div');
    item.className = 'flex gap-2.5 chat-msg-enter';
    item.style.animation = 'chatMsgIn 0.3s ease forwards';

    var avatarColor = msg.kind === 'ai_manager' ? '#041627' : getColor(msg.authorName);
    if (msg.kind === 'agent_question') avatarColor = '#7c2d12';
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
    if (msg.kind === 'agent_question') {
      text.style.fontWeight = '500';
      text.style.color = '#2f343c';
    }
    text.textContent = msg.message;

    body.append(author, text);
    item.append(avatar, body);
    chatContainer.appendChild(item);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  async function submitQuestion() {
    var elements = getElements();
    var input = elements.input;
    var submit = elements.submit;
    if (!input || !submit || submit.disabled) return;

    var text = input.value.trim();
    if (!text) return;

    submit.disabled = true;
    submit.classList.add('opacity-40');
    try {
      var response = await fetch(questionUrl(), {
        method: 'POST',
        credentials: 'include',
        headers: Object.assign({ 'Content-Type': 'application/json' }, csrfHeaders()),
        body: JSON.stringify({ text: text })
      });
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || !data.ok) throw new Error(data.error || 'Не удалось отправить вопрос');

      input.value = '';
      setActivity('Вопрос отправлен');
      setOnlineLabel('чат открыт');
      await refreshChat();
    } catch {
      setActivity('Не удалось отправить вопрос, попробуйте еще раз');
    } finally {
      submit.disabled = false;
      submit.classList.remove('opacity-40');
    }
  }

  function bindQuestionForm() {
    var elements = getElements();
    var input = elements.input;
    var submit = elements.submit;
    if (!input || !submit || submit.dataset.liveChatBound === 'true') return;

    submit.dataset.liveChatBound = 'true';
    input.dataset.liveChatBound = 'true';
    submit.addEventListener('click', submitQuestion);
    input.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') submitQuestion();
    });
  }

  function renderChatState(data) {
    var chatStatus = data.liveState && data.liveState.chatStatus;
    var demoLive = data.testMode === true;
    var elements = getElements();

    if (elements.chatPanel) elements.chatPanel.classList.remove('hidden');
    bindQuestionForm();

    if (!demoLive && (chatStatus === 'ended' || data.accessStatus === 'replay')) {
      setInputState(false, 'Задайте вопрос...');
      setActivity('Вебинар окончен, чат открыт');
      setOnlineLabel('чат открыт');
      return;
    }

    if (!demoLive && chatStatus === 'locked') {
      setInputState(false, 'Задайте вопрос...');
      setActivity('Чат открыт, можно задать вопрос');
      setOnlineLabel('чат открыт');
      return;
    }

    setInputState(false, 'Задайте вопрос...');
    setActivity('Чат открыт, можно задать вопрос');
    setOnlineLabel('чат открыт');
  }

  async function refreshChat() {
    if (!getElements().chatContainer) return;
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
      setOnlineLabel('переподключение');
    }
  }

  window.__liveChatRefresh = refreshChat;
  window.__liveChatAddMessage = addMessage;
  window.__liveChatBindQuestionForm = bindQuestionForm;

  bindQuestionForm();
  refreshChat();
  window.setInterval(refreshChat, 2500);
})();
