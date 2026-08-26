import { deleteJson, getJson, patchJson, post, postBinary } from './utils.js?v=author-profile-2';

const statusLabels = {
  DRAFT: 'Черновик',
  PENDING: 'На проверке',
  NEEDS_INFO: 'Нужны уточнения',
  VERIFIED: 'Проверен',
  REJECTED: 'Отклонён',
  SUSPENDED: 'Приостановлен',
};

let current = { profile: null, evidence: [], latestVerification: null };

function node(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const target = node(id);
  if (target) target.textContent = value;
}

function showMode(mode, focusId) {
  document.body.dataset.authorMode = mode;
  if (focusId) window.requestAnimationFrame(() => node(focusId)?.focus());
}

function showError(error) {
  if (error?.status === 401) {
    setText('authorErrorTitle', 'Сначала войдите в аккаунт');
    setText('authorErrorText', 'Откройте страницу «Мой доступ» и завершите защищённый вход.');
  } else if (error?.status === 403) {
    setText('authorErrorTitle', 'Нет доступа к профилю автора');
    setText('authorErrorText', 'Профиль доступен активному автору или владельцу выбранной организации.');
  } else {
    setText('authorErrorTitle', 'Не удалось загрузить профиль');
    setText('authorErrorText', 'Проверьте соединение и обновите страницу.');
  }
  showMode('error', 'authorErrorTitle');
}

function editableStatus(status) {
  return !status || ['DRAFT', 'NEEDS_INFO', 'REJECTED'].includes(status);
}

function fillProfile(profile) {
  node('authorPublicName').value = profile?.publicName || '';
  node('authorBio').value = profile?.bio || '';
  node('authorSpecializations').value = (profile?.specializations || []).join('\n');
  node('authorOrganization').value = profile?.professionalOrganization || '';
  node('authorRegion').value = profile?.region || '';
  node('authorExperience').value = profile?.experience || '';
}

function evidenceLabel(kind) {
  return {
    LICENSE: 'Лицензия или удостоверение',
    DIPLOMA: 'Диплом',
    BAR_MEMBERSHIP: 'Адвокатский статус',
    OTHER: 'Другой документ',
  }[kind] || kind;
}

function formatBytes(value) {
  if (value < 1024) return `${value} Б`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} КБ`;
}

function renderEvidence(items, editable) {
  const list = node('authorEvidenceList');
  list.replaceChildren();
  node('authorEvidenceEmpty').hidden = items.length > 0;
  for (const item of items) {
    const entry = document.createElement('li');
    entry.className = 'author-evidence-item';
    const text = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'text-body-md font-bold text-primary';
    name.textContent = item.originalName;
    const meta = document.createElement('p');
    meta.className = 'mt-1 text-label-sm text-on-surface-variant';
    meta.textContent = `${evidenceLabel(item.kind)} · ${formatBytes(item.sizeBytes)}${item.submitted ? ' · Отправлен' : ''}`;
    text.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'author-evidence-actions';
    const download = document.createElement('a');
    download.className = 'platform-secondary-button';
    download.href = `/api/v1/author-verification/evidence/${encodeURIComponent(item.id)}`;
    download.textContent = `Скачать ${item.originalName}`;
    actions.append(download);
    if (editable && !item.submitted) {
      const remove = document.createElement('button');
      remove.className = 'platform-secondary-button';
      remove.type = 'button';
      remove.textContent = 'Удалить документ';
      remove.addEventListener('click', () => removeEvidence(item.id, remove));
      actions.append(remove);
    }
    entry.append(text, actions);
    list.append(entry);
  }
}

function render(data) {
  current = data;
  const status = data.profile?.verificationStatus || 'DRAFT';
  const editable = editableStatus(status);
  setText('authorStatusLabel', statusLabels[status] || status);
  const comment = data.latestVerification?.publicComment || '';
  setText('authorReviewComment', comment);
  node('authorReviewComment').hidden = !comment;
  fillProfile(data.profile);
  renderEvidence(data.evidence || [], editable);

  for (const control of node('authorProfileForm').elements) control.disabled = !editable;
  for (const control of node('authorEvidenceForm').elements) control.disabled = !editable;
  node('authorSubmitButton').disabled = !editable;
  if (!editable) {
    setText(
      'authorSubmitStatus',
      status === 'PENDING'
        ? 'Заявка ожидает решения администратора.'
        : status === 'VERIFIED'
          ? 'Профиль проверен. Документы остаются приватными.'
          : 'Изменения недоступны в текущем статусе.',
    );
  } else {
    setText('authorSubmitStatus', '');
  }
  showMode('content', 'authorHeading');
}

function specializationsFromInput() {
  return node('authorSpecializations')
    .value.split(/[\n,]/)
    .map(value => value.trim())
    .filter(Boolean);
}

function draftPayload() {
  return {
    publicName: node('authorPublicName').value.trim() || null,
    bio: node('authorBio').value.trim() || null,
    specializations: specializationsFromInput(),
    professionalOrganization: node('authorOrganization').value.trim() || null,
    region: node('authorRegion').value.trim() || null,
    experience: node('authorExperience').value.trim() || null,
  };
}

function clearFormErrors() {
  for (const input of node('authorProfileForm').elements) input.removeAttribute?.('aria-invalid');
  for (const id of [
    'authorPublicNameError',
    'authorBioError',
    'authorSpecializationsError',
    'authorOrganizationError',
    'authorRegionError',
    'authorExperienceError',
  ]) {
    setText(id, '');
  }
}

function validateForSubmission() {
  clearFormErrors();
  const fields = [
    ['authorPublicName', 'authorPublicNameError', 'Укажите ФИО от 2 до 160 символов.'],
    ['authorBio', 'authorBioError', 'Добавьте описание не короче 50 символов.'],
    ['authorOrganization', 'authorOrganizationError', 'Укажите профессиональную организацию.'],
    ['authorRegion', 'authorRegionError', 'Укажите регион.'],
    ['authorExperience', 'authorExperienceError', 'Опишите профессиональный опыт не короче 20 символов.'],
  ];
  for (const [inputId, errorId, message] of fields) {
    const input = node(inputId);
    if (!input.checkValidity()) {
      input.setAttribute('aria-invalid', 'true');
      setText(errorId, message);
      input.focus();
      return false;
    }
  }
  const specializations = specializationsFromInput();
  if (specializations.length < 1 || specializations.length > 30 || specializations.some(value => value.length < 2 || value.length > 120)) {
    node('authorSpecializations').setAttribute('aria-invalid', 'true');
    setText('authorSpecializationsError', 'Укажите от одной до 30 специализаций длиной до 120 символов.');
    node('authorSpecializations').focus();
    return false;
  }
  if ((current.evidence || []).length === 0) {
    setText('authorEvidenceError', 'Добавьте подтверждающий документ.');
    node('authorEvidenceFile').focus();
    return false;
  }
  return true;
}

async function refresh() {
  render(await getJson('/v1/author-profile'));
}

async function removeEvidence(evidenceId, button) {
  button.disabled = true;
  setText('authorEvidenceStatus', 'Удаляем документ…');
  try {
    await deleteJson(`/v1/author-verification/evidence/${encodeURIComponent(evidenceId)}`);
    await refresh();
    setText('authorEvidenceStatus', 'Документ удалён.');
  } catch {
    setText('authorEvidenceStatus', 'Не удалось удалить документ. Обновите страницу и повторите.');
    button.disabled = false;
  }
}

function bindProfileForm() {
  node('authorProfileForm').addEventListener('submit', async event => {
    event.preventDefault();
    clearFormErrors();
    const button = node('authorSaveButton');
    button.disabled = true;
    button.textContent = 'Сохраняем…';
    setText('authorProfileStatus', '');
    try {
      await patchJson('/v1/author-profile', draftPayload());
      await refresh();
      setText('authorProfileStatus', 'Черновик сохранён.');
    } catch (error) {
      setText(
        'authorProfileStatus',
        error?.status === 409
          ? 'Профиль уже отправлен и временно недоступен для изменений.'
          : 'Не удалось сохранить черновик. Проверьте поля и соединение.',
      );
    } finally {
      button.disabled = false;
      button.textContent = 'Сохранить черновик';
    }
  });
}

function bindEvidenceForm() {
  node('authorEvidenceForm').addEventListener('submit', async event => {
    event.preventDefault();
    const input = node('authorEvidenceFile');
    const file = input.files?.[0];
    setText('authorEvidenceError', '');
    if (!file || !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) || file.size < 1 || file.size > 5 * 1024 * 1024) {
      input.setAttribute('aria-invalid', 'true');
      setText('authorEvidenceError', 'Выберите PDF, JPEG или PNG размером до 5 МБ.');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    const button = node('authorEvidenceButton');
    button.disabled = true;
    button.textContent = 'Добавляем…';
    setText('authorEvidenceStatus', 'Документ загружается. Не закрывайте страницу.');
    try {
      await postBinary('/v1/author-verification/evidence', file, {
          'content-type': file.type,
          'x-evidence-kind': node('authorEvidenceKind').value,
          'x-evidence-filename': encodeURIComponent(file.name),
      });
      input.value = '';
      await refresh();
      setText('authorEvidenceStatus', 'Документ добавлен и доступен только вам и проверяющему администратору.');
    } catch {
      setText('authorEvidenceStatus', 'Не удалось добавить документ. Проверьте файл и соединение.');
    } finally {
      button.disabled = false;
      button.textContent = 'Добавить документ';
    }
  });
}

function bindSubmission() {
  node('authorSubmitButton').addEventListener('click', async () => {
    if (!validateForSubmission()) return;
    const button = node('authorSubmitButton');
    button.disabled = true;
    button.textContent = 'Отправляем…';
    setText('authorSubmitStatus', 'Проверяем обязательные поля и документы.');
    try {
      await patchJson('/v1/author-profile', draftPayload());
      await post('/v1/author-verification', {});
      await refresh();
      setText('authorSubmitStatus', 'Профиль отправлен на проверку.');
    } catch (error) {
      setText(
        'authorSubmitStatus',
        error?.payload?.code === 'author_verification_evidence_required'
          ? 'Добавьте подтверждающий документ.'
          : 'Не удалось отправить профиль. Проверьте обязательные поля и повторите.',
      );
      button.disabled = false;
    } finally {
      button.textContent = 'Отправить на проверку';
    }
  });
}

async function start() {
  bindProfileForm();
  bindEvidenceForm();
  bindSubmission();
  try {
    const session = await getJson('/v1/auth/session');
    const membership = session.memberships?.find(item => item.organizationId === session.activeOrganizationId);
    if (!membership || !['OWNER', 'AUTHOR'].includes(membership.role)) {
      const error = new Error('Author access required');
      error.status = 403;
      throw error;
    }
    await refresh();
  } catch (error) {
    showError(error);
  }
}

void start();
