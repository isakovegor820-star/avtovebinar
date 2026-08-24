import { getJson, post } from './utils.js?v=site-review-7';

const roleLabels = {
  OWNER: 'Владелец',
  AUTHOR: 'Автор',
  MODERATOR: 'Модератор',
  CRM_MANAGER: 'CRM-менеджер',
  ANALYST: 'Аналитик',
  AUDITOR: 'Аудитор',
};
const WEBINAR_INVITE_STORAGE_KEY = 'aspb.pendingWebinarInvite';
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ORGANIZATION_CREATE_KEY = 'aspb.organizationCreateIdempotencyKey';
let pendingWebinarInviteMemory = '';
let acceptedWebinarAccess = null;

function node(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const target = node(id);
  if (target) target.textContent = value;
}

function showMode(mode, focusId) {
  document.body.dataset.platformMode = mode;
  if (focusId) window.requestAnimationFrame(() => node(focusId)?.focus());
}

function fragmentTokens() {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const tokens = {
    loginToken: params.get('token') || '',
    invitationToken: params.get('invite') || '',
    webinarInvitationToken: params.get('webinarInvite') || '',
  };
  if (window.location.hash) {
    window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
  }
  return tokens;
}

function storePendingWebinarInvitation(token) {
  if (!OPAQUE_TOKEN_PATTERN.test(token)) return false;
  pendingWebinarInviteMemory = token;
  try {
    window.sessionStorage.setItem(WEBINAR_INVITE_STORAGE_KEY, token);
  } catch {
    // The in-memory copy still supports an already authenticated session.
  }
  return true;
}

function pendingWebinarInvitation() {
  if (pendingWebinarInviteMemory) return pendingWebinarInviteMemory;
  try {
    const stored = window.sessionStorage.getItem(WEBINAR_INVITE_STORAGE_KEY) || '';
    if (OPAQUE_TOKEN_PATTERN.test(stored)) {
      pendingWebinarInviteMemory = stored;
      return stored;
    }
  } catch {
    // Storage can be disabled; keep the safe empty fallback.
  }
  return '';
}

function clearPendingWebinarInvitation() {
  pendingWebinarInviteMemory = '';
  try {
    window.sessionStorage.removeItem(WEBINAR_INVITE_STORAGE_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}

function isDisabled(error) {
  return error?.status === 404 && error?.payload?.code === 'platform_accounts_disabled';
}

function renderError(error) {
  if (isDisabled(error)) {
    setText('platformErrorTitle', 'Вход пока не включён');
    setText('platformErrorText', 'Платформа ещё работает в режиме совместимости. Действующая регистрация и вебинарная комната доступны без изменений.');
    const retry = node('platformRetryButton');
    if (retry) retry.hidden = true;
  } else if (error?.status === 401) {
    setText('platformErrorTitle', 'Ссылка недействительна');
    setText('platformErrorText', 'Срок действия ссылки истёк или она уже была использована. Запросите новую одноразовую ссылку.');
  } else {
    setText('platformErrorTitle', 'Не удалось войти');
    setText('platformErrorText', navigator.onLine === false
      ? 'Нет соединения с интернетом. Подключитесь к сети и повторите попытку.'
      : 'Сервис временно недоступен. Повторите попытку через несколько секунд.');
  }
  showMode('error', 'platformErrorTitle');
}

function renderWebinarInvitationError(error) {
  if (error?.status === 401) {
    renderLogin(true);
    return;
  }
  setText('platformErrorTitle', 'Приглашение недоступно');
  setText(
    'platformErrorText',
    error?.status === 404
      ? 'Ссылка истекла, уже использована или вы вошли с другим email. Войдите с адресом, на который пришло приглашение, или запросите новую ссылку.'
      : 'Не удалось принять приглашение. Проверьте соединение и повторите.',
  );
  const retry = node('platformRetryButton');
  retry.hidden = false;
  retry.textContent = 'Войти другим адресом';
  showMode('error', 'platformErrorTitle');
}

function renderLogin(forWebinarInvitation = false) {
  setText('platformLoginTitle', forWebinarInvitation ? 'Войдите, чтобы принять приглашение' : 'Войти по одноразовой ссылке');
  setText(
    'platformLoginDescription',
    forWebinarInvitation
      ? 'Укажите email, на который пришло приглашение. После защищённого входа доступ к вебинару откроется автоматически.'
      : 'Укажите рабочий email. Если для него есть активный аккаунт, мы отправим ссылку со сроком действия 20 минут.',
  );
  setText(
    'platformEmailHint',
    forWebinarInvitation
      ? 'Используйте точно тот адрес, куда было отправлено приглашение.'
      : 'Используйте адрес, на который вас пригласили в организацию.',
  );
  node('platformContinueInviteButton').hidden = !forWebinarInvitation;
  showMode('login', 'platformEmail');
}

function renderMfaChallenge() {
  const input = node('platformMfaOtp');
  input.value = '';
  input.removeAttribute('aria-invalid');
  setText('platformMfaError', '');
  setText('platformMfaStatus', '');
  showMode('mfa', 'platformMfaOtp');
}

function renderMfaSettings(session, membership) {
  const settings = node('platformMfaSettings');
  const isOwner = membership.role === 'OWNER';
  settings.hidden = !isOwner;
  if (!isOwner) return;

  const enabled = Boolean(session.mfa?.enabled);
  node('platformMfaStartButton').hidden = enabled;
  node('platformMfaEnrollment').hidden = true;
  node('platformMfaDisableForm').hidden = !enabled;
  setText(
    'platformMfaSettingsDescription',
    enabled
      ? 'MFA включена. При каждом новом входе потребуется код из приложения-аутентификатора.'
      : 'Добавьте приложение-аутентификатор, чтобы защищать новые входы одноразовым кодом.',
  );
  setText('platformMfaSettingsStatus', '');
}

function renderSession(session) {
  if (session.mfaRequired) {
    renderMfaChallenge();
    return;
  }
  if (!session.activeOrganizationId && session.memberships.length > 1) {
    const select = node('platformOrganization');
    select.replaceChildren();
    for (const membership of session.memberships) {
      const option = document.createElement('option');
      option.value = membership.organizationId;
      option.textContent = membership.organization.name;
      select.append(option);
    }
    showMode('select', 'platformOrganization');
    return;
  }

  if (!session.activeOrganizationId && session.memberships.length === 0) {
    setText('platformOnboardingStatus', '');
    showMode('onboarding', 'platformOrganizationNameInput');
    return;
  }

  const membership = session.memberships.find(item => item.organizationId === session.activeOrganizationId);
  if (!membership) {
    renderError({ status: 401 });
    return;
  }
  setText('platformUserName', session.user.displayName || 'Аккаунт АСПБ');
  setText('platformOrganizationName', membership.organization.name);
  setText('platformRole', roleLabels[membership.role] || membership.role);
  node('platformAuthorProfileLink').hidden = !['OWNER', 'AUTHOR'].includes(membership.role);
  node('platformCreatorWebinarsLink').hidden = !['OWNER', 'AUTHOR'].includes(membership.role);
  node('platformModerationLink').hidden = !['OWNER', 'MODERATOR'].includes(membership.role);
  node('platformOrganizationSettingsLink').hidden = membership.role !== 'OWNER';
  renderMfaSettings(session, membership);
  const webinarAccess = node('platformWebinarAccess');
  webinarAccess.hidden = !acceptedWebinarAccess;
  if (acceptedWebinarAccess) {
    setText('platformWebinarAccessName', acceptedWebinarAccess.webinar.title);
    const expiresAt = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(acceptedWebinarAccess.expiresAt));
    setText('platformWebinarAccessExpiry', `Приглашение действует до ${expiresAt}.`);
  }
  showMode('ready', 'platformUserName');
}

async function renderAuthenticatedSession(session) {
  if (session.mfaRequired) {
    renderMfaChallenge();
    return;
  }
  const webinarInvitationToken = pendingWebinarInvitation();
  if (webinarInvitationToken) {
    try {
      acceptedWebinarAccess = await post('/v1/webinar-invitations/accept', { token: webinarInvitationToken });
      clearPendingWebinarInvitation();
    } catch (error) {
      renderWebinarInvitationError(error);
      return;
    }
  }
  renderSession(session);
}

async function hydrateSession() {
  const session = await getJson('/v1/auth/session');
  await renderAuthenticatedSession(session);
}

async function consumeToken(token) {
  const session = await post('/v1/auth/passwordless/consume', { token });
  await renderAuthenticatedSession(session);
}

async function consumeInvitation(token) {
  const session = await post('/v1/organization/invitations/accept', { token });
  await renderAuthenticatedSession(session);
}

function bindLoginForm() {
  const form = node('platformLoginForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const email = String(new FormData(form).get('email') || '').trim();
    const input = node('platformEmail');
    const button = node('platformLoginButton');
    setText('platformEmailError', '');
    setText('platformLoginStatus', '');
    input.removeAttribute('aria-invalid');

    if (!input.checkValidity()) {
      input.setAttribute('aria-invalid', 'true');
      setText('platformEmailError', 'Введите корректный email.');
      input.focus();
      return;
    }

    button.disabled = true;
    button.textContent = 'Отправляем…';
    try {
      const response = await post('/v1/auth/passwordless/request', { email });
      setText(
        'platformLoginStatus',
        pendingWebinarInvitation()
          ? 'Если аккаунт доступен, мы отправим ссылку. Откройте её в этом браузере. Если вошли в другой вкладке, вернитесь сюда и нажмите «Продолжить после входа».'
          : response.message || 'Если аккаунт доступен, мы отправим ссылку для входа.',
      );
    } catch (error) {
      if (isDisabled(error)) renderError(error);
      else setText('platformLoginStatus', 'Не удалось отправить запрос. Проверьте соединение и повторите.');
    } finally {
      button.disabled = false;
      button.textContent = 'Получить ссылку';
    }
  });
}

function bindWebinarInvitationContinuation() {
  node('platformContinueInviteButton').addEventListener('click', async () => {
    const button = node('platformContinueInviteButton');
    button.disabled = true;
    setText('platformLoginStatus', 'Проверяем вход и приглашение…');
    try {
      await hydrateSession();
    } catch (error) {
      if (error?.status === 401) {
        setText('platformLoginStatus', 'Сначала откройте одноразовую ссылку из письма, затем повторите.');
      } else {
        renderWebinarInvitationError(error);
      }
    } finally {
      button.disabled = false;
    }
  });
}

function bindOrganizationForm() {
  node('platformOrganizationForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = node('platformOrganizationButton');
    const organizationId = String(new FormData(event.currentTarget).get('organizationId') || '');
    button.disabled = true;
    setText('platformOrganizationStatus', 'Проверяем доступ…');
    try {
      await post('/v1/auth/active-organization', { organizationId });
      await hydrateSession();
    } catch (error) {
      if (error?.status === 401) showMode('login', 'platformEmail');
      else setText('platformOrganizationStatus', 'Организация недоступна. Обновите страницу и повторите.');
    } finally {
      button.disabled = false;
    }
  });
}

function organizationCreateIdempotencyKey() {
  try {
    const existing = window.sessionStorage.getItem(ORGANIZATION_CREATE_KEY);
    if (existing) return existing;
    const created = window.crypto.randomUUID();
    window.sessionStorage.setItem(ORGANIZATION_CREATE_KEY, created);
    return created;
  } catch {
    return window.crypto.randomUUID();
  }
}

function clearOrganizationCreateIdempotencyKey() {
  try {
    window.sessionStorage.removeItem(ORGANIZATION_CREATE_KEY);
  } catch {
    // The key is retry metadata, not a credential.
  }
}

function clearOnboardingErrors() {
  for (const id of ['platformOrganizationNameInput', 'platformOrganizationSlug', 'platformInvitationToken']) {
    node(id).removeAttribute('aria-invalid');
  }
  setText('platformOrganizationNameError', '');
  setText('platformOrganizationSlugError', '');
  setText('platformInvitationTokenError', '');
  setText('platformOnboardingStatus', '');
}

function bindOnboardingForms() {
  node('platformCreateOrganizationForm').addEventListener('submit', async event => {
    event.preventDefault();
    clearOnboardingErrors();
    const form = event.currentTarget;
    const name = node('platformOrganizationNameInput');
    const slug = node('platformOrganizationSlug');
    if (!name.checkValidity()) {
      name.setAttribute('aria-invalid', 'true');
      setText('platformOrganizationNameError', 'Введите название от 2 до 160 знаков.');
      name.focus();
      return;
    }
    if (slug.value && !slug.checkValidity()) {
      slug.setAttribute('aria-invalid', 'true');
      setText('platformOrganizationSlugError', 'Используйте буквы, цифры, пробелы или дефисы.');
      slug.focus();
      return;
    }
    const button = node('platformCreateOrganizationButton');
    button.disabled = true;
    button.textContent = 'Создаём…';
    setText('platformOnboardingStatus', 'Создаём организацию и защищённый tenant-контекст…');
    try {
      await post('/v1/organizations', {
        name: String(new FormData(form).get('name') || '').trim(),
        ...(String(new FormData(form).get('slug') || '').trim() ? { slug: String(new FormData(form).get('slug')).trim() } : {}),
      }, { 'Idempotency-Key': organizationCreateIdempotencyKey() });
      clearOrganizationCreateIdempotencyKey();
      await hydrateSession();
    } catch (error) {
      if (error?.payload?.code === 'organization_slug_invalid') {
        slug.setAttribute('aria-invalid', 'true');
        setText('platformOrganizationSlugError', 'Выберите другой короткий адрес.');
        slug.focus();
      } else if (error?.status === 409) {
        setText('platformOnboardingStatus', 'Не удалось создать организацию с этими данными. Измените короткий адрес и повторите.');
      } else {
        setText('platformOnboardingStatus', 'Не удалось создать организацию. Проверьте соединение и повторите.');
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Создать организацию';
    }
  });

  node('platformAcceptInvitationForm').addEventListener('submit', async event => {
    event.preventDefault();
    clearOnboardingErrors();
    const input = node('platformInvitationToken');
    if (!input.checkValidity()) {
      input.setAttribute('aria-invalid', 'true');
      setText('platformInvitationTokenError', 'Вставьте одноразовый код из письма.');
      input.focus();
      return;
    }
    const button = node('platformAcceptInvitationButton');
    button.disabled = true;
    button.textContent = 'Принимаем…';
    try {
      await renderAuthenticatedSession(await post('/v1/organization/invitations/accept', { token: input.value.trim() }));
    } catch {
      input.setAttribute('aria-invalid', 'true');
      setText('platformInvitationTokenError', 'Код истёк, отозван или уже использован. Запросите новое приглашение.');
      input.focus();
    } finally {
      button.disabled = false;
      button.textContent = 'Принять приглашение';
    }
  });
}

function validOtp(input, errorId) {
  input.removeAttribute('aria-invalid');
  setText(errorId, '');
  if (input.checkValidity()) return String(input.value).trim();
  input.setAttribute('aria-invalid', 'true');
  setText(errorId, 'Введите шестизначный код.');
  input.focus();
  return '';
}

function bindMfaChallenge() {
  node('platformMfaForm').addEventListener('submit', async event => {
    event.preventDefault();
    const input = node('platformMfaOtp');
    const otp = validOtp(input, 'platformMfaError');
    if (!otp) return;

    const button = node('platformMfaButton');
    button.disabled = true;
    button.textContent = 'Проверяем…';
    setText('platformMfaStatus', '');
    try {
      await renderAuthenticatedSession(await post('/v1/auth/mfa/verify', { otp }));
    } catch (error) {
      if (error?.payload?.code === 'user_mfa_code_invalid') {
        input.setAttribute('aria-invalid', 'true');
        setText('platformMfaError', 'Код не подошёл. Дождитесь нового кода и повторите.');
        input.select();
      } else if (error?.status === 401) {
        showMode('login', 'platformEmail');
      } else {
        setText('platformMfaStatus', 'Не удалось проверить код. Проверьте соединение и повторите.');
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Подтвердить вход';
    }
  });

  node('platformMfaLogoutButton').addEventListener('click', async () => {
    const button = node('platformMfaLogoutButton');
    button.disabled = true;
    try {
      await post('/v1/auth/logout', {});
      showMode('login', 'platformEmail');
    } catch {
      setText('platformMfaStatus', 'Не удалось завершить вход. Проверьте соединение и повторите.');
    } finally {
      button.disabled = false;
    }
  });
}

function bindMfaSettings() {
  node('platformMfaStartButton').addEventListener('click', async () => {
    const button = node('platformMfaStartButton');
    button.disabled = true;
    setText('platformMfaSettingsStatus', 'Создаём защищённый ключ…');
    try {
      const enrollment = await post('/v1/auth/mfa/enrollment/start', {});
      setText('platformMfaSecret', enrollment.secret);
      node('platformMfaEnrollment').hidden = false;
      setText('platformMfaSettingsStatus', 'Добавьте ключ и подтвердите настройку кодом в течение 10 минут.');
      node('platformMfaEnrollmentOtp').focus();
    } catch (error) {
      if (error?.status === 403) {
        setText('platformMfaSettingsStatus', 'Настроить MFA может только активный владелец организации.');
      } else {
        setText('platformMfaSettingsStatus', 'Не удалось начать настройку. Проверьте соединение и повторите.');
      }
    } finally {
      button.disabled = false;
    }
  });

  node('platformMfaEnrollmentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const input = node('platformMfaEnrollmentOtp');
    const otp = validOtp(input, 'platformMfaEnrollmentError');
    if (!otp) return;
    const button = node('platformMfaEnrollmentButton');
    button.disabled = true;
    button.textContent = 'Включаем…';
    try {
      renderSession(await post('/v1/auth/mfa/enrollment/confirm', { otp }));
      setText('platformMfaSettingsStatus', 'MFA включена. Другие активные сессии завершены.');
    } catch (error) {
      input.setAttribute('aria-invalid', 'true');
      setText(
        'platformMfaEnrollmentError',
        error?.payload?.code === 'user_mfa_code_invalid'
          ? 'Код не подошёл. Введите актуальный код из приложения.'
          : 'Не удалось включить MFA. Начните настройку заново.',
      );
      input.select();
    } finally {
      button.disabled = false;
      button.textContent = 'Включить MFA';
    }
  });

  node('platformMfaDisableForm').addEventListener('submit', async event => {
    event.preventDefault();
    const input = node('platformMfaDisableOtp');
    const otp = validOtp(input, 'platformMfaDisableError');
    if (!otp) return;
    const button = node('platformMfaDisableButton');
    button.disabled = true;
    button.textContent = 'Отключаем…';
    try {
      renderSession(await post('/v1/auth/mfa/disable', { otp }));
      setText('platformMfaSettingsStatus', 'MFA отключена. Другие активные сессии завершены.');
    } catch (error) {
      input.setAttribute('aria-invalid', 'true');
      setText(
        'platformMfaDisableError',
        error?.payload?.code === 'user_mfa_code_invalid'
          ? 'Код не подошёл. Введите актуальный код из приложения.'
          : 'Не удалось отключить MFA. Проверьте соединение и повторите.',
      );
      input.select();
    } finally {
      button.disabled = false;
      button.textContent = 'Отключить MFA';
    }
  });
}

function bindActions() {
  node('platformRetryButton').addEventListener('click', () => renderLogin(Boolean(pendingWebinarInvitation())));
  node('platformLogoutButton').addEventListener('click', async () => {
    const button = node('platformLogoutButton');
    button.disabled = true;
    setText('platformReadyStatus', 'Завершаем сессию…');
    try {
      await post('/v1/auth/logout', {});
      showMode('login', 'platformEmail');
    } catch {
      setText('platformReadyStatus', 'Не удалось выйти. Проверьте соединение и повторите.');
    } finally {
      button.disabled = false;
    }
  });
}

async function processLocationFragment() {
  const { loginToken, invitationToken, webinarInvitationToken } = fragmentTokens();
  try {
    if (webinarInvitationToken && !storePendingWebinarInvitation(webinarInvitationToken)) {
      const invalidLink = new Error('Недействительная ссылка');
      invalidLink.status = 404;
      throw invalidLink;
    }
    if (loginToken && invitationToken) {
      const invalidLink = new Error('Недействительная ссылка');
      invalidLink.status = 401;
      throw invalidLink;
    }
    if (invitationToken) await consumeInvitation(invitationToken);
    else if (loginToken) await consumeToken(loginToken);
    else await hydrateSession();
  } catch (error) {
    if (!loginToken && !invitationToken && error?.status === 401) renderLogin(Boolean(pendingWebinarInvitation()));
    else if (pendingWebinarInvitation()) renderWebinarInvitationError(error);
    else renderError(error);
  }
}

async function start() {
  bindLoginForm();
  bindWebinarInvitationContinuation();
  bindOrganizationForm();
  bindOnboardingForms();
  bindMfaChallenge();
  bindMfaSettings();
  bindActions();
  window.addEventListener('hashchange', () => void processLocationFragment());
  await processLocationFragment();
}

void start();
