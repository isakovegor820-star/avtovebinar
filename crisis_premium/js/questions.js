/**
 * questions.js — форма вопроса, рендер инсайтов.
 */

import { post, formatTimelineTime } from './utils.js?v=prelaunch-20260825-2';
import { track, WEBINAR_INSIGHTS } from './analytics.js?v=prelaunch-20260825-2';

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
      item.className = 'flex gap-3 webinar-insight-msg transition-[opacity,transform] duration-500 ease-out opacity-0 translate-y-2';

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
  const status = document.getElementById('questionSubmitStatus');
  const showToParticipants = document.getElementById('questionShowToParticipants');
  const displayMode = document.getElementById('questionDisplayMode');
  if (!input || !button) return;

  function setQuestionStatus(message, { error = false } = {}) {
    input.setAttribute('aria-invalid', error ? 'true' : 'false');
    if (!status) return;
    status.dataset.questionError = error ? 'true' : 'false';
    status.setAttribute('role', error ? 'alert' : 'status');
    status.setAttribute('aria-live', error ? 'assertive' : 'polite');
    status.classList.toggle('text-error', error);
    status.classList.toggle('text-on-surface-variant', !error);
    status.textContent = message;
  }

  async function submitQuestion() {
    if (button.disabled) return;

    setQuestionStatus('');
    const text = input.value.trim();
    if (!text) return;

    button.disabled = true;
    // FIX 6a: трекаем попытку отправить вопрос
    track('question_submit_attempt', { textLength: text.length });

    try {
      const isPublic = Boolean(showToParticipants?.checked);
      const result = await post('/questions', {
        text,
        showToParticipants: isPublic,
        displayMode: displayMode?.value || 'pseudonym',
        publicationNoticeAccepted: isPublic,
      });

      // FIX 6a: трекаем успешную отправку
      track('question_submitted');

      input.value = '';
      setQuestionStatus('Вопрос отправлен команде АСПБ.');
      document.dispatchEvent(new CustomEvent('aspb:chat-question-submitted', {
        detail: {
          text,
          questionId: result.questionId,
          chatMessageId: result.chatMessageId,
        },
      }));
      if (window.__liveChatRefresh) {
        window.__liveChatRefresh();
      }
    } catch (error) {
      // FIX 6b: вместо alert — inline-ошибка под полем ввода
      track('question_submit_error', { error: error.message });
      setQuestionStatus('Не удалось отправить — проверьте соединение и попробуйте снова.', {
        error: true,
      });
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener('click', submitQuestion);
  showToParticipants?.addEventListener('change', () => {
    if (displayMode) displayMode.disabled = !showToParticipants.checked;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitQuestion();
  });
}
