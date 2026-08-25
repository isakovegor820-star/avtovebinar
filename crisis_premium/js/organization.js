import { deleteJson, getJson, patchJson, post } from './utils.js?v=organization-1';

const roles = {
  OWNER: 'Владелец', AUTHOR: 'Автор', MODERATOR: 'Модератор', CRM_MANAGER: 'CRM-менеджер', ANALYST: 'Аналитик', AUDITOR: 'Аудитор',
};
const state = { session: null, organization: null, membersCursor: null, invitationsCursor: null };
let confirmation = null;
let settingsRequestKey = null;

function node(id) { return document.getElementById(id); }
function setText(id, value) { const target = node(id); if (target) target.textContent = value; }
function mode(value, focusId) { document.body.dataset.organizationMode = value; if (focusId) requestAnimationFrame(() => node(focusId)?.focus()); }
function status(value) { setText('organizationStatus', value); }
function makeButton(label, className = 'platform-secondary-button') { const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; return button; }

function showError(error) {
  const denied = error?.status === 403;
  const signedOut = error?.status === 401;
  setText('organizationErrorTitle', signedOut ? 'Войдите в аккаунт' : denied ? 'Раздел доступен владельцу' : 'Не удалось загрузить команду');
  setText('organizationErrorText', signedOut
    ? 'Откройте аккаунт и войдите по одноразовой ссылке.'
    : denied ? 'Попросите владельца изменить команду или выдать вам роль владельца.'
    : navigator.onLine === false ? 'Нет соединения. Подключитесь к сети и повторите.' : 'Сервис временно недоступен. Повторите через несколько секунд.');
  node('organizationRetry').textContent = signedOut ? 'Открыть аккаунт' : 'Повторить';
  node('organizationRetry').dataset.signedOut = signedOut ? 'true' : 'false';
  mode('error', 'organizationErrorTitle');
}

function renderOrganization() {
  const value = state.organization;
  setText('organizationTitle', value.name);
  setText('organizationSlug', `Адрес: ${value.slug}`);
  node('organizationName').value = value.name;
  node('organizationTimezone').value = value.settings?.defaultTimezone || 'Europe/Moscow';
}

function confirmAction({ title, text, label, action, trigger }) {
  setText('organizationConfirmTitle', title);
  setText('organizationConfirmText', text);
  setText('organizationConfirmAction', label);
  confirmation = { action, trigger };
  node('organizationConfirmDialog').showModal();
  node('organizationConfirmAction').focus();
}

function memberCard(member) {
  const article = document.createElement('article'); article.className = 'organization-member';
  const main = document.createElement('div'); main.className = 'organization-member-main';
  const name = document.createElement('h3'); name.className = 'text-body-md font-bold text-primary'; name.textContent = member.displayName || member.email;
  const email = document.createElement('p'); email.className = 'organization-member-email mt-1 text-label-sm text-on-surface-variant'; email.textContent = member.email;
  const joined = document.createElement('p'); joined.className = 'mt-1 text-label-sm text-on-surface-variant'; joined.textContent = `В команде с ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(member.joinedAt))}`;
  main.append(name, email, joined);
  const actions = document.createElement('div'); actions.className = 'organization-member-actions';
  const label = document.createElement('label'); label.className = 'grid gap-2 text-label-sm font-bold text-primary'; label.textContent = 'Роль';
  const select = document.createElement('select'); select.className = 'platform-input min-w-48 px-3 text-body-md'; select.setAttribute('aria-label', `Роль: ${member.email}`);
  for (const [value, text] of Object.entries(roles)) { const option = document.createElement('option'); option.value = value; option.textContent = text; option.selected = value === member.role; select.append(option); }
  label.append(select);
  const save = makeButton('Сохранить роль');
  save.addEventListener('click', async () => {
    save.disabled = true; status('Сохраняем роль…');
    try {
      await patchJson(`/v1/organization/memberships/${encodeURIComponent(member.id)}/role`, { role: select.value });
      member.role = select.value; status(`Роль для ${member.email} сохранена.`);
    } catch (error) {
      select.value = member.role;
      status(error?.payload?.code === 'last_organization_owner' ? 'Нельзя понизить последнего активного владельца. Сначала назначьте другого.' : 'Не удалось сохранить роль. Обновите список и повторите.');
    } finally { save.disabled = false; }
  });
  const remove = makeButton('Удалить доступ');
  remove.addEventListener('click', () => confirmAction({
    title: 'Удалить доступ к кабинету АСПБ?',
    text: `${member.email} потеряет доступ к вебинарам и разделам своей роли. История и аудит сохранятся.`,
    label: 'Удалить доступ', trigger: remove,
    action: async () => { await deleteJson(`/v1/organization/memberships/${encodeURIComponent(member.id)}`); article.remove(); status(`Доступ для ${member.email} удалён.`); },
  }));
  actions.append(label, save, remove); article.append(main, actions); return article;
}

async function loadMembers(reset = false) {
  if (reset) { state.membersCursor = null; node('organizationMembers').replaceChildren(); }
  const query = new URLSearchParams({ limit: '25', ...(state.membersCursor ? { cursor: state.membersCursor } : {}) });
  const response = await getJson(`/v1/organizations/${encodeURIComponent(state.organization.id)}/members?${query}`);
  node('organizationMembers').append(...response.items.map(memberCard));
  state.membersCursor = response.nextCursor;
  node('organizationMembersMore').hidden = !state.membersCursor;
  node('organizationMembersEmpty').hidden = node('organizationMembers').childElementCount > 1;
}

function invitationCard(invitation) {
  const article = document.createElement('article'); article.className = 'organization-invitation';
  const main = document.createElement('div');
  const email = document.createElement('h3'); email.className = 'organization-member-email text-body-md font-bold text-primary'; email.textContent = invitation.emailNormalized;
  const detail = document.createElement('p'); detail.className = 'mt-1 text-label-sm text-on-surface-variant'; detail.textContent = `${roles[invitation.role] || invitation.role} · ${invitation.status}`;
  main.append(email, detail); article.append(main);
  if (invitation.status === 'PENDING') {
    const revoke = makeButton('Отозвать приглашение');
    revoke.addEventListener('click', () => confirmAction({
      title: 'Отозвать приглашение?', text: `Ссылка для ${invitation.emailNormalized} перестанет работать.`, label: 'Отозвать приглашение', trigger: revoke,
      action: async () => { await deleteJson(`/v1/organization/invitations/${encodeURIComponent(invitation.id)}`); await loadInvitations(true); status(`Приглашение для ${invitation.emailNormalized} отозвано.`); },
    }));
    article.append(revoke);
  }
  return article;
}

async function loadInvitations(reset = false) {
  if (reset) { state.invitationsCursor = null; node('organizationInvitations').replaceChildren(); }
  const query = new URLSearchParams({ limit: '25', ...(state.invitationsCursor ? { cursor: state.invitationsCursor } : {}) });
  const response = await getJson(`/v1/organization/invitations?${query}`);
  node('organizationInvitations').append(...response.invitations.map(invitationCard));
  state.invitationsCursor = response.nextCursor;
  node('organizationInvitationsMore').hidden = !state.invitationsCursor;
  node('organizationInvitationsEmpty').hidden = node('organizationInvitations').childElementCount > 0;
}

async function hydrate() {
  mode('loading');
  try {
    state.session = await getJson('/v1/auth/session');
    const membership = state.session.memberships?.find(item => item.organizationId === state.session.activeOrganizationId);
    if (!membership) throw Object.assign(new Error('No tenant'), { status: 401 });
    if (membership.role !== 'OWNER') throw Object.assign(new Error('Owner required'), { status: 403 });
    const response = await getJson(`/v1/organizations/${encodeURIComponent(membership.organizationId)}`);
    state.organization = response.organization; renderOrganization();
    await Promise.all([loadMembers(true), loadInvitations(true)]);
    mode('content', 'organizationTitle');
  } catch (error) { showError(error); }
}

function bind() {
  node('organizationRetry').addEventListener('click', () => { if (node('organizationRetry').dataset.signedOut === 'true') location.href = 'platform-access.html'; else void hydrate(); });
  node('organizationMembersMore').addEventListener('click', () => void loadMembers());
  node('organizationInvitationsMore').addEventListener('click', () => void loadInvitations());
  node('organizationConfirmDialog').addEventListener('close', async () => {
    const pending = confirmation; confirmation = null;
    if (node('organizationConfirmDialog').returnValue === 'confirm' && pending) {
      status('Выполняем подтверждённое действие…');
      try { await pending.action(); } catch (error) { status(error?.payload?.code === 'last_organization_owner' ? 'Последнего активного владельца нельзя удалить. Сначала назначьте другого.' : 'Не удалось выполнить действие. Обновите список и повторите.'); }
    }
    pending?.trigger?.focus();
  });
  node('organizationSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    for (const id of ['organizationName', 'organizationTimezone']) { node(id).removeAttribute('aria-invalid'); setText(`${id}Error`, ''); }
    const name = node('organizationName'), timezone = node('organizationTimezone');
    if (!name.checkValidity()) { name.setAttribute('aria-invalid', 'true'); setText('organizationNameError', 'Введите название от 2 до 160 знаков.'); name.focus(); return; }
    if (!timezone.checkValidity()) { timezone.setAttribute('aria-invalid', 'true'); setText('organizationTimezoneError', 'Введите IANA-зону, например Europe/Moscow.'); timezone.focus(); return; }
    const button = node('organizationSaveButton'); button.disabled = true; button.textContent = 'Сохраняем…'; status('Сохраняем настройки…'); settingsRequestKey ||= crypto.randomUUID();
    try {
      const response = await patchJson(`/v1/organizations/${encodeURIComponent(state.organization.id)}`, { expectedRevision: state.organization.revision, name: name.value.trim(), settings: { defaultTimezone: timezone.value.trim(), locale: 'ru-RU' } }, { 'Idempotency-Key': settingsRequestKey });
      state.organization = response.organization; settingsRequestKey = null; renderOrganization(); status('Настройки сохранены.');
    } catch (error) {
      if (error?.payload?.code === 'organization_revision_conflict') { settingsRequestKey = null; status('Настройки уже изменились. Обновляем данные…'); await hydrate(); }
      else status('Не удалось сохранить. Проверьте соединение и повторите.');
    } finally { button.disabled = false; button.textContent = 'Сохранить настройки'; }
  });
  node('organizationInvitationForm').addEventListener('submit', async event => {
    event.preventDefault(); const email = node('organizationInviteEmail'); email.removeAttribute('aria-invalid'); setText('organizationInviteEmailError', '');
    if (!email.checkValidity()) { email.setAttribute('aria-invalid', 'true'); setText('organizationInviteEmailError', 'Введите корректный email.'); email.focus(); return; }
    const button = node('organizationInviteButton'); button.disabled = true; button.textContent = 'Отправляем…'; status('Ставим приглашение в очередь…');
    try { await post('/v1/organization/invitations', { email: email.value.trim(), role: node('organizationInviteRole').value }); email.value = ''; await loadInvitations(true); status('Приглашение поставлено в очередь доставки.'); }
    catch (error) { if (error?.status === 409) { email.setAttribute('aria-invalid', 'true'); setText('organizationInviteEmailError', 'Этот адрес уже добавлен в команду.'); email.focus(); } else status('Не удалось отправить приглашение. Проверьте соединение и повторите.'); }
    finally { button.disabled = false; button.textContent = 'Отправить приглашение'; }
  });
}

bind(); void hydrate();
