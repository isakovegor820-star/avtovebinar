import { getJson, patchJson, post } from './utils.js?v=site-review-7';

const allowedTransitions = {
  NEW: ['IN_REVIEW', 'REJECTED'],
  IN_REVIEW: ['ACTION_REQUIRED', 'RESOLVED', 'REJECTED'],
  ACTION_REQUIRED: ['IN_REVIEW', 'RESOLVED', 'REJECTED'],
  RESOLVED: ['IN_REVIEW'],
  REJECTED: ['IN_REVIEW'],
};
const statusLabels = { NEW: 'Новая', IN_REVIEW: 'На рассмотрении', ACTION_REQUIRED: 'Нужно действие', RESOLVED: 'Решена', REJECTED: 'Отклонена' };
const categoryLabels = { CONTENT: 'Контент', AUTHOR: 'Автор', RIGHTS: 'Нарушение прав' };
const platformStatusLabels = {
  ACTIVE: 'Активна', SUSPENDED: 'Приостановлена', ARCHIVED: 'В архиве',
  PENDING: 'Ожидает', PROCESSING: 'В работе', RUNNING: 'В работе', COMPLETED: 'Завершено',
  READY: 'Готово', FAILED: 'Ошибка', CANCELLED: 'Отменено', CANCELED: 'Отменено',
  PAUSED: 'Приостановлено', SENT: 'Отправлено', DEAD: 'Требует разбора',
  DRAFT: 'Черновик', PUBLISHED: 'Опубликовано', DEPRECATED: 'Устарело',
  active: 'Активна', suspended: 'Приостановлена', archived: 'В архиве', pending: 'Ожидает',
  processing: 'В работе', running: 'В работе', completed: 'Завершено', ready: 'Готово',
  failed: 'Ошибка', cancelled: 'Отменено', canceled: 'Отменено', paused: 'Приостановлено',
  sent: 'Отправлено', dead: 'Требует разбора',
};
const form = document.getElementById('reportFilters');
const list = document.getElementById('reportList');

function textElement(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function setStatus(value) { document.getElementById('queueStatus').textContent = value; }

function replaceText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function aggregateValue(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('ru-RU').format(value) : 'Скрыто';
}

function renderOrganizationAnalytics(payload) {
  const organizations = new Map();
  for (const row of payload.rows || []) {
    const current = organizations.get(row.organizationId) || {
      name: row.organizationName,
      registrations: 0,
      activeIdentities: 0,
      questions: 0,
      ctaActions: 0,
      visible: { registrations: false, activeIdentities: false, questions: false, ctaActions: false },
    };
    for (const key of ['registrations', 'activeIdentities', 'questions', 'ctaActions']) {
      if (Number.isFinite(row[key])) {
        current[key] += row[key];
        current.visible[key] = true;
      }
    }
    organizations.set(row.organizationId, current);
  }
  const body = document.getElementById('organizationAnalyticsRows');
  body.replaceChildren(...[...organizations.values()].map(organization => {
    const row = document.createElement('tr');
    const values = [
      organization.name,
      aggregateValue(organization.visible.registrations ? organization.registrations : null),
      aggregateValue(organization.visible.activeIdentities ? organization.activeIdentities : null),
      aggregateValue(organization.visible.questions ? organization.questions : null),
      aggregateValue(organization.visible.ctaActions ? organization.ctaActions : null),
    ];
    row.append(...values.map(value => textElement('td', '', value)));
    return row;
  }));
  replaceText(
    'organizationAnalyticsStatus',
    organizations.size
      ? `Период в UTC · privacy threshold: ${payload.privacyThreshold}. Содержимое чата, заметки и контакты исключены.`
      : 'Организаций в агрегате за период нет.',
  );
}

function readableStatus(status) {
  return platformStatusLabels[status] || String(status || 'Не указан').replaceAll('_', ' ').toLocaleLowerCase('ru-RU');
}

function renderDirectory(payload) {
  const organizations = payload.organizations?.items || [];
  const organizationRows = document.getElementById('organizationDirectoryRows');
  organizationRows.replaceChildren(...organizations.map(organization => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.append(
      textElement('strong', '', organization.name),
      textElement('small', 'admin-secondary', organization.slug),
    );
    row.append(
      nameCell,
      textElement('td', '', readableStatus(organization.status)),
      textElement('td', '', new Intl.NumberFormat('ru-RU').format(organization._count?.memberships || 0)),
      textElement('td', '', new Intl.NumberFormat('ru-RU').format(organization._count?.webinars || 0)),
      textElement('td', '', String(organization.platformRevision)),
    );
    return row;
  }));
  replaceText('organizationMetric', new Intl.NumberFormat('ru-RU').format(organizations.length));
  replaceText(
    'organizationDirectoryStatus',
    organizations.length
      ? `${organizations.length} организаций${payload.organizations?.truncated ? ' · показаны первые 100' : ''}`
      : 'Организаций пока нет.',
  );

  const renderTaxonomy = (items, listId, statusId, truncated) => {
    const taxonomyList = document.getElementById(listId);
    const nodes = items.length
      ? items.map(item => {
          const node = document.createElement('li');
          node.append(
            textElement('strong', '', item.name),
            textElement('span', '', readableStatus(item.status)),
            textElement('small', '', `Код: ${item.slug || item.code} · ревизия ${item.platformRevision}`),
          );
          return node;
        })
      : [textElement('li', 'control-empty', 'Справочник пока пуст.')];
    taxonomyList.replaceChildren(...nodes);
    replaceText(statusId, `${items.length} записей${truncated ? ' · показаны первые 500' : ''}`);
  };
  renderTaxonomy(
    payload.taxonomy?.practiceAreas || [],
    'practiceAreasList',
    'practiceAreasStatus',
    payload.taxonomy?.practiceAreasTruncated,
  );
  renderTaxonomy(
    payload.taxonomy?.jurisdictions || [],
    'jurisdictionsList',
    'jurisdictionsStatus',
    payload.taxonomy?.jurisdictionsTruncated,
  );

  const queueRows = document.getElementById('deliveryQueueRows');
  const queues = payload.queues || [];
  queueRows.replaceChildren(...queues.map(queue => {
    const row = document.createElement('tr');
    row.append(
      textElement('td', '', queue.label),
      textElement('td', '', new Intl.NumberFormat('ru-RU').format(queue.total || 0)),
      textElement(
        'td',
        '',
        queue.states?.length
          ? queue.states.map(state => `${readableStatus(state.status)}: ${new Intl.NumberFormat('ru-RU').format(state.count)}`).join(' · ')
          : 'Очередь пуста',
      ),
    );
    return row;
  }));
  replaceText('deliveryQueuesStatus', queues.length ? 'Состояния обновлены' : 'Очереди не найдены');
}

function renderFeatureFlags(payload) {
  const list = document.getElementById('featureFlagsList');
  list.replaceChildren(...(payload.flags || []).map(flag => {
    const item = document.createElement('li');
    item.append(
      textElement('strong', '', flag.key),
      textElement('span', '', flag.enabled ? 'Включён' : 'Выключен'),
      textElement('small', '', flag.description || `Ревизия ${flag.revision}`),
    );
    return item;
  }));
  const active = (payload.flags || []).filter(flag => flag.enabled).length;
  replaceText('featureMetric', new Intl.NumberFormat('ru-RU').format(active));
  replaceText('featureFlagsStatus', payload.flags?.length ? `${payload.flags.length} флагов` : 'Флагов нет');
}

function renderRollouts(payload) {
  const list = document.getElementById('rolloutList');
  list.replaceChildren(...(payload.policies || []).map(policy => {
    const item = document.createElement('li');
    const mode = policy.mode || policy.defaultMode || policy.strategy || 'Политика настроена';
    item.append(
      textElement('strong', '', policy.feature),
      textElement('span', '', String(mode)),
      textElement('small', '', `Индивидуальных настроек: ${policy.entries?.length || 0}`),
    );
    return item;
  }));
  replaceText('rolloutStatus', payload.policies?.length ? `${payload.policies.length} политик` : 'Политик нет');
}

async function loadHealth() {
  const response = await fetch('/api/health/ready', { credentials: 'same-origin', cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  const metric = document.getElementById('healthMetric');
  const ready = response.ok && payload.ok === true;
  metric.textContent = ready ? 'Готов' : 'Нужно внимание';
  metric.dataset.state = ready ? 'ready' : 'degraded';
  replaceText('healthDetail', ready ? 'Критические зависимости отвечают.' : 'Откройте детали health в защищённом ops-контуре.');
}

async function loadPlatformSummary() {
  const results = await Promise.allSettled([
    getJson('/admin/platform/directory'),
    getJson('/admin/analytics/organizations'),
    getJson('/admin/platform/feature-flags'),
    getJson('/admin/platform/tenant-rollouts'),
    loadHealth(),
  ]);
  if (results[0].status === 'fulfilled') renderDirectory(results[0].value);
  else {
    const message = results[0].reason?.status === 403 ? 'Недостаточно полномочий platform admin.' : 'Список не загружен. Повторите позже.';
    replaceText('organizationDirectoryStatus', message);
    replaceText('practiceAreasStatus', 'Справочник не загружен');
    replaceText('jurisdictionsStatus', 'Справочник не загружен');
    replaceText('deliveryQueuesStatus', 'Состояния не загружены');
  }
  if (results[1].status === 'fulfilled') renderOrganizationAnalytics(results[1].value);
  else replaceText('organizationAnalyticsStatus', results[1].reason?.status === 403 ? 'Недостаточно полномочий для агрегатов.' : 'Агрегаты не загружены. Повторите позже.');
  if (results[2].status === 'fulfilled') renderFeatureFlags(results[2].value);
  else replaceText('featureFlagsStatus', 'Флаги не загружены');
  if (results[3].status === 'fulfilled') renderRollouts(results[3].value);
  else replaceText('rolloutStatus', 'Rollout не загружен');
  if (results[4].status === 'rejected') {
    const metric = document.getElementById('healthMetric');
    metric.textContent = 'Не проверен';
    metric.dataset.state = 'error';
    replaceText('healthDetail', 'Сервис health не ответил.');
  }
}

function restoreFilter() {
  document.getElementById('reportStatus').value = new URLSearchParams(location.search).get('status') || '';
}

function field(label, control) {
  const wrapper = document.createElement('label');
  wrapper.append(document.createTextNode(label), control);
  return wrapper;
}

async function transition(report, select, reason, button) {
  if (reason.value.trim().length < 3) {
    reason.setAttribute('aria-invalid', 'true');
    reason.focus();
    setStatus('Укажите основание длиной не менее трёх символов.');
    return;
  }
  button.disabled = true;
  setStatus('Сохраняем переход…');
  try {
    await patchJson(`/admin/moderation/reports/${encodeURIComponent(report.id)}/status`, { status: select.value, reason: reason.value.trim(), expectedRevision: report.revision });
    setStatus('Переход сохранён в неизменяемой истории.');
    await load();
  } catch (error) {
    setStatus(error?.status === 409 ? 'Данные изменились. Обновляем очередь.' : 'Переход отклонён сервером.');
    if (error?.status === 409) await load();
  } finally { button.disabled = false; }
}

async function criticalAction(report, action, reason, confirmation, button) {
  if (reason.value.trim().length < 3 || !confirmation.checked) {
    if (reason.value.trim().length < 3) reason.setAttribute('aria-invalid', 'true');
    (reason.value.trim().length < 3 ? reason : confirmation).focus();
    setStatus('Укажите основание и подтвердите критическое действие.');
    return;
  }
  button.disabled = true;
  setStatus('Применяем критическое действие…');
  try {
    const targetsAuthor = action.value === 'SUSPEND_AUTHOR' || action.value === 'RESTORE_AUTHOR';
    const expectedTargetRevision = targetsAuthor
      ? (report.authorProfile?.moderationRevision ?? report.webinar?.authorProfile?.moderationRevision ?? 0)
      : (report.webinar?.moderationRevision ?? 0);
    await post(`/admin/moderation/reports/${encodeURIComponent(report.id)}/actions`, {
      action: action.value,
      reason: reason.value.trim(),
      expectedRevision: report.revision,
      expectedTargetRevision,
      confirmation: 'APPLY_MODERATION_ACTION',
    });
    setStatus('Действие применено атомарно и записано в аудит.');
    confirmation.checked = false;
  } catch (error) {
    setStatus(error?.status === 409 ? 'Ревизия изменилась или действие выключено. Обновите очередь.' : 'Действие не выполнено.');
  } finally { button.disabled = false; }
}

function reportCard(report) {
  const item = document.createElement('li');
  item.className = 'report-card';
  const heading = textElement('h3', '', `${categoryLabels[report.category] || report.category} · ${report.targetType === 'WEBINAR' ? 'вебинар' : 'автор'}`);
  const badge = textElement('span', 'status-badge', statusLabels[report.status] || report.status);
  const meta = document.createElement('p');
  meta.className = 'report-meta';
  meta.append(document.createTextNode(`Создана: ${new Date(report.createdAt).toLocaleString('ru-RU')}`), document.createTextNode(`Ревизия: ${report.revision}`));
  const description = textElement('p', 'description', report.description);
  const controls = document.createElement('div');
  controls.className = 'card-actions';
  const next = document.createElement('select');
  next.setAttribute('aria-label', 'Следующий статус');
  for (const status of allowedTransitions[report.status] || []) {
    const option = document.createElement('option'); option.value = status; option.textContent = statusLabels[status]; next.append(option);
  }
  const reason = document.createElement('textarea'); reason.maxLength = 500; reason.placeholder = 'Основание решения';
  const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Сохранить переход';
  save.disabled = next.options.length === 0;
  save.addEventListener('click', () => void transition(report, next, reason, save));
  controls.append(field('Следующий статус', next), field('Основание', reason), save);

  const action = document.createElement('select');
  for (const [value, label] of [['UNPUBLISH_WEBINAR', 'Снять вебинар с публикации'], ['SUSPEND_AUTHOR', 'Приостановить автора'], ['RESTORE_WEBINAR', 'Восстановить вебинар'], ['RESTORE_AUTHOR', 'Восстановить автора']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; action.append(option);
  }
  const confirmation = document.createElement('input'); confirmation.type = 'checkbox';
  const confirmationLabel = document.createElement('label'); confirmationLabel.className = 'confirmation wide';
  confirmationLabel.append(confirmation, document.createTextNode('Я проверил основание и подтверждаю критическое действие'));
  const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Применить критическое действие';
  apply.addEventListener('click', () => void criticalAction(report, action, reason, confirmation, apply));
  controls.append(field('Критическое действие', action), confirmationLabel, apply);
  item.append(heading, badge, meta, description, controls);
  return item;
}

async function load() {
  list.setAttribute('aria-busy', 'true');
  document.getElementById('queueError').hidden = true;
  setStatus('Загружаем очередь…');
  const status = document.getElementById('reportStatus').value;
  try {
    const payload = await getJson(`/admin/moderation/reports${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    list.replaceChildren(...payload.items.map(reportCard));
    document.getElementById('queueCount').textContent = `${payload.pagination.total} жалоб`;
    document.getElementById('queueEmpty').hidden = payload.items.length > 0;
    setStatus('Очередь обновлена.');
  } catch (error) {
    list.replaceChildren();
    const message = error?.status === 401 ? 'Войдите в admin с MFA.' : error?.status === 403 ? 'Недостаточно полномочий platform admin.' : 'Повторите запрос.';
    document.getElementById('queueErrorText').textContent = message;
    document.getElementById('queueError').hidden = false;
    setStatus('Ошибка загрузки.');
  } finally { list.setAttribute('aria-busy', 'false'); }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const status = document.getElementById('reportStatus').value;
  history.pushState({}, '', `platform-moderation.html${status ? `?status=${status}` : ''}`);
  load();
});
window.addEventListener('popstate', () => { restoreFilter(); load(); });
document.getElementById('queueRetry').addEventListener('click', load);
restoreFilter();
load();
loadPlatformSummary();
