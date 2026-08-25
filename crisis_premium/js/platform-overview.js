import { getJson } from './utils.js?v=platform-overview-1';

const STATUS_LABELS = {
  ACTIVE: 'Организация активна',
  DRAFT: 'Черновик',
  NEEDS_REVIEW: 'Нужна проверка',
  READY: 'Готово',
  IN_MODERATION: 'На модерации',
  PUBLISHED: 'Опубликовано',
  ARCHIVED: 'В архиве',
  SCHEDULED: 'Запланирована',
  ROOM_OPEN: 'Комната открыта',
  LIVE: 'Идёт премьера',
  REPLAY: 'Доступна запись',
  CLOSED: 'Завершена',
  CANCELLED: 'Отменена',
  complete: 'Готово',
  in_progress: 'В работе',
  blocked: 'Заблокировано',
  not_started: 'Не начато',
};

const VISIBILITY_LABELS = {
  PUBLIC: 'Открытый доступ',
  UNLISTED: 'По прямой ссылке',
  PRIVATE: 'Закрытый доступ',
};

function element(tag, options = {}) {
  const result = document.createElement(tag);
  if (options.className) result.className = options.className;
  if (options.text !== undefined) result.textContent = options.text;
  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) result.setAttribute(name, value);
  }
  return result;
}

function byId(id) {
  return document.getElementById(id);
}

function setMode(mode) {
  document.body.dataset.overviewMode = mode;
}

function plural(value, one, few, many) {
  const number = Math.abs(Number(value) || 0);
  const mod100 = number % 100;
  const mod10 = number % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function selectedWebinarId() {
  return new URLSearchParams(location.search).get('webinar') || '';
}

function dateTime(value, timezone) {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(value));
}

function shortDate(value, timezone) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(value));
}

function toneForStatus(value) {
  if (['ACTIVE', 'READY', 'PUBLISHED', 'complete'].includes(value)) return 'success';
  if (['NEEDS_REVIEW', 'IN_MODERATION', 'blocked'].includes(value)) return 'warning';
  if (['SCHEDULED', 'ROOM_OPEN', 'LIVE', 'REPLAY', 'in_progress'].includes(value)) return 'info';
  return 'neutral';
}

function renderHeader(payload) {
  const creatorAccess = ['OWNER', 'AUTHOR'].includes(payload.membership.role);
  const firstName = String(payload.user.displayName || '').trim().split(/\s+/)[0];
  byId('overviewGreeting').textContent = firstName ? `Здравствуйте, ${firstName}` : 'Здравствуйте';
  byId('overviewOrganizationCopy').textContent = `${payload.organization.name} · ${payload.organization.timezone}. Данные обновлены по состоянию на серверное время.`;
  const status = byId('overviewOrganizationStatus');
  status.textContent = STATUS_LABELS[payload.organization.status] || payload.organization.status;
  status.dataset.tone = toneForStatus(payload.organization.status);
  byId('overviewCreateWebinar').hidden = !creatorAccess;
  byId('overviewOrganizationLink').hidden = payload.membership.role !== 'OWNER';
  byId('nextSessionSetupLink').hidden = !creatorAccess;
  byId('readinessCreateLink').hidden = !creatorAccess;
  byId('overviewReadinessCard').hidden = !creatorAccess;
  byId('overviewPublicationsCard').hidden = !creatorAccess;
  byId('overviewCommandGrid').dataset.singleCard = String(!creatorAccess);
  byId('overviewOperationsGrid').dataset.singleCard = String(!creatorAccess);
  if (!creatorAccess) {
    byId('nextSessionEmptyCopy').textContent = 'Запланированные вебинары активной организации появятся здесь.';
  }
}

function renderNextSession(payload) {
  const session = payload.nextSession;
  byId('nextSessionContent').hidden = !session;
  byId('nextSessionEmpty').hidden = Boolean(session);
  const badge = byId('nextSessionState');
  if (!session) {
    badge.textContent = 'Не запланировано';
    badge.dataset.tone = 'neutral';
    return;
  }
  badge.textContent = STATUS_LABELS[session.lifecycleStatus] || session.lifecycleStatus;
  badge.dataset.tone = toneForStatus(session.lifecycleStatus);
  byId('nextSessionWebinar').textContent = session.webinar.title;
  byId('nextSessionDate').textContent = dateTime(session.scheduledAt, session.timezone);
  byId('nextSessionName').textContent = session.title;
  byId('nextSessionRegistrations').textContent = String(session.registrationCount);
  byId('nextSessionDuration').textContent = `${session.durationMinutes} мин.`;
  byId('nextSessionLink').href = `creator-webinars.html#webinar=${encodeURIComponent(session.webinar.id)}&step=7`;
}

function renderReadiness(payload) {
  const select = byId('overviewWebinarSelect');
  select.replaceChildren();
  for (const webinar of payload.webinarOptions) {
    const option = element('option', { text: webinar.title, attributes: { value: webinar.id } });
    option.selected = webinar.id === payload.selectedWebinar?.id;
    select.append(option);
  }
  const selected = payload.selectedWebinar;
  byId('readinessContent').hidden = !selected;
  byId('readinessEmpty').hidden = Boolean(selected);
  select.hidden = !selected;
  if (!selected?.readiness) return;
  const readiness = selected.readiness;
  const complete = readiness.steps.filter(step => step.status === 'complete').length;
  byId('readinessProgress').value = complete;
  byId('readinessProgress').textContent = `${complete} из 8`;
  byId('readinessSummary').textContent = `${complete} из 8 ${plural(complete, 'шага готово', 'шагов готовы', 'шагов готовы')}`;
  byId('readinessSteps').replaceChildren(...readiness.steps.map(step => {
    const item = element('li');
    item.dataset.state = step.status;
    item.append(
      element('strong', { text: `${step.number}. ${step.label}` }),
      element('span', { text: STATUS_LABELS[step.status] || step.status }),
    );
    return item;
  }));
  const firstBlocker = readiness.blockers[0];
  byId('readinessLink').href = `creator-webinars.html#webinar=${encodeURIComponent(selected.id)}&step=${firstBlocker?.step || 8}`;
  byId('readinessLink').textContent = readiness.publicationReady ? 'Открыть публикацию' : 'Продолжить подготовку';
}

function renderAttention(payload) {
  const list = byId('attentionList');
  list.replaceChildren(...payload.attention.map(item => {
    const row = element('li');
    row.dataset.kind = item.kind;
    const link = element('a', { attributes: { href: item.href } });
    const copy = element('span', { className: 'overview-list-copy' });
    copy.append(element('strong', { text: item.title }), element('span', { text: item.detail }));
    const arrow = element('span', { className: 'overview-list-arrow', text: '→', attributes: { 'aria-hidden': 'true' } });
    link.append(copy, arrow);
    row.append(link);
    return row;
  }));
  byId('attentionCount').textContent = String(payload.attention.length);
  byId('attentionEmpty').hidden = payload.attention.length > 0;
}

function renderMetrics(payload) {
  const metrics = payload.metrics;
  byId('metricsList').hidden = !metrics;
  byId('metricsUnavailable').hidden = Boolean(metrics);
  if (!metrics) return;
  byId('metricRegistrations').textContent = String(metrics.registrations);
  byId('metricViews').textContent = String(metrics.uniqueEntries);
  byId('metricQuestions').textContent = String(metrics.questions);
  byId('metricCta').textContent = String(metrics.ctaActions);
  const from = new Date(metrics.period.from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const to = new Date(new Date(metrics.period.toExclusive).getTime() - 1).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  byId('metricsPeriod').textContent = `${from} — ${to}, UTC. Повторные и фоновые события исключены.`;
}

function renderCrm(payload) {
  const crm = payload.crm;
  byId('crmQueues').hidden = !crm;
  byId('crmTimezone').hidden = !crm;
  byId('crmUnavailable').hidden = Boolean(crm);
  if (!crm) return;
  byId('crmToday').textContent = String(crm.counts.today);
  byId('crmOverdue').textContent = String(crm.counts.overdue);
  byId('crmWithoutTask').textContent = String(crm.counts.withoutTask);
  byId('crmTimezone').textContent = `Сегодня: ${crm.localDate}. Часовой пояс: ${crm.timezone}.`;
}

function renderPublications(payload) {
  const list = byId('publicationsList');
  list.replaceChildren(...payload.publications.map(item => {
    const row = element('li');
    const link = element('a', { attributes: { href: item.href } });
    const copy = element('span', { className: 'overview-list-copy' });
    copy.append(
      element('strong', { text: item.title }),
      element('span', { text: `${STATUS_LABELS[item.contentStatus] || item.contentStatus} · ${VISIBILITY_LABELS[item.visibility] || 'Доступ настроен'}` }),
    );
    const status = element('span', { className: 'overview-status', text: STATUS_LABELS[item.contentStatus] || item.contentStatus });
    status.dataset.tone = toneForStatus(item.contentStatus);
    link.append(copy, status);
    row.append(link);
    return row;
  }));
  byId('publicationsEmpty').hidden = payload.publications.length > 0;
}

function renderActivity(payload) {
  const list = byId('activityList');
  list.replaceChildren(...payload.activity.map(item => {
    const row = element('li');
    const time = element('time', { text: shortDate(item.occurredAt, payload.organization.timezone), attributes: { datetime: item.occurredAt } });
    row.append(element('strong', { text: item.label }), element('span', { text: item.actor }), time);
    return row;
  }));
  byId('activityEmpty').hidden = payload.activity.length > 0;
}

function render(payload) {
  renderHeader(payload);
  renderNextSession(payload);
  renderReadiness(payload);
  renderAttention(payload);
  renderMetrics(payload);
  renderCrm(payload);
  renderPublications(payload);
  renderActivity(payload);
  byId('overviewStatus').textContent = `Обзор обновлён ${shortDate(payload.generatedAt, payload.organization.timezone)}.`;
  setMode('content');
}

function renderError(error) {
  const title = byId('overviewErrorTitle');
  const text = byId('overviewErrorText');
  if (error?.status === 401) {
    title.textContent = 'Сначала войдите в платформу';
    text.textContent = 'Откройте защищённую ссылку из письма или запросите новую на странице входа.';
  } else if (error?.status === 403) {
    title.textContent = 'Обзор недоступен для этой роли';
    text.textContent = 'Выберите другую организацию или обратитесь к владельцу команды.';
  } else if (error?.status === 404) {
    title.textContent = 'Обзор ещё не включён';
    text.textContent = 'Рабочий контур организации пока закрыт политикой запуска. Действующие публичные сценарии не изменены.';
  } else {
    title.textContent = 'Не удалось загрузить обзор';
    text.textContent = navigator.onLine === false
      ? 'Нет соединения с интернетом. Подключитесь к сети и повторите.'
      : 'Сервер не вернул данные. Повторите запрос; выбранная организация сохранится.';
  }
  setMode('error');
  title.focus();
}

async function load() {
  setMode('loading');
  const webinar = selectedWebinarId();
  try {
    render(await getJson(`/v1/platform/overview${webinar ? `?webinarId=${encodeURIComponent(webinar)}` : ''}`));
  } catch (error) {
    renderError(error);
  }
}

byId('overviewRetry').addEventListener('click', load);
byId('overviewWebinarSelect').addEventListener('change', event => {
  const params = new URLSearchParams(location.search);
  params.set('webinar', event.target.value);
  history.pushState({}, '', `platform-overview.html?${params}`);
  void load();
});
window.addEventListener('popstate', load);

void load();
