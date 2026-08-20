import { getJson, post } from './utils.js?v=site-review-7';

const roleLabels = {
  OWNER: 'Владелец',
  AUTHOR: 'Автор',
  MODERATOR: 'Модератор',
  CRM_MANAGER: 'CRM-менеджер',
  ANALYST: 'Аналитик',
  AUDITOR: 'Аудитор',
};

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
  };
  if (window.location.hash) {
    window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
  }
  return tokens;
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

  const membership = session.memberships.find(item => item.organizationId === session.activeOrganizationId);
  if (!membership) {
    renderError({ status: 401 });
    return;
  }
  setText('platformUserName', session.user.displayName || 'Аккаунт АСПБ');
  setText('platformOrganizationName', membership.organization.name);
  setText('platformRole', roleLabels[membership.role] || membership.role);
  node('platformAuthorProfileLink').hidden = !['OWNER', 'AUTHOR'].includes(membership.role);
  renderMfaSettings(session, membership);
  showMode('ready', 'platformUserName');
}

async function hydrateSession() {
  const session = await getJson('/v1/auth/session');
  renderSession(session);
}

async function consumeToken(token) {
  const session = await post('/v1/auth/passwordless/consume', { token });
  renderSession(session);
}

async function consumeInvitation(token) {
  const session = await post('/v1/organization/invitations/accept', { token });
  renderSession(session);
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
      setText('platformLoginStatus', response.message || 'Если аккаунт доступен, мы отправим ссылку для входа.');
    } catch (error) {
      if (isDisabled(error)) renderError(error);
      else setText('platformLoginStatus', 'Не удалось отправить запрос. Проверьте соединение и повторите.');
    } finally {
      button.disabled = false;
      button.textContent = 'Получить ссылку';
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
      renderSession(await post('/v1/auth/mfa/verify', { otp }));
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
  node('platformRetryButton').addEventListener('click', () => showMode('login', 'platformEmail'));
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

async function start() {
  bindLoginForm();
  bindOrganizationForm();
  bindMfaChallenge();
  bindMfaSettings();
  bindActions();

  const { loginToken, invitationToken } = fragmentTokens();
  try {
    if (loginToken && invitationToken) {
      const invalidLink = new Error('Недействительная ссылка');
      invalidLink.status = 401;
      throw invalidLink;
    }
    if (invitationToken) await consumeInvitation(invitationToken);
    else if (loginToken) await consumeToken(loginToken);
    else await hydrateSession();
  } catch (error) {
    if (!loginToken && !invitationToken && error?.status === 401) showMode('login', 'platformEmail');
    else renderError(error);
  }
}

void start();
