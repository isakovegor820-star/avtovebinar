import { deleteJson, getJson, patchJson, post } from './utils.js';

const node = id => document.getElementById(id);
const stateLabels = {
  upcoming: 'Предстоит',
  available: 'Доступен',
  expired: 'Срок истёк',
  revoked: 'Доступ отозван',
  unavailable: 'Сессия недоступна',
};

function setMode(mode) {
  document.body.dataset.accountMode = mode;
}

function setStatus(message, state = '') {
  const status = node('accountStatus');
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function safeDateTime(value, timezone) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(
      new Date(value),
    );
  }
}

function pluralNotes(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} заметок`;
  if (mod10 === 1) return `${count} заметка`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} заметки`;
  return `${count} заметок`;
}

function createText(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function createWebinarCard(item) {
  const card = document.createElement('article');
  card.className = 'account-card';
  const heading = createText('h3', '', item.title);
  const state = createText('p', 'account-card-state', stateLabels[item.accessState] || 'Статус не указан');
  state.dataset.state = item.accessState;
  const date = createText(
    'p',
    'account-card-meta',
    `${safeDateTime(item.scheduledAt, item.timezone)} · ${item.timezone}`,
  );
  card.append(heading, state, date);
  if (item.accessExpiresAt) {
    card.append(
      createText(
        'p',
        'account-card-meta',
        `Доступ до ${safeDateTime(item.accessExpiresAt, item.timezone)} (${item.timezone})`,
      ),
    );
  }

  const progress = document.createElement('progress');
  progress.max = 100;
  progress.value = item.progress.percent;
  progress.setAttribute('aria-label', `Прогресс просмотра: ${item.progress.percent}%`);
  const progressCopy = createText(
    'p',
    'account-card-progress-copy',
    `Просмотрено ${item.progress.percent}% · ${pluralNotes(item.noteCount)}`,
  );
  card.append(progress, progressCopy);

  if (item.accessState === 'upcoming' || item.accessState === 'available') {
    const actions = document.createElement('div');
    actions.className = 'account-card-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'activate-registration';
    button.dataset.registrationId = item.registrationId;
    button.textContent = item.accessState === 'upcoming' ? 'Открыть страницу сессии' : 'Продолжить просмотр';
    actions.append(button);
    card.append(actions);
  }
  return card;
}

function createSavedCard(item) {
  const card = document.createElement('article');
  card.className = 'account-card';
  card.append(
    createText('h3', '', item.title),
    createText(
      'p',
      'account-card-state',
      item.accessGranted ? 'Есть доступ' : 'Сохранено без доступа',
    ),
    createText('p', 'account-card-meta', `Сохранено ${safeDateTime(item.savedAt, 'Europe/Moscow')}`),
  );
  const actions = document.createElement('div');
  actions.className = 'account-card-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.dataset.action = 'remove-favorite';
  remove.dataset.webinarId = item.webinarId;
  remove.textContent = 'Удалить из сохранённых';
  actions.append(remove);
  card.append(actions);
  return card;
}

function renderSection(id, items, cardFactory, emptyId) {
  const container = node(id);
  container.replaceChildren(...items.map(cardFactory));
  if (emptyId) node(emptyId).hidden = items.length > 0;
}

function renderDashboard(data) {
  node('accountOrganization').textContent = `Организация: ${data.organization.name}`;
  renderSection('accountUpcoming', data.sections.upcoming, createWebinarCard, 'accountUpcomingEmpty');
  renderSection('accountRecordings', data.sections.recordings, createWebinarCard, 'accountRecordingsEmpty');
  renderSection('accountWatched', data.sections.watched, createWebinarCard, 'accountWatchedEmpty');
  renderSection('accountSaved', data.sections.saved, createSavedCard, 'accountSavedEmpty');
  renderSection('accountUnavailable', data.sections.unavailable, createWebinarCard);
  node('accountUnavailableSection').hidden = data.sections.unavailable.length === 0;
}

function renderPreferences(data) {
  const form = node('accountNotificationForm');
  for (const [name, enabled] of Object.entries(data.preferences)) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) input.checked = Boolean(enabled);
  }
  node('accountServiceNotice').textContent = data.serviceNotice;
}

async function activateRegistration(button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = 'Открываем…';
  setStatus('Проверяем доступ к выбранной сессии.');
  try {
    const result = await post(`/v1/viewer/registrations/${encodeURIComponent(button.dataset.registrationId)}/activate`, {});
    window.location.assign(result.roomUrl || 'webinar.html');
  } catch {
    setStatus('Доступ завершён или отозван. Обновите кабинет.', 'error');
    button.disabled = false;
    button.textContent = previous;
  }
}

async function removeFavorite(button) {
  button.disabled = true;
  try {
    await deleteJson(`/v1/viewer/favorites/${encodeURIComponent(button.dataset.webinarId)}`);
    button.closest('.account-card')?.remove();
    if (!node('accountSaved').children.length) node('accountSavedEmpty').hidden = false;
    setStatus('Вебинар удалён из сохранённых.', 'success');
  } catch {
    setStatus('Не удалось изменить сохранённые. Повторите.', 'error');
    button.disabled = false;
  }
}

async function savePreferences(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  node('accountSettingsStatus').textContent = 'Сохраняем…';
  const payload = {};
  for (const name of [
    'marketingEmailEnabled',
    'marketingTelegramEnabled',
    'serviceEmailEnabled',
    'serviceTelegramEnabled',
  ]) {
    payload[name] = Boolean(form.elements.namedItem(name)?.checked);
  }
  try {
    const result = await patchJson('/v1/viewer/notifications', payload);
    renderPreferences({ ...result, serviceNotice: node('accountServiceNotice').textContent });
    node('accountSettingsStatus').textContent = 'Настройки сохранены. Рекламные и сервисные каналы остаются разделены.';
    node('accountSettingsStatus').dataset.state = 'success';
  } catch {
    node('accountSettingsStatus').textContent = 'Не удалось сохранить настройки. Повторите.';
    node('accountSettingsStatus').dataset.state = 'error';
  } finally {
    button.disabled = false;
  }
}

async function initialize() {
  try {
    const [dashboard, notifications] = await Promise.all([
      getJson('/v1/viewer/dashboard'),
      getJson('/v1/viewer/notifications'),
    ]);
    renderDashboard(dashboard);
    renderPreferences(notifications);
    setMode('content');
  } catch (error) {
    node('accountErrorText').textContent =
      error?.status === 0
        ? 'Сервер не ответил. Проверьте подключение и обновите страницу.'
        : 'Войдите по безопасной ссылке из письма, чтобы увидеть свои материалы.';
    setMode('error');
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'activate-registration') void activateRegistration(button);
  if (button.dataset.action === 'remove-favorite') void removeFavorite(button);
});
node('accountNotificationForm').addEventListener('submit', savePreferences);
void initialize();
