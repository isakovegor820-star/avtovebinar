import { post } from './utils.js?v=site-review-7';

const form = document.getElementById('publicReportForm');
const status = document.getElementById('publicReportStatus');
const errorPanel = document.getElementById('publicReportError');
const errorText = document.getElementById('publicReportErrorText');
const params = new URLSearchParams(location.search);
const targetType = params.get('targetType') === 'AUTHOR_PROFILE' ? 'AUTHOR_PROFILE' : 'WEBINAR';
const targetId = params.get('targetId')?.trim() || '';

if (!targetId) {
  form.hidden = true;
  errorText.textContent = 'Материал недоступен. Вернитесь в каталог и откройте форму со страницы публикации.';
  errorPanel.hidden = false;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!targetId) return;
  const submit = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  submit.disabled = true;
  status.textContent = 'Отправляем обращение…';
  errorPanel.hidden = true;
  try {
    const reporterContact = String(data.get('reporterContact') || '').trim();
    const payload = await post('/v1/reports', {
      targetType,
      targetId,
      category: String(data.get('category') || ''),
      description: String(data.get('description') || '').trim(),
      ...(reporterContact ? { reporterContact } : {}),
    });
    form.reset();
    form.hidden = true;
    status.textContent = `Обращение принято. Номер: ${payload.report.id}.`;
    document.getElementById('reportHeading').focus();
  } catch (error) {
    errorText.textContent = error?.status === 404
      ? 'Материал недоступен или приём обращений ещё не включён.'
      : error?.status === 429
        ? 'Слишком много обращений. Подождите и повторите попытку.'
        : 'Сервер не принял обращение. Проверьте поля и попробуйте снова.';
    errorPanel.hidden = false;
    status.textContent = 'Ошибка отправки';
  } finally {
    submit.disabled = false;
  }
});
