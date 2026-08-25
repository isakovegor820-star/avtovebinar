import { getJson } from './utils.js?v=platform-shell-1';

const ROLE_LABELS = {
  OWNER: 'Владелец',
  AUTHOR: 'Автор',
  MODERATOR: 'Модератор',
  CRM_MANAGER: 'CRM-менеджер',
  ANALYST: 'Аналитик',
  AUDITOR: 'Аудитор',
};

const ALL_ROLES = Object.keys(ROLE_LABELS);
const CREATOR_ROLES = ['OWNER', 'AUTHOR'];

const NAVIGATION = [
  {
    label: 'Главное',
    items: [{ label: 'Обзор', href: 'platform-overview.html', roles: ALL_ROLES }],
  },
  {
    label: 'Работа',
    items: [
      { label: 'Вебинары', href: 'creator-webinars.html', roles: CREATOR_ROLES },
      { label: 'CRM', href: 'crm.html', roles: ['OWNER', 'CRM_MANAGER', 'ANALYST', 'AUDITOR'] },
      { label: 'Аналитика', href: 'analytics.html', roles: ['OWNER', 'AUTHOR', 'ANALYST', 'AUDITOR'] },
      { label: 'Модерация', href: 'moderation.html', roles: ['OWNER', 'MODERATOR'] },
    ],
  },
  {
    label: 'Контент',
    items: [
      { label: 'Исправления', href: 'creator-corrections.html', roles: CREATOR_ROLES },
      { label: 'Профиль автора', href: 'author-profile.html', roles: CREATOR_ROLES },
    ],
  },
  {
    label: 'Команда',
    items: [
      { label: 'Команда и настройки', href: 'organization.html', roles: ['OWNER'] },
      { label: 'Мой доступ', href: 'platform-access.html?mode=access', roles: ALL_ROLES },
    ],
  },
];

const PAGE_CONFIG = {
  'platform-overview.html': { title: 'Обзор', group: 'Главное', action: { label: 'Создать вебинар', href: 'creator-webinars.html#create', roles: CREATOR_ROLES } },
  'creator-webinars.html': { title: 'Вебинары', group: 'Работа', action: { label: 'Новый вебинар', href: 'creator-webinars.html#create', roles: CREATOR_ROLES } },
  'crm.html': { title: 'CRM', group: 'Работа' },
  'analytics.html': { title: 'Аналитика', group: 'Работа' },
  'moderation.html': { title: 'Модерация', group: 'Работа' },
  'creator-corrections.html': { title: 'Исправления', group: 'Контент' },
  'author-profile.html': { title: 'Профиль автора', group: 'Контент' },
  'organization.html': { title: 'Команда и настройки', group: 'Команда' },
};

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function initials(value) {
  const parts = String(value || 'АСПБ').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map(part => part[0]).join('') || 'А';
}

function currentPage() {
  return location.pathname.split('/').pop() || 'platform-overview.html';
}

function focusableWithin(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(item => !item.hidden && item.getAttribute('aria-hidden') !== 'true');
}

function pageConfig() {
  return PAGE_CONFIG[currentPage()] || { title: document.title.split('|')[0].trim(), group: 'Платформа' };
}

function createSidebar() {
  const aside = node('aside', 'platform-shell-sidebar');
  aside.id = 'platformSidebar';
  aside.setAttribute('aria-label', 'Рабочая навигация АСПБ');
  aside.setAttribute('aria-hidden', 'false');

  const close = node('button', 'platform-shell-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть меню');
  close.dataset.platformClose = '';

  const brand = node('a', 'platform-shell-brand');
  brand.href = 'platform-overview.html';
  const mark = node('span', 'platform-shell-brand-mark', 'АСПБ');
  mark.setAttribute('aria-hidden', 'true');
  const copy = node('span', 'platform-shell-brand-copy');
  copy.append(node('strong', '', 'Кабинет АСПБ'), node('span', '', 'Вебинары, участники и аналитика'));
  brand.append(mark, copy);

  const nav = node('nav', 'platform-shell-nav');
  nav.setAttribute('aria-label', 'Разделы платформы');
  nav.dataset.platformNavigation = '';

  const support = node('section', 'platform-shell-support');
  support.append(
    node('strong', '', 'Нужна помощь?'),
    node('span', '', 'Справка по публикации, ролям и безопасности.'),
  );
  const supportLink = node('a', '', 'Открыть справку');
  supportLink.href = 'chat-rules.html';
  support.append(supportLink);

  const user = node('div', 'platform-shell-user');
  user.dataset.platformUser = '';
  const avatar = node('span', 'platform-shell-user-avatar', 'А');
  avatar.setAttribute('aria-hidden', 'true');
  const userCopy = node('span', 'platform-shell-user-copy');
  userCopy.append(node('strong', '', 'Аккаунт АСПБ'), node('span', '', 'Проверяем доступ…'));
  user.append(avatar, userCopy);

  aside.append(close, brand, nav, support, user);
  return aside;
}

function createUtilityBar(config) {
  const header = node('header', 'platform-utility-bar');
  const leading = node('div', 'platform-utility-leading');
  const menu = node('button', 'platform-shell-menu-button');
  menu.type = 'button';
  menu.setAttribute('aria-label', 'Открыть меню');
  menu.setAttribute('aria-controls', 'platformSidebar');
  menu.setAttribute('aria-expanded', 'false');
  menu.dataset.platformOpen = '';
  const menuGlyph = node('span');
  menuGlyph.setAttribute('aria-hidden', 'true');
  menu.append(menuGlyph);

  const breadcrumb = node('div', 'platform-breadcrumb');
  breadcrumb.append(node('span', '', `Кабинет АСПБ / ${config.group}`), node('strong', '', config.title));
  leading.append(menu, breadcrumb);

  const actions = node('div', 'platform-utility-actions');
  const context = node('div', 'platform-context-meta');
  const organization = node('span', 'platform-context-organization', 'Организация');
  const timezone = node('span', 'platform-context-timezone', 'Часовой пояс');
  const role = node('span', 'platform-context-role', 'Роль');
  const notifications = node('a');
  notifications.href = 'platform-overview.html#attention';
  notifications.textContent = 'Требует внимания';
  notifications.dataset.platformNotifications = '';
  organization.dataset.platformOrganizationName = '';
  timezone.dataset.platformTimezone = '';
  role.dataset.platformRole = '';
  context.append(organization, timezone, role, node('span', '', ''));
  context.lastElementChild.append(notifications);
  actions.append(context);
  if (config.action) {
    const action = node('a', 'platform-utility-primary', config.action.label);
    action.href = config.action.href;
    action.dataset.platformAction = '';
    action.dataset.roles = config.action.roles.join(',');
    actions.append(action);
  }
  header.append(leading, actions);
  return header;
}

function renderNavigation(nav, role) {
  nav.replaceChildren();
  for (const group of NAVIGATION) {
    const visible = group.items.filter(item => item.roles.includes(role));
    if (!visible.length) continue;
    const section = node('section', 'platform-shell-nav-group');
    section.append(node('h2', '', group.label));
    for (const item of visible) {
      const link = node('a', '', item.label);
      link.href = item.href;
      if (item.href.split('?')[0] === currentPage()) link.setAttribute('aria-current', 'page');
      section.append(link);
    }
    nav.append(section);
  }
}

function setupDrawer(sidebar, utility) {
  const openButton = utility.querySelector('[data-platform-open]');
  const closeButton = sidebar.querySelector('[data-platform-close]');
  const backdrop = node('button', 'platform-shell-backdrop');
  backdrop.type = 'button';
  backdrop.setAttribute('aria-label', 'Закрыть меню');
  document.body.append(backdrop);
  let returnFocus = null;

  const close = () => {
    if (!document.body.classList.contains('platform-shell-open')) return;
    document.body.classList.remove('platform-shell-open');
    document.querySelector('main')?.removeAttribute('inert');
    openButton.setAttribute('aria-expanded', 'false');
    const isCompact = window.matchMedia('(max-width: 64rem)').matches;
    sidebar.setAttribute('aria-hidden', isCompact ? 'true' : 'false');
    if (isCompact) sidebar.setAttribute('inert', '');
    else sidebar.removeAttribute('inert');
    returnFocus?.focus();
  };

  const open = () => {
    returnFocus = document.activeElement;
    document.body.classList.add('platform-shell-open');
    document.querySelector('main')?.setAttribute('inert', '');
    openButton.setAttribute('aria-expanded', 'true');
    sidebar.setAttribute('aria-hidden', 'false');
    sidebar.removeAttribute('inert');
    closeButton.focus();
  };

  openButton.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  sidebar.addEventListener('click', event => {
    if (event.target.closest('a') && window.matchMedia('(max-width: 64rem)').matches) close();
  });
  sidebar.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !document.body.classList.contains('platform-shell-open')) return;
    const items = focusableWithin(sidebar);
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  const breakpoint = window.matchMedia('(max-width: 64rem)');
  const sync = () => {
    if (!breakpoint.matches) close();
    const closedCompact = breakpoint.matches && !document.body.classList.contains('platform-shell-open');
    sidebar.setAttribute('aria-hidden', closedCompact ? 'true' : 'false');
    if (closedCompact) sidebar.setAttribute('inert', '');
    else sidebar.removeAttribute('inert');
  };
  breakpoint.addEventListener('change', sync);
  sync();
}

function activeMembership(session) {
  return session.memberships?.find(item => item.organizationId === session.activeOrganizationId) || null;
}

function renderSession(sidebar, utility, session, overview) {
  const membership = activeMembership(session);
  if (!membership) return;
  const role = membership.role;
  renderNavigation(sidebar.querySelector('[data-platform-navigation]'), role);
  const displayName = session.user?.displayName || session.user?.email || 'Аккаунт АСПБ';
  const userCard = sidebar.querySelector('[data-platform-user]');
  userCard.querySelector('.platform-shell-user-avatar').textContent = initials(displayName);
  userCard.querySelector('strong').textContent = displayName;
  userCard.querySelector('.platform-shell-user-copy span').textContent = ROLE_LABELS[role] || role;
  utility.querySelector('[data-platform-organization-name]').textContent = membership.organization.name;
  utility.querySelector('[data-platform-role]').textContent = ROLE_LABELS[role] || role;
  utility.querySelector('[data-platform-timezone]').textContent = overview?.organization?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const action = utility.querySelector('[data-platform-action]');
  if (action) action.hidden = !action.dataset.roles.split(',').includes(role);
  const notifications = utility.querySelector('[data-platform-notifications]');
  const count = Number(overview?.attention?.length || 0);
  notifications.textContent = overview ? (count ? `Требует внимания: ${count}` : 'Нет срочных задач') : 'Задачи недоступны';

}

function watchDirtyForms(main) {
  main.addEventListener('input', event => {
    if (event.target.closest('form')) document.body.dataset.platformFormDirty = 'true';
  });
  main.addEventListener('submit', () => {
    window.setTimeout(() => delete document.body.dataset.platformFormDirty, 0);
  });
}

async function hydrate(sidebar, utility) {
  try {
    const session = await getJson('/v1/auth/session');
    let overview = null;
    if (session.authenticated && session.activeOrganizationId) {
      overview = await getJson('/v1/platform/overview').catch(() => null);
    }
    renderSession(sidebar, utility, session, overview);
  } catch {
    const nav = sidebar.querySelector('[data-platform-navigation]');
    nav.replaceChildren();
    const access = node('a', '', 'Вход для команды');
    access.href = 'platform-access.html';
    nav.append(access);
    utility.querySelector('[data-platform-role]').textContent = 'Требуется вход';
  }
}

function start() {
  const main = document.querySelector('main');
  if (!main || document.body.classList.contains('has-platform-shell')) return;
  const config = pageConfig();
  const sidebar = createSidebar();
  const utility = createUtilityBar(config);
  document.body.classList.add('has-platform-shell');
  document.body.insertBefore(sidebar, document.body.firstChild);
  main.insertBefore(utility, main.firstChild);
  setupDrawer(sidebar, utility);
  watchDirtyForms(main);
  void hydrate(sidebar, utility);
}

start();
