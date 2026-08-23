import { csrfHeaders, deleteJson, getJson, patchJson, post } from './utils.js?v=creator-webinars-2';

const labels = {
  contentStatus: {
    DRAFT: 'Черновик',
    NEEDS_REVIEW: 'Нужны изменения',
    READY: 'Готов к публикации',
    IN_MODERATION: 'На модерации',
    PUBLISHED: 'Опубликован',
    ARCHIVED: 'В архиве',
  },
  mediaStatus: { NOT_UPLOADED: 'Видео не загружено', PROCESSING: 'Видео обрабатывается', READY: 'Видео готово', FAILED: 'Ошибка видео' },
  transcriptStatus: { NOT_AVAILABLE: 'Транскрипта нет', DRAFT: 'Черновик', REVIEWED: 'Проверен', PUBLISHED: 'Опубликован' },
  scenarioStatus: { NOT_AVAILABLE: 'Сценария нет', DRAFT: 'Черновик', PUBLISHED: 'Опубликован' },
  visibility: { PUBLIC: 'Публичный', UNLISTED: 'По ссылке', PRIVATE: 'По приглашению' },
  lifecycle: { SCHEDULED: 'Запланирован', ROOM_OPEN: 'Комната открыта', LIVE: 'Идёт эфир', REPLAY: 'Доступен replay', CLOSED: 'Закрыт', CANCELLED: 'Отменён' },
  access: { PENDING: 'Ожидает принятия', ACCEPTED: 'Принято', REVOKED: 'Отозвано', EXPIRED: 'Истекло' },
  mediaAsset: {
    CREATED: 'Создано', UPLOADING: 'Загружается', VALIDATING: 'Проверяется',
    TRANSCODING: 'Формируется HLS', TRANSCRIBING: 'Готовится расшифровка', ENRICHING: 'Готовятся материалы',
    READY: 'Готово', FAILED: 'Ошибка обработки', CANCELLED: 'Отменено',
  },
  suggestionType: {
    TITLE: 'Название', DESCRIPTION: 'Описание', CHAPTER: 'Глава', TAG: 'Тег', PREPARED_QUESTION: 'Подготовленный AI-вопрос',
  },
  suggestionStatus: { PENDING: 'Требует проверки', ACCEPTED: 'Принято', REJECTED: 'Отклонено' },
};

const state = {
  session: null,
  membership: null,
  referenceData: { practiceAreas: [], jurisdictions: [] },
  webinars: [],
  current: null,
  scenario: null,
  grants: [],
  transcript: null,
  terms: [],
  suggestions: [],
  mediaAsset: null,
  transcriptRowCounter: 0,
  activeJobPoll: 0,
  scenarioRowCounter: 0,
};

function node(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const target = node(id);
  if (target) target.textContent = value ?? '';
}

function setMode(mode, focusId) {
  document.body.dataset.creatorMode = mode;
  if (focusId) window.requestAnimationFrame(() => node(focusId)?.focus());
}

function formatDateTime(value, timezone) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone || undefined,
  }).format(new Date(value));
}

function operationKey(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function strictNullable(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function numberOrNull(value) {
  return value === '' || value === null || value === undefined ? null : Number(value);
}

function firstInvalid(form) {
  const invalid = [...form.elements].find(control => typeof control.checkValidity === 'function' && !control.checkValidity());
  if (!invalid) return null;
  invalid.setAttribute('aria-invalid', 'true');
  invalid.focus();
  return invalid;
}

function clearInvalid(form) {
  for (const control of form.elements) control.removeAttribute?.('aria-invalid');
}

function processing(button, busy, label, busyLabel) {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : label;
}

function errorCopy(error, fallback) {
  const code = error?.payload?.code;
  if (code === 'webinar_metadata_incomplete') {
    const fields = error.payload?.fieldErrors?.missingFields || error.payload?.details?.missingFields;
    return Array.isArray(fields) && fields.length
      ? `Заполните обязательные сведения: ${fields.join(', ')}.`
      : 'Заполните обязательные юридические сведения.';
  }
  if (code === 'author_verification_required') return 'Публикация доступна только проверенному активному автору.';
  if (code === 'webinar_publication_not_ready') return 'Видео, транскрипт и сценарий должны быть опубликованы отдельно.';
  if (code === 'chat_scenario_disclosure_required') return 'Добавьте маркировку подготовленных сообщений в юридические сведения.';
  if (code === 'chat_scenario_empty') return 'Добавьте хотя бы одно подготовленное сообщение.';
  if (code === 'chat_scenario_review_required') return 'Проверьте статус каждого сообщения: черновики нельзя публиковать.';
  if (code === 'chat_scenario_no_approved_messages') return 'Одобрите хотя бы одно сообщение перед публикацией.';
  if (code === 'webinar_slug_conflict') return 'Этот slug уже используется. Выберите другой.';
  if (code === 'media_storage_unconfigured') return 'Приватное хранилище ещё не подключено. Выберите провайдера перед загрузкой.';
  if (code === 'transcript_revision_conflict') return 'Расшифровка уже изменилась. Обновите вебинар и повторите.';
  if (code === 'transcript_review_required') return 'Сначала проверьте расшифровку.';
  if (code === 'suggestion_revision_conflict') return 'Предложение уже проверено или изменилось. Обновите список.';
  if (error?.status === 409) return 'Действие недоступно в текущем статусе. Обновите вебинар и проверьте условия.';
  if (error?.status === 400) return 'Проверьте заполненные поля и допустимые значения.';
  return fallback;
}

function showFatalError(error) {
  if (error?.status === 401) {
    setText('creatorErrorTitle', 'Сначала войдите в аккаунт');
    setText('creatorErrorText', 'Откройте страницу «Мой доступ» и завершите защищённый вход.');
  } else if (error?.status === 403) {
    setText('creatorErrorTitle', 'Нет доступа к вебинарам');
    setText('creatorErrorText', 'Кабинет доступен активному автору или владельцу выбранной организации.');
  } else if (error?.status === 404) {
    setText('creatorErrorTitle', 'Кабинет ещё не включён');
    setText('creatorErrorText', 'Функция недоступна для выбранной организации. Вернитесь к странице доступа.');
  } else {
    setText('creatorErrorTitle', 'Не удалось загрузить кабинет');
    setText('creatorErrorText', 'Проверьте соединение и обновите страницу.');
  }
  setMode('error', 'creatorErrorTitle');
}

function option(value, text) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = text;
  return item;
}

function fillReferenceData() {
  const jurisdiction = node('creatorJurisdiction');
  jurisdiction.replaceChildren(option('', 'Не выбрана'));
  for (const item of state.referenceData.jurisdictions) jurisdiction.append(option(item.id, item.name));

  const primary = node('creatorPrimaryArea');
  primary.replaceChildren(option('', 'Не выбрана'));
  for (const item of state.referenceData.practiceAreas.filter(area => !area.parentId)) {
    primary.append(option(item.id, item.name));
  }
  renderSpecializations('');
}

function renderSpecializations(selected) {
  const parentId = node('creatorPrimaryArea').value;
  const specialization = node('creatorSpecialization');
  specialization.replaceChildren(option('', 'Не выбрана'));
  for (const item of state.referenceData.practiceAreas.filter(area => area.parentId === parentId)) {
    specialization.append(option(item.id, item.name));
  }
  specialization.value = selected || '';
}

function renderWebinarList() {
  const list = node('creatorWebinarList');
  list.replaceChildren();
  node('creatorListEmpty').hidden = state.webinars.length > 0;
  setText('creatorListCount', `${state.webinars.length} ${state.webinars.length === 1 ? 'вебинар' : 'вебинаров'}`);
  for (const webinar of state.webinars) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'creator-webinar-button';
    button.dataset.webinarId = webinar.id;
    button.setAttribute('aria-current', String(state.current?.id === webinar.id));
    const title = document.createElement('span');
    title.className = 'creator-webinar-button-title';
    title.textContent = webinar.title;
    const meta = document.createElement('span');
    meta.className = 'creator-webinar-button-meta';
    meta.textContent = `${labels.contentStatus[webinar.contentStatus] || webinar.contentStatus} · ${labels.visibility[webinar.visibility] || webinar.visibility}`;
    button.append(title, meta);
    button.addEventListener('click', () => void selectWebinar(webinar.id));
    item.append(button);
    list.append(item);
  }
}

function renderStatusGrid(webinar) {
  const target = node('creatorStatusGrid');
  target.replaceChildren();
  const statuses = [
    ['Контент', labels.contentStatus[webinar.contentStatus] || webinar.contentStatus],
    ['Видео', labels.mediaStatus[webinar.mediaStatus] || webinar.mediaStatus],
    ['Транскрипт', labels.transcriptStatus[webinar.transcriptStatus] || webinar.transcriptStatus],
    ['Сценарий', labels.scenarioStatus[webinar.scenarioStatus] || webinar.scenarioStatus],
    ['Запуски', String(webinar.sessions?.length || 0)],
  ];
  for (const [name, value] of statuses) {
    const card = document.createElement('div');
    card.className = 'creator-status-card';
    const label = document.createElement('p');
    label.className = 'text-label-sm text-on-surface-variant';
    label.textContent = name;
    const status = document.createElement('p');
    status.className = 'creator-status-value';
    status.textContent = value;
    card.append(label, status);
    target.append(card);
  }
}

function fillMetadata(webinar) {
  const fields = {
    creatorTitle: webinar.title,
    creatorSlug: webinar.slug,
    creatorDescription: webinar.description || '',
    creatorOutcome: webinar.outcomeDescription || '',
    creatorJurisdiction: webinar.jurisdiction?.id || '',
    creatorAudienceLevel: webinar.audienceLevel || '',
    creatorTargetAudience: webinar.targetAudience || '',
    creatorFormat: webinar.format || '',
    creatorDuration: webinar.durationMinutes || '',
    creatorLanguage: webinar.language || 'ru',
    creatorVisibility: webinar.visibility,
    creatorFreshness: webinar.freshnessStatus,
    creatorCurrentAsOf: webinar.currentAsOf || '',
    creatorDisclaimer: webinar.disclaimer || '',
    creatorSyntheticDisclosure: webinar.syntheticDisclosure || '',
  };
  for (const [id, value] of Object.entries(fields)) node(id).value = value;
  const primary = webinar.practiceAreas?.find(item => item.isPrimary);
  const specialization = webinar.practiceAreas?.find(item => !item.isPrimary);
  node('creatorPrimaryArea').value = primary?.id || '';
  renderSpecializations(specialization?.id || '');

  const editable = ['DRAFT', 'NEEDS_REVIEW'].includes(webinar.contentStatus);
  for (const control of node('creatorMetadataForm').elements) control.disabled = !editable;
  for (const control of node('creatorSourceForm').elements) control.disabled = !editable;
  node('creatorScenarioAddButton').disabled = !editable;
  node('creatorScenarioSaveButton').disabled = !editable;
  node('creatorScenarioPublishButton').disabled = !editable;

  node('creatorSubmitButton').disabled = !['DRAFT', 'NEEDS_REVIEW'].includes(webinar.contentStatus);
  node('creatorPublishButton').disabled = webinar.contentStatus !== 'READY';
  node('creatorArchiveButton').disabled = webinar.contentStatus !== 'PUBLISHED';
}

function metadataPayload() {
  const practiceAreas = [];
  if (node('creatorPrimaryArea').value) {
    practiceAreas.push({ practiceAreaId: node('creatorPrimaryArea').value, isPrimary: true });
  }
  if (node('creatorSpecialization').value) {
    practiceAreas.push({ practiceAreaId: node('creatorSpecialization').value, isPrimary: false });
  }
  return {
    title: node('creatorTitle').value.trim(),
    slug: node('creatorSlug').value.trim(),
    description: strictNullable(node('creatorDescription').value),
    outcomeDescription: strictNullable(node('creatorOutcome').value),
    jurisdictionId: strictNullable(node('creatorJurisdiction').value),
    practiceAreas,
    visibility: node('creatorVisibility').value,
    freshnessStatus: node('creatorFreshness').value,
    audienceLevel: strictNullable(node('creatorAudienceLevel').value),
    targetAudience: strictNullable(node('creatorTargetAudience').value),
    format: strictNullable(node('creatorFormat').value),
    durationMinutes: numberOrNull(node('creatorDuration').value),
    language: node('creatorLanguage').value.trim(),
    currentAsOf: strictNullable(node('creatorCurrentAsOf').value),
    disclaimer: strictNullable(node('creatorDisclaimer').value),
    syntheticDisclosure: strictNullable(node('creatorSyntheticDisclosure').value),
    supersededByWebinarId: state.current.supersededByWebinarId || null,
  };
}

function renderSources(items) {
  const list = node('creatorSourcesList');
  list.replaceChildren();
  node('creatorSourcesEmpty').hidden = items.length > 0;
  const editable = ['DRAFT', 'NEEDS_REVIEW'].includes(state.current.contentStatus);
  for (const source of items) {
    const item = document.createElement('li');
    item.className = 'creator-list-item';
    const copy = document.createElement('div');
    copy.className = 'creator-list-item-copy';
    const title = document.createElement('p');
    title.className = 'font-bold text-primary';
    title.textContent = source.title;
    const link = document.createElement('a');
    link.className = 'mt-1 block text-body-md text-on-surface-variant underline';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.url;
    copy.append(title, link);
    const remove = document.createElement('button');
    remove.className = 'platform-secondary-button creator-danger-button';
    remove.type = 'button';
    remove.textContent = 'Удалить источник';
    remove.disabled = !editable;
    remove.addEventListener('click', () => void removeSource(source.id, remove));
    item.append(copy, remove);
    list.append(item);
  }
}

function addScenarioRow(message = {}) {
  const fragment = node('creatorScenarioTemplate').content.cloneNode(true);
  const row = fragment.querySelector('.creator-scenario-row');
  const rowId = ++state.scenarioRowCounter;
  for (const [field, labelName] of [
    ['offsetSeconds', 'offset'],
    ['kind', 'kind'],
    ['status', 'status'],
    ['text', 'text'],
  ]) {
    const control = row.querySelector(`[data-field="${field}"]`);
    const label = row.querySelector(`[data-label="${labelName}"]`);
    control.id = `creatorScenario${field}-${rowId}`;
    label.htmlFor = control.id;
    control.value = message[field] ?? (field === 'kind' ? 'PREPARED_QUESTION' : field === 'status' ? 'DRAFT' : '');
  }
  row.querySelector('[data-action="remove"]').addEventListener('click', () => {
    row.remove();
    setText('creatorScenarioStatus', 'Сообщение удалено из формы. Сохраните сценарий, чтобы применить изменение.');
  });
  node('creatorScenarioMessages').append(row);
}

function renderScenario(scenario) {
  state.scenario = scenario;
  node('creatorScenarioMessages').replaceChildren();
  if (scenario?.messages?.length) {
    for (const message of scenario.messages) addScenarioRow(message);
  }
  setText(
    'creatorScenarioVersion',
    scenario ? `Версия ${scenario.version} · ${labels.scenarioStatus[scenario.status] || scenario.status}` : 'Сценарий ещё не создан',
  );
}

function scenarioPayload() {
  const rows = [...node('creatorScenarioMessages').querySelectorAll('.creator-scenario-row')];
  const messages = rows.map(row => ({
    offsetSeconds: Number(row.querySelector('[data-field="offsetSeconds"]').value),
    kind: row.querySelector('[data-field="kind"]').value,
    status: row.querySelector('[data-field="status"]').value,
    text: row.querySelector('[data-field="text"]').value.trim(),
  }));
  const invalid = rows.flatMap(row => [...row.querySelectorAll('input, select, textarea')]).find(control => !control.checkValidity());
  if (invalid) {
    invalid.setAttribute('aria-invalid', 'true');
    invalid.focus();
    throw new Error('scenario_invalid');
  }
  return { messages };
}

function renderSessions(sessions) {
  const list = node('creatorSessionsList');
  list.replaceChildren();
  node('creatorSessionsEmpty').hidden = sessions.length > 0;
  for (const session of sessions) {
    const item = document.createElement('li');
    item.className = 'creator-list-item';
    const copy = document.createElement('div');
    copy.className = 'creator-list-item-copy';
    const title = document.createElement('p');
    title.className = 'font-bold text-primary creator-number';
    title.textContent = formatDateTime(session.scheduledAt, session.timezone);
    const meta = document.createElement('p');
    meta.className = 'mt-1 text-body-md text-on-surface-variant';
    meta.textContent = `${labels.lifecycle[session.lifecycleStatus] || session.lifecycleStatus} · ${session.timezone} · ${session.durationMinutes} мин.`;
    copy.append(title, meta);
    item.append(copy);
    list.append(item);
  }
}

function renderGrants(grants) {
  state.grants = grants;
  const list = node('creatorAccessList');
  list.replaceChildren();
  node('creatorAccessEmpty').hidden = grants.length > 0;
  for (const grant of grants) {
    const item = document.createElement('li');
    item.className = 'creator-list-item';
    const copy = document.createElement('div');
    copy.className = 'creator-list-item-copy';
    const title = document.createElement('p');
    title.className = 'font-bold text-primary';
    title.textContent = 'Получатель скрыт';
    const meta = document.createElement('p');
    meta.className = 'mt-1 text-body-md text-on-surface-variant creator-number';
    meta.textContent = `${labels.access[grant.status] || grant.status} · до ${formatDateTime(grant.expiresAt)}`;
    copy.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'creator-list-item-actions';
    if (!['REVOKED', 'EXPIRED'].includes(grant.status)) {
      const revoke = document.createElement('button');
      revoke.className = 'platform-secondary-button creator-danger-button';
      revoke.type = 'button';
      revoke.textContent = 'Отозвать доступ';
      revoke.addEventListener('click', () => void revokeGrant(grant.id, revoke));
      actions.append(revoke);
    }
    item.append(copy, actions);
    list.append(item);
  }
}

function formatPosition(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function renderMediaAsset(asset) {
  state.mediaAsset = asset || null;
  const actions = node('creatorMediaActions');
  actions.hidden = !asset;
  if (!asset) {
    setText('creatorMediaSummary', labels.mediaStatus[state.current?.mediaStatus] || 'Видео ещё не загружено.');
    return;
  }
  const progress = Number.isFinite(asset.progressPercent) ? ` · ${asset.progressPercent}%` : '';
  const duration = asset.durationSeconds ? ` · ${Math.ceil(asset.durationSeconds / 60)} мин.` : '';
  setText(
    'creatorMediaSummary',
    `Версия ${asset.version} · ${labels.mediaAsset[asset.status] || asset.status}${progress}${duration}`,
  );
  node('creatorMediaActivateButton').disabled = asset.status !== 'READY' || state.current?.currentMediaAsset?.id === asset.id;
  node('creatorMediaRetryButton').disabled = asset.status !== 'FAILED';
  node('creatorMediaCancelButton').disabled = !['CREATED', 'UPLOADING', 'VALIDATING'].includes(asset.status);
}

function addTranscriptSegmentRow(segment, index) {
  const fragment = node('creatorTranscriptSegmentTemplate').content.cloneNode(true);
  const row = fragment.querySelector('.creator-transcript-segment');
  const rowId = ++state.transcriptRowCounter;
  row.dataset.segmentIndex = String(index);
  for (const [field, labelName] of [
    ['startMs', 'start'], ['endMs', 'end'], ['speaker', 'speaker'], ['text', 'text'],
  ]) {
    const control = row.querySelector(`[data-field="${field}"]`);
    const label = row.querySelector(`[data-label="${labelName}"]`);
    control.id = `creatorTranscript${field}-${rowId}`;
    label.htmlFor = control.id;
    control.value = segment[field] ?? '';
  }
  row.querySelector('[data-action="seek"]').addEventListener('click', () => {
    const startMs = Number(row.querySelector('[data-field="startMs"]').value || 0);
    setText('creatorTranscriptPosition', `Выбранный таймкод: ${formatPosition(startMs)}`);
    row.querySelector('[data-field="text"]').focus();
  });
  node('creatorTranscriptSegments').append(row);
}

function renderTranscript(transcript) {
  state.transcript = transcript || null;
  const form = node('creatorTranscriptForm');
  node('creatorTranscriptEmpty').hidden = Boolean(transcript);
  form.hidden = !transcript;
  node('creatorTranscriptSegments').replaceChildren();
  if (!transcript) {
    setText('creatorTranscriptSummary', 'Расшифровка ещё не создана.');
    node('creatorAiGenerateButton').disabled = true;
    return;
  }
  setText(
    'creatorTranscriptSummary',
    `Версия ${transcript.version} · ${labels.transcriptStatus[transcript.status] || transcript.status} · ревизия ${transcript.revision} · ${transcript.segments.length} сегментов`,
  );
  transcript.segments.forEach(addTranscriptSegmentRow);
  node('creatorTranscriptPublishButton').disabled = transcript.status !== 'REVIEWED';
  node('creatorAiGenerateButton').disabled = !['REVIEWED', 'PUBLISHED'].includes(transcript.status);
  const exportAvailable = transcript.status === 'PUBLISHED';
  for (const [id, format] of [['creatorTranscriptTxtLink', 'txt'], ['creatorTranscriptVttLink', 'vtt']]) {
    const link = node(id);
    link.href = exportAvailable
      ? `/api/v1/creator/webinars/${encodeURIComponent(state.current.id)}/transcript/export?format=${format}`
      : '#';
    link.setAttribute('aria-disabled', String(!exportAvailable));
    link.tabIndex = exportAvailable ? 0 : -1;
  }
}

function renderTerms(terms) {
  state.terms = terms;
  const list = node('creatorTermsList');
  list.replaceChildren();
  node('creatorTermsEmpty').hidden = terms.length > 0;
  for (const term of terms) {
    const item = document.createElement('li');
    item.className = 'creator-list-item';
    const copy = document.createElement('div');
    copy.className = 'creator-list-item-copy';
    const title = document.createElement('p');
    title.className = 'font-bold text-primary';
    title.textContent = term.term;
    const expansion = document.createElement('p');
    expansion.className = 'mt-1 text-body-md text-on-surface-variant';
    expansion.textContent = term.expansion || 'Без расшифровки';
    copy.append(title, expansion);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'platform-secondary-button creator-danger-button';
    remove.textContent = 'Удалить термин';
    remove.addEventListener('click', () => void removeTerm(term.id, remove));
    item.append(copy, remove);
    list.append(item);
  }
}

function aiField(container, suggestionId, name, labelText, value, options = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = options.wide ? 'creator-transcript-text-field grid gap-2' : 'grid gap-2';
  const label = document.createElement('label');
  label.className = 'text-label-md font-label-md text-primary';
  label.htmlFor = `creatorAi-${suggestionId}-${name}`;
  label.textContent = labelText;
  const control = options.multiline ? document.createElement('textarea') : document.createElement('input');
  control.id = label.htmlFor;
  control.dataset.aiField = name;
  control.className = options.multiline
    ? 'platform-input creator-scenario-text px-4 py-3'
    : `platform-input px-4${options.number ? ' creator-number' : ''}`;
  if (options.number) {
    control.type = 'number';
    control.inputMode = 'numeric';
    control.min = '0';
  }
  control.value = value ?? '';
  control.required = options.required !== false;
  wrapper.append(label, control);
  container.append(wrapper);
  return control;
}

function renderAiSuggestions(suggestions) {
  state.suggestions = suggestions;
  const target = node('creatorAiSuggestions');
  target.replaceChildren();
  node('creatorAiEmpty').hidden = suggestions.length > 0;
  for (const suggestion of suggestions) {
    const card = document.createElement('article');
    card.className = 'creator-ai-suggestion';
    card.dataset.status = suggestion.status;
    const heading = document.createElement('h4');
    heading.className = 'creator-ai-suggestion-title text-title-sm font-bold text-primary';
    heading.textContent = labels.suggestionType[suggestion.type] || suggestion.type;
    const status = document.createElement('p');
    status.className = 'creator-ai-suggestion-status mt-1 text-label-sm text-on-surface-variant';
    status.textContent = labels.suggestionStatus[suggestion.status] || suggestion.status;
    const fields = document.createElement('div');
    fields.className = 'creator-ai-fields mt-4';
    const content = suggestion.content || {};
    if (['TITLE', 'DESCRIPTION'].includes(suggestion.type)) {
      aiField(fields, suggestion.id, 'text', suggestion.type === 'TITLE' ? 'Название' : 'Описание', content.text, { multiline: suggestion.type === 'DESCRIPTION', wide: true });
    } else if (suggestion.type === 'CHAPTER') {
      aiField(fields, suggestion.id, 'startMs', 'Начало, мс', content.startMs, { number: true });
      aiField(fields, suggestion.id, 'title', 'Название главы', content.title);
      aiField(fields, suggestion.id, 'description', 'Описание главы', content.description, { required: false, wide: true });
    } else if (suggestion.type === 'TAG') {
      aiField(fields, suggestion.id, 'name', 'Тег', content.name);
    } else {
      aiField(fields, suggestion.id, 'offsetSeconds', 'Таймкод, секунды', content.offsetSeconds, { number: true });
      aiField(fields, suggestion.id, 'text', 'Подготовленный вопрос', content.text, { multiline: true, wide: true });
    }
    for (const control of fields.querySelectorAll('input, textarea')) control.disabled = suggestion.status !== 'PENDING';
    card.append(heading, status, fields);
    if (suggestion.status === 'PENDING') {
      const actions = document.createElement('div');
      actions.className = 'creator-actions mt-4';
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.className = 'platform-primary-button';
      accept.textContent = 'Принять после проверки';
      accept.addEventListener('click', () => void reviewSuggestion(suggestion, card, 'ACCEPT', accept));
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'platform-secondary-button creator-danger-button';
      reject.textContent = 'Отклонить';
      reject.addEventListener('click', () => void reviewSuggestion(suggestion, card, 'REJECT', reject));
      actions.append(accept, reject);
      card.append(actions);
    }
    target.append(card);
  }
}

function suggestionContent(suggestion, card) {
  const value = name => card.querySelector(`[data-ai-field="${name}"]`)?.value.trim();
  if (suggestion.type === 'TITLE' || suggestion.type === 'DESCRIPTION') return { text: value('text') };
  if (suggestion.type === 'CHAPTER') {
    return { startMs: Number(value('startMs')), title: value('title'), ...(value('description') ? { description: value('description') } : {}) };
  }
  if (suggestion.type === 'TAG') return { name: value('name') };
  return { offsetSeconds: Number(value('offsetSeconds')), text: value('text') };
}

async function loadTranscriptWorkspace(webinarId) {
  const transcriptRequest = getJson(`/v1/creator/webinars/${encodeURIComponent(webinarId)}/transcript`).catch(error => {
    if (error?.status === 404) return { transcript: null };
    throw error;
  });
  const [transcriptResult, termsResult, suggestionsResult] = await Promise.all([
    transcriptRequest,
    getJson('/v1/creator/term-dictionary'),
    getJson(`/v1/creator/webinars/${encodeURIComponent(webinarId)}/ai-suggestions`),
  ]);
  if (state.current?.id !== webinarId) return;
  renderTranscript(transcriptResult.transcript);
  renderTerms(termsResult.terms || []);
  renderAiSuggestions(suggestionsResult.suggestions || []);
  renderMediaAsset(state.current.currentMediaAsset || null);
  if (readUploadResume()) {
    setText('creatorUploadStatus', 'Есть незавершённая загрузка. Выберите тот же файл, чтобы продолжить без повторной передачи готовых частей.');
  }
  node('creatorTranscriptGenerateButton').disabled = state.current.mediaStatus !== 'READY';
}

function waitForNextPoll() {
  return new Promise(resolve => window.setTimeout(resolve, document.hidden ? 5_000 : 1_500));
}

async function pollContentJob(jobId, kind) {
  const pollToken = ++state.activeJobPoll;
  for (let attempt = 0; attempt < 120 && pollToken === state.activeJobPoll; attempt += 1) {
    const result = await getJson(`/v1/creator/content-jobs/${encodeURIComponent(jobId)}/status`);
    const job = result.job;
    setText('creatorTranscriptJobStatus', `${kind}: ${job.status === 'PENDING' ? 'в очереди' : job.status === 'RUNNING' ? 'обрабатывается' : job.status.toLowerCase()} · попытка ${job.attempts}/${job.maxAttempts}`);
    if (job.status === 'SUCCEEDED') {
      await loadTranscriptWorkspace(state.current.id);
      setText('creatorTranscriptJobStatus', `${kind} готова. Проверьте результат.`);
      return;
    }
    if (['FAILED', 'DEAD_LETTER', 'CANCELLED'].includes(job.status)) {
      setText('creatorTranscriptJobStatus', `${kind} не завершена. Код: ${job.errorCode || 'content_job_failed'}.`);
      return;
    }
    await waitForNextPoll();
  }
}

async function loadWebinarList() {
  const result = await getJson('/v1/creator/webinars');
  state.webinars = result.items || [];
  renderWebinarList();
}

async function selectWebinar(webinarId, focus = true) {
  state.activeJobPoll += 1;
  setText('creatorCommandStatus', 'Загружаем вебинар…');
  try {
    const [detail, scenario] = await Promise.all([
      getJson(`/v1/creator/webinars/${encodeURIComponent(webinarId)}`),
      getJson(`/v1/creator/webinars/${encodeURIComponent(webinarId)}/chat-scenario`),
    ]);
    state.current = detail.webinar;
    state.scenario = scenario.scenario;
    setText('creatorOverviewHeading', state.current.title);
    node('creatorPreviewLink').href = `creator-webinar-preview.html#webinar=${encodeURIComponent(state.current.id)}`;
    renderStatusGrid(state.current);
    fillMetadata(state.current);
    renderSources(state.current.sources || []);
    renderScenario(state.scenario);
    renderSessions(state.current.sessions || []);
    renderTranscript(null);
    renderTerms([]);
    renderAiSuggestions([]);
    renderMediaAsset(state.current.currentMediaAsset || null);
    node('creatorNoSelection').hidden = true;
    node('creatorEditor').hidden = false;
    node('creatorAccessSection').hidden = !(state.membership.role === 'OWNER' && state.current.visibility === 'PRIVATE');
    if (!node('creatorAccessSection').hidden) {
      const result = await getJson(`/v1/creator/webinars/${encodeURIComponent(webinarId)}/access-grants`);
      renderGrants(result.grants || []);
    } else {
      renderGrants([]);
    }
    try {
      await loadTranscriptWorkspace(webinarId);
      setText('creatorTranscriptJobStatus', '');
    } catch (error) {
      setText(
        'creatorTranscriptJobStatus',
        errorCopy(error, 'Инструменты видео и расшифровки временно недоступны. Остальные сведения можно редактировать.'),
      );
    }
    renderWebinarList();
    setText('creatorCommandStatus', '');
    if (focus) window.requestAnimationFrame(() => node('creatorOverviewHeading').focus());
  } catch (error) {
    if ([401, 403].includes(error?.status)) showFatalError(error);
    else setText('creatorCommandStatus', 'Не удалось загрузить вебинар. Проверьте соединение и повторите.');
  }
}

async function refreshCurrent(focus = false) {
  if (!state.current) return;
  const id = state.current.id;
  await loadWebinarList();
  await selectWebinar(id, focus);
}

async function removeSource(sourceId, button) {
  button.disabled = true;
  setText('creatorSourceStatus', 'Удаляем источник…');
  try {
    await deleteJson(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/sources/${encodeURIComponent(sourceId)}`);
    await refreshCurrent();
    setText('creatorSourceStatus', 'Источник удалён.');
  } catch (error) {
    setText('creatorSourceStatus', errorCopy(error, 'Не удалось удалить источник. Обновите страницу и повторите.'));
    button.disabled = false;
  }
}

async function revokeGrant(grantId, button) {
  button.disabled = true;
  setText('creatorAccessStatus', 'Отзываем доступ…');
  try {
    await deleteJson(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/access-grants/${encodeURIComponent(grantId)}`);
    const result = await getJson(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/access-grants`);
    renderGrants(result.grants || []);
    setText('creatorAccessStatus', 'Доступ отозван. Новые входы закрыты.');
  } catch (error) {
    setText('creatorAccessStatus', errorCopy(error, 'Не удалось отозвать доступ. Обновите страницу и повторите.'));
    button.disabled = false;
  }
}

async function removeTerm(termId, button) {
  processing(button, true, 'Удалить термин', 'Удаляем…');
  try {
    await deleteJson(`/v1/creator/term-dictionary/${encodeURIComponent(termId)}`);
    const result = await getJson('/v1/creator/term-dictionary');
    renderTerms(result.terms || []);
    setText('creatorTermStatus', 'Термин удалён из словаря организации.');
  } catch (error) {
    setText('creatorTermStatus', errorCopy(error, 'Не удалось удалить термин. Обновите список и повторите.'));
    processing(button, false, 'Удалить термин', 'Удаляем…');
  }
}

async function reviewSuggestion(suggestion, card, action, button) {
  if (action === 'ACCEPT') {
    const invalid = [...card.querySelectorAll('input, textarea')].find(control => !control.checkValidity());
    if (invalid) {
      invalid.setAttribute('aria-invalid', 'true');
      invalid.focus();
      setText('creatorAiStatus', 'Заполните поля предложения перед принятием.');
      return;
    }
  }
  const idle = action === 'ACCEPT' ? 'Принять после проверки' : 'Отклонить';
  processing(button, true, idle, action === 'ACCEPT' ? 'Принимаем…' : 'Отклоняем…');
  setText('creatorAiStatus', '');
  try {
    await patchJson(
      `/v1/creator/webinars/${encodeURIComponent(state.current.id)}/ai-suggestions/${encodeURIComponent(suggestion.id)}`,
      {
        action,
        expectedRevision: suggestion.revision,
        ...(action === 'ACCEPT' ? { content: suggestionContent(suggestion, card) } : {}),
      },
    );
    await refreshCurrent(false);
    setText('creatorAiStatus', action === 'ACCEPT'
      ? 'Предложение принято как ручное решение.'
      : 'Предложение отклонено.');
  } catch (error) {
    setText('creatorAiStatus', errorCopy(error, 'Не удалось проверить предложение. Обновите список и повторите.'));
    processing(button, false, idle, '');
  }
}

function transcriptPayload() {
  const rows = [...node('creatorTranscriptSegments').querySelectorAll('.creator-transcript-segment')];
  const invalid = rows.flatMap(row => [...row.querySelectorAll('input, textarea')]).find(control => !control.checkValidity());
  if (invalid) {
    invalid.setAttribute('aria-invalid', 'true');
    invalid.focus();
    throw new Error('transcript_invalid');
  }
  return rows.map(row => ({
    startMs: Number(row.querySelector('[data-field="startMs"]').value),
    endMs: Number(row.querySelector('[data-field="endMs"]').value),
    ...(row.querySelector('[data-field="speaker"]').value.trim()
      ? { speaker: row.querySelector('[data-field="speaker"]').value.trim() }
      : {}),
    text: row.querySelector('[data-field="text"]').value.trim(),
  }));
}

async function refreshMediaStatus() {
  if (!state.mediaAsset) return null;
  const result = await getJson(`/v1/creator/media/${encodeURIComponent(state.mediaAsset.id)}/status`);
  renderMediaAsset(result.asset);
  return result.asset;
}

async function pollMediaAsset(assetId) {
  for (let attempt = 0; attempt < 120 && state.mediaAsset?.id === assetId; attempt += 1) {
    const asset = await refreshMediaStatus();
    if (!asset || ['READY', 'FAILED', 'CANCELLED'].includes(asset.status)) {
      setText('creatorUploadStatus', asset?.status === 'READY'
        ? 'Видео готово. Включите эту версию, когда будете готовы к переключению.'
        : 'Обработка остановлена. Проверьте статус и доступные действия.');
      return;
    }
    await waitForNextPoll();
  }
}

function uploadResumeStorageKey(webinarId = state.current?.id) {
  return webinarId ? `aspb.creator.upload.${webinarId}` : '';
}

function readUploadResume() {
  try {
    const raw = window.sessionStorage.getItem(uploadResumeStorageKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveUploadResume(value) {
  try {
    const key = uploadResumeStorageKey();
    if (key) window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Upload remains usable without browser-side resume metadata.
  }
}

function clearUploadResume() {
  try {
    const key = uploadResumeStorageKey();
    if (key) window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in hardened browsing modes.
  }
}

async function putUploadPart(part, body, mimeType) {
  const target = new URL(part.url, window.location.href);
  const sameOrigin = target.origin === window.location.origin;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(target, {
        method: 'PUT',
        body,
        credentials: sameOrigin ? 'same-origin' : 'omit',
        headers: {
          'Content-Type': mimeType,
          ...(sameOrigin ? await csrfHeaders() : {}),
        },
      });
      if (response.ok) {
        const etag = response.headers.get('etag');
        if (!etag) throw new Error('Сервер не подтвердил загруженную часть. Повторите загрузку.');
        const checkpoint = sameOrigin ? await response.json().catch(() => null) : null;
        return { etag, completedParts: checkpoint?.checkpointed ? checkpoint.completedParts : null };
      }
      const payload = sameOrigin ? await response.json().catch(() => ({})) : {};
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) {
        const error = new Error(payload.error || 'Не удалось загрузить часть файла. Повторите попытку.');
        error.status = response.status;
        throw error;
      }
    } catch (error) {
      if (attempt === 3 || (error?.status && error.status < 500 && error.status !== 429)) throw error;
    }
    await new Promise(resolve => window.setTimeout(resolve, attempt * 500));
  }
  throw new Error('Не удалось загрузить часть файла. Проверьте соединение и повторите попытку.');
}

async function uploadVideo(file) {
  const saved = readUploadResume();
  const matchesSavedFile = saved
    && saved.fileName === file.name
    && saved.mimeType === file.type
    && saved.sizeBytes === String(file.size);
  let init = null;
  if (matchesSavedFile) {
    setText('creatorUploadStatus', 'Проверяем ранее загруженные части…');
    try {
      init = await post(`/v1/creator/uploads/${encodeURIComponent(saved.uploadId)}/resume`, {});
    } catch (error) {
      if (![404, 409].includes(error?.status)) throw error;
      clearUploadResume();
    }
  }
  if (!init) {
    init = await post(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/uploads`, {
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: String(file.size),
    });
    saveUploadResume({
      uploadId: init.uploadId,
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: String(file.size),
    });
  }
  renderMediaAsset(init.asset);
  let completedParts = [...(init.completedParts || [])];
  const partSize = init.limits.partSizeBytes;
  for (let index = 0; index < init.parts.length; index += 1) {
    const part = init.parts[index];
    setText('creatorUploadStatus', `Загружаем часть ${part.partNumber}… Уже готово: ${completedParts.length}.`);
    const body = file.slice((part.partNumber - 1) * partSize, Math.min(file.size, part.partNumber * partSize));
    const uploaded = await putUploadPart(part, body, file.type);
    if (uploaded.completedParts) {
      completedParts = uploaded.completedParts;
      continue;
    }
    const recorded = await post(`/v1/creator/uploads/${encodeURIComponent(init.uploadId)}/parts`, {
      partNumber: part.partNumber,
      etag: uploaded.etag,
    });
    completedParts = recorded.completedParts;
  }
  const completed = await post(`/v1/creator/uploads/${encodeURIComponent(init.uploadId)}/complete`, { parts: completedParts });
  clearUploadResume();
  renderMediaAsset(completed.asset);
  setText('creatorUploadStatus', 'Файл загружен. Проверяем и готовим HLS…');
  void pollMediaAsset(completed.asset.id).catch(error => {
    setText('creatorUploadStatus', errorCopy(error, 'Не удалось обновить статус. Нажмите «Обновить статус».'));
  });
}

async function mediaAction(action, button, idleLabel, busyLabel) {
  if (!state.mediaAsset) return;
  processing(button, true, idleLabel, busyLabel);
  try {
    await post(`/v1/creator/media/${encodeURIComponent(state.mediaAsset.id)}/${action}`, {});
    if (action === 'activate') {
      await refreshCurrent(false);
      setText('creatorUploadStatus', 'Готовая версия видео включена.');
    } else {
      await refreshMediaStatus();
      if (action === 'cancel') clearUploadResume();
      setText('creatorUploadStatus', action === 'retry' ? 'Повторная обработка поставлена в очередь.' : 'Обработка отменена.');
    }
  } catch (error) {
    setText('creatorUploadStatus', errorCopy(error, 'Не удалось выполнить действие. Обновите статус и повторите.'));
    processing(button, false, idleLabel, busyLabel);
  }
}

function bindMediaTranscript() {
  const uploadForm = node('creatorUploadForm');
  uploadForm.addEventListener('submit', async event => {
    event.preventDefault();
    clearInvalid(uploadForm);
    const fileInput = node('creatorVideoFile');
    const file = fileInput.files?.[0];
    const allowedTypes = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
    if (!file || !allowedTypes.has(file.type)) {
      fileInput.setAttribute('aria-invalid', 'true');
      fileInput.focus();
      setText('creatorUploadStatus', 'Выберите файл MP4, MOV или WebM.');
      return;
    }
    const button = node('creatorUploadButton');
    processing(button, true, 'Загрузить видео', 'Загружаем…');
    setText('creatorUploadStatus', 'Подготавливаем защищённую загрузку…');
    try {
      await uploadVideo(file);
      uploadForm.reset();
    } catch (error) {
      setText('creatorUploadStatus', errorCopy(error, 'Не удалось загрузить видео. Проверьте файл и соединение.'));
    } finally {
      processing(button, false, 'Загрузить видео', 'Загружаем…');
    }
  });

  node('creatorMediaRefreshButton').addEventListener('click', async () => {
    const button = node('creatorMediaRefreshButton');
    processing(button, true, 'Обновить статус', 'Обновляем…');
    try {
      await refreshMediaStatus();
      setText('creatorUploadStatus', 'Статус видео обновлён.');
    } catch (error) {
      setText('creatorUploadStatus', errorCopy(error, 'Не удалось обновить статус видео.'));
    } finally {
      processing(button, false, 'Обновить статус', 'Обновляем…');
    }
  });
  node('creatorMediaActivateButton').addEventListener('click', () => void mediaAction(
    'activate', node('creatorMediaActivateButton'), 'Включить готовую версию', 'Включаем…',
  ));
  node('creatorMediaRetryButton').addEventListener('click', () => void mediaAction(
    'retry', node('creatorMediaRetryButton'), 'Повторить обработку', 'Запускаем…',
  ));
  node('creatorMediaCancelButton').addEventListener('click', () => void mediaAction(
    'cancel', node('creatorMediaCancelButton'), 'Отменить обработку', 'Отменяем…',
  ));

  node('creatorTranscriptGenerateButton').addEventListener('click', async () => {
    const button = node('creatorTranscriptGenerateButton');
    processing(button, true, 'Создать расшифровку', 'Ставим в очередь…');
    setText('creatorTranscriptJobStatus', 'Создаём задачу расшифровки…');
    try {
      const result = await post(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/transcript`, {});
      setText('creatorTranscriptJobStatus', 'Расшифровка поставлена в очередь.');
      await pollContentJob(result.job.id, 'Расшифровка');
    } catch (error) {
      setText('creatorTranscriptJobStatus', errorCopy(error, 'Не удалось запустить расшифровку.'));
    } finally {
      processing(button, false, 'Создать расшифровку', 'Ставим в очередь…');
    }
  });

  node('creatorAiGenerateButton').addEventListener('click', async () => {
    const button = node('creatorAiGenerateButton');
    processing(button, true, 'Предложить материалы с AI', 'Ставим в очередь…');
    setText('creatorAiStatus', 'Создаём задачу AI-подготовки…');
    try {
      const result = await post(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/ai-suggestions`, {});
      setText('creatorAiStatus', 'AI-подготовка поставлена в очередь. Публикация останется ручной.');
      await pollContentJob(result.job.id, 'AI-подготовка');
    } catch (error) {
      setText('creatorAiStatus', errorCopy(error, 'Не удалось запустить AI-подготовку.'));
    } finally {
      processing(button, false, 'Предложить материалы с AI', 'Ставим в очередь…');
    }
  });

  const transcriptForm = node('creatorTranscriptForm');
  transcriptForm.addEventListener('submit', async event => {
    event.preventDefault();
    clearInvalid(transcriptForm);
    const status = event.submitter?.dataset.transcriptStatus || 'DRAFT';
    const button = event.submitter || node('creatorTranscriptDraftButton');
    const idleLabel = status === 'REVIEWED' ? 'Отметить как проверенный' : 'Сохранить черновик';
    let segments;
    try {
      segments = transcriptPayload();
    } catch {
      setText('creatorTranscriptStatus', 'Проверьте таймкоды, спикеров и текст сегментов.');
      return;
    }
    processing(button, true, idleLabel, 'Сохраняем…');
    try {
      const result = await patchJson(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/transcript`, {
        transcriptId: state.transcript.id,
        expectedRevision: state.transcript.revision,
        status,
        segments,
      });
      renderTranscript(result.transcript);
      setText('creatorTranscriptStatus', status === 'REVIEWED'
        ? 'Расшифровка сохранена и отмечена как проверенная.'
        : 'Черновик расшифровки сохранён.');
      await loadWebinarList();
    } catch (error) {
      setText('creatorTranscriptStatus', errorCopy(error, 'Не удалось сохранить расшифровку.'));
    } finally {
      processing(button, false, idleLabel, 'Сохраняем…');
    }
  });

  node('creatorTranscriptPublishButton').addEventListener('click', async () => {
    const button = node('creatorTranscriptPublishButton');
    processing(button, true, 'Опубликовать расшифровку', 'Публикуем…');
    try {
      const result = await post(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/transcript/publish`, {
        transcriptId: state.transcript.id,
        expectedRevision: state.transcript.revision,
      });
      state.current.transcriptStatus = result.transcript.status;
      renderStatusGrid(state.current);
      renderTranscript(result.transcript);
      await loadWebinarList();
      setText('creatorTranscriptStatus', 'Расшифровка опубликована отдельно от вебинара.');
    } catch (error) {
      setText('creatorTranscriptStatus', errorCopy(error, 'Не удалось опубликовать расшифровку.'));
    } finally {
      processing(button, false, 'Опубликовать расшифровку', 'Публикуем…');
    }
  });

  const termForm = node('creatorTermForm');
  termForm.addEventListener('submit', async event => {
    event.preventDefault();
    clearInvalid(termForm);
    if (firstInvalid(termForm)) {
      setText('creatorTermStatus', 'Укажите термин длиной до 160 символов.');
      return;
    }
    const button = node('creatorTermButton');
    processing(button, true, 'Добавить термин', 'Добавляем…');
    try {
      await post('/v1/creator/term-dictionary', {
        term: node('creatorTerm').value.trim(),
        ...(node('creatorTermExpansion').value.trim() ? { expansion: node('creatorTermExpansion').value.trim() } : {}),
      });
      termForm.reset();
      const result = await getJson('/v1/creator/term-dictionary');
      renderTerms(result.terms || []);
      setText('creatorTermStatus', 'Термин добавлен в словарь организации.');
    } catch (error) {
      setText('creatorTermStatus', errorCopy(error, 'Не удалось добавить термин.'));
    } finally {
      processing(button, false, 'Добавить термин', 'Добавляем…');
    }
  });

  for (const id of ['creatorTranscriptTxtLink', 'creatorTranscriptVttLink']) {
    node(id).addEventListener('click', event => {
      if (event.currentTarget.getAttribute('aria-disabled') === 'true') event.preventDefault();
    });
  }
}

function bindCreate() {
  const form = node('creatorCreateForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearInvalid(form);
    setText('creatorNewTitleError', '');
    setText('creatorNewSlugError', '');
    const invalid = firstInvalid(form);
    if (invalid) {
      setText(invalid.id === 'creatorNewTitle' ? 'creatorNewTitleError' : 'creatorNewSlugError', invalid.id === 'creatorNewTitle' ? 'Укажите название от 3 до 240 символов.' : 'Используйте латинские буквы, цифры и дефисы.');
      return;
    }
    const button = node('creatorCreateButton');
    processing(button, true, 'Создать черновик', 'Создаём…');
    setText('creatorCreateStatus', '');
    try {
      const result = await post('/v1/creator/webinars', {
        title: node('creatorNewTitle').value.trim(),
        slug: node('creatorNewSlug').value.trim(),
      });
      form.reset();
      await loadWebinarList();
      await selectWebinar(result.webinar.id);
      setText('creatorCreateStatus', 'Черновик создан.');
    } catch (error) {
      setText('creatorCreateStatus', errorCopy(error, 'Не удалось создать черновик. Проверьте соединение и повторите.'));
    } finally {
      processing(button, false, 'Создать черновик', 'Создаём…');
    }
  });
}

function bindMetadata() {
  node('creatorPrimaryArea').addEventListener('change', () => renderSpecializations(''));
  const form = node('creatorMetadataForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearInvalid(form);
    if (firstInvalid(form)) {
      setText('creatorMetadataStatus', 'Проверьте отмеченное поле и допустимую длину.');
      return;
    }
    const button = node('creatorSaveButton');
    processing(button, true, 'Сохранить сведения', 'Сохраняем…');
    setText('creatorMetadataStatus', '');
    try {
      await patchJson(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}`, metadataPayload());
      await refreshCurrent();
      setText('creatorMetadataStatus', 'Сведения сохранены.');
    } catch (error) {
      setText('creatorMetadataStatus', errorCopy(error, 'Не удалось сохранить сведения. Проверьте поля и соединение.'));
    } finally {
      processing(button, false, 'Сохранить сведения', 'Сохраняем…');
    }
  });
}

function bindSources() {
  const form = node('creatorSourceForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearInvalid(form);
    if (firstInvalid(form)) {
      setText('creatorSourceStatus', 'Укажите название и полную HTTPS-ссылку.');
      return;
    }
    const button = node('creatorSourceButton');
    processing(button, true, 'Добавить источник', 'Добавляем…');
    try {
      await post(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/sources`, {
        type: node('creatorSourceType').value,
        title: node('creatorSourceTitle').value.trim(),
        url: node('creatorSourceUrl').value.trim(),
      });
      form.reset();
      await refreshCurrent();
      setText('creatorSourceStatus', 'Источник добавлен.');
    } catch (error) {
      setText('creatorSourceStatus', errorCopy(error, 'Не удалось добавить источник. Проверьте ссылку и повторите.'));
    } finally {
      processing(button, false, 'Добавить источник', 'Добавляем…');
    }
  });
}

function bindScenario() {
  node('creatorScenarioAddButton').addEventListener('click', () => {
    addScenarioRow();
    const rows = node('creatorScenarioMessages').querySelectorAll('.creator-scenario-row');
    rows[rows.length - 1]?.querySelector('input')?.focus();
  });
  node('creatorScenarioSaveButton').addEventListener('click', async () => {
    const button = node('creatorScenarioSaveButton');
    let payload;
    try {
      payload = scenarioPayload();
    } catch {
      setText('creatorScenarioStatus', 'Заполните таймкод, тип, подпись и текст каждого сообщения.');
      return;
    }
    processing(button, true, 'Сохранить сценарий', 'Сохраняем…');
    try {
      const result = await patchJson(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/chat-scenario`, payload);
      renderScenario(result.scenario);
      await refreshCurrent();
      setText('creatorScenarioStatus', 'Сценарий сохранён как черновик.');
    } catch (error) {
      setText('creatorScenarioStatus', errorCopy(error, 'Не удалось сохранить сценарий. Проверьте поля и соединение.'));
    } finally {
      processing(button, false, 'Сохранить сценарий', 'Сохраняем…');
    }
  });
  node('creatorScenarioPublishButton').addEventListener('click', async () => {
    const button = node('creatorScenarioPublishButton');
    processing(button, true, 'Опубликовать сценарий', 'Публикуем…');
    try {
      const result = await post(
        `/v1/creator/webinars/${encodeURIComponent(state.current.id)}/chat-scenario/publish`,
        {},
        { 'Idempotency-Key': operationKey('scenario-publish') },
      );
      renderScenario(result.scenario);
      await refreshCurrent();
      setText('creatorScenarioStatus', 'Сценарий опубликован. Все сообщения сохраняют явную synthetic-маркировку.');
    } catch (error) {
      setText('creatorScenarioStatus', errorCopy(error, 'Не удалось опубликовать сценарий. Проверьте условия и повторите.'));
    } finally {
      processing(button, false, 'Опубликовать сценарий', 'Публикуем…');
    }
  });
}

function bindSchedule() {
  const form = node('creatorScheduleForm');
  node('creatorStartsOn').min = new Date().toISOString().slice(0, 10);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearInvalid(form);
    if (firstInvalid(form)) {
      setText('creatorScheduleStatus', 'Проверьте дату, время, часовой пояс и числовые ограничения.');
      return;
    }
    const button = node('creatorScheduleButton');
    processing(button, true, 'Создать расписание', 'Создаём…');
    const recurrenceType = node('creatorRecurrence').value;
    try {
      await post(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/sessions`, {
        recurrenceType,
        timezone: node('creatorTimezone').value.trim(),
        localStartTime: node('creatorLocalTime').value,
        startsOn: node('creatorStartsOn').value,
        endsOn: recurrenceType === 'ONCE' ? null : strictNullable(node('creatorEndsOn').value),
        maxFutureInstances: recurrenceType === 'ONCE' ? 1 : Number(node('creatorMaxInstances').value || 30),
        durationMinutes: Number(node('creatorSessionDuration').value),
        roomOpenBeforeMinutes: Number(node('creatorRoomOpen').value || 0),
        replayAvailableHours: Number(node('creatorReplayHours').value || 0),
        replayEnabled: node('creatorReplayEnabled').checked,
      });
      await refreshCurrent();
      setText('creatorScheduleStatus', 'Расписание создано. Время сохранено в UTC с явным часовым поясом.');
    } catch (error) {
      setText('creatorScheduleStatus', errorCopy(error, 'Не удалось создать расписание. Проверьте дату, DST и ограничения.'));
    } finally {
      processing(button, false, 'Создать расписание', 'Создаём…');
    }
  });
}

function bindAccess() {
  const form = node('creatorAccessForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearInvalid(form);
    if (firstInvalid(form)) {
      setText('creatorAccessStatus', 'Введите корректный email и срок от 1 до 30 дней.');
      return;
    }
    const button = node('creatorAccessButton');
    processing(button, true, 'Отправить приглашение', 'Создаём…');
    try {
      await post(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/access-grants`, {
        email: node('creatorAccessEmail').value.trim(),
        purpose: 'VIEW',
        expiresInDays: Number(node('creatorAccessDays').value),
      });
      form.reset();
      node('creatorAccessDays').value = '7';
      const result = await getJson(`/v1/creator/webinars/${encodeURIComponent(state.current.id)}/access-grants`);
      renderGrants(result.grants || []);
      setText('creatorAccessStatus', 'Приглашение создано. Адрес скрыт в списке и логах.');
    } catch (error) {
      setText('creatorAccessStatus', errorCopy(error, 'Не удалось создать приглашение. Проверьте email и соединение.'));
    } finally {
      processing(button, false, 'Отправить приглашение', 'Создаём…');
    }
  });
}

async function runCommand(action, button, idleLabel, busyLabel) {
  processing(button, true, idleLabel, busyLabel);
  setText('creatorCommandStatus', busyLabel);
  try {
    await post(
      `/v1/creator/webinars/${encodeURIComponent(state.current.id)}/${action}`,
      {},
      { 'Idempotency-Key': operationKey(`webinar-${action}`) },
    );
    await refreshCurrent(true);
    setText('creatorCommandStatus', action === 'archive' ? 'Вебинар архивирован без удаления истории.' : 'Статус вебинара обновлён.');
  } catch (error) {
    setText('creatorCommandStatus', errorCopy(error, 'Не удалось изменить статус. Проверьте условия и повторите.'));
  } finally {
    button.textContent = idleLabel;
    fillMetadata(state.current);
  }
}

function bindCommands() {
  node('creatorDuplicateButton').addEventListener('click', async () => {
    const button = node('creatorDuplicateButton');
    processing(button, true, 'Дублировать вебинар', 'Дублируем…');
    try {
      const result = await post(
        `/v1/creator/webinars/${encodeURIComponent(state.current.id)}/duplicate`,
        {},
        { 'Idempotency-Key': operationKey('webinar-duplicate') },
      );
      await loadWebinarList();
      await selectWebinar(result.webinar.id);
      setText('creatorCommandStatus', 'Создан новый черновик без регистраций, аналитики и истории.');
    } catch (error) {
      setText('creatorCommandStatus', errorCopy(error, 'Не удалось дублировать вебинар. Обновите страницу и повторите.'));
    } finally {
      processing(button, false, 'Дублировать вебинар', 'Дублируем…');
    }
  });
  node('creatorSubmitButton').addEventListener('click', () => void runCommand('submit', node('creatorSubmitButton'), 'Отправить на модерацию', 'Отправляем…'));
  node('creatorPublishButton').addEventListener('click', () => void runCommand('publish', node('creatorPublishButton'), 'Опубликовать вебинар', 'Публикуем…'));
  node('creatorArchiveButton').addEventListener('click', () => void runCommand('archive', node('creatorArchiveButton'), 'Архивировать вебинар', 'Архивируем…'));
}

function bindAll() {
  bindCreate();
  bindMetadata();
  bindSources();
  bindScenario();
  bindSchedule();
  bindAccess();
  bindMediaTranscript();
  bindCommands();
}

async function start() {
  bindAll();
  try {
    state.session = await getJson('/v1/auth/session');
    state.membership = state.session.memberships?.find(item => item.organizationId === state.session.activeOrganizationId);
    if (!state.membership || !['OWNER', 'AUTHOR'].includes(state.membership.role)) {
      const error = new Error('Creator access required');
      error.status = 403;
      throw error;
    }
    const [referenceData, webinarPage] = await Promise.all([
      getJson('/v1/creator/reference-data'),
      getJson('/v1/creator/webinars'),
    ]);
    state.referenceData = referenceData;
    state.webinars = webinarPage.items || [];
    setText('creatorOrganizationSummary', `${state.membership.organization.name} · ${state.membership.role === 'OWNER' ? 'Владелец' : 'Автор'}`);
    fillReferenceData();
    renderWebinarList();
    setMode('content', 'creatorHeading');
    const fragmentId = new URLSearchParams(location.hash.slice(1)).get('webinar');
    const initial = state.webinars.find(item => item.id === fragmentId)?.id || state.webinars[0]?.id;
    if (initial) await selectWebinar(initial, false);
  } catch (error) {
    showFatalError(error);
  }
}

void start();
