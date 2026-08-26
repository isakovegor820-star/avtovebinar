import { deleteJson, getJson, patchJson, post, postDownload } from './utils.js?v=crm-5';

const state = {
  reference: null,
  contacts: [],
  total: 0,
  pagination: null,
  selectedContactId: null,
  detailRequestId: 0,
  queues: null,
  tags: [],
  scoring: null,
  currentDetail: null,
  pendingManualHotKey: null,
  pendingScoringVersionKey: null,
  pendingBulkPreviewKey: null,
  pendingDeliveryKey: null,
  bulkPreview: null,
};

function node(id) {
  return document.getElementById(id);
}

function element(tag, options = {}) {
  const result = document.createElement(tag);
  if (options.className) result.className = options.className;
  if (options.text !== undefined) result.textContent = options.text;
  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) result.setAttribute(name, value);
  }
  return result;
}

function setMode(mode) {
  document.body.dataset.crmMode = mode;
}

function setLiveStatus(target, message, stateName = '') {
  target.textContent = message;
  if (stateName) target.dataset.state = stateName;
  else delete target.dataset.state;
}

function formatDateTime(value, timezone = activeTimezone()) {
  if (!value) return 'Не назначен';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value));
}

function statusLabel(value) {
  return (
    {
      pending: 'ожидает',
      retrying: 'повторная попытка',
      sent: 'отправлено',
      completed: 'завершено',
      failed: 'ошибка',
      failed_permanent: 'не доставлено',
      dead_letter: 'требует разбора',
      cancelled: 'отменено',
      PENDING: 'ожидает',
      SENDING: 'отправляется',
      SENT: 'отправлено',
      RETRY_SCHEDULED: 'повтор запланирован',
      BLOCKED: 'получатель отписан или доступ отозван',
      DEAD_LETTER: 'требует разбора',
      unsubscribed: 'получатель отписан',
      registered: 'зарегистрирован',
      new: 'новый',
      answered: 'отвечен',
      in_progress: 'в процессе',
      OPEN: 'в работе',
      COMPLETED: 'завершена',
      CANCELLED: 'отменена',
    }[value] || value
  );
}

function sourceLabel(value) {
  return (
    {
      registration_activation: 'подтверждение регистрации',
      legacy_backfill: 'перенос legacy-истории',
      tenant_crm: 'CRM организации',
      webinar_room: 'вебинарная комната',
      viewer_account: 'кабинет зрителя',
      passwordless: 'вход по безопасной ссылке',
      partner_application: 'CTA-заявка',
      email_outbox: 'email-доставка',
      registration_notification: 'Telegram-уведомление регистрации',
      tenant_crm_delivery: 'CRM организации',
      tenant_crm_delivery_worker: 'очередь доставки CRM',
      public_catalog: 'публичный каталог',
      legacy: 'legacy-регистрация',
    }[value] || value
  );
}

function categoryLabel(value) {
  return { OPEN: 'в работе', WON: 'успешно', LOST: 'потеряно' }[value] || value;
}

function priorityLabel(value) {
  return { LOW: 'низкий', NORMAL: 'обычный', HIGH: 'высокий', URGENT: 'срочный' }[value] || value;
}

function contactCountText(count) {
  const value = Math.max(0, Number(count) || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  const noun = mod100 >= 11 && mod100 <= 14 ? 'контактов' : mod10 === 1 ? 'контакт' : mod10 >= 2 && mod10 <= 4 ? 'контакта' : 'контактов';
  return `${value} ${noun}`;
}

function idempotencyKey(prefix) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function pendingIdempotencyKey(stateField, prefix) {
  state[stateField] ||= idempotencyKey(prefix);
  return state[stateField];
}

function hotStatusText(score) {
  if (!score) return 'Не вычислен';
  if (score.manualOverride === 'HOT') return 'Горячий — ручное решение';
  if (score.manualOverride === 'NOT_HOT') return 'Не горячий — ручное решение';
  return score.effectiveHot ? 'Горячий по правилам' : 'Не горячий по правилам';
}

function activePipeline() {
  return state.reference?.pipelines?.find(pipeline => pipeline.isDefault) || state.reference?.pipelines?.[0] || null;
}

function activeTimezone() {
  return activePipeline()?.timezone || state.queues?.timezone || 'Europe/Moscow';
}

function fillSelect(select, items, placeholder, valueFor, labelFor) {
  const selected = select.value;
  select.replaceChildren(element('option', { text: placeholder, attributes: { value: '' } }));
  for (const item of items) {
    select.append(element('option', { text: labelFor(item), attributes: { value: valueFor(item) } }));
  }
  select.value = selected;
}

function hydrateReference() {
  const stages = activePipeline()?.stages?.filter(stage => stage.status === 'ACTIVE') || [];
  fillSelect(node('crmFilters').elements.stageId, stages, 'Все этапы', stage => stage.id, stage => stage.name);
  fillSelect(
    node('crmFilters').elements.managerId,
    state.reference.managers || [],
    'Все менеджеры',
    manager => manager.id,
    manager => manager.name,
  );
  fillSelect(node('crmStageForm').elements.stageId, stages, 'Выберите этап', stage => stage.id, stage => stage.name);
  fillSelect(
    node('crmTaskForm').elements.assigneeMembershipId,
    (state.reference.managers || []).filter(manager => manager.type === 'membership'),
    'Выберите менеджера',
    manager => manager.id,
    manager => manager.name,
  );
  const membershipManagers = (state.reference.managers || []).filter(manager => manager.type === 'membership');
  fillSelect(
    node('crmBulkForm').elements.managerMembershipId,
    membershipManagers,
    'Выберите менеджера',
    manager => manager.id,
    manager => manager.name,
  );
  fillSelect(
    node('crmBulkForm').elements.taskAssigneeMembershipId,
    membershipManagers,
    'Выберите менеджера',
    manager => manager.id,
    manager => manager.name,
  );
  fillSelect(node('crmBulkForm').elements.stageId, stages, 'Выберите этап', stage => stage.id, stage => stage.name);
  node('crmPrivacyNotice').hidden = !state.reference.maskedPersonalData;
  node('crmSearchField').hidden = state.reference.maskedPersonalData;
  if (state.reference.maskedPersonalData) {
    node('crmFilters').elements.search.value = '';
    const params = new URLSearchParams(window.location.search);
    if (params.has('search')) {
      params.delete('search');
      window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params.toString()}` : ''}`);
    }
  }
  node('crmStageForm').hidden = !state.reference.canEditContacts;
  node('crmTaskForm').hidden = !state.reference.canEditTasks;
  node('crmDeliveryForm').hidden = !state.reference.canSendDeliveries;
  node('crmManualHotForm').hidden = !state.reference.canEditContacts;
  node('crmAssignTagForm').hidden = !state.reference.canEditTags;
  node('crmTagManagement').hidden = !state.reference.canEditTags;
  node('crmScoringManagement').hidden = !state.reference.canManageScoring;
  node('crmStageManagement').hidden = !state.reference.canManageStages;
  node('crmBulkTools').hidden = !state.reference.canRunBulkActions && !state.reference.canExport;
  node('crmBulkActionSection').hidden = !state.reference.canRunBulkActions;
  node('crmExportSection').hidden = !state.reference.canExport;
  const timezone = activeTimezone();
  node('crmQueueTimezone').textContent = `Сегодня определяется по timezone ${timezone}. Просроченные задачи показаны отдельно.`;
  node('crmTaskTimezone').textContent = `Срок и напоминание вводятся и показываются в timezone ${timezone}.`;
  node('crmNextContactLabel').textContent = `Следующий контакт (${timezone})`;
  renderStageManagement();
  renderTagManagement();
  renderScoringManagement();
  renderQueues();
  updateBulkActionFields();
}

function queryFromForm() {
  const params = new URLSearchParams();
  const data = new FormData(node('crmFilters'));
  for (const [name, rawValue] of data.entries()) {
    const value = String(rawValue).trim();
    if (value) params.set(name, value);
  }
  return params;
}

function currentFilters() {
  return Object.fromEntries(queryFromForm().entries());
}

function invalidateBulkPreview(message = 'Фильтры или действие изменены. Создайте новый preview.') {
  state.bulkPreview = null;
  state.pendingBulkPreviewKey = null;
  const button = node('crmBulkExecuteButton');
  button.disabled = true;
  button.textContent = 'Выполнить для 0 контактов';
  node('crmBulkResult').hidden = true;
  node('crmBulkFailures').replaceChildren();
  setLiveStatus(node('crmBulkPreviewStatus'), message);
}

function updateBulkLostReasonVisibility() {
  const form = node('crmBulkForm');
  const selected = activePipeline()?.stages?.find(stage => stage.id === form.elements.stageId.value);
  const field = node('crmBulkLostReasonField');
  const visible = form.elements.actionType.value === 'CHANGE_STAGE' && selected?.semanticCategory === 'LOST';
  field.hidden = !visible;
  form.elements.stageReason.required = visible;
  if (!visible) form.elements.stageReason.value = '';
}

function updateBulkActionFields() {
  const form = node('crmBulkForm');
  const actionType = form.elements.actionType.value;
  for (const field of form.querySelectorAll('[data-bulk-field]')) {
    field.hidden = field.dataset.bulkField !== actionType;
    for (const control of field.querySelectorAll('input, select, textarea')) control.required = false;
  }
  const requiredNames = {
    ADD_TAG: ['tagId'],
    ASSIGN_MANAGER: ['managerMembershipId'],
    CHANGE_STAGE: ['stageId'],
    CREATE_TASK: ['taskTitle', 'taskAssigneeMembershipId', 'taskPriority', 'taskDueLocal', 'taskReminderLocal'],
  }[actionType] || [];
  for (const name of requiredNames) form.elements[name].required = true;
  updateBulkLostReasonVisibility();
}

function buildBulkAction() {
  const form = node('crmBulkForm');
  const type = form.elements.actionType.value;
  if (type === 'ASSIGN_MANAGER') {
    return { type, assigneeMembershipId: form.elements.managerMembershipId.value };
  }
  if (type === 'CHANGE_STAGE') {
    const reason = form.elements.stageReason.value.trim();
    return { type, stageId: form.elements.stageId.value, ...(reason ? { reason } : {}) };
  }
  if (type === 'CREATE_TASK') {
    return {
      type,
      task: {
        title: form.elements.taskTitle.value.trim(),
        description: form.elements.taskDescription.value.trim() || null,
        assigneeMembershipId: form.elements.taskAssigneeMembershipId.value,
        priority: form.elements.taskPriority.value,
        dueLocal: form.elements.taskDueLocal.value,
        reminderLocal: form.elements.taskReminderLocal.value,
      },
    };
  }
  return { type: 'ADD_TAG', tagId: form.elements.tagId.value };
}

function bulkFailureLabel(code) {
  return (
    {
      crm_contact_not_found: 'Контакт больше недоступен в этой организации.',
      crm_stage_not_found: 'Этап больше недоступен.',
      crm_tag_not_found: 'Тег больше недоступен.',
      crm_bulk_item_failed: 'Действие не выполнено. Повторите после проверки данных.',
    }[code] || 'Действие не выполнено по безопасной серверной проверке.'
  );
}

function renderBulkResult(bulkAction) {
  const successes = bulkAction.results?.successes || [];
  const failures = bulkAction.results?.failures || [];
  node('crmBulkResult').hidden = false;
  node('crmBulkResultSummary').textContent = `Успешно: ${successes.length}. Не выполнено: ${failures.length}.`;
  node('crmBulkFailures').replaceChildren(
    ...failures.map(failure =>
      element('li', { text: `${bulkFailureLabel(failure.code)} Код: ${failure.code}.` }),
    ),
  );
}

function hydrateFormFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const form = node('crmFilters');
  for (const field of form.elements) {
    if (!field.name) continue;
    field.value = params.get(field.name) || '';
  }
}

function renderContacts(contacts, total) {
  const list = node('crmContactList');
  list.replaceChildren(
    ...contacts.map(contact => {
      const item = element('li');
      const button = element('button', {
        className: 'crm-contact-button',
        attributes: { type: 'button', 'data-contact-id': contact.id },
      });
      if (contact.id === state.selectedContactId) button.setAttribute('aria-current', 'true');
      button.append(
        element('strong', { text: contact.displayName || 'Без имени' }),
        element('span', { text: [contact.email, contact.phone].filter(Boolean).join(' · ') || 'Контакт скрыт' }),
        element('span', { text: `${contact.stage.name} · ${contact.manager?.name || 'Без менеджера'}` }),
        element('span', {
          text: `Score ${contact.score?.value || 0} · ${hotStatusText(contact.score)}${contact.tags?.length ? ` · Теги: ${contact.tags.map(tag => tag.name).join(', ')}` : ''}`,
        }),
      );
      button.addEventListener('click', () => void selectContact(contact.id));
      item.append(button);
      return item;
    }),
  );
  node('crmContactsEmpty').hidden = contacts.length > 0;
  node('crmContactCount').textContent = `Найдено контактов: ${total}`;
}

function renderPagination(pagination) {
  const container = node('crmPagination');
  const pages = pagination?.pages || 0;
  const page = pagination?.page || 1;
  container.hidden = pages <= 1;
  node('crmPreviousPage').disabled = page <= 1;
  node('crmNextPage').disabled = page >= pages;
  node('crmPageStatus').textContent = pages > 0 ? `Страница ${page} из ${pages}` : '';
}

function renderQueues() {
  const counts = state.queues?.counts || { today: 0, overdue: 0, withoutTask: 0 };
  const selected = new URLSearchParams(window.location.search).get('queue') || '';
  const queueButtons = [
    [node('crmQueueToday'), 'today', counts.today],
    [node('crmQueueOverdue'), 'overdue', counts.overdue],
    [node('crmQueueWithoutTask'), 'without_task', counts.withoutTask],
  ];
  for (const [button, queue, count] of queueButtons) {
    button.setAttribute('aria-pressed', selected === queue ? 'true' : 'false');
    button.querySelector('strong').textContent = String(count || 0);
  }
  if (state.queues) {
    node('crmQueueTimezone').textContent = `Сегодня — ${state.queues.localDate}, timezone ${state.queues.timezone}. Просроченные задачи показаны отдельно.`;
    setLiveStatus(
      node('crmQueueStatus'),
      state.queues.counts.remindersDue > 0
        ? `Напоминаний к текущему моменту: ${state.queues.counts.remindersDue}`
        : 'Напоминаний к текущему моменту нет.',
    );
  }
}

async function loadQueues() {
  state.queues = await getJson('/v1/crm/queues');
  renderQueues();
}

function selectQueue(queue) {
  invalidateBulkPreview();
  const params = new URLSearchParams(window.location.search);
  const selected = params.get('queue');
  if (!queue || selected === queue) params.delete('queue');
  else params.set('queue', queue);
  params.delete('page');
  window.history.pushState({}, '', `${window.location.pathname}${params.size ? `?${params.toString()}` : ''}`);
  hydrateFormFromUrl();
  renderQueues();
  clearDetail();
  void loadContacts().catch(error =>
    setLiveStatus(node('crmContactCount'), error.message || 'Не удалось открыть рабочую очередь.', 'error'),
  );
}

function setPage(page) {
  const params = new URLSearchParams(window.location.search);
  if (page <= 1) params.delete('page');
  else params.set('page', String(page));
  window.history.pushState({}, '', `${window.location.pathname}${params.size ? `?${params.toString()}` : ''}`);
  clearDetail();
  void loadContacts().catch(error =>
    setLiveStatus(node('crmContactCount'), error.message || 'Не удалось открыть страницу.', 'error'),
  );
}

async function loadContacts({ clearMissingSelection = true } = {}) {
  const params = new URLSearchParams(window.location.search);
  const result = await getJson(`/v1/crm/contacts${params.size ? `?${params.toString()}` : ''}`);
  state.contacts = result.contacts || [];
  state.pagination = result.pagination || null;
  state.total = result.pagination?.total || 0;
  renderContacts(state.contacts, state.total);
  renderPagination(state.pagination);
  if (
    clearMissingSelection &&
    state.selectedContactId &&
    !state.contacts.some(contact => contact.id === state.selectedContactId)
  ) {
    clearDetail();
  }
}

function clearDetail() {
  state.detailRequestId += 1;
  state.selectedContactId = null;
  state.currentDetail = null;
  node('crmContactDetail').removeAttribute('aria-busy');
  node('crmDetailEmpty').hidden = false;
  node('crmDetailContent').hidden = true;
  renderTasks([]);
  renderDeliveries([]);
  renderScore(null);
  renderContactTags([]);
  setLiveStatus(node('crmTaskFormStatus'), '');
  renderContacts(state.contacts, state.total);
}

function renderTimeline(items) {
  const list = node('crmTimeline');
  list.replaceChildren(
    ...items.map(item => {
      const row = element('li', { className: 'crm-timeline-item' });
      const time = element('time', { text: formatDateTime(item.occurredAt), attributes: { datetime: item.occurredAt } });
      const content = element('div');
      content.append(element('p', { text: item.summary }));
      if (item.status) content.append(element('p', { text: `Статус: ${statusLabel(item.status)}` }));
      content.append(element('p', { text: `Источник: ${sourceLabel(item.source)}` }));
      row.append(time, content);
      return row;
    }),
  );
  if (!items.length) list.append(element('li', { className: 'crm-empty', text: 'Событий пока нет.' }));
}

function deliveryChannelLabel(channel) {
  return channel === 'EMAIL' ? 'Email' : channel === 'TELEGRAM' ? 'Telegram' : channel;
}

function deliveryReasonLabel(code) {
  return (
    {
      crm_delivery_consent_required: 'Нет действующего маркетингового согласия на этот канал.',
      crm_delivery_telegram_unavailable: 'Telegram не привязан к участнику.',
      crm_delivery_recipient_unavailable: 'Регистрация, учётная запись или получатель у провайдера недоступны.',
      crm_delivery_requester_inactive: 'Исходный менеджер больше не имеет доступа. Создайте новое сообщение.',
      crm_delivery_provider_temporary_failure: 'Временная ошибка провайдера. Очередь выполнит повтор.',
      crm_delivery_provider_disabled: 'Провайдер выключен; отправка не имитировалась.',
      crm_delivery_worker_interrupted: 'Worker восстановил незавершённую попытку.',
    }[code] || 'Сервер безопасно остановил отправку.'
  );
}

function selectedDeliveryEligibility() {
  const form = node('crmDeliveryForm');
  const registration = (state.currentDetail?.registrations || []).find(
    item => item.id === form.elements.registrationId.value,
  );
  const key = form.elements.channel.value === 'EMAIL' ? 'email' : 'telegram';
  return registration?.deliveryEligibility?.[key] || null;
}

function updateDeliveryFormState({ announce = true } = {}) {
  const form = node('crmDeliveryForm');
  const email = form.elements.channel.value === 'EMAIL';
  const subjectField = node('crmDeliverySubjectField');
  subjectField.hidden = !email;
  form.elements.subject.required = email;
  if (!email) form.elements.subject.value = '';
  const eligibility = selectedDeliveryEligibility();
  const submit = node('crmDeliverySubmit');
  submit.disabled = !eligibility?.allowed;
  if (!announce) return;
  if (!form.elements.registrationId.value) {
    setLiveStatus(node('crmDeliveryStatus'), 'Выберите регистрацию и канал.');
  } else if (eligibility?.allowed) {
    setLiveStatus(
      node('crmDeliveryStatus'),
      'Канал доступен. Согласие будет повторно проверено worker перед отправкой.',
      'success',
    );
  } else {
    setLiveStatus(node('crmDeliveryStatus'), deliveryReasonLabel(eligibility?.reasonCode), 'error');
  }
}

function hydrateDeliveryForm(detail) {
  const form = node('crmDeliveryForm');
  const selected = form.elements.registrationId.value;
  fillSelect(
    form.elements.registrationId,
    detail.registrations || [],
    'Выберите регистрацию',
    registration => registration.id,
    registration =>
      `${registration.webinarTitle} · ${formatDateTime(registration.scheduledAt, registration.timezone)} (${registration.timezone})`,
  );
  if ((detail.registrations || []).some(registration => registration.id === selected)) {
    form.elements.registrationId.value = selected;
  } else if (detail.registrations?.length === 1) {
    form.elements.registrationId.value = detail.registrations[0].id;
  }
  form.hidden = !detail.canSendDeliveries;
  updateDeliveryFormState({ announce: false });
}

async function retryDelivery(deliveryId, button) {
  button.disabled = true;
  setLiveStatus(node('crmDeliveryStatus'), 'Повторно проверяем согласие и возвращаем сообщение в очередь…');
  try {
    await post(`/v1/crm/deliveries/${encodeURIComponent(deliveryId)}/retry`, {
      idempotencyKey: idempotencyKey('crm-delivery-retry'),
    });
    const contactId = state.selectedContactId;
    if (contactId) await selectContact(contactId);
    setLiveStatus(node('crmDeliveryStatus'), 'Повтор поставлен в очередь. Перед отправкой согласие проверится снова.', 'success');
  } catch (error) {
    setLiveStatus(node('crmDeliveryStatus'), error.message || 'Не удалось запросить повтор.', 'error');
  } finally {
    button.disabled = false;
  }
}

function renderDeliveries(items) {
  const list = node('crmDeliveryList');
  node('crmDeliveriesEmpty').hidden = items.length > 0;
  list.replaceChildren(
    ...items.map(delivery => {
      const row = element('li', {
        className: 'crm-delivery-item',
        attributes: { 'data-status': delivery.status },
      });
      const content = element('div');
      content.append(
        element('p', {
          text: `${deliveryChannelLabel(delivery.channel)} · ${statusLabel(delivery.status)}`,
        }),
      );
      const details = [
        `Создано: ${formatDateTime(delivery.createdAt)}`,
        `попыток: ${delivery.attempts}`,
        delivery.nextAttemptAt ? `следующая: ${formatDateTime(delivery.nextAttemptAt)}` : '',
        delivery.lastErrorCode ? deliveryReasonLabel(delivery.lastErrorCode) : '',
      ].filter(Boolean);
      content.append(element('p', { className: 'crm-delivery-meta', text: details.join(' · ') }));
      const actions = element('div', { className: 'crm-task-actions' });
      if (delivery.canRetry) {
        const retry = element('button', {
          text: 'Повторить безопасно',
          attributes: {
            type: 'button',
            'aria-label': `Повторить ${deliveryChannelLabel(delivery.channel)}-доставку после повторной проверки согласия`,
          },
        });
        retry.addEventListener('click', () => void retryDelivery(delivery.id, retry));
        actions.append(retry);
      }
      row.append(content, actions);
      return row;
    }),
  );
}

function renderTasks(items) {
  const list = node('crmTaskList');
  node('crmTasksEmpty').hidden = items.length > 0;
  list.replaceChildren(
    ...items.map(task => {
      const row = element('li', { className: 'crm-task-item', attributes: { 'data-status': task.status } });
      const content = element('div');
      content.append(element('h4', { text: task.title }));
      if (task.description) content.append(element('p', { text: task.description }));
      const meta = element('div', { className: 'crm-task-meta' });
      const overdue = task.status === 'OPEN' && new Date(task.dueAt).getTime() < Date.now();
      meta.append(
        element('span', { text: `Статус: ${statusLabel(task.status)}${overdue ? ' · просрочена' : ''}` }),
        element('span', { text: `Исполнитель: ${task.assignee.name}` }),
        element('span', { text: `Срок: ${formatDateTime(task.dueAt, task.timezone)} · приоритет: ${priorityLabel(task.priority)}` }),
        element('span', { text: `Напомнить: ${formatDateTime(task.reminderAt, task.timezone)}` }),
      );
      content.append(meta);
      const actions = element('div', { className: 'crm-task-actions' });
      if (state.reference?.canEditTasks && task.status === 'OPEN') {
        const complete = element('button', {
          text: 'Завершить',
          attributes: { type: 'button', 'aria-label': `Завершить задачу «${task.title}»` },
        });
        complete.addEventListener('click', () => void changeTaskStatus(task.id, 'COMPLETED'));
        const cancel = element('button', {
          text: 'Отменить',
          attributes: { type: 'button', 'aria-label': `Отменить задачу «${task.title}»` },
        });
        cancel.addEventListener('click', () => void changeTaskStatus(task.id, 'CANCELLED'));
        actions.append(complete, cancel);
      }
      row.append(content, actions);
      return row;
    }),
  );
}

function renderScore(score) {
  node('crmScoreValue').textContent = score ? `${score.value} баллов` : '0 баллов';
  node('crmHotStatus').textContent = score
    ? `${hotStatusText(score)}${score.manualReason ? ` · Причина: ${score.manualReason}` : ''}`
    : 'Не вычислен';
  node('crmScoreModel').textContent = score?.ruleSetVersion
    ? `Версия ${score.ruleSetVersion} · порог ${score.hotThreshold}`
    : 'Не назначена';
  const factors = node('crmScoreFactors');
  factors.replaceChildren(
    ...(score?.factors || []).map(factor =>
      element('li', {
        text: `${factor.label}: ${factor.count} × ${factor.pointsEach} = ${factor.subtotal} · последнее событие ${formatDateTime(factor.lastOccurredAt)}`,
      }),
    ),
  );
  if (!score?.factors?.length) {
    factors.append(element('li', { className: 'crm-empty', text: 'Факторов scoring пока нет.' }));
  }
  const form = node('crmManualHotForm');
  form.elements.mode.value = score?.manualOverride || 'AUTOMATIC';
  form.elements.reason.value = score?.manualReason || '';
}

function renderContactTags(tags) {
  const list = node('crmContactTags');
  list.replaceChildren(
    ...tags.map(tag => {
      const item = element('li', {
        className: 'crm-tag-chip',
        attributes: { 'data-color': tag.colorToken, 'data-status': tag.status },
      });
      item.append(element('span', { text: `${tag.name}${tag.status === 'ARCHIVED' ? ' · архив' : ''}` }));
      if (state.reference?.canEditTags && state.selectedContactId) {
        const remove = element('button', {
          text: 'Снять',
          attributes: { type: 'button', 'aria-label': `Снять тег «${tag.name}» с контакта` },
        });
        remove.addEventListener('click', () => void removeContactTag(tag.id));
        item.append(remove);
      }
      return item;
    }),
  );
  if (!tags.length) list.append(element('li', { className: 'crm-empty', text: 'Теги не назначены.' }));

  const select = node('crmAssignTagForm').elements.tagId;
  const assigned = new Set(tags.map(tag => tag.id));
  fillSelect(
    select,
    state.tags.filter(tag => tag.status === 'ACTIVE' && !assigned.has(tag.id)),
    'Выберите тег',
    tag => tag.id,
    tag => tag.name,
  );
}

function renderTagManagement() {
  const list = node('crmTagManagementList');
  if (!state.reference?.canEditTags) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(
    ...state.tags.map(tag => {
      const item = element('li', { className: 'crm-tag-management-row' });
      const summary = element('div');
      summary.append(
        element('strong', { text: tag.name }),
        element('span', {
          text: `${tag.status === 'ACTIVE' ? 'Активен' : 'В архиве'} · контактов: ${tag.contactCount || 0}`,
        }),
      );
      const toggle = element('button', {
        text: tag.status === 'ACTIVE' ? 'Архивировать' : 'Вернуть из архива',
        attributes: {
          type: 'button',
          'aria-label': `${tag.status === 'ACTIVE' ? 'Архивировать' : 'Вернуть из архива'} тег «${tag.name}»`,
        },
      });
      toggle.addEventListener('click', () => void updateTagStatus(tag.id, tag.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE'));
      item.append(summary, toggle);
      return item;
    }),
  );
  if (!state.tags.length) list.append(element('li', { className: 'crm-empty', text: 'Теги организации ещё не созданы.' }));
}

function renderScoringManagement() {
  const active = state.scoring?.active;
  node('crmActiveScoringSummary').textContent = active
    ? `Активна версия ${active.version} «${active.name}», порог hot: ${active.hotThreshold}.`
    : 'Активная scoring-модель ещё не создана.';
  if (!state.reference?.canManageScoring || !active) return;
  const form = node('crmScoringForm');
  form.elements.hotThreshold.value = String(active.hotThreshold);
  const fieldByCode = {
    registration: 'registration',
    room_entered: 'roomEntered',
    viewed_50_percent: 'viewed50Percent',
    question: 'question',
    cta: 'cta',
  };
  for (const rule of active.rules || []) {
    const field = fieldByCode[rule.code];
    if (field) form.elements[field].value = String(rule.points);
  }
}

async function loadTags() {
  const result = await getJson('/v1/crm/tags?includeArchived=true');
  state.tags = result.tags || [];
  fillSelect(
    node('crmBulkForm').elements.tagId,
    state.tags.filter(tag => tag.status === 'ACTIVE'),
    'Выберите тег',
    tag => tag.id,
    tag => tag.name,
  );
  renderTagManagement();
  if (state.currentDetail) renderContactTags(state.currentDetail.contact.tags || []);
}

async function loadScoring() {
  state.scoring = await getJson('/v1/crm/scoring');
  renderScoringManagement();
}

async function changeTaskStatus(taskId, status) {
  if (!state.selectedContactId) return;
  const contactId = state.selectedContactId;
  setLiveStatus(node('crmTaskFormStatus'), status === 'COMPLETED' ? 'Завершаем задачу…' : 'Отменяем задачу…');
  try {
    await patchJson(`/v1/crm/tasks/${encodeURIComponent(taskId)}`, { status });
    await Promise.all([loadQueues(), loadContacts({ clearMissingSelection: false })]);
    if (state.selectedContactId === contactId) await selectContact(contactId);
    setLiveStatus(
      node('crmTaskFormStatus'),
      status === 'COMPLETED' ? 'Задача завершена.' : 'Задача отменена.',
      'success',
    );
  } catch (error) {
    setLiveStatus(node('crmTaskFormStatus'), error.message || 'Не удалось изменить задачу.', 'error');
  }
}

function updateLostReasonVisibility() {
  const select = node('crmStageForm').elements.stageId;
  const selected = activePipeline()?.stages?.find(stage => stage.id === select.value);
  const field = node('crmLostReasonField');
  field.hidden = selected?.semanticCategory !== 'LOST';
  field.querySelector('textarea').required = !field.hidden;
  if (field.hidden) field.querySelector('textarea').value = '';
}

async function selectContact(contactId) {
  const requestId = state.detailRequestId + 1;
  state.detailRequestId = requestId;
  state.selectedContactId = contactId;
  renderContacts(state.contacts, state.total);
  node('crmContactDetail').setAttribute('aria-busy', 'true');
  let result;
  try {
    result = await getJson(`/v1/crm/contacts/${encodeURIComponent(contactId)}`);
  } catch (error) {
    if (state.detailRequestId === requestId) {
      clearDetail();
      setLiveStatus(node('crmContactCount'), error.message || 'Не удалось открыть контакт.', 'error');
    }
    return;
  } finally {
    if (state.detailRequestId === requestId) node('crmContactDetail').removeAttribute('aria-busy');
  }
  if (state.detailRequestId !== requestId || state.selectedContactId !== contactId) return;
  state.currentDetail = result;
  const contact = result.contact;
  node('crmDetailEmpty').hidden = true;
  node('crmDetailContent').hidden = false;
  node('crmContactName').textContent = contact.displayName || 'Без имени';
  node('crmContactIdentity').textContent = [contact.email, contact.phone].filter(Boolean).join(' · ') || 'Персональные данные скрыты';
  node('crmContactStage').textContent = contact.stage.name;
  node('crmContactStage').dataset.category = contact.stage.semanticCategory;
  node('crmContactManager').textContent = contact.manager?.name || 'Не назначен';
  node('crmNextContact').textContent = formatDateTime(contact.nextContactAt, activeTimezone());
  node('crmContactSource').textContent = contact.source || 'Не указан';
  node('crmStageForm').elements.stageId.value = contact.stage.id;
  updateLostReasonVisibility();
  renderTasks(result.tasks || []);
  hydrateDeliveryForm(result);
  renderDeliveries(result.deliveries || []);
  renderScore(result.scoring || contact.score || null);
  renderContactTags(contact.tags || []);
  renderTimeline(result.timeline || []);
  node('crmContactDetail').focus({ preventScroll: true });
}

function renderStageManagement() {
  const list = node('crmStageManagementList');
  if (!state.reference?.canManageStages) {
    list.replaceChildren();
    return;
  }
  const stages = activePipeline()?.stages || [];
  list.replaceChildren(
    ...stages.map((stage, index) => {
      const item = element('li', { className: 'crm-stage-row' });
      const label = element('label');
      label.append(element('span', { text: 'Название' }));
      const input = element('input', { attributes: { value: stage.name, maxlength: '120' } });
      label.append(input);
      const code = element('span', {
        className: 'crm-stage-code',
        text: `Код: ${stage.code} · ${categoryLabel(stage.semanticCategory)}`,
      });
      const actions = element('div', { className: 'crm-stage-actions' });
      const save = element('button', {
        text: 'Сохранить',
        attributes: { type: 'button', 'aria-label': `Сохранить название этапа «${stage.name}»` },
      });
      save.addEventListener('click', () => void saveStage(stage.id, { name: input.value.trim() }));
      actions.append(save);
      if (index > 0) {
        const up = element('button', { text: 'Выше', attributes: { type: 'button', 'aria-label': `Переместить этап «${stage.name}» выше` } });
        up.addEventListener('click', () => void saveStage(stage.id, { position: index - 1 }));
        actions.append(up);
      }
      if (!stage.isProtected && stage.status === 'ACTIVE') {
        const archive = element('button', {
          text: 'Архивировать',
          attributes: { type: 'button', 'aria-label': `Архивировать этап «${stage.name}»` },
        });
        archive.addEventListener('click', () => void saveStage(stage.id, { status: 'ARCHIVED' }));
        actions.append(archive);
      }
      item.append(label, code, actions);
      return item;
    }),
  );
}

async function refreshReference() {
  state.reference = await getJson('/v1/crm/reference-data');
  hydrateReference();
  hydrateFormFromUrl();
}

async function saveStage(stageId, changes) {
  const status = node('crmStageManagementStatus');
  setLiveStatus(status, 'Сохраняем этап…');
  try {
    await patchJson(`/v1/crm/stages/${encodeURIComponent(stageId)}`, changes);
    await refreshReference();
    await loadContacts();
    setLiveStatus(status, 'Этап сохранён.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось сохранить этап.', 'error');
  }
}

async function updateTagStatus(tagId, statusValue) {
  const status = node('crmTagManagementStatus');
  setLiveStatus(status, statusValue === 'ARCHIVED' ? 'Архивируем тег…' : 'Возвращаем тег…');
  try {
    await patchJson(`/v1/crm/tags/${encodeURIComponent(tagId)}`, { status: statusValue });
    await loadTags();
    if (state.selectedContactId) await selectContact(state.selectedContactId);
    setLiveStatus(status, statusValue === 'ARCHIVED' ? 'Тег архивирован.' : 'Тег снова доступен.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось изменить тег.', 'error');
  }
}

async function removeContactTag(tagId) {
  if (!state.selectedContactId) return;
  const contactId = state.selectedContactId;
  const status = node('crmAssignTagStatus');
  setLiveStatus(status, 'Снимаем тег…');
  try {
    await deleteJson(`/v1/crm/contacts/${encodeURIComponent(contactId)}/tags/${encodeURIComponent(tagId)}`);
    await Promise.all([loadTags(), loadContacts({ clearMissingSelection: false })]);
    if (state.selectedContactId === contactId) await selectContact(contactId);
    setLiveStatus(status, 'Тег снят с контакта.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось снять тег.', 'error');
  }
}

async function previewBulkAction() {
  const form = node('crmBulkForm');
  if (!form.reportValidity()) return;
  const previewButton = node('crmBulkPreviewButton');
  const executeButton = node('crmBulkExecuteButton');
  previewButton.disabled = true;
  executeButton.disabled = true;
  setLiveStatus(node('crmBulkPreviewStatus'), 'Проверяем точное количество контактов…');
  try {
    const result = await post('/v1/crm/bulk-actions', {
      mode: 'PREVIEW',
      filters: currentFilters(),
      action: buildBulkAction(),
      idempotencyKey: pendingIdempotencyKey('pendingBulkPreviewKey', 'crm-bulk-preview'),
    });
    state.bulkPreview = result.bulkAction;
    const count = result.bulkAction.expectedCount;
    executeButton.textContent = `Выполнить для ${contactCountText(count)}`;
    executeButton.disabled = count === 0;
    setLiveStatus(
      node('crmBulkPreviewStatus'),
      count > 0
        ? `Проверено: ${contactCountText(count)}. Предварительный выбор действует до ${formatDateTime(result.bulkAction.expiresAt)}.`
        : 'По текущим фильтрам контактов нет. Выполнение недоступно.',
      count > 0 ? 'success' : '',
    );
  } catch (error) {
    setLiveStatus(node('crmBulkPreviewStatus'), error.message || 'Не удалось проверить количество.', 'error');
  } finally {
    previewButton.disabled = false;
  }
}

async function executeBulkAction() {
  if (!state.bulkPreview || state.bulkPreview.expectedCount === 0) return;
  const previewId = state.bulkPreview.id;
  const executeButton = node('crmBulkExecuteButton');
  executeButton.disabled = true;
  setLiveStatus(node('crmBulkPreviewStatus'), `Выполняем действие для ${contactCountText(state.bulkPreview.expectedCount)}…`);
  try {
    const result = await post('/v1/crm/bulk-actions', { mode: 'EXECUTE', previewId });
    state.bulkPreview = result.bulkAction;
    renderBulkResult(result.bulkAction);
    const successes = result.bulkAction.results?.successes?.length || 0;
    const failures = result.bulkAction.results?.failures?.length || 0;
    setLiveStatus(
      node('crmBulkPreviewStatus'),
      `Выполнение завершено. Успешно: ${successes}. Не выполнено: ${failures}.`,
      failures ? 'error' : 'success',
    );
    const selectedContactId = state.selectedContactId;
    await Promise.all([loadQueues(), loadContacts({ clearMissingSelection: false }), loadTags()]);
    if (selectedContactId && state.selectedContactId === selectedContactId) await selectContact(selectedContactId);
  } catch (error) {
    setLiveStatus(node('crmBulkPreviewStatus'), error.message || 'Не удалось выполнить массовое действие.', 'error');
    if (error.payload?.code !== 'crm_bulk_in_progress') state.bulkPreview = null;
  }
}

async function exportCurrentContacts() {
  const button = node('crmExportButton');
  button.disabled = true;
  setLiveStatus(node('crmExportStatus'), 'Формируем одноразовый CSV по текущим фильтрам…');
  try {
    const result = await postDownload('/v1/crm/exports', { filters: currentFilters() });
    const url = URL.createObjectURL(result.blob);
    const link = element('a', { attributes: { href: url, download: result.fileName } });
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setLiveStatus(node('crmExportStatus'), `CSV сформирован. Строк данных: ${result.rowCount}.`, 'success');
  } catch (error) {
    setLiveStatus(node('crmExportStatus'), error.message || 'Не удалось сформировать CSV.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function boot() {
  setMode('loading');
  try {
    await refreshReference();
    await Promise.all([loadQueues(), loadContacts(), loadTags(), loadScoring()]);
    setMode('content');
  } catch (error) {
    node('crmErrorText').textContent = error.status === 404
      ? 'CRM ещё не включена для этой организации или объект недоступен.'
      : error.message || 'Не удалось загрузить CRM. Повторите попытку.';
    setMode('error');
  }
}

node('crmFilters').addEventListener('submit', event => {
  event.preventDefault();
  invalidateBulkPreview();
  const params = queryFromForm();
  window.history.pushState({}, '', `${window.location.pathname}${params.size ? `?${params.toString()}` : ''}`);
  renderQueues();
  clearDetail();
  void loadContacts().catch(error => setLiveStatus(node('crmContactCount'), error.message || 'Не удалось применить фильтры.', 'error'));
});

node('crmClearFilters').addEventListener('click', () => {
  invalidateBulkPreview();
  node('crmFilters').reset();
  window.history.pushState({}, '', window.location.pathname);
  renderQueues();
  clearDetail();
  void loadContacts();
});

node('crmFilters').addEventListener('input', () => invalidateBulkPreview());
node('crmBulkForm').addEventListener('input', () => invalidateBulkPreview('Действие изменено. Проверьте количество заново.'));
node('crmBulkForm').addEventListener('change', event => {
  if (event.target.name === 'actionType') updateBulkActionFields();
  if (event.target.name === 'stageId') updateBulkLostReasonVisibility();
  invalidateBulkPreview('Действие изменено. Проверьте количество заново.');
});
node('crmBulkForm').addEventListener('submit', event => {
  event.preventDefault();
  void previewBulkAction();
});
node('crmBulkExecuteButton').addEventListener('click', () => void executeBulkAction());
node('crmExportButton').addEventListener('click', () => void exportCurrentContacts());

node('crmPreviousPage').addEventListener('click', () => setPage((state.pagination?.page || 1) - 1));
node('crmNextPage').addEventListener('click', () => setPage((state.pagination?.page || 1) + 1));
for (const button of document.querySelectorAll('.crm-queue-button')) {
  button.addEventListener('click', () => selectQueue(button.dataset.queue));
}

node('crmStageForm').elements.stageId.addEventListener('change', updateLostReasonVisibility);
node('crmStageForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedContactId) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = node('crmStageStatus');
  button.disabled = true;
  setLiveStatus(status, 'Сохраняем этап…');
  try {
    const contactId = state.selectedContactId;
    const body = { stageId: form.elements.stageId.value };
    const reason = form.elements.reason.value.trim();
    if (reason) body.reason = reason;
    await patchJson(`/v1/crm/contacts/${encodeURIComponent(contactId)}/stage`, body);
    await loadContacts({ clearMissingSelection: false });
    await selectContact(contactId);
    setLiveStatus(status, 'Этап контакта сохранён.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось изменить этап.', 'error');
  } finally {
    button.disabled = false;
  }
});

node('crmDeliveryForm').elements.registrationId.addEventListener('change', () => updateDeliveryFormState());
node('crmDeliveryForm').elements.channel.addEventListener('change', () => updateDeliveryFormState());
node('crmDeliveryForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedContactId) return;
  const form = event.currentTarget;
  const eligibility = selectedDeliveryEligibility();
  if (!eligibility?.allowed) {
    updateDeliveryFormState();
    return;
  }
  const button = node('crmDeliverySubmit');
  const status = node('crmDeliveryStatus');
  button.disabled = true;
  setLiveStatus(status, 'Проверяем согласие и ставим сообщение в очередь…');
  try {
    const contactId = state.selectedContactId;
    const channel = form.elements.channel.value;
    await post(`/v1/crm/contacts/${encodeURIComponent(contactId)}/deliveries`, {
      channel,
      registrationId: form.elements.registrationId.value,
      ...(channel === 'EMAIL' ? { subject: form.elements.subject.value.trim() } : {}),
      message: form.elements.message.value.trim(),
      idempotencyKey: pendingIdempotencyKey('pendingDeliveryKey', 'crm-delivery'),
    });
    state.pendingDeliveryKey = null;
    form.elements.subject.value = '';
    form.elements.message.value = '';
    if (state.selectedContactId === contactId) await selectContact(contactId);
    setLiveStatus(
      status,
      'Сообщение в очереди. Worker повторно проверит согласие непосредственно перед отправкой.',
      'success',
    );
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось поставить сообщение в очередь.', 'error');
  } finally {
    button.disabled = !selectedDeliveryEligibility()?.allowed;
  }
});

node('crmTaskForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedContactId) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = node('crmTaskFormStatus');
  button.disabled = true;
  setLiveStatus(status, 'Создаём задачу…');
  try {
    const contactId = state.selectedContactId;
    await post(`/v1/crm/contacts/${encodeURIComponent(contactId)}/tasks`, {
      title: form.elements.title.value.trim(),
      description: form.elements.description.value.trim() || null,
      assigneeMembershipId: form.elements.assigneeMembershipId.value,
      priority: form.elements.priority.value,
      dueLocal: form.elements.dueLocal.value,
      reminderLocal: form.elements.reminderLocal.value,
    });
    form.reset();
    await Promise.all([loadQueues(), loadContacts({ clearMissingSelection: false })]);
    if (state.selectedContactId === contactId) await selectContact(contactId);
    setLiveStatus(status, 'Задача создана.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось создать задачу.', 'error');
  } finally {
    button.disabled = false;
  }
});

node('crmManualHotForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedContactId) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = node('crmManualHotStatus');
  button.disabled = true;
  setLiveStatus(status, 'Сохраняем решение…');
  try {
    const contactId = state.selectedContactId;
    await patchJson(`/v1/crm/contacts/${encodeURIComponent(contactId)}/hot`, {
      mode: form.elements.mode.value,
      reason: form.elements.reason.value.trim(),
      idempotencyKey: pendingIdempotencyKey('pendingManualHotKey', 'crm-hot'),
    });
    state.pendingManualHotKey = null;
    await loadContacts({ clearMissingSelection: false });
    if (state.selectedContactId === contactId) await selectContact(contactId);
    setLiveStatus(status, 'Ручное решение сохранено с причиной.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось сохранить решение.', 'error');
  } finally {
    button.disabled = false;
  }
});

node('crmAssignTagForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedContactId) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = node('crmAssignTagStatus');
  button.disabled = true;
  setLiveStatus(status, 'Добавляем тег…');
  try {
    const contactId = state.selectedContactId;
    const tagId = form.elements.tagId.value;
    await post(`/v1/crm/contacts/${encodeURIComponent(contactId)}/tags/${encodeURIComponent(tagId)}`, {});
    await Promise.all([loadTags(), loadContacts({ clearMissingSelection: false })]);
    if (state.selectedContactId === contactId) await selectContact(contactId);
    setLiveStatus(status, 'Тег добавлен к контакту.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось добавить тег.', 'error');
  } finally {
    button.disabled = false;
  }
});

node('crmCreateTagForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = node('crmTagManagementStatus');
  button.disabled = true;
  setLiveStatus(status, 'Создаём тег…');
  try {
    await post('/v1/crm/tags', {
      name: form.elements.name.value.trim(),
      colorToken: form.elements.colorToken.value,
    });
    form.reset();
    await loadTags();
    setLiveStatus(status, 'Тег создан внутри организации.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось создать тег.', 'error');
  } finally {
    button.disabled = false;
  }
});

node('crmScoringForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = node('crmScoringStatus');
  button.disabled = true;
  setLiveStatus(status, 'Создаём и включаем новую версию…');
  try {
    await post('/v1/crm/scoring/versions', {
      name: form.elements.name.value.trim(),
      hotThreshold: Number(form.elements.hotThreshold.value),
      points: {
        registration: Number(form.elements.registration.value),
        roomEntered: Number(form.elements.roomEntered.value),
        viewed50Percent: Number(form.elements.viewed50Percent.value),
        question: Number(form.elements.question.value),
        cta: Number(form.elements.cta.value),
      },
      idempotencyKey: pendingIdempotencyKey('pendingScoringVersionKey', 'crm-score-version'),
    });
    state.pendingScoringVersionKey = null;
    await Promise.all([loadScoring(), loadContacts({ clearMissingSelection: false })]);
    if (state.selectedContactId) await selectContact(state.selectedContactId);
    setLiveStatus(status, 'Новая версия активна, баллы пересчитаны без дублирования факторов.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось включить scoring-версию.', 'error');
  } finally {
    button.disabled = false;
  }
});

node('crmCreateStageForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = node('crmStageManagementStatus');
  button.disabled = true;
  setLiveStatus(status, 'Добавляем этап…');
  try {
    await post('/v1/crm/stages', {
      name: form.elements.name.value.trim(),
      semanticCategory: form.elements.semanticCategory.value,
    });
    form.reset();
    await refreshReference();
    setLiveStatus(status, 'Новый этап добавлен.', 'success');
  } catch (error) {
    setLiveStatus(status, error.message || 'Не удалось добавить этап.', 'error');
  } finally {
    button.disabled = false;
  }
});

node('crmRetry').addEventListener('click', () => void boot());
window.addEventListener('popstate', () => {
  invalidateBulkPreview();
  hydrateFormFromUrl();
  renderQueues();
  clearDetail();
  void loadContacts();
});

void boot();
