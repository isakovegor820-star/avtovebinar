import { getJson } from './utils.js';

const labels = {
  freshness: {
    CURRENT: 'Актуален',
    REVIEW_DUE: 'Требует проверки',
    OUTDATED: 'Устарел',
    SUPERSEDED: 'Есть новая версия',
    UNKNOWN: 'Актуальность не указана',
  },
  format: { RECORDED: 'Запись', PREMIERE: 'Премьера', ON_DEMAND: 'По запросу' },
  level: {
    INTRODUCTORY: 'Начальный',
    PRACTITIONER: 'Практикующий специалист',
    ADVANCED: 'Продвинутый',
    ALL_LEVELS: 'Все уровни',
  },
};

const allowedKeys = [
  'q',
  'practiceArea',
  'specialization',
  'jurisdiction',
  'level',
  'format',
  'availability',
  'dateFrom',
  'dateTo',
  'sort',
  'page',
];
const state = { practiceAreas: [], jurisdictions: [], request: 0 };
const node = id => document.getElementById(id);

function setMode(mode) {
  document.body.dataset.catalogMode = mode;
}

function currentParameters() {
  const source = new URLSearchParams(window.location.search);
  const output = new URLSearchParams();
  allowedKeys.forEach(key => {
    const value = source.get(key)?.trim();
    if (value) output.set(key, value);
  });
  return output;
}

function apiQuery() {
  const params = currentParameters();
  if (!params.has('availability')) params.set('availability', 'ALL');
  if (!params.has('sort')) params.set('sort', params.has('q') ? 'RELEVANCE' : 'UPCOMING');
  params.set('pageSize', '12');
  return params;
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

function fillSelect(select, items, valueKey, labelKey, selected) {
  while (select.options.length > 1) select.remove(1);
  items.forEach(item => {
    const option = document.createElement('option');
    option.value = item[valueKey];
    option.textContent = item[labelKey];
    select.append(option);
  });
  select.value = selected || '';
}

function refreshSpecializations(selected = '') {
  const root = node('catalogPracticeArea').value;
  const children = state.practiceAreas.filter(area => area.parentSlug && (!root || area.parentSlug === root));
  fillSelect(node('catalogSpecialization'), children, 'slug', 'name', selected);
}

async function loadReferences(params) {
  const [areas, jurisdictions] = await Promise.all([
    getJson('/v1/catalog/practice-areas'),
    getJson('/v1/catalog/jurisdictions'),
  ]);
  state.practiceAreas = areas.practiceAreas || [];
  state.jurisdictions = jurisdictions.jurisdictions || [];
  fillSelect(
    node('catalogPracticeArea'),
    state.practiceAreas.filter(area => !area.parentSlug),
    'slug',
    'name',
    params.get('practiceArea'),
  );
  refreshSpecializations(params.get('specialization'));
  fillSelect(node('catalogJurisdiction'), state.jurisdictions, 'code', 'name', params.get('jurisdiction'));
}

function restoreForm(params) {
  const values = {
    catalogQuery: params.get('q'),
    catalogLevel: params.get('level'),
    catalogFormat: params.get('format'),
    catalogAvailability: params.get('availability') || 'ALL',
    catalogSort: params.get('sort') || (params.has('q') ? 'RELEVANCE' : 'UPCOMING'),
    catalogDateFrom: params.get('dateFrom'),
    catalogDateTo: params.get('dateTo'),
  };
  Object.entries(values).forEach(([id, value]) => {
    node(id).value = value || '';
  });
  if (params.has('dateFrom') || params.has('dateTo')) node('catalogDateFrom').closest('details').open = true;
}

function appendFact(list, term, value, className = '') {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = value || 'Не указано';
  if (className) dd.className = className;
  row.append(dt, dd);
  list.append(row);
}

function appendAuthorFact(list, author) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const value = document.createElement('dd');
  term.textContent = 'Автор';
  if (author?.slug && author?.publicName) {
    const link = document.createElement('a');
    link.href = `catalog-author.html?${new URLSearchParams({ author: author.slug }).toString()}`;
    link.textContent = author.publicName;
    value.append(link);
  } else {
    value.textContent = author?.publicName || 'Не указано';
  }
  row.append(term, value);
  list.append(row);
}

function card(item) {
  const listItem = document.createElement('li');
  const article = document.createElement('article');
  article.className = 'catalog-card';

  const tags = document.createElement('div');
  tags.className = 'catalog-card-tags';
  [item.practiceArea?.name, item.specialization?.name].filter(Boolean).forEach(value => {
    const tag = document.createElement('span');
    tag.className = 'catalog-tag';
    tag.textContent = value;
    tags.append(tag);
  });

  const heading = document.createElement('h3');
  const link = document.createElement('a');
  link.href = item.canonicalPath;
  link.textContent = item.title;
  heading.append(link);

  const description = document.createElement('p');
  description.className = 'catalog-card-description';
  description.textContent = item.description || 'Описание готовится.';

  const facts = document.createElement('dl');
  facts.className = 'catalog-card-facts';
  appendAuthorFact(facts, item.author);
  appendFact(facts, 'Юрисдикция', item.jurisdiction?.name);
  appendFact(facts, 'Формат', labels.format[item.format] || item.format);
  appendFact(facts, 'Актуальность', labels.freshness[item.freshnessStatus] || item.freshnessStatus);
  appendFact(
    facts,
    'Ближайший запуск',
    item.nextSession ? formatDateTime(item.nextSession.scheduledAt, item.nextSession.timezone) : 'Дата уточняется',
    'catalog-card-date',
  );
  appendFact(facts, 'Длительность', item.durationMinutes ? `${item.durationMinutes} мин.` : null);
  article.append(tags, heading, description, facts);
  listItem.append(article);
  return listItem;
}

function pageLink(page, current, label) {
  const link = document.createElement('a');
  const params = currentParameters();
  if (page === 1) params.delete('page');
  else params.set('page', String(page));
  link.className = 'platform-secondary-button catalog-page-link';
  link.href = `catalog.html${params.size ? `?${params.toString()}` : ''}`;
  link.textContent = label || String(page);
  if (page === current) {
    link.setAttribute('aria-current', 'page');
    link.setAttribute('aria-label', `Страница ${page}, текущая`);
  } else {
    link.setAttribute('aria-label', label ? `${label}, страница ${page}` : `Страница ${page}`);
  }
  return link;
}

function renderPagination(pagination) {
  const nav = node('catalogPagination');
  nav.replaceChildren();
  if (pagination.totalPages <= 1) return;
  if (pagination.page > 1) nav.append(pageLink(pagination.page - 1, pagination.page, 'Назад'));
  const start = Math.max(1, pagination.page - 2);
  const end = Math.min(pagination.totalPages, pagination.page + 2);
  for (let page = start; page <= end; page += 1) nav.append(pageLink(page, pagination.page));
  if (pagination.page < pagination.totalPages) nav.append(pageLink(pagination.page + 1, pagination.page, 'Вперёд'));
}

async function loadCatalog() {
  const requestId = ++state.request;
  setMode('loading');
  node('catalogResultsSummary').textContent = 'Загрузка результатов';
  try {
    const params = apiQuery();
    const payload = await getJson(`/v1/catalog/webinars?${params.toString()}`);
    if (requestId !== state.request) return;
    const items = payload.items || [];
    node('catalogGrid').replaceChildren(...items.map(card));
    const total = payload.pagination?.total || 0;
    node('catalogResultsSummary').textContent = total
      ? `${total} ${total === 1 ? 'вебинар' : total < 5 ? 'вебинара' : 'вебинаров'}`
      : 'Ничего не найдено';
    renderPagination(payload.pagination || { page: 1, totalPages: 0 });
    setMode(items.length ? 'content' : 'empty');
  } catch (error) {
    if (requestId !== state.request) return;
    node('catalogErrorText').textContent =
      error?.status === 404
        ? 'Публичный каталог ещё не включён.'
        : error?.status === 0
          ? 'Сервер не ответил вовремя. Проверьте подключение и повторите.'
          : 'Не удалось загрузить вебинары. Повторите запрос.';
    node('catalogResultsSummary').textContent = 'Ошибка загрузки';
    setMode('error');
  }
}

function submitFilters(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const params = new URLSearchParams();
  allowedKeys.forEach(key => {
    if (key === 'page') return;
    const value = String(form.get(key) || '').trim();
    if (!value) return;
    if (key === 'availability' && value === 'ALL') return;
    params.set(key, value);
  });
  window.location.assign(`catalog.html${params.size ? `?${params.toString()}` : ''}`);
}

async function initialize() {
  const params = currentParameters();
  restoreForm(params);
  node('catalogFilterForm').addEventListener('submit', submitFilters);
  node('catalogPracticeArea').addEventListener('change', () => refreshSpecializations(''));
  node('catalogRetryButton').addEventListener('click', loadCatalog);
  try {
    await loadReferences(params);
  } catch {
    // Каталог остаётся полезен без справочников; ошибка самого списка обрабатывается отдельно.
  }
  await loadCatalog();
}

initialize();
