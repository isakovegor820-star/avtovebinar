import { getJson } from './utils.js';

const node = id => document.getElementById(id);
const labels = {
  freshness: { CURRENT: 'Актуален', REVIEW_DUE: 'Требует проверки', OUTDATED: 'Устарел', SUPERSEDED: 'Есть новая версия', UNKNOWN: 'Актуальность не указана' },
  format: { RECORDED: 'Запись', PREMIERE: 'Премьера', ON_DEMAND: 'По запросу' },
};

function setMode(mode) { document.body.dataset.authorMode = mode; }
function setText(id, value, fallback = 'Не указано') { node(id).textContent = value || fallback; }

function renderSpecializations(items) {
  const values = Array.isArray(items) ? items.filter(value => typeof value === 'string' && value.trim()) : [];
  node('authorSpecializations').replaceChildren(...values.map(value => {
    const item = document.createElement('li');
    item.textContent = value;
    return item;
  }));
  node('authorSpecializationsEmpty').hidden = values.length > 0;
}

function webinarCard(webinar) {
  const item = document.createElement('li');
  item.className = 'author-webinar-card';
  const heading = document.createElement('h3');
  const link = document.createElement('a');
  const description = document.createElement('p');
  const meta = document.createElement('p');
  meta.className = 'author-webinar-meta';
  link.href = webinar.canonicalPath;
  link.textContent = webinar.title;
  heading.append(link);
  description.textContent = webinar.description || 'Описание готовится.';
  meta.textContent = [labels.format[webinar.format] || webinar.format, labels.freshness[webinar.freshnessStatus] || webinar.freshnessStatus, webinar.durationMinutes ? `${webinar.durationMinutes} мин.` : null].filter(Boolean).join(' · ');
  item.append(heading, description, meta);
  return item;
}

function render(author) {
  document.title = `${author.publicName} — автор | АСПБ`;
  document.querySelector('meta[name="description"]').content = `Публичный профиль автора ${author.publicName} и опубликованные вебинары на АСПБ.`;
  setText('authorName', author.publicName, 'Автор АСПБ');
  setText('authorOrganization', author.organization?.name);
  setText('authorBio', author.bio, 'Автор пока не добавил публичное описание.');
  setText('authorExperience', author.experience);
  setText('authorRegion', author.region);
  setText('authorProfessionalOrganization', author.professionalOrganization);
  renderSpecializations(author.specializations);
  const webinars = Array.isArray(author.webinars) ? author.webinars : [];
  node('authorWebinars').replaceChildren(...webinars.map(webinarCard));
  node('authorWebinarsEmpty').hidden = webinars.length > 0;
  node('authorReportLink').href = `report.html?${new URLSearchParams({ targetType: 'AUTHOR_PROFILE', targetId: author.reportTargetId }).toString()}`;
  setMode('content');
  node('authorName').focus();
}

async function initialize() {
  const slug = new URLSearchParams(window.location.search).get('author')?.trim();
  if (!slug) {
    node('authorRetryButton').hidden = true;
    setMode('error');
    node('authorError').querySelector('h1').focus?.();
    return;
  }
  node('authorRetryButton').hidden = false;
  setMode('loading');
  try {
    const payload = await getJson(`/api/v1/catalog/authors/${encodeURIComponent(slug)}`);
    render(payload.author);
  } catch (error) {
    node('authorErrorText').textContent = error?.status === 404
      ? 'Автор не найден или профиль больше не опубликован.'
      : 'Сервер не ответил. Проверьте соединение и повторите.';
    node('authorRetryButton').hidden = error?.status === 404;
    setMode('error');
    node('authorError').querySelector('h1').focus?.();
  }
}

node('authorRetryButton').addEventListener('click', () => void initialize());
void initialize();
