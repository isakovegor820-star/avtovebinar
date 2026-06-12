/**
 * slides.js — синхронные слайды презентации поверх плеера вебинара.
 *
 * Листает изображения assets/slides/slide-NN.jpg по таймкодам относительно
 * времени основного видео (#webinarVideo). Слайд показывается крупным планом,
 * видео спикера сжимается в угол (класс `slides-active` на #videoPlayerContainer).
 *
 * Модуль самодостаточный и не зависит от внутренностей video.js: он только
 * слушает `timeupdate`/`seeked` у видео по id. Если слайдов нет или разметка
 * выключена — комната выглядит ровно как раньше (graceful degradation).
 *
 * Режим разметки таймкодов: открыть webinar.html?slides_edit=1 —
 * ПРОБЕЛ отмечает момент смены слайда, «Скопировать» выгружает массив.
 */

const SLIDE_COUNT = 48;
const FALLBACK_DURATION = 3860; // длина записи (сек), если video.duration ещё не готов
const SLIDE_SRC = i => `assets/slides/slide-${String(i + 1).padStart(2, '0')}.jpg`;
const STORAGE_KEY = 'aspb_slide_timecodes';

/**
 * Реальные таймкоды смены слайдов (секунды от начала видео), по одному на слайд.
 * Слайд 1 всегда с 0. Заполняется через режим разметки (?slides_edit=1) и
 * вставляется сюда. Пока null — используется равномерная раскладка по длине видео.
 *
 * Формат: [0, 42, 95, ...] — ровно SLIDE_COUNT значений по возрастанию.
 */
const SLIDE_TIMECODES = null;

function buildUniformTimecodes(duration) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : FALLBACK_DURATION;
  return Array.from({ length: SLIDE_COUNT }, (_, i) => Math.round((i * total) / SLIDE_COUNT));
}

function loadSavedTimecodes() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch (_) {
    /* битый localStorage — игнорируем */
  }
  return null;
}

function initSlides() {
  const video = document.getElementById('webinarVideo');
  const slide = document.getElementById('webinarSlide');
  const container = document.getElementById('videoPlayerContainer');
  if (!video || !slide || !container) return; // комната без слайд-слоя — выходим тихо

  const params = new URLSearchParams(location.search);
  const editMode = params.get('slides_edit') === '1';

  // Источник таймкодов: сохранённая разметка → захардкоженный массив → равномерно.
  let timecodes = loadSavedTimecodes() || SLIDE_TIMECODES || buildUniformTimecodes(video.duration);

  container.classList.add('slides-active');
  let currentIndex = -1;

  // Префетч слайдов, чтобы не было мигания при перелистывании.
  for (let i = 0; i < SLIDE_COUNT; i += 1) {
    const img = new Image();
    img.src = SLIDE_SRC(i);
  }

  function indexForTime(t) {
    let idx = 0;
    for (let i = 0; i < timecodes.length; i += 1) {
      if (t >= timecodes[i]) idx = i;
    }
    return idx;
  }

  function showSlide(idx) {
    if (idx === currentIndex) return;
    currentIndex = idx;
    slide.src = SLIDE_SRC(idx);
  }

  function sync() {
    showSlide(indexForTime(video.currentTime));
  }

  // Если таймкоды равномерные, пересчитываем их, когда станет известна длина видео.
  video.addEventListener('loadedmetadata', () => {
    if (!loadSavedTimecodes() && !SLIDE_TIMECODES) {
      timecodes = buildUniformTimecodes(video.duration);
      currentIndex = -1;
      sync();
    }
  });

  video.addEventListener('timeupdate', sync);
  video.addEventListener('seeked', () => {
    currentIndex = -1;
    sync();
  });

  showSlide(0);

  // В режиме разметки стартуем с РЕАЛЬНО сохранённых меток (или с нуля),
  // а не с равномерной заглушки — иначе редактор решит, что всё уже размечено.
  if (editMode) initEditMode(video, loadSavedTimecodes());
}

/**
 * Режим разметки: смотрим эфир, жмём ПРОБЕЛ в момент смены слайда.
 * Таймкоды копятся, сохраняются в localStorage и выгружаются текстом.
 */
function initEditMode(video, initialTimecodes) {
  let marks = Array.isArray(initialTimecodes) && initialTimecodes.length ? initialTimecodes.slice() : [0];

  const panel = document.createElement('div');
  panel.id = 'slidesEditor';
  panel.innerHTML = `
    <div class="se-title">Разметка слайдов · ПРОБЕЛ = следующий слайд</div>
    <div class="se-status">Время: <b id="seTime">0:00</b> · Слайд: <b id="seCount">1</b> / ${SLIDE_COUNT}</div>
    <div class="se-row">
      <button id="seMark">ПРОБЕЛ → слайд дальше</button>
      <button id="seBack">↩ Отменить</button>
      <button id="sePause">⏯</button>
      <button id="seCopy">📋 Скопировать</button>
      <button id="seReset">🗑 Сброс</button>
    </div>
    <textarea id="seOut" readonly rows="5"></textarea>`;
  document.body.appendChild(panel);

  const seTime = panel.querySelector('#seTime');
  const seCount = panel.querySelector('#seCount');
  const seOut = panel.querySelector('#seOut');
  const fmt = s => {
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  function render() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
    seCount.textContent = marks.length;
    seOut.value =
      'const SLIDE_TIMECODES = [\n  ' +
      marks.map((t, i) => `${t}/* #${i + 1} ${fmt(t)} */`).join(', ') +
      '\n];';
  }

  function mark() {
    if (marks.length >= SLIDE_COUNT) {
      alert('Все ' + SLIDE_COUNT + ' слайдов размечены');
      return;
    }
    marks.push(Math.round(video.currentTime));
    render();
  }

  panel.querySelector('#seMark').onclick = mark;
  panel.querySelector('#seBack').onclick = () => {
    if (marks.length > 1) {
      marks.pop();
      render();
    }
  };
  panel.querySelector('#sePause').onclick = () => (video.paused ? video.play() : video.pause());
  panel.querySelector('#seReset').onclick = () => {
    if (confirm('Сбросить разметку?')) {
      marks = [0];
      render();
    }
  };
  panel.querySelector('#seCopy').onclick = () => {
    seOut.select();
    document.execCommand('copy');
    alert('Таймкоды скопированы. Пришлите их — вставлю в slides.js (SLIDE_TIMECODES).');
  };

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      mark();
    } else if (e.code === 'ArrowRight') {
      video.currentTime += 5;
    } else if (e.code === 'ArrowLeft') {
      video.currentTime -= 5;
    }
  });

  video.addEventListener('timeupdate', () => {
    seTime.textContent = fmt(video.currentTime);
  });

  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSlides);
} else {
  initSlides();
}
