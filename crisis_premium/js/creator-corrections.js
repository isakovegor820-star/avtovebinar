import { getJson, post } from './utils.js?v=site-review-7';

const list = document.getElementById('correctionList');
const status = document.getElementById('correctionStatus');

function input(label, name, value = '') {
  const wrapper = document.createElement('label');
  wrapper.textContent = label;
  const control = document.createElement(name === 'description' ? 'textarea' : 'input');
  control.name = name;
  control.value = value || '';
  control.required = name === 'title' || name === 'description';
  control.maxLength = name === 'title' ? 180 : 4000;
  control.className = 'platform-input';
  wrapper.append(control);
  return wrapper;
}

function renderRequest(request) {
  const item = document.createElement('li');
  item.className = 'analytics-panel';
  const heading = document.createElement('h2');
  heading.textContent = `Запрос от ${new Date(request.createdAt).toLocaleDateString('ru-RU')}`;
  const reason = document.createElement('p'); reason.textContent = `Основание: ${request.reason}`;
  const decision = document.createElement('p'); decision.textContent = request.visibilityDecision === 'KEEP_PUBLISHED' ? 'Текущая допустимая версия остаётся публичной.' : 'Вебинар скрыт до одобрения исправления.';
  item.append(heading, reason, decision);
  if (request.status !== 'OPEN') {
    const state = document.createElement('p'); state.textContent = `Состояние: ${request.status}. Новая версия уже отправлена или рассмотрена.`; item.append(state); return item;
  }
  const form = document.createElement('form'); form.className = 'analytics-filter-grid';
  const title = input('Новый заголовок', 'title');
  const description = input('Новое описание', 'description');
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'platform-primary-button'; submit.textContent = 'Отправить новую версию на проверку';
  form.append(title, description, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; status.textContent = 'Отправляем неизменяемую версию…';
    try {
      const values = new FormData(form);
      await post(`/v1/moderation/corrections/${encodeURIComponent(request.id)}/submissions`, {
        expectedRevision: request.revision,
        baseContentVersion: request.baselineContentVersion,
        content: { title: String(values.get('title') || '').trim(), description: String(values.get('description') || '').trim() },
      });
      status.textContent = 'Версия отправлена на проверку. Публикация не изменена.';
      await load();
    } catch (error) {
      status.textContent = error?.status === 409 ? 'Вебинар или запрос изменился. Данные обновлены.' : 'Версию не удалось отправить.';
      if (error?.status === 409) await load();
    } finally { submit.disabled = false; }
  });
  item.append(form);
  return item;
}

async function load() {
  list.setAttribute('aria-busy', 'true'); status.textContent = 'Загружаем запросы…'; document.getElementById('correctionError').hidden = true;
  try {
    const payload = await getJson('/v1/moderation/corrections');
    list.replaceChildren(...payload.corrections.map(renderRequest));
    document.getElementById('correctionEmpty').hidden = payload.corrections.length > 0;
    status.textContent = 'Запросы обновлены.';
  } catch (error) {
    list.replaceChildren();
    document.getElementById('correctionErrorText').textContent = error?.status === 403 ? 'Нужна роль автора или владельца организации.' : 'Повторите запрос.';
    document.getElementById('correctionError').hidden = false; status.textContent = 'Ошибка загрузки.';
  } finally { list.setAttribute('aria-busy', 'false'); }
}

document.getElementById('correctionRetry').addEventListener('click', load);
load();
