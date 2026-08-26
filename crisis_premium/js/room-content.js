/**
 * Published room content: chapters, transcript search, captions and materials.
 * One response is rendered as an atomic transcript/version snapshot.
 */

import { getJson, formatTimelineTime } from './utils.js?v=prelaunch-20260825-2';
import { track } from './analytics.js?v=prelaunch-20260825-2';

const CONTENT_PATH = '/webinar/content/session/current';
const REFRESH_INTERVAL_MS = 60_000;
let currentSnapshot = null;
let currentSegments = [];
let refreshTimer = null;
let refreshInFlight = null;
let listenersBound = false;
let searchAnalyticsTimer = null;

function node(id) {
  return document.getElementById(id);
}

function setHidden(element, hidden) {
  if (element) element.classList.toggle('hidden', hidden);
}

function setBlockState(panelId, state, message) {
  const panel = node(panelId);
  if (!panel) return;
  panel.dataset.state = state;
  const status = panel.querySelector('[data-room-block-state]');
  if (status) status.textContent = message;
  const retry = panel.querySelector('[data-room-content-retry]');
  setHidden(retry, state !== 'error');
}

function safeMaterialUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), window.location.href);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function chapterCountLabel(count) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) return `${count} глава`;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${count} главы`;
  return `${count} глав`;
}

function sourceAccessLabel(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return `проверено ${new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)}`;
}

function safeCaptionsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/media/webinar/')) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function requestSeek(startMs, label) {
  const seconds = Math.max(0, Number(startMs) / 1000);
  document.dispatchEvent(
    new CustomEvent('aspb:room-seek-request', {
      detail: { seconds, source: 'published_transcript' },
    }),
  );
  const status = node('roomContentActionStatus');
  if (status) status.textContent = `Переходим к ${formatTimelineTime(seconds)}: ${label}`;
}

function createSeekButton(startMs, label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.roomSeek = String(startMs);
  button.setAttribute('aria-label', `Перейти к ${formatTimelineTime(startMs / 1000)}: ${label}`);
  button.textContent = formatTimelineTime(startMs / 1000);
  button.addEventListener('click', () => requestSeek(startMs, label));
  return button;
}

function renderChapters(chapters, hasTranscript) {
  const list = node('roomChaptersList');
  if (!list) return;
  list.textContent = '';
  if (!hasTranscript) {
    setHidden(list, true);
    setBlockState('roomChaptersPanel', 'unavailable', 'Главы появятся после публикации проверенного транскрипта.');
    return;
  }
  if (!chapters.length) {
    setHidden(list, true);
    setBlockState('roomChaptersPanel', 'empty', 'Для этой версии транскрипта главы ещё не добавлены.');
    return;
  }

  chapters.forEach(chapter => {
    const item = document.createElement('li');
    item.className = 'room-chapter-item';
    const button = createSeekButton(chapter.startMs, chapter.title, 'room-time-button');
    if (typeof chapter.id === 'string') {
      button.addEventListener('click', () => track('chapter_open', { chapterId: chapter.id }));
    }
    const copy = document.createElement('div');
    copy.className = 'min-w-0';
    const title = document.createElement('p');
    title.className = 'room-chapter-title';
    title.textContent = chapter.title;
    copy.appendChild(title);
    if (chapter.description) {
      const description = document.createElement('p');
      description.className = 'room-chapter-description';
      description.textContent = chapter.description;
      copy.appendChild(description);
    }
    item.append(button, copy);
    list.appendChild(item);
  });
  setHidden(list, false);
  setBlockState('roomChaptersPanel', 'content', chapterCountLabel(chapters.length));
}

function normalizeSearch(value) {
  return String(value || '').trim().toLocaleLowerCase('ru-RU');
}

function matchingSegments(query) {
  const normalized = normalizeSearch(query);
  if (!normalized) return currentSegments;
  return currentSegments.filter(segment =>
    `${segment.speaker || ''} ${segment.text}`.toLocaleLowerCase('ru-RU').includes(normalized),
  );
}

function resultLabel(count, query) {
  if (!query) return `Фрагментов в опубликованной версии: ${count}`;
  if (count === 0) return `По запросу «${query}» ничего не найдено.`;
  return `Найдено результатов: ${count}`;
}

function renderTranscriptResults() {
  const input = node('roomTranscriptSearch');
  const list = node('roomTranscriptResults');
  const count = node('roomTranscriptResultCount');
  if (!list || !count) return;
  const query = String(input?.value || '').trim();
  const segments = matchingSegments(query);
  list.textContent = '';

  segments.forEach(segment => {
    const item = document.createElement('li');
    item.className = 'room-transcript-segment';
    const heading = document.createElement('div');
    heading.className = 'room-transcript-heading';
    const seek = createSeekButton(
      segment.startMs,
      segment.text,
      'room-time-button room-transcript-seek',
    );
    const speaker = document.createElement('span');
    speaker.className = 'room-transcript-speaker';
    speaker.textContent = segment.speaker || 'Спикер';
    heading.append(seek, speaker);
    const text = document.createElement('p');
    text.className = 'room-transcript-text';
    text.textContent = segment.text;
    item.append(heading, text);
    list.appendChild(item);
  });

  count.textContent = resultLabel(segments.length, query);
  setBlockState(
    'roomTranscriptPanel',
    segments.length ? 'content' : 'empty',
    segments.length ? 'Опубликованный транскрипт' : 'Измените запрос или очистите поиск.',
  );
}

function transcriptResultButtons() {
  return [...document.querySelectorAll('#roomTranscriptResults .room-transcript-seek')];
}

function bindSearch() {
  const input = node('roomTranscriptSearch');
  if (!input || input.dataset.bound === 'true') return;
  input.dataset.bound = 'true';
  input.addEventListener('input', () => {
    renderTranscriptResults();
    if (searchAnalyticsTimer) window.clearTimeout(searchAnalyticsTimer);
    const query = String(input.value || '').trim();
    const safe = query.length >= 2
      && query.length <= 120
      && /^[\p{L}\p{N}\s.,:;!?()«»"'-]+$/u.test(query)
      && !/@/.test(query)
      && !/(?:^|\s)\+?\d[\d\s()-]{8,}\d(?:$|\s)/.test(query);
    if (safe) searchAnalyticsTimer = window.setTimeout(() => track('transcript_search', { query }), 700);
  });
  input.addEventListener('keydown', event => {
    const buttons = transcriptResultButtons();
    if ((event.key === 'ArrowDown' || event.key === 'Enter') && buttons[0]) {
      event.preventDefault();
      if (event.key === 'Enter') buttons[0].click();
      buttons[0].focus();
      return;
    }
    if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      input.value = '';
      renderTranscriptResults();
    }
  });
  node('roomTranscriptResults')?.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = transcriptResultButtons();
    const current = buttons.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[target]?.focus();
  });
}

function setCaptions(transcript) {
  const track = node('webinarCaptionsTrack');
  const button = node('customCaptionsBtn');
  const captionsUrl = safeCaptionsUrl(transcript?.captionsUrl);
  if (!track || !button) return;

  if (track.track) track.track.mode = 'disabled';
  track.removeAttribute('src');
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-label', 'Включить субтитры');
  button.querySelector('.material-symbols-outlined')?.classList.remove('room-caption-icon--active');
  button.disabled = !captionsUrl;
  if (!captionsUrl) return;
  track.src = captionsUrl;
}

function bindCaptions() {
  const track = node('webinarCaptionsTrack');
  const button = node('customCaptionsBtn');
  if (!track || !button || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';
  button.addEventListener('click', () => {
    if (button.disabled || !track.track) return;
    const enabled = track.track.mode !== 'showing';
    track.track.mode = enabled ? 'showing' : 'disabled';
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? 'Выключить субтитры' : 'Включить субтитры');
    button.querySelector('.material-symbols-outlined')?.classList.toggle('room-caption-icon--active', enabled);
  });
  track.addEventListener('error', () => {
    if (track.track) track.track.mode = 'disabled';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Субтитры временно недоступны');
    const status = node('webinarPlayerStatus');
    if (status) status.textContent = 'Субтитры обновились. Загружаем опубликованную версию заново.';
    void hydrateRoomContent({ background: true, force: true }).catch(() => {});
  });
}

function renderTranscript(transcript, mediaState) {
  const controls = node('roomTranscriptControls');
  const results = node('roomTranscriptResults');
  currentSegments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  if (!transcript || currentSegments.length === 0) {
    setHidden(controls, true);
    setHidden(results, true);
    const message =
      mediaState === 'processing'
        ? 'Видео обрабатывается. Транскрипт появится только после проверки и публикации автором.'
        : 'Опубликованного транскрипта пока нет. Черновики и проверяемые версии зрителям не показываются.';
    setBlockState('roomTranscriptPanel', mediaState === 'processing' ? 'processing' : 'unavailable', message);
    const count = node('roomTranscriptResultCount');
    if (count) count.textContent = '';
    setCaptions(null);
    return;
  }

  setHidden(controls, false);
  setHidden(results, false);
  const version = node('roomTranscriptVersion');
  if (version) version.textContent = `Версия ${transcript.version}`;
  setCaptions(transcript);
  renderTranscriptResults();
}

function renderMaterials(materials) {
  const list = node('roomMaterialsList');
  if (!list) return;
  list.textContent = '';
  if (!materials.length) {
    setHidden(list, true);
    setBlockState('roomMaterialsPanel', 'empty', 'Материалы и источники к этому вебинару пока не добавлены.');
    return;
  }
  materials.forEach(material => {
    const item = document.createElement('li');
    item.className = 'room-material-item';
    const copy = document.createElement('div');
    copy.className = 'min-w-0';
    const title = document.createElement('p');
    title.className = 'room-material-title';
    title.textContent = material.title;
    const meta = document.createElement('p');
    meta.className = 'room-material-meta';
    const sourceTypeLabels = {
      REGULATION: 'Нормативный акт',
      STATUTE_PROVISION: 'Норма закона',
      COURT_DECISION: 'Судебный акт',
      OFFICIAL_GUIDANCE: 'Официальное разъяснение',
      OFFICIAL_SOURCE: 'Официальный источник',
      TEMPLATE_OR_CHECKLIST: 'Шаблон или чек-лист',
      OTHER: 'Дополнительный материал',
    };
    meta.textContent = [
      sourceTypeLabels[material.type] || 'Источник',
      sourceAccessLabel(material.accessedAt),
    ]
      .filter(Boolean)
      .join(' · ');
    copy.append(title, meta);
    if (material.note) {
      const note = document.createElement('p');
      note.className = 'room-material-note';
      note.textContent = material.note;
      copy.appendChild(note);
    }
    item.appendChild(copy);
    const href = safeMaterialUrl(material.url);
    if (href) {
      const link = document.createElement('a');
      link.className = 'room-material-link';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Открыть источник';
      item.appendChild(link);
    }
    list.appendChild(item);
  });
  setHidden(list, false);
  setBlockState('roomMaterialsPanel', 'content', `Материалов и источников: ${materials.length}`);
}

function renderSnapshot(snapshot) {
  currentSnapshot = snapshot;
  renderChapters(Array.isArray(snapshot.chapters) ? snapshot.chapters : [], Boolean(snapshot.transcript));
  renderTranscript(snapshot.transcript, snapshot.mediaState);
  renderMaterials(Array.isArray(snapshot.materials) ? snapshot.materials : []);
}

function renderLoading() {
  setBlockState('roomChaptersPanel', 'loading', 'Загружаем главы…');
  setBlockState('roomTranscriptPanel', 'loading', 'Загружаем опубликованный транскрипт…');
  setBlockState('roomMaterialsPanel', 'loading', 'Загружаем материалы и источники…');
}

function renderFailure(error) {
  const unavailable = error && [401, 403, 404, 423].includes(Number(error.status));
  const state = unavailable ? 'unavailable' : 'error';
  const message = unavailable
    ? 'Контент недоступен для текущей сессии. Проверьте срок доступа в разделе «Мой доступ».'
    : 'Не удалось загрузить контент. Проверьте соединение и повторите попытку.';
  setBlockState('roomChaptersPanel', state, message);
  setBlockState('roomTranscriptPanel', state, message);
  setBlockState('roomMaterialsPanel', state, message);
  setHidden(node('roomChaptersList'), true);
  setHidden(node('roomTranscriptControls'), true);
  setHidden(node('roomTranscriptResults'), true);
  setHidden(node('roomMaterialsList'), true);
  setCaptions(null);
}

function scheduleRefresh() {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = null;
  if (document.visibilityState === 'hidden') return;
  refreshTimer = window.setTimeout(() => {
    void hydrateRoomContent({ background: true }).catch(() => {}).finally(scheduleRefresh);
  }, REFRESH_INTERVAL_MS);
}

function bindGlobalListeners() {
  if (listenersBound) return;
  listenersBound = true;
  bindSearch();
  bindCaptions();
  document.querySelectorAll('[data-room-content-retry]').forEach(button => {
    button.addEventListener('click', () => void hydrateRoomContent({ force: true }));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void hydrateRoomContent({ background: true }).catch(() => {}).finally(scheduleRefresh);
    } else if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  });
}

export async function hydrateRoomContent(options = {}) {
  if (!window.location.pathname.endsWith('webinar.html')) return null;
  // A retry must reuse the same protected request while it is running. Parallel
  // force-refreshes can otherwise render an older transcript after a newer one.
  if (refreshInFlight) return refreshInFlight;
  bindGlobalListeners();
  if (!options.background) renderLoading();

  refreshInFlight = getJson(CONTENT_PATH)
    .then(snapshot => {
      if (!snapshot?.ok) throw new Error('Room content response is invalid');
      const materialsKey = JSON.stringify(snapshot.materials || []);
      const currentMaterialsKey = JSON.stringify(currentSnapshot?.materials || []);
      if (
        options.force ||
        !currentSnapshot ||
        snapshot.consistencyKey !== currentSnapshot.consistencyKey ||
        materialsKey !== currentMaterialsKey ||
        snapshot.mediaState !== currentSnapshot.mediaState
      ) {
        renderSnapshot(snapshot);
      }
      scheduleRefresh();
      return snapshot;
    })
    .catch(error => {
      if (!options.background || !currentSnapshot) renderFailure(error);
      throw error;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}
