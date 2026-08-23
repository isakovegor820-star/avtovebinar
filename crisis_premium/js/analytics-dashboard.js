import { getJson } from './utils.js?v=site-review-7';

const allowed = ['webinarId', 'sessionId', 'source', 'playback', 'from', 'to'];
const form = document.getElementById('analyticsFilters');
const status = document.getElementById('analyticsStatus');
const content = document.getElementById('analyticsContent');
const errorPanel = document.getElementById('analyticsError');
let requestNumber = 0;

function parameters() {
  const source = new URLSearchParams(location.search);
  const result = new URLSearchParams();
  allowed.forEach(key => {
    const value = source.get(key)?.trim();
    if (value) result.set(key, value);
  });
  if (!result.has('playback')) result.set('playback', 'LIVE');
  return result;
}

function restoreForm() {
  const params = parameters();
  allowed.forEach(key => {
    const control = form.elements.namedItem(key);
    if (control) control.value = params.get(key) || (key === 'playback' ? 'LIVE' : '');
  });
}

function apiFilters(params) {
  const result = new URLSearchParams(params);
  result.delete('playback');
  return result.toString();
}

function setList(listId, emptyId, items, format) {
  const list = document.getElementById(listId);
  list.replaceChildren(...items.map(item => {
    const row = document.createElement('li');
    row.textContent = format(item);
    return row;
  }));
  document.getElementById(emptyId).hidden = items.length > 0;
}

function renderOverview(payload) {
  const labels = {
    registrations: 'Регистрации', uniqueEntries: 'Уникальные входы', liveViews: 'Зрители эфира', replayViews: 'Зрители записи', averageWatchSeconds: 'Среднее время, сек.', questions: 'Вопросы', ctaActions: 'CTA-действия', completion: 'Досмотрели',
  };
  const metrics = { ...payload.metrics, completion: `${Math.round(payload.metrics.completion.rate * 100)}% (${payload.metrics.completion.numerator} из ${payload.metrics.completion.denominator})` };
  document.getElementById('analyticsMetrics').replaceChildren(...Object.entries(metrics).map(([key, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = labels[key] || key;
    detail.textContent = String(value);
    row.append(term, detail);
    return row;
  }));
  document.getElementById('analyticsPeriod').textContent = `Период: ${payload.period.from} — ${payload.period.toExclusive}; ${payload.period.timezone}`;
  document.getElementById('analyticsFormulaList').replaceChildren(...Object.entries(payload.formulas).map(([key, value]) => {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = labels[key] || key;
    detail.textContent = value;
    wrapper.append(term, detail);
    return wrapper;
  }));
}

function renderRetention(payload) {
  document.getElementById('retentionRows').replaceChildren(...payload.intervals.map(interval => {
    const row = document.createElement('tr');
    const label = document.createElement('th');
    const value = document.createElement('td');
    label.scope = 'row';
    label.textContent = `${interval.fromPercent}%`;
    value.textContent = interval.suppressed ? `Скрыто: меньше ${payload.privacyThreshold}` : String(interval.viewers ?? 0);
    row.append(label, value);
    return row;
  }));
}

async function load() {
  const ownRequest = ++requestNumber;
  status.textContent = 'Загружаем показатели…';
  status.hidden = false;
  content.hidden = true;
  errorPanel.hidden = true;
  const params = parameters();
  const filters = apiFilters(params);
  const suffix = filters ? `?${filters}` : '';
  try {
    const [overview, retention, live, transcript] = await Promise.all([
      getJson(`/v1/analytics/overview${suffix}`),
      getJson(`/v1/analytics/retention?${filters ? `${filters}&` : ''}playback=${params.get('playback')}`),
      getJson(`/v1/analytics/live${suffix}`),
      getJson(`/v1/analytics/content${suffix}`),
    ]);
    if (ownRequest !== requestNumber) return;
    renderOverview(overview);
    renderRetention(retention);
    document.getElementById('activeViewers').textContent = String(live.activeViewers);
    document.getElementById('liveAlgorithm').textContent = `${live.algorithm} Обновление может задерживаться до ${live.refreshDelaySeconds} сек.`;
    setList('popularChapters', 'popularChaptersEmpty', transcript.popularChapters, item => `${item.title}: ${item.count}`);
    setList('transcriptSearches', 'transcriptSearchesEmpty', transcript.transcriptSearches, item => `${item.query}: ${item.count}`);
    content.hidden = false;
    status.textContent = 'Показатели обновлены';
  } catch (error) {
    if (ownRequest !== requestNumber) return;
    document.getElementById('analyticsErrorText').textContent = error?.status === 403
      ? 'У вашей роли нет доступа к аналитике.'
      : error?.status === 404
        ? 'Отчёт или выбранный Webinar/WebinarSession недоступен.'
        : 'Сервер не вернул отчёт. Повторите запрос.';
    errorPanel.hidden = false;
    status.textContent = 'Ошибка загрузки';
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const values = new FormData(form);
  const params = new URLSearchParams();
  allowed.forEach(key => {
    const value = String(values.get(key) || '').trim();
    if (value && !(key === 'playback' && value === 'LIVE')) params.set(key, value);
  });
  history.pushState({}, '', `analytics.html${params.size ? `?${params}` : ''}`);
  restoreForm();
  load();
});

window.addEventListener('popstate', () => {
  restoreForm();
  load();
});
document.getElementById('analyticsRetry').addEventListener('click', load);
restoreForm();
load();
