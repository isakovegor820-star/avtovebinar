import { getJson } from './utils.js?v=creator-preview-1';

const statusLabels = { DRAFT: 'Черновик', NEEDS_REVIEW: 'Нужны изменения', READY: 'Готов к публикации', IN_MODERATION: 'На модерации', PUBLISHED: 'Опубликован', ARCHIVED: 'В архиве' };
const visibilityLabels = { PUBLIC: 'Публичный', UNLISTED: 'По ссылке', PRIVATE: 'По приглашению' };
const freshnessLabels = { CURRENT: 'Актуален', REVIEW_DUE: 'Требует проверки', OUTDATED: 'Устарел', SUPERSEDED: 'Заменён актуальной версией', UNKNOWN: 'Актуальность не определена' };
const mediaLabels = { NOT_UPLOADED: 'Видео не загружено', PROCESSING: 'Видео обрабатывается', READY: 'Видео готово', FAILED: 'Ошибка обработки видео' };
const kindLabels = { PREPARED_QUESTION: 'Подготовленный вопрос', MODERATOR_NOTICE: 'Подготовлено модератором', AUTHOR_PROMPT: 'Подготовлено автором' };

function node(id) { return document.getElementById(id); }
function setText(id, value) { node(id).textContent = value ?? ''; }
function setMode(mode, focusId) { document.body.dataset.previewMode = mode; if (focusId) requestAnimationFrame(() => node(focusId)?.focus()); }
function formatDateTime(value, timezone) { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone || undefined }).format(new Date(value)); }

function item(titleText, metaText, extraClass = '') {
  const entry = document.createElement('li');
  entry.className = `preview-item ${extraClass}`.trim();
  const title = document.createElement('p');
  title.className = 'preview-item-title';
  title.textContent = titleText;
  const meta = document.createElement('p');
  meta.className = 'mt-1 text-body-md';
  meta.textContent = metaText;
  entry.append(title, meta);
  return entry;
}

function renderPreview(payload, scenario) {
  const webinar = payload.webinar;
  setText('previewState', `Preview · ${statusLabels[webinar.contentStatus] || webinar.contentStatus}`);
  setText('previewTitle', webinar.title);
  setText('previewDescription', webinar.description || 'Описание пока не добавлено.');
  setText('previewAuthor', webinar.author?.publicName || 'Автор не выбран');
  setText('previewFreshness', freshnessLabels[webinar.freshnessStatus] || webinar.freshnessStatus);
  setText('previewVisibility', visibilityLabels[webinar.visibility] || webinar.visibility);
  setText('previewMediaStatus', mediaLabels[webinar.mediaStatus] || webinar.mediaStatus);

  const sources = node('previewSources');
  sources.replaceChildren();
  node('previewSourcesEmpty').hidden = webinar.sources.length > 0;
  for (const source of webinar.sources) sources.append(item(source.title, source.url));

  const sessions = node('previewSessions');
  sessions.replaceChildren();
  node('previewSessionsEmpty').hidden = webinar.sessions.length > 0;
  for (const session of webinar.sessions) sessions.append(item(formatDateTime(session.scheduledAt, session.timezone), `${session.timezone} · ${session.durationMinutes} мин.`));

  const messages = node('previewScenario');
  messages.replaceChildren();
  node('previewScenarioEmpty').hidden = Boolean(scenario?.messages?.length);
  for (const message of scenario?.messages || []) {
    messages.append(item(`${kindLabels[message.kind] || message.kind} · ${message.offsetSeconds} с`, `${message.authorLabel}: ${message.text}`, 'preview-synthetic'));
  }
  setMode('content', 'previewTitle');
}

function showError(error) {
  if (error?.status === 401) { setText('previewErrorTitle', 'Сначала войдите в аккаунт'); setText('previewErrorText', 'Завершите вход на странице «Мой доступ» и повторите.'); }
  else if ([403, 404].includes(error?.status)) { setText('previewErrorTitle', 'Preview недоступен'); setText('previewErrorText', 'Вебинар не найден или не принадлежит выбранной организации.'); }
  else { setText('previewErrorTitle', 'Не удалось загрузить preview'); setText('previewErrorText', 'Проверьте соединение и обновите страницу.'); }
  setMode('error', 'previewErrorTitle');
}

async function start() {
  const webinarId = new URLSearchParams(location.hash.slice(1)).get('webinar');
  if (!webinarId) { showError({ status: 404 }); return; }
  node('previewBackLink').href = `creator-webinars.html#webinar=${encodeURIComponent(webinarId)}`;
  try {
    const [preview, scenario] = await Promise.all([
      getJson(`/v1/creator/webinars/${encodeURIComponent(webinarId)}/preview`),
      getJson(`/v1/creator/webinars/${encodeURIComponent(webinarId)}/chat-scenario`),
    ]);
    renderPreview(preview, scenario.scenario);
  } catch (error) { showError(error); }
}

void start();
