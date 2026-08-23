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
const form = document.getElementById('reportFilters');
const list = document.getElementById('reportList');

function textElement(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function setStatus(value) { document.getElementById('queueStatus').textContent = value; }

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
