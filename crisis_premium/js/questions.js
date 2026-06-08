/**
 * questions.js — форма вопроса, рендер инсайтов.
 */

import { post, formatTimelineTime } from './utils.js';
import { track, WEBINAR_INSIGHTS } from './analytics.js';

let renderedInsightTimes = new Set();

export function resetInsightTimes() {
  renderedInsightTimes = new Set();
}

export function setChatActivity(text) {
  const node = document.getElementById('chatActivity');
  if (node) node.textContent = text;
}

export function updateInsightHeader(currentTime) {
  const label = document.getElementById('chatOnlineLabel');
  if (!label) return;
  const next = WEBINAR_INSIGHTS.find(item => item.time > currentTime);
  label.textContent = next ? `следующий: ${formatTimelineTime(next.time)}` : 'финальный CTA';
}

export function updateWebinarInsights(currentTime, isSyncing = false) {
  const list = document.getElementById('questionList');
  if (!list) return;
  updateInsightHeader(currentTime);

  const visibleItems = WEBINAR_INSIGHTS.filter(item => item.time <= currentTime);
  const currentInsightElements = list.querySelectorAll('.webinar-insight-msg');

  if (visibleItems.length < renderedInsightTimes.size || isSyncing) {
    currentInsightElements.forEach(el => el.remove());
    renderedInsightTimes.clear();
  }

  setChatActivity('Сценарные подсказки синхронизированы с записью');

  let appendedNew = false;
  visibleItems.forEach(insight => {
    if (!renderedInsightTimes.has(insight.time)) {
      renderedInsightTimes.add(insight.time);
      const item = document.createElement('div');
      item.className = 'flex gap-3 webinar-insight-msg transition-all duration-500 ease-out opacity-0 translate-y-2';

      const icon = document.createElement('div');
      icon.className = 'w-8 h-8 rounded-full bg-primary text-on-primary flex-shrink-0 flex items-center justify-center';
      const iconSymbol = document.createElement('span');
      iconSymbol.className = 'material-symbols-outlined text-[18px]';
      iconSymbol.textContent = insight.icon;
      icon.append(iconSymbol);

      const body = document.createElement('div');
      body.className = 'space-y-1';
      const title = document.createElement('div');
      title.className = 'text-label-sm font-bold text-primary flex items-center gap-2';
      title.textContent = insight.title;
      const time = document.createElement('span');
      time.className = 'text-[11px] font-medium text-on-surface-variant';
      time.textContent = formatTimelineTime(insight.time);
      title.append(time);

      const bubble = document.createElement('div');
      bubble.className = 'bg-surface-container p-3 rounded-xl rounded-tl-none text-body-md text-on-surface-variant border border-outline-variant/20';
      bubble.textContent = insight.text;

      body.append(title, bubble);
      item.append(icon, body);
      list.appendChild(item);
      appendedNew = true;

      setTimeout(() => {
        item.classList.remove('opacity-0', 'translate-y-2');
      }, 50);
    }
  });

  if (appendedNew) {
    list.scrollTop = list.scrollHeight;
  }
}

export function bindQuestionForm() {
  const input = document.getElementById('questionInput');
  const button = document.getElementById('questionSubmit');
  if (!input || !button) return;
  const errorParent = input.parentElement;

  function clearQuestionError() {
    errorParent?.querySelector('[data-question-error="true"]')?.remove();
  }

  async function submitQuestion() {
    if (button.disabled) return;

    clearQuestionError();
    const text = input.value.trim();
    if (!text) return;

    button.disabled = true;
    // FIX 6a: трекаем попытку отправить вопрос
    track('question_submit_attempt', { textLength: text.length });

    try {
      await post('/questions', { text });

      // FIX 6a: трекаем успешную отправку
      track('question_submitted');

      input.value = '';
      if (window.__liveChatRefresh) {
        window.__liveChatRefresh();
      }
    } catch (error) {
      // FIX 6b: вместо alert — inline-ошибка под полем ввода
      track('question_submit_error', { error: error.message });
      clearQuestionError();
      const errNode = document.createElement('p');
      errNode.dataset.questionError = 'true';
      errNode.className = 'text-label-sm text-error mt-1 px-1';
      errNode.textContent = 'Не удалось отправить — проверьте соединение и попробуйте снова';
      errorParent?.appendChild(errNode);
      setTimeout(() => errNode.remove(), 4000);
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener('click', submitQuestion);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitQuestion();
  });
}
