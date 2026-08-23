import { getJson, post, putJson, deleteJson, utm } from './utils.js';

const node = id => document.getElementById(id);
const labels = {
  freshness: {
    CURRENT: 'Актуален',
    REVIEW_DUE: 'Требует повторной проверки',
    OUTDATED: 'Устарел',
    SUPERSEDED: 'Заменён новой версией',
    UNKNOWN: 'Актуальность не указана',
  },
  format: { RECORDED: 'Запись', PREMIERE: 'Премьера', ON_DEMAND: 'По запросу' },
};
let currentWebinar = null;

function setMode(mode) {
  document.body.dataset.detailMode = mode;
}

function text(id, value, fallback = 'Не указано') {
  node(id).textContent = value || fallback;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
}

function formatDateTime(value, timezone) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: timezone || 'Europe/Moscow',
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(
      new Date(value),
    );
  }
}

function renderFreshness(webinar) {
  const notice = node('detailFreshnessNotice');
  const successor = node('detailSuccessorLink');
  successor.hidden = true;
  if (webinar.freshnessStatus === 'CURRENT') {
    notice.hidden = true;
    return;
  }
  const copy = {
    SUPERSEDED: ['Есть новая версия', 'Этот материал сохранён для истории, но автор опубликовал актуальную версию.'],
    OUTDATED: ['Материал устарел', 'Правовые сведения могли измениться. Проверьте дату актуальности и источники до применения.'],
    REVIEW_DUE: ['Требуется повторная проверка', 'Наступила дата плановой проверки материала автором.'],
    UNKNOWN: ['Актуальность не подтверждена', 'Для legacy-материала дата актуальности пока не указана.'],
  }[webinar.freshnessStatus] || ['Проверьте актуальность', 'Статус материала требует внимания.'];
  text('detailFreshnessTitle', copy[0]);
  text('detailFreshnessText', copy[1]);
  if (webinar.supersededBy) {
    successor.href = webinar.supersededBy.canonicalPath;
    successor.hidden = false;
  }
  notice.hidden = false;
}

function renderSessions(sessions) {
  const list = node('detailSessions');
  const items = (sessions || []).filter(session => session.lifecycleStatus !== 'CANCELLED');
  list.replaceChildren(
    ...items.map(session => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      const meta = document.createElement('div');
      title.textContent = formatDateTime(session.scheduledAt, session.timezone);
      meta.textContent = `${session.timezone} · ${session.durationMinutes} мин.`;
      item.append(title, meta);
      return item;
    }),
  );
  node('detailSessionsEmpty').hidden = items.length > 0;
}

function renderSources(sources) {
  const list = node('detailSources');
  list.replaceChildren(
    ...(sources || []).map(source => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = source.title;
      item.append(title);
      if (source.url) {
        const line = document.createElement('div');
        const link = document.createElement('a');
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = source.url;
        line.append(link);
        item.append(line);
      }
      if (source.accessedAt) {
        const accessed = document.createElement('div');
        accessed.textContent = `Дата обращения: ${formatDate(source.accessedAt)}`;
        item.append(accessed);
      }
      return item;
    }),
  );
  node('detailSourcesEmpty').hidden = (sources || []).length > 0;
}

function setRegistrationStatus(message, state = '') {
  const status = node('detailRegistrationStatus');
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function configureRegistration(webinar) {
  currentWebinar = webinar;
  const form = node('detailRegistrationForm');
  const select = node('detailRegistrationSession');
  const field = node('detailSessionField');
  const button = node('detailRegistrationButton');
  const sessions = webinar.sessions || [];
  select.replaceChildren(
    ...sessions.map(session => {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = `${formatDateTime(session.scheduledAt, session.timezone)} · ${session.timezone}`;
      option.selected = session.id === webinar.nextSession?.id;
      return option;
    }),
  );
  field.hidden = sessions.length <= 1;
  if (!sessions.length) {
    form.querySelectorAll('input, select, button').forEach(control => {
      control.disabled = true;
    });
    button.textContent = 'Нет доступной даты';
    setRegistrationStatus('Автор ещё не открыл дату для регистрации.');
  }
}

function registrationPayload(form) {
  const data = new FormData(form);
  return {
    sessionId: String(data.get('sessionId') || currentWebinar?.nextSession?.id || ''),
    name: String(data.get('name') || ''),
    email: String(data.get('email') || ''),
    phone: String(data.get('phone') || ''),
    companyWebsite: String(data.get('companyWebsite') || ''),
    personalDataConsent: data.get('personalDataConsent') === 'on',
    termsAccepted: data.get('termsAccepted') === 'on',
    marketingEmailConsent: data.get('marketingEmailConsent') === 'on',
    marketingTelegramConsent: data.get('marketingTelegramConsent') === 'on',
    ...utm(),
  };
}

async function submitRegistration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity() || !currentWebinar) return;
  const button = node('detailRegistrationButton');
  button.disabled = true;
  button.textContent = 'Регистрируем…';
  setRegistrationStatus('Проверяем данные и выбранную дату.');
  const params = new URLSearchParams({ organization: currentWebinar.organization.slug });
  try {
    const result = await post(
      `/v1/catalog/webinars/${encodeURIComponent(currentWebinar.canonicalSlug)}/register?${params.toString()}`,
      registrationPayload(form),
    );
    if (result.verificationRequired === false) {
      setRegistrationStatus('Вебинар добавлен в кабинет. Откройте «Мой кабинет» в меню.', 'success');
      button.textContent = 'Зарегистрировано';
      return;
    }
    setRegistrationStatus('Проверьте почту: мы отправили безопасную ссылку для подтверждения.', 'success');
    button.disabled = false;
    button.textContent = 'Отправить ссылку ещё раз';
  } catch (error) {
    setRegistrationStatus(
      error?.status === 0
        ? 'Сервер не ответил. Проверьте подключение и повторите.'
        : 'Не удалось зарегистрироваться на эту дату. Обновите страницу и повторите.',
      'error',
    );
    button.disabled = false;
    button.textContent = 'Зарегистрироваться';
  }
}

async function toggleFavorite() {
  if (!currentWebinar) return;
  const button = node('detailFavoriteButton');
  const saved = button.getAttribute('aria-pressed') === 'true';
  button.disabled = true;
  try {
    if (saved) {
      await deleteJson(`/v1/viewer/favorites/${encodeURIComponent(currentWebinar.id)}`);
      button.setAttribute('aria-pressed', 'false');
      button.textContent = 'Сохранить в кабинете';
      setRegistrationStatus('Удалено из сохранённых.');
    } else {
      await putJson(`/v1/viewer/favorites/${encodeURIComponent(currentWebinar.id)}`);
      button.setAttribute('aria-pressed', 'true');
      button.textContent = 'Сохранено';
      setRegistrationStatus('Вебинар сохранён. Это не меняет правила доступа.', 'success');
    }
  } catch {
    setRegistrationStatus('Сначала войдите или зарегистрируйтесь. Сохранение не открывает закрытый доступ.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function hydrateFavoriteState(webinarId) {
  try {
    const dashboard = await getJson('/v1/viewer/dashboard');
    const saved = dashboard.sections?.saved?.some(item => item.webinarId === webinarId);
    if (!saved) return;
    node('detailFavoriteButton').setAttribute('aria-pressed', 'true');
    node('detailFavoriteButton').textContent = 'Сохранено';
  } catch {
    // Anonymous visitors can register without learning whether another account exists.
  }
}

function render(webinar) {
  if (webinar.wasAlias) {
    const params = new URLSearchParams({ organization: webinar.organization.slug, webinar: webinar.canonicalSlug });
    window.history.replaceState(null, '', `catalog-webinar.html?${params.toString()}`);
  }
  if (webinar.visibility === 'UNLISTED') {
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement('meta');
      robots.name = 'robots';
      document.head.append(robots);
    }
    robots.content = 'noindex, nofollow, noarchive';
  }
  document.title = `${webinar.title} | АСПБ`;
  text('detailMetaLine', `${webinar.organization.name} · ${webinar.visibility === 'UNLISTED' ? 'Доступ по ссылке' : 'Публичный вебинар'}`);
  text('detailTitle', webinar.title);
  text('detailDescription', webinar.description, 'Описание готовится.');
  text('detailAuthor', webinar.author?.publicName);
  text('detailArea', [webinar.practiceArea?.name, webinar.specialization?.name].filter(Boolean).join(' · '));
  text('detailJurisdiction', webinar.jurisdiction?.name);
  text('detailFreshness', labels.freshness[webinar.freshnessStatus] || webinar.freshnessStatus);
  text('detailFormat', labels.format[webinar.format] || webinar.format);
  text('detailDuration', webinar.durationMinutes ? `${webinar.durationMinutes} мин.` : null);
  text('detailOutcome', webinar.outcomeDescription, 'Практический результат пока не описан.');
  text('detailAudience', webinar.targetAudience, 'Аудитория пока не указана.');
  text('detailAuthorName', webinar.author?.publicName);
  text('detailAuthorBio', webinar.author?.bio, 'Автор пока не добавил публичное описание.');
  text(
    'detailAuthorCredentials',
    [webinar.author?.professionalOrganization, webinar.author?.experience, webinar.author?.region]
      .filter(Boolean)
      .join(' · '),
    'Дополнительные сведения не указаны.',
  );
  text(
    'detailNextSession',
    webinar.nextSession
      ? `Ближайший запуск: ${formatDateTime(webinar.nextSession.scheduledAt, webinar.nextSession.timezone)}`
      : 'Новые даты ещё не назначены.',
  );
  text(
    'detailCurrentAsOf',
    webinar.currentAsOf ? `Материал актуален на ${formatDate(webinar.currentAsOf)}` : 'Дата актуальности не указана.',
  );
  text('detailDisclaimer', webinar.disclaimer, 'Правовой дисклеймер не опубликован.');
  text(
    'detailSyntheticDisclosure',
    webinar.syntheticDisclosure,
    'Подготовленные сообщения не используются в этом вебинаре либо маркировка не опубликована.',
  );
  renderFreshness(webinar);
  renderSessions(webinar.sessions);
  renderSources(webinar.sources);
  configureRegistration(webinar);
  const reportLink = node('detailReportLink');
  reportLink.href = `report.html?${new URLSearchParams({ targetType: 'WEBINAR', targetId: webinar.id }).toString()}`;
  reportLink.hidden = false;
  void hydrateFavoriteState(webinar.id);
}

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  const organization = params.get('organization')?.trim();
  const webinar = params.get('webinar')?.trim();
  if (!organization || !webinar) {
    setMode('error');
    return;
  }
  try {
    const payload = await getJson(
      `/v1/catalog/webinars/${encodeURIComponent(webinar)}?organization=${encodeURIComponent(organization)}`,
    );
    render(payload.webinar);
    setMode('content');
  } catch (error) {
    text(
      'detailErrorText',
      error?.status === 0
        ? 'Сервер не ответил вовремя. Проверьте подключение и попробуйте снова.'
        : 'Материал не найден, снят с публикации или доступен только по приглашению.',
    );
    setMode('error');
  }
}

node('detailRegistrationForm').addEventListener('submit', submitRegistration);
node('detailFavoriteButton').addEventListener('click', toggleFavorite);
initialize();
