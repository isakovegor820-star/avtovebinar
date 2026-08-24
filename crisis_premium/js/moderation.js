import { getJson, patchJson, post } from './utils.js?v=question-moderation-2';

const typeLabels = {
  PARTICIPANT: 'Участник',
  MODERATOR: 'Модератор',
  PREPARED_QUESTION: 'Подготовленный вопрос',
  AI_MODERATOR: 'AI-модератор',
  SYSTEM: 'Системное сообщение',
};

const state = {
  sessions: [],
  currentSessionId: '',
  messages: [],
  questions: [],
};

const questionStatusLabels = {
  NEW: 'Новый',
  IN_REVIEW: 'На проверке',
  ACTION_REQUIRED: 'Нужен человек',
  RESOLVED: 'Решён',
  REJECTED: 'Отклонён',
};

function node(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const target = node(id);
  if (target) target.textContent = value;
}

function showMode(mode, focusId) {
  document.body.dataset.moderationMode = mode;
  if (focusId) window.requestAnimationFrame(() => node(focusId)?.focus());
}

function formatDate(value, timezone = 'Europe/Moscow') {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value));
}

function errorText(error) {
  if (error?.status === 401) return 'Сессия входа истекла. Войдите снова.';
  if (error?.status === 403) return 'Для этого раздела нужна роль модератора или владельца.';
  if (error?.status === 404) return 'Раздел выключен или объект принадлежит другой организации.';
  return navigator.onLine === false
    ? 'Нет соединения с интернетом. Подключитесь к сети и повторите.'
    : 'Не удалось загрузить данные. Обновите страницу и повторите.';
}

function renderError(error) {
  setText('moderationErrorText', errorText(error));
  showMode('error', 'moderationErrorTitle');
}

function renderSessions() {
  const select = node('moderationSession');
  select.replaceChildren();
  for (const session of state.sessions) {
    const option = document.createElement('option');
    option.value = session.id;
    option.textContent = `${session.webinarTitle} · ${formatDate(session.scheduledAt, session.timezone)}`;
    select.append(option);
  }
  if (!state.currentSessionId || !state.sessions.some(session => session.id === state.currentSessionId)) {
    state.currentSessionId = state.sessions[0]?.id || '';
  }
  select.value = state.currentSessionId;
}

function createText(className, value) {
  const target = document.createElement('p');
  target.className = className;
  target.textContent = value;
  return target;
}

function messageMatchesFilter(message) {
  const filter = node('moderationFilter').value;
  if (filter === 'hidden') return Boolean(message.hiddenAt);
  if (filter === 'visible') return !message.hiddenAt;
  return true;
}

function actionButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

async function applyMessageAction(message, reasonInput, button) {
  const reason = reasonInput.value.trim();
  reasonInput.removeAttribute('aria-invalid');
  if (reason.length < 3) {
    reasonInput.setAttribute('aria-invalid', 'true');
    reasonInput.focus();
    setText('moderationActionStatus', 'Укажите причину длиной не менее трёх символов.');
    return;
  }
  button.disabled = true;
  setText('moderationActionStatus', message.hiddenAt ? 'Восстанавливаем сообщение…' : 'Скрываем сообщение…');
  try {
    await patchJson(
      `/v1/moderation/sessions/${encodeURIComponent(state.currentSessionId)}/messages/${encodeURIComponent(message.id)}`,
      {
        action: message.hiddenAt ? 'RESTORE' : 'HIDE',
        reason,
        expectedRevision: message.moderationRevision,
      },
    );
    setText('moderationActionStatus', message.hiddenAt ? 'Сообщение восстановлено и снова видно в комнате.' : 'Сообщение скрыто из комнаты.');
    await loadMessages();
  } catch (error) {
    setText('moderationActionStatus', error?.payload?.error || 'Не удалось изменить сообщение. Обновите список и повторите.');
  } finally {
    button.disabled = false;
  }
}

async function applyRegistrationAction(message, reasonInput, button) {
  const reason = reasonInput.value.trim();
  reasonInput.removeAttribute('aria-invalid');
  if (reason.length < 3) {
    reasonInput.setAttribute('aria-invalid', 'true');
    reasonInput.focus();
    setText('moderationActionStatus', 'Укажите причину длиной не менее трёх символов.');
    return;
  }
  const blocked = Boolean(message.registrationChatBlockedAt);
  button.disabled = true;
  setText('moderationActionStatus', blocked ? 'Восстанавливаем доступ к чату…' : 'Блокируем доступ к чату…');
  try {
    await patchJson(
      `/v1/moderation/sessions/${encodeURIComponent(state.currentSessionId)}/registrations/${encodeURIComponent(message.registrationId)}/chat-access`,
      { action: blocked ? 'RESTORE' : 'BLOCK', reason },
    );
    setText('moderationActionStatus', blocked ? 'Доступ регистрации к чату восстановлен.' : 'Новые сообщения регистрации заблокированы.');
    await loadMessages();
  } catch (error) {
    setText('moderationActionStatus', error?.payload?.error || 'Не удалось изменить доступ к чату.');
  } finally {
    button.disabled = false;
  }
}

function renderMessage(message) {
  const item = document.createElement('li');
  item.className = 'moderation-message';
  item.dataset.hidden = String(Boolean(message.hiddenAt));

  const heading = document.createElement('div');
  heading.className = 'moderation-message-heading';
  const identity = document.createElement('div');
  const author = createText('font-bold text-primary', message.authorName || 'Без подписи');
  const time = createText('mt-1 text-label-sm text-on-surface-variant', formatDate(message.visibleAt));
  identity.append(author, time);
  const badges = document.createElement('div');
  badges.className = 'moderation-message-heading';
  const type = document.createElement('span');
  type.className = 'moderation-message-type';
  type.textContent = typeLabels[message.type] || 'Неизвестный тип';
  const visibility = document.createElement('span');
  visibility.className = 'moderation-message-state';
  visibility.dataset.state = message.hiddenAt ? 'hidden' : 'visible';
  visibility.textContent = message.hiddenAt ? 'Скрыто' : 'Видно в комнате';
  badges.append(type, visibility);
  heading.append(identity, badges);

  const text = createText('moderation-message-text mt-4 text-body-md leading-relaxed text-on-surface', message.message);
  item.append(heading, text);
  if (message.hiddenAt) {
    item.append(createText('mt-3 text-label-sm text-on-surface-variant', `Причина скрытия: ${message.hiddenReason || 'не указана'}`));
  }
  if (message.registrationId) {
    const access = createText('moderation-registration-state mt-3 text-label-sm font-bold', message.registrationChatBlockedAt ? 'Чат регистрации заблокирован' : 'Чат регистрации доступен');
    access.dataset.state = message.registrationChatBlockedAt ? 'blocked' : 'available';
    item.append(access);
  }

  const actions = document.createElement('div');
  actions.className = 'moderation-message-actions mt-5';
  const reasonId = `moderationReason-${message.id}`;
  const reasonField = document.createElement('div');
  reasonField.className = 'moderation-reason-field';
  const reasonLabel = document.createElement('label');
  reasonLabel.className = 'text-label-sm font-bold text-primary';
  reasonLabel.htmlFor = reasonId;
  reasonLabel.textContent = message.hiddenAt ? 'Причина восстановления' : 'Причина действия';
  const reasonInput = document.createElement('input');
  reasonInput.id = reasonId;
  reasonInput.className = 'platform-input px-4';
  reasonInput.maxLength = 500;
  reasonInput.required = true;
  reasonInput.placeholder = 'Например: персональные данные';
  reasonField.append(reasonLabel, reasonInput);
  actions.append(reasonField);

  const messageAction = actionButton(
    message.hiddenAt ? 'Восстановить сообщение' : 'Скрыть сообщение',
    message.hiddenAt ? 'platform-primary-button' : 'platform-secondary-button',
    event => void applyMessageAction(message, reasonInput, event.currentTarget),
  );
  actions.append(messageAction);
  if (message.registrationId) {
    const registrationAction = actionButton(
      message.registrationChatBlockedAt ? 'Вернуть доступ к чату' : 'Заблокировать чат регистрации',
      'platform-secondary-button',
      event => void applyRegistrationAction(message, reasonInput, event.currentTarget),
    );
    actions.append(registrationAction);
  }
  item.append(actions);
  return item;
}

function renderMessages() {
  const list = node('moderationMessageList');
  list.replaceChildren();
  const visibleMessages = state.messages.filter(messageMatchesFilter);
  node('moderationEmpty').hidden = visibleMessages.length > 0;
  setText('moderationMessageCount', `${visibleMessages.length} из ${state.messages.length}`);
  for (const message of visibleMessages) list.append(renderMessage(message));
}

function readQuestionReason(input) {
  const reason = input.value.trim();
  input.removeAttribute('aria-invalid');
  if (reason.length >= 3) return reason;
  input.setAttribute('aria-invalid', 'true');
  input.focus();
  setText('moderationQuestionActionStatus', 'Укажите причину длиной не менее трёх символов.');
  return '';
}

async function applyQuestionState(question, statusSelect, prioritySelect, reasonInput, button) {
  const reason = readQuestionReason(reasonInput);
  if (!reason) return;
  button.disabled = true;
  setText('moderationQuestionActionStatus', 'Сохраняем состояние вопроса…');
  try {
    await patchJson(
      `/v1/moderation/sessions/${encodeURIComponent(state.currentSessionId)}/questions/${encodeURIComponent(question.id)}`,
      {
        status: statusSelect.value,
        priority: prioritySelect.value,
        reason,
        expectedRevision: question.revision,
      },
    );
    setText('moderationQuestionActionStatus', 'Состояние сохранено в истории участника и CRM.');
    await loadQuestions();
  } catch (error) {
    setText('moderationQuestionActionStatus', error?.payload?.error || 'Не удалось сохранить состояние. Обновите очередь и повторите.');
  } finally {
    button.disabled = false;
  }
}

async function generateQuestionSuggestion(question, button) {
  button.disabled = true;
  setText('moderationQuestionActionStatus', 'Ищем основание только в опубликованных материалах…');
  try {
    await post(
      `/v1/moderation/sessions/${encodeURIComponent(state.currentSessionId)}/questions/${encodeURIComponent(question.id)}/suggestions`,
      { expectedRevision: question.revision },
    );
    setText('moderationQuestionActionStatus', 'Черновик подготовлен. Проверьте основание перед публикацией.');
    await loadQuestions();
  } catch (error) {
    setText('moderationQuestionActionStatus', error?.payload?.error || 'Не удалось подготовить черновик. Обновите очередь и повторите.');
  } finally {
    button.disabled = false;
  }
}

async function reviewQuestionSuggestion(question, action, reasonInput, button) {
  const reason = readQuestionReason(reasonInput);
  if (!reason || !question.suggestion) return;
  button.disabled = true;
  setText('moderationQuestionActionStatus', action === 'PUBLISH' ? 'Публикуем проверенный ответ…' : 'Отклоняем черновик…');
  try {
    await post(
      `/v1/moderation/sessions/${encodeURIComponent(state.currentSessionId)}/questions/${encodeURIComponent(question.id)}/suggestions/${encodeURIComponent(question.suggestion.id)}/review`,
      { action, reason, expectedQuestionRevision: question.revision },
    );
    setText(
      'moderationQuestionActionStatus',
      action === 'PUBLISH'
        ? 'Проверенный ответ опубликован в комнате.'
        : 'Черновик отклонён, вопрос оставлен человеку.',
    );
    await Promise.all([loadQuestions(), loadMessages()]);
  } catch (error) {
    setText('moderationQuestionActionStatus', error?.payload?.error || 'Не удалось рассмотреть черновик. Обновите очередь и повторите.');
  } finally {
    button.disabled = false;
  }
}

function renderSuggestion(question, reasonInput) {
  const suggestion = question.suggestion;
  if (!suggestion) return null;
  const block = document.createElement('section');
  block.className = 'moderation-suggestion mt-5';
  block.setAttribute('aria-label', 'Черновик AI-модератора');
  const heading = document.createElement('h3');
  heading.className = 'text-label-sm font-bold text-primary';
  heading.textContent = 'Черновик AI-модератора';
  const disclosure = createText(
    'mt-1 text-label-sm text-on-surface-variant',
    suggestion.status === 'PENDING'
      ? 'Не опубликован. Требуется проверка человека.'
      : suggestion.status === 'ACCEPTED'
        ? 'Опубликован после проверки человеком.'
        : 'Отклонён человеком.',
  );
  const answer = createText('moderation-message-text mt-3 text-body-md leading-relaxed text-on-surface', suggestion.answer);
  block.append(heading, disclosure, answer);
  if (suggestion.grounding?.type === 'transcript') {
    block.append(
      createText(
        'mt-3 text-label-sm text-on-surface-variant',
        `Основание: опубликованная расшифровка, версия ${suggestion.grounding.transcriptVersion}, таймкод ${suggestion.grounding.label}.`,
      ),
    );
  } else if (suggestion.grounding?.type === 'source') {
    const source = document.createElement('a');
    source.className = 'moderation-source-link mt-3';
    source.href = suggestion.grounding.url;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = `Открыть источник: ${suggestion.grounding.title}`;
    block.append(source);
  } else {
    block.append(createText('mt-3 text-label-sm font-bold text-on-surface-variant', 'Основание не найдено. Вопрос должен разобрать человек.'));
  }
  if (suggestion.status === 'PENDING') {
    const actions = document.createElement('div');
    actions.className = 'moderation-message-actions mt-4';
    actions.append(
      actionButton('Опубликовать после проверки', 'platform-primary-button', event =>
        void reviewQuestionSuggestion(question, 'PUBLISH', reasonInput, event.currentTarget),
      ),
      actionButton('Отклонить черновик', 'platform-secondary-button', event =>
        void reviewQuestionSuggestion(question, 'REJECT', reasonInput, event.currentTarget),
      ),
    );
    block.append(actions);
  }
  return block;
}

function renderQuestion(question) {
  const item = document.createElement('li');
  item.className = 'moderation-message moderation-question';
  const heading = document.createElement('div');
  heading.className = 'moderation-message-heading';
  const identity = document.createElement('div');
  identity.append(
    createText('font-bold text-primary', question.participantLabel),
    createText('mt-1 text-label-sm text-on-surface-variant', formatDate(question.createdAt)),
  );
  const badges = document.createElement('div');
  badges.className = 'moderation-message-heading';
  const status = document.createElement('span');
  status.className = 'moderation-message-state';
  status.dataset.state = question.status.toLocaleLowerCase('en-US');
  status.textContent = questionStatusLabels[question.status] || 'Неизвестное состояние';
  badges.append(status);
  if (question.priority === 'HIGH') {
    const priority = document.createElement('span');
    priority.className = 'moderation-message-state';
    priority.dataset.state = 'priority';
    priority.textContent = 'Приоритетный';
    badges.append(priority);
  }
  if (question.repeatCount > 1) {
    const repeated = document.createElement('span');
    repeated.className = 'moderation-message-type';
    repeated.textContent = `Повторяется: ${question.repeatCount}`;
    badges.append(repeated);
  }
  heading.append(identity, badges);
  item.append(heading, createText('moderation-message-text mt-4 text-body-md leading-relaxed text-on-surface', question.text));

  const reasonId = `questionReason-${question.id}`;
  const reasonField = document.createElement('div');
  reasonField.className = 'moderation-reason-field mt-5';
  const reasonLabel = document.createElement('label');
  reasonLabel.className = 'text-label-sm font-bold text-primary';
  reasonLabel.htmlFor = reasonId;
  reasonLabel.textContent = 'Причина решения';
  const reasonInput = document.createElement('input');
  reasonInput.id = reasonId;
  reasonInput.className = 'platform-input px-4';
  reasonInput.maxLength = 500;
  reasonInput.placeholder = 'Например: ответ проверен по расшифровке';
  reasonField.append(reasonLabel, reasonInput);
  item.append(reasonField);

  const suggestion = renderSuggestion(question, reasonInput);
  if (suggestion) item.append(suggestion);

  const controls = document.createElement('div');
  controls.className = 'moderation-question-controls mt-5';
  const statusField = document.createElement('label');
  statusField.className = 'moderation-filter-label';
  statusField.textContent = 'Состояние';
  const statusSelect = document.createElement('select');
  statusSelect.className = 'platform-input px-4';
  for (const [value, label] of Object.entries(questionStatusLabels)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    statusSelect.append(option);
  }
  statusSelect.value = question.status;
  statusField.append(statusSelect);
  const priorityField = document.createElement('label');
  priorityField.className = 'moderation-filter-label';
  priorityField.textContent = 'Приоритет';
  const prioritySelect = document.createElement('select');
  prioritySelect.className = 'platform-input px-4';
  prioritySelect.append(new Option('Обычный', 'NORMAL'), new Option('Высокий', 'HIGH'));
  prioritySelect.value = question.priority;
  priorityField.append(prioritySelect);
  controls.append(statusField, priorityField);
  controls.append(
    actionButton('Сохранить состояние', 'platform-secondary-button', event =>
      void applyQuestionState(question, statusSelect, prioritySelect, reasonInput, event.currentTarget),
    ),
  );
  if (
    (!question.suggestion || question.suggestion.status !== 'PENDING') &&
    ['NEW', 'IN_REVIEW', 'ACTION_REQUIRED'].includes(question.status)
  ) {
    controls.append(
      actionButton('Подготовить основанный черновик', 'platform-secondary-button', event =>
        void generateQuestionSuggestion(question, event.currentTarget),
      ),
    );
  }
  item.append(controls);
  return item;
}

function renderQuestions() {
  const list = node('moderationQuestionList');
  list.replaceChildren();
  node('moderationQuestionEmpty').hidden = state.questions.length > 0;
  setText('moderationQuestionCount', `Вопросов: ${state.questions.length}`);
  for (const question of state.questions) list.append(renderQuestion(question));
}

async function loadQuestions() {
  if (!state.currentSessionId) {
    state.questions = [];
    renderQuestions();
    return;
  }
  const list = node('moderationQuestionList');
  list.setAttribute('aria-busy', 'true');
  try {
    const queue = node('moderationQuestionQueue').value;
    const result = await getJson(
      `/v1/moderation/sessions/${encodeURIComponent(state.currentSessionId)}/questions?queue=${encodeURIComponent(queue)}`,
    );
    state.questions = result.questions || [];
    renderQuestions();
  } catch (error) {
    state.questions = [];
    renderQuestions();
    setText('moderationQuestionActionStatus', errorText(error));
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

async function loadMessages() {
  if (!state.currentSessionId) {
    state.messages = [];
    renderMessages();
    setText('moderationSessionSummary', 'У организации пока нет доступных сессий.');
    return;
  }
  const list = node('moderationMessageList');
  list.setAttribute('aria-busy', 'true');
  setText('moderationSessionSummary', 'Загружаем сообщения выбранной сессии…');
  try {
    const result = await getJson(`/v1/moderation/sessions/${encodeURIComponent(state.currentSessionId)}/messages`);
    state.messages = result.messages || [];
    renderMessages();
    setText('moderationSessionSummary', `${result.session.title} · ${formatDate(result.session.scheduledAt, result.session.timezone)}`);
  } catch (error) {
    state.messages = [];
    renderMessages();
    setText('moderationSessionSummary', errorText(error));
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

async function bootstrap() {
  try {
    const auth = await getJson('/v1/auth/session');
    const membership = auth.memberships?.find(item => item.organizationId === auth.activeOrganizationId);
    if (!membership || !['OWNER', 'MODERATOR'].includes(membership.role)) {
      throw { status: 403 };
    }
    const result = await getJson('/v1/moderation/sessions');
    state.sessions = result.sessions || [];
    renderSessions();
    showMode('content', 'moderationHeading');
    await Promise.all([loadQuestions(), loadMessages()]);
  } catch (error) {
    renderError(error);
  }
}

node('moderationSession').addEventListener('change', event => {
  state.currentSessionId = event.currentTarget.value;
  void Promise.all([loadQuestions(), loadMessages()]);
});
node('moderationRefreshButton').addEventListener('click', () => void Promise.all([loadQuestions(), loadMessages()]));
node('moderationFilter').addEventListener('change', renderMessages);
node('moderationQuestionQueue').addEventListener('change', () => void loadQuestions());

void bootstrap();
