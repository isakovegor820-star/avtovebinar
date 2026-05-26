import type { Request } from 'express';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, AppError, getClientIp } from '../lib/http.js';
import { createAccessToken, createAdminSession, hashIp, hashToken, parseAdminSession } from '../lib/tokens.js';
import { env } from '../lib/env.js';
import { CRM_STATUS_LABELS, CRM_STATUSES, isCrmStatus } from '../lib/crm.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { formatMoscowDate, sendTelegramMessageToChat } from '../lib/telegram.js';
import { getReplayExpiresAt } from '../lib/time.js';

export const adminRouter = Router();

const ADMIN_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type AdminRole = (typeof ADMIN_ROLES)[number];

function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLES.includes(value as AdminRole);
}

type AdminRequest = Request & {
  admin?: {
    id: string | null;
    login: string;
    email: string | null;
    role: string;
  };
};

async function requireAdmin(req: AdminRequest, _res: any, next: any) {
  const session = parseAdminSession(req.cookies?.aspb_admin_session);
  if (!session) {
    return next(new AppError(401, 'Admin authorization required'));
  }

  if (session.adminId) {
    const adminUser = await prisma.adminUser.findUnique({ where: { id: session.adminId } });
    if (!adminUser || !adminUser.isActive) {
      return next(new AppError(401, 'Admin authorization required'));
    }

    req.admin = {
      id: adminUser.id,
      login: adminUser.name,
      email: adminUser.email,
      role: adminUser.role
    };
    return next();
  }

  req.admin = {
    id: session.adminId ?? null,
    login: session.login ?? env.ADMIN_LOGIN,
    email: session.email ?? null,
    role: session.role ?? 'owner'
  };
  return next();
}

function requireRole(roles: AdminRole[]) {
  return (req: AdminRequest, _res: any, next: any) => {
    if (!req.admin || !roles.includes(req.admin.role as AdminRole)) {
      return next(new AppError(403, 'Недостаточно прав'));
    }

    return next();
  };
}

async function ensureDefaultAdminUser() {
  const existingCount = await prisma.adminUser.count();
  if (existingCount > 0) {
    return null;
  }

  return prisma.adminUser.create({
    data: {
      name: env.ADMIN_LOGIN,
      email: env.ADMIN_LOGIN.includes('@') ? env.ADMIN_LOGIN.toLowerCase() : `${env.ADMIN_LOGIN}@local.admin`,
      passwordHash: hashPassword(env.ADMIN_PASSWORD),
      role: 'owner'
    }
  });
}

async function audit(req: AdminRequest, input: {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  await prisma.auditLog.create({
    data: {
      adminUserId: req.admin?.id ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      beforeJson: input.before === undefined ? Prisma.JsonNull : input.before as Prisma.InputJsonValue,
      afterJson: input.after === undefined ? Prisma.JsonNull : input.after as Prisma.InputJsonValue,
      ipHash: hashIp(getClientIp(req)),
      userAgent: req.headers['user-agent'] ?? null
    }
  });
}

function adminPage() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>АСПБ admin</title>
  <style>
    :root { color-scheme: light; --blue:#041627; --muted:#5d6673; --line:#dbe2ea; --bg:#f7f9fb; --soft:#eef4fb; --white:#fff; --accent:#d2e4fb; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--blue); }
    header { position:sticky; top:0; z-index:5; background:rgba(255,255,255,.92); border-bottom:1px solid var(--line); backdrop-filter: blur(12px); }
    .wrap { max-width:1280px; margin:0 auto; padding:24px; }
    .top { display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:28px; }
    h2 { margin:0 0 14px; font-size:20px; }
    h3 { margin:0 0 10px; font-size:16px; }
    .sub { color:var(--muted); margin-top:4px; font-size:14px; }
    .grid { display:grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap:14px; margin:24px 0; }
    .layout { display:grid; grid-template-columns: minmax(0, 1fr) 380px; gap:18px; align-items:start; }
    .card, .panel { background:white; border:1px solid var(--line); border-radius:18px; box-shadow:0 18px 50px rgba(4,22,39,.06); }
    .card { padding:18px; }
    .metric { font-size:30px; font-weight:800; }
    .label { color:var(--muted); font-size:13px; margin-top:4px; }
    .panel { padding:20px; margin-bottom:18px; }
    .side { position:sticky; top:112px; }
    .filters { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
    input, select, button, textarea { font:inherit; border-radius:12px; border:1px solid var(--line); padding:11px 13px; }
    textarea { width:100%; min-height:110px; resize:vertical; }
    button { border:0; background:var(--blue); color:#fff; cursor:pointer; font-weight:700; }
    button.secondary { background:#d2e4fb; color:var(--blue); }
    button.ghost { background:#fff; color:var(--blue); border:1px solid var(--line); }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:12px 8px; vertical-align:top; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .pill { display:inline-flex; padding:5px 9px; border-radius:999px; background:var(--soft); font-size:12px; font-weight:700; }
    .pill.dark { background:var(--blue); color:#fff; }
    .login { max-width:420px; margin:12vh auto; padding:28px; }
    .login input { width:100%; margin:8px 0; }
    .hidden { display:none !important; }
    .stack { display:grid; gap:12px; }
    .row { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; padding:10px 0; border-bottom:1px solid var(--line); }
    .muted-box { background:var(--soft); border:1px solid var(--line); border-radius:14px; padding:12px; }
    .question { display:grid; grid-template-columns:1fr auto; gap:12px; align-items:start; padding:14px 0; border-bottom:1px solid var(--line); }
    .question p { margin:6px 0 0; color:#28313b; }
    .broadcast-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:10px; }
    .status-line { color:var(--muted); font-size:13px; }
    .hot-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:12px; }
    .hot-card { border:1px solid #c9d8e9; border-radius:16px; padding:14px; background:linear-gradient(135deg,#fff,#f3f8ff); display:grid; gap:8px; }
    .hot-head { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
    .hot-score { display:inline-flex; align-items:center; gap:6px; padding:5px 8px; border-radius:999px; background:var(--blue); color:#fff; font-size:12px; font-weight:800; white-space:nowrap; }
    .action-row { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
    .action-row a, .mini-link { display:inline-flex; align-items:center; justify-content:center; text-decoration:none; border-radius:10px; padding:9px 11px; font-weight:800; font-size:13px; border:1px solid var(--line); color:var(--blue); background:#fff; }
    .telegram-box { border:1px solid #b9d5f5; background:#f2f8ff; border-radius:16px; padding:14px; display:grid; gap:10px; }
    .telegram-box.connected { background:linear-gradient(135deg,#eef7ff,#fff); }
    @media (max-width: 1050px) { .layout { grid-template-columns:1fr; } .side { position:static; } }
    @media (max-width: 900px) { .grid, .hot-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } table { display:block; overflow:auto; } }
    @media (max-width: 620px) { .hot-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="wrap top">
      <div>
        <h1>АСПБ admin</h1>
        <div class="sub">Регистрации, вопросы и базовая аналитика автовебинара</div>
      </div>
      <button id="logoutBtn" class="secondary hidden">Выйти</button>
    </div>
  </header>

  <main class="wrap">
    <section id="loginPanel" class="panel login">
      <h2>Вход</h2>
      <input id="login" placeholder="Логин" autocomplete="username" />
      <input id="password" placeholder="Пароль" type="password" autocomplete="current-password" />
      <button id="loginBtn">Войти</button>
      <p id="loginError" class="sub"></p>
    </section>

    <section id="appPanel" class="hidden">
      <div class="grid" id="metrics"></div>

      <section class="panel">
        <div class="top">
          <div>
            <h2>Горячие участники</h2>
            <div class="sub">Приоритет для менеджера: Telegram, вход в комнату, вопросы, заявки или ручная отметка.</div>
          </div>
          <button id="hotRefreshBtn" class="ghost">Обновить</button>
        </div>
        <div id="hotLeads" class="hot-grid"></div>
      </section>

      <section class="panel hidden" id="userAdminSection">
        <div class="top">
          <div>
            <h2>Менеджеры и роли</h2>
            <div class="sub">Owner/admin управляют доступом. Менеджеры видят всех лидов, действия пишутся в audit log.</div>
          </div>
          <button id="usersRefreshBtn" class="ghost">Обновить</button>
        </div>
        <div class="filters">
          <input id="newUserName" placeholder="Имя менеджера" />
          <input id="newUserEmail" placeholder="Email для входа" />
          <input id="newUserPassword" type="password" placeholder="Временный пароль" />
          <select id="newUserRole"></select>
          <button id="createUserBtn">Добавить</button>
        </div>
        <div id="usersList"></div>
      </section>

      <div class="layout">
        <div>
          <section class="panel">
            <div class="top">
              <div>
                <h2>Маркетинговая воронка</h2>
                <div class="sub">Период, источники, UTM и конверсии до заявки/договора.</div>
              </div>
              <button id="funnelRefreshBtn" class="ghost">Обновить</button>
            </div>
            <div class="filters">
              <input id="funnelFrom" type="date" />
              <input id="funnelTo" type="date" />
              <select id="funnelGroupBy">
                <option value="source">source</option>
                <option value="utmSource">utm_source</option>
                <option value="utmMedium">utm_medium</option>
                <option value="utmCampaign">utm_campaign</option>
              </select>
            </div>
            <div class="grid" id="funnelMetrics"></div>
            <div id="funnelTable"></div>
          </section>

          <section class="panel">
            <h2>Регистрации и воронка</h2>
            <div class="filters" id="queueTabs">
              <button class="ghost" data-queue="all">Все</button>
              <button class="ghost" data-queue="new">Новые</button>
              <button class="ghost" data-queue="today">Сегодня</button>
              <button class="ghost" data-queue="hot">Горячие</button>
              <button class="ghost" data-queue="questions">Вопросы</button>
              <button class="ghost" data-queue="applications">Заявки</button>
              <button class="ghost" data-queue="contracts">Договоры</button>
            </div>
            <div class="filters">
              <input id="query" placeholder="Имя, email, телефон" />
              <input id="date" type="date" />
              <select id="status"></select>
              <select id="managerFilter"></select>
              <select id="telegramFilter"><option value="">Telegram: все</option><option value="yes">подключен</option><option value="no">не подключен</option></select>
              <select id="roomFilter"><option value="">Комната: все</option><option value="yes">заходил</option><option value="no">не заходил</option></select>
              <select id="questionFilter"><option value="">Вопросы: все</option><option value="yes">есть вопрос</option></select>
              <select id="applicationFilter"><option value="">Заявки: все</option><option value="yes">есть заявка</option></select>
              <button id="refreshBtn">Обновить</button>
            </div>
            <div id="registrations"></div>
          </section>

          <section class="panel">
            <h2>Заявки на партнерский договор</h2>
            <div id="applications"></div>
          </section>

          <section class="panel">
            <h2>Telegram-новости участникам</h2>
            <div class="sub">Сообщение уйдет только тем, кто нажал Telegram-кнопку после регистрации и привязал бота.</div>
            <textarea id="broadcastText" placeholder="Например: Завтра в 11:00 МСК разберем, как юристу не терять клиентов с долговыми рисками и передавать их в АСПБ."></textarea>
            <div class="broadcast-actions">
              <button id="broadcastBtn">Отправить новость</button>
              <span id="broadcastStatus" class="status-line"></span>
            </div>
          </section>

          <section class="panel">
            <h2>Вопросы</h2>
            <div id="questions"></div>
          </section>
        </div>

        <aside class="panel side">
          <h2>Карточка лида</h2>
          <div id="leadCard" class="sub">Выберите регистрацию, чтобы увидеть контакт, события, вопросы и заметки менеджера.</div>
        </aside>
      </div>
    </section>
  </main>

  <script>
    const CRM_STATUSES = ${JSON.stringify(CRM_STATUSES.map(status => ({ value: status, label: CRM_STATUS_LABELS[status] })))};
    const loginPanel = document.getElementById('loginPanel');
    const appPanel = document.getElementById('appPanel');
    const logoutBtn = document.getElementById('logoutBtn');
    const queryInput = document.getElementById('query');
    const dateInput = document.getElementById('date');
    const statusFilter = document.getElementById('status');
    const managerFilter = document.getElementById('managerFilter');
    const telegramFilter = document.getElementById('telegramFilter');
    const roomFilter = document.getElementById('roomFilter');
    const questionFilter = document.getElementById('questionFilter');
    const applicationFilter = document.getElementById('applicationFilter');
    const queueTabs = document.getElementById('queueTabs');
    const registrationsNode = document.getElementById('registrations');
    const applicationsNode = document.getElementById('applications');
    const questionsNode = document.getElementById('questions');
    const hotLeadsNode = document.getElementById('hotLeads');
    const userAdminSection = document.getElementById('userAdminSection');
    const usersList = document.getElementById('usersList');
    const newUserRole = document.getElementById('newUserRole');
    const broadcastText = document.getElementById('broadcastText');
    const broadcastBtn = document.getElementById('broadcastBtn');
    const broadcastStatus = document.getElementById('broadcastStatus');
    const funnelFrom = document.getElementById('funnelFrom');
    const funnelTo = document.getElementById('funnelTo');
    const funnelGroupBy = document.getElementById('funnelGroupBy');
    const funnelMetrics = document.getElementById('funnelMetrics');
    const funnelTable = document.getElementById('funnelTable');
    let currentQueue = 'all';
    let activeManagers = [];

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Ошибка запроса');
      return response.json();
    }

    function clear(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function node(tag, attrs, children) {
      const element = document.createElement(tag);
      Object.entries(attrs || {}).forEach(([key, value]) => {
        if (value === null || value === undefined) return;
        if (key === 'class') element.className = value;
        else if (key === 'text') element.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
        else element.setAttribute(key, value);
      });
      (children || []).forEach(child => element.append(child));
      return element;
    }

    function fmtDate(value) {
      if (!value) return '—';
      return new Intl.DateTimeFormat('ru-RU', { dateStyle:'short', timeStyle:'short' }).format(new Date(value));
    }

    function crmLabel(value) {
      const item = CRM_STATUSES.find(status => status.value === value);
      return item ? item.label : value || '—';
    }

    function telegramUrl(lead) {
      if (lead.telegramUsername) return 'https://t.me/' + String(lead.telegramUsername).replace(/^@/, '');
      return '';
    }

    function hotReasons(item) {
      const reasons = [];
      if (item.isHot) reasons.push('отмечен вручную');
      if (item.partnerApplicationCount) reasons.push('заявка на договор');
      if (item.questionCount) reasons.push('задал вопрос');
      if (item.roomEnteredAt) reasons.push('был в комнате');
      if (item.lead.telegramSubscribedAt || item.telegramClickedAt) reasons.push('Telegram подключен');
      return reasons;
    }

    function fillStatusFilter() {
      clear(statusFilter);
      statusFilter.append(node('option', { value:'', text:'Все CRM-статусы' }));
      CRM_STATUSES.forEach(item => statusFilter.append(node('option', { value:item.value, text:item.label })));
    }

    function fillManagerFilter() {
      clear(managerFilter);
      managerFilter.append(node('option', { value:'', text:'Все менеджеры' }));
      activeManagers.forEach(manager => managerFilter.append(node('option', { value:manager.id, text:manager.name + ' · ' + manager.role })));
    }

    async function loadManagers() {
      const data = await api('/api/admin/managers');
      activeManagers = data.managers || [];
      fillManagerFilter();
      return activeManagers;
    }

    function managerName(id) {
      const manager = activeManagers.find(item => item.id === id);
      return manager ? manager.name : 'Не назначен';
    }

    function fillRoleSelect(roles) {
      clear(newUserRole);
      (roles || ['manager']).forEach(role => newUserRole.append(node('option', { value:role, text:role })));
      newUserRole.value = 'manager';
    }

    async function loadUsers() {
      try {
        const data = await api('/api/admin/users');
        userAdminSection.classList.remove('hidden');
        fillRoleSelect(data.roles);
        clear(usersList);
        if (!data.users.length) {
          usersList.append(node('p', { class:'sub', text:'Менеджеров пока нет.' }));
          return;
        }
        data.users.forEach(user => {
          const roleSelect = node('select');
          data.roles.forEach(role => roleSelect.append(node('option', { value:role, text:role })));
          roleSelect.value = user.role;
          usersList.append(node('div', { class:'row' }, [
            node('div', {}, [
              node('strong', { text:user.name }),
              node('div', { text:user.email }),
              node('div', { class:'sub', text:'роль: ' + user.role + ', вход: ' + fmtDate(user.lastLoginAt) })
            ]),
            node('div', { class:'action-row' }, [
              roleSelect,
              node('button', { class:'ghost', text:user.isActive ? 'Отключить' : 'Включить', onclick:async () => {
                await api('/api/admin/users/' + user.id, { method:'PATCH', body:JSON.stringify({ isActive:!user.isActive }) });
                await loadUsers();
              }}),
              node('button', { text:'Сохранить роль', onclick:async () => {
                await api('/api/admin/users/' + user.id, { method:'PATCH', body:JSON.stringify({ role:roleSelect.value }) });
                await loadUsers();
              }})
            ])
          ]));
        });
      } catch (_error) {
        userAdminSection.classList.add('hidden');
      }
    }

    async function createUser() {
      const name = document.getElementById('newUserName').value.trim();
      const email = document.getElementById('newUserEmail').value.trim();
      const password = document.getElementById('newUserPassword').value;
      if (!name || !email || !password) {
        alert('Заполните имя, email и пароль.');
        return;
      }

      await api('/api/admin/users', {
        method:'POST',
        body:JSON.stringify({ name, email, password, role:newUserRole.value || 'manager' })
      });
      document.getElementById('newUserName').value = '';
      document.getElementById('newUserEmail').value = '';
      document.getElementById('newUserPassword').value = '';
      await loadUsers();
    }

    async function loadSummary() {
      const data = await api('/api/admin/analytics/summary');
      const items = [
        ['Посетители', data.summary.pageViews],
        ['Регистрации', data.summary.registrations],
        ['Входы в комнату', data.summary.roomEntries],
        ['Telegram', data.summary.telegramSubscribers],
        ['Горячие', data.summary.hotLeads],
        ['Вопросы', data.summary.questions],
        ['Заявки', data.summary.partnerApplications]
      ];
      const metrics = document.getElementById('metrics');
      clear(metrics);
      items.forEach(([label, value]) => {
        metrics.append(node('div', { class:'card' }, [
          node('div', { class:'metric', text:String(value) }),
          node('div', { class:'label', text:label })
        ]));
      });
    }

    function pct(value) {
      return Math.round((Number(value) || 0) * 1000) / 10 + '%';
    }

    function isoDate(date) {
      return date.toISOString().slice(0, 10);
    }

    function initFunnelDates() {
      const now = new Date();
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      funnelFrom.value = isoDate(from);
      funnelTo.value = isoDate(now);
    }

    async function loadFunnel() {
      const params = new URLSearchParams();
      if (funnelFrom.value) params.set('from', funnelFrom.value);
      if (funnelTo.value) params.set('to', funnelTo.value);
      if (funnelGroupBy.value) params.set('groupBy', funnelGroupBy.value);
      const data = await api('/api/admin/analytics/funnel?' + params.toString());
      const summaryItems = [
        ['Посетители', data.summary.visitors],
        ['Регистрации', data.summary.registrations + ' / ' + pct(data.rates.registrationRate)],
        ['TG clicks', data.summary.telegramClicks + ' / ' + pct(data.rates.telegramClickRate)],
        ['TG подписки', data.summary.telegramSubscribers + ' / ' + pct(data.rates.telegramSubscribeRate)],
        ['Комната', data.summary.roomEntries + ' / ' + pct(data.rates.roomEntryRate)],
        ['Вопросы', data.summary.questions + ' / ' + pct(data.rates.questionRate)],
        ['Заявки', data.summary.applications + ' / ' + pct(data.rates.applicationRate)],
        ['Договоры', data.summary.contracts + ' / ' + pct(data.rates.contractRate)]
      ];
      clear(funnelMetrics);
      summaryItems.forEach(([label, value]) => {
        funnelMetrics.append(node('div', { class:'card' }, [
          node('div', { class:'metric', text:String(value) }),
          node('div', { class:'label', text:label })
        ]));
      });

      clear(funnelTable);
      const tbody = node('tbody');
      data.groups.forEach(row => {
        tbody.append(node('tr', {}, [
          node('td', {}, [node('strong', { text:row.key })]),
          node('td', { text:String(row.visitors) }),
          node('td', { text:String(row.registrations) + ' / ' + pct(row.registrationRate) }),
          node('td', { text:String(row.telegramSubscribers) + ' / ' + pct(row.telegramSubscribeRate) }),
          node('td', { text:String(row.roomEntries) + ' / ' + pct(row.roomEntryRate) }),
          node('td', { text:String(row.questions) }),
          node('td', { text:String(row.applications) + ' / ' + pct(row.applicationRate) }),
          node('td', { text:String(row.contracts) + ' / ' + pct(row.contractRate) })
        ]));
      });
      funnelTable.append(node('table', {}, [
        node('thead', {}, [node('tr', {}, [
          node('th', { text:data.groupBy }),
          node('th', { text:'Посетители' }),
          node('th', { text:'Регистрации' }),
          node('th', { text:'TG' }),
          node('th', { text:'Комната' }),
          node('th', { text:'Вопросы' }),
          node('th', { text:'Заявки' }),
          node('th', { text:'Договоры' })
        ])]),
        tbody
      ]));
    }

    async function loadHotLeads() {
      const data = await api('/api/admin/hot-leads');
      clear(hotLeadsNode);
      if (!data.registrations.length) {
        hotLeadsNode.append(node('p', { class:'sub', text:'Пока нет горячих участников.' }));
        return;
      }
      data.registrations.forEach(item => {
        const reasons = hotReasons(item);
        hotLeadsNode.append(node('div', { class:'hot-card' }, [
          node('div', { class:'hot-head' }, [
            node('div', {}, [
              node('strong', { text:item.lead.name }),
              node('div', { class:'sub', text:item.lead.phone }),
              node('div', { class:'sub', text:item.lead.email })
            ]),
            node('span', { class:'hot-score', text:item.isHot ? 'HOT' : String(reasons.length) + ' сигн.' })
          ]),
          node('div', { class:'sub', text:reasons.join(' · ') || 'активность' }),
          node('div', { class:'action-row' }, [
            node('button', { class:'ghost', text:'Карточка', onclick:() => loadRegistrationCard(item.id) }),
            telegramUrl(item.lead)
              ? node('a', { href:telegramUrl(item.lead), target:'_blank', text:'Telegram' })
              : item.lead.telegramChatId
                ? node('span', { class:'pill', text:'Telegram подключен' })
                : node('span', { class:'sub', text:'Telegram не подключен' })
          ])
        ]));
      });
    }

    async function loadRegistrations() {
      const params = new URLSearchParams();
      if (currentQueue && currentQueue !== 'all') params.set('queue', currentQueue);
      if (queryInput.value) params.set('query', queryInput.value);
      if (dateInput.value) params.set('date', dateInput.value);
      if (statusFilter.value) params.set('status', statusFilter.value);
      if (managerFilter.value) params.set('managerId', managerFilter.value);
      if (telegramFilter.value) params.set('telegram', telegramFilter.value);
      if (roomFilter.value) params.set('room', roomFilter.value);
      if (questionFilter.value) params.set('hasQuestion', questionFilter.value);
      if (applicationFilter.value) params.set('hasApplication', applicationFilter.value);
      const data = await api('/api/admin/registrations?' + params.toString());
      clear(registrationsNode);
      const tbody = node('tbody');
      data.registrations.forEach(item => {
        const row = node('tr');
        row.append(
          node('td', {}, [
            node('strong', { text:item.lead.name }),
            node('div', { text:item.lead.email }),
            node('div', { text:item.lead.phone })
          ]),
          node('td', {}, [
            node('span', { class:'pill dark', text:crmLabel(item.crmStatus) }),
            item.isHot ? node('span', { class:'pill', text:'HOT' }) : node('span', { class:'hidden' }),
            node('div', { class:'sub', text:'менеджер: ' + (item.assignedManager ? item.assignedManager.name : 'не назначен') }),
            node('div', { class:'sub', text:'след. контакт: ' + fmtDate(item.nextContactAt) }),
            node('div', { class:'sub', text:'регистрация: ' + fmtDate(item.registeredAt) })
          ]),
          node('td', {}, [
            node('div', { text:fmtDate(item.webinar.scheduledAt) }),
            node('div', { class:'sub', text:'вопросов: ' + item.questionCount + ', заявок: ' + item.partnerApplicationCount })
          ]),
          node('td', {}, [
            node('div', { text:'комната: ' + (item.roomEnteredAt ? 'да' : 'нет') }),
            node('div', { text:'ТГ: ' + (item.lead.telegramSubscribedAt ? 'подключен' : item.telegramClickedAt ? 'клик' : 'нет') }),
            node('button', { class:'ghost', text:'Открыть', onclick:() => loadRegistrationCard(item.id) })
          ])
        );
        tbody.append(row);
      });
      const table = node('table', {}, [
        node('thead', {}, [node('tr', {}, [
          node('th', { text:'Контакт' }),
          node('th', { text:'CRM' }),
          node('th', { text:'Эфир' }),
          node('th', { text:'Действия' })
        ])]),
        tbody
      ]);
      registrationsNode.append(table);
    }

    async function loadRegistrationCard(id) {
      const data = await api('/api/admin/registrations/' + id);
      const registration = data.registration;
      const card = document.getElementById('leadCard');
      clear(card);

      const statusSelect = node('select');
      CRM_STATUSES.forEach(item => statusSelect.append(node('option', { value:item.value, text:item.label })));
      statusSelect.value = registration.crmStatus || 'new';

      const managerSelect = node('select');
      managerSelect.append(node('option', { value:'', text:'Не назначен' }));
      activeManagers.forEach(manager => managerSelect.append(node('option', { value:manager.id, text:manager.name + ' · ' + manager.role })));
      managerSelect.value = registration.assignedManagerId || '';

      const nextContact = node('input', { type:'datetime-local' });
      if (registration.nextContactAt) {
        const date = new Date(registration.nextContactAt);
        nextContact.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }

      const note = node('textarea', { placeholder:'Заметка менеджера' });
      note.value = registration.managerNote || '';
      const tgUrl = telegramUrl(registration.lead);
      const manualReminderText = 'Напоминаем про вебинар АСПБ. Подготовьте один вопрос по клиенту с долгами — ссылка на комнату придет в этом сообщении.';

      card.append(
        node('div', { class:'stack' }, [
          node('div', { class:'muted-box' }, [
            node('h3', { text:registration.lead.name }),
            node('div', { text:registration.lead.email }),
            node('div', { text:registration.lead.phone }),
            node('div', { class:'sub', text:[registration.lead.city, registration.lead.professionalStatus].filter(Boolean).join(' · ') || 'Город/статус не указаны' })
          ]),
          node('div', { class:'row' }, [node('span', { text:'Источник' }), node('strong', { text:registration.lead.source || 'direct' })]),
          node('div', { class:'row' }, [node('span', { text:'UTM' }), node('span', { text:[registration.lead.utmSource, registration.lead.utmMedium, registration.lead.utmCampaign].filter(Boolean).join(' / ') || '—' })]),
          node('div', { class:'row' }, [node('span', { text:'Регистрация' }), node('strong', { text:fmtDate(registration.registeredAt) })]),
          node('div', { class:'row' }, [node('span', { text:'Эфир' }), node('strong', { text:fmtDate(registration.webinarSession.scheduledAt) })]),
          node('div', { class:'row' }, [node('span', { text:'Комната' }), node('strong', { text:registration.roomEnteredAt ? fmtDate(registration.roomEnteredAt) : 'не заходил' })]),
          node('label', { class:'stack' }, [node('span', { text:'Ответственный менеджер' }), managerSelect]),
          node('label', { class:'stack' }, [node('span', { text:'Следующий контакт' }), nextContact]),
          node('button', { class:'secondary', text:'Сохранить менеджера/контакт', onclick:async () => {
            await api('/api/admin/registrations/' + id + '/manager', {
              method:'PATCH',
              body:JSON.stringify({ assignedManagerId:managerSelect.value || null, nextContactAt:nextContact.value || null })
            });
            await Promise.all([loadRegistrations(), loadHotLeads(), loadRegistrationCard(id)]);
          }}),
          node('div', { class:registration.lead.telegramChatId ? 'telegram-box connected' : 'telegram-box' }, [
            node('h3', { text:registration.lead.telegramChatId ? 'Telegram подключен' : 'Telegram не подключен' }),
            node('div', { class:'row' }, [node('span', { text:'Username' }), node('strong', { text:registration.lead.telegramUsername ? '@' + registration.lead.telegramUsername.replace(/^@/, '') : '—' })]),
            node('div', { class:'row' }, [node('span', { text:'Имя в Telegram' }), node('strong', { text:registration.lead.telegramFirstName || '—' })]),
            node('div', { class:'row' }, [node('span', { text:'Подключен' }), node('strong', { text:registration.lead.telegramSubscribedAt ? fmtDate(registration.lead.telegramSubscribedAt) : '—' })]),
            node('div', { class:'action-row' }, [
              tgUrl ? node('a', { href:tgUrl, target:'_blank', text:'Написать' }) : node('span', { class:'sub', text:'Нет username' }),
              node('button', { class:'ghost', text:'Отправить напоминание', onclick:async () => {
                await api('/api/admin/registrations/' + id + '/telegram-reminder', { method:'POST', body:JSON.stringify({ text:manualReminderText }) });
                alert('Напоминание отправлено');
              }}),
              node('button', { class:registration.isHot ? 'secondary' : '', text:registration.isHot ? 'Горячий' : 'Пометить горячим', onclick:async () => {
                await api('/api/admin/registrations/' + id + '/hot', { method:'PATCH', body:JSON.stringify({ isHot:!registration.isHot }) });
                await Promise.all([loadHotLeads(), loadRegistrations(), loadSummary(), loadRegistrationCard(id)]);
              }})
            ])
          ]),
          node('label', { class:'stack' }, [node('span', { text:'CRM-статус' }), statusSelect]),
          node('button', { text:'Сохранить статус', onclick:async () => {
            await api('/api/admin/registrations/' + id + '/status', { method:'PATCH', body:JSON.stringify({ crmStatus: statusSelect.value }) });
            await Promise.all([loadRegistrations(), loadSummary(), loadRegistrationCard(id)]);
          }}),
          node('label', { class:'stack' }, [node('span', { text:'Заметка менеджера' }), note]),
          node('button', { class:'secondary', text:'Сохранить заметку', onclick:async () => {
            await api('/api/admin/registrations/' + id + '/note', { method:'PATCH', body:JSON.stringify({ managerNote: note.value }) });
            await loadRegistrationCard(id);
          }}),
          renderCardList('Заявки на договор', registration.partnerApplications, item => [
            item.sphere || 'Сфера не указана',
            item.clientFlow || 'Поток не указан',
            item.preferredFormat || 'Формат не указан',
            item.comment || ''
          ]),
          renderCardList('Вопросы', registration.questions, item => [item.text, fmtDate(item.createdAt)]),
          renderCardList('История действий менеджеров', data.auditLogs || [], item => [
            item.action,
            item.adminUser ? item.adminUser.name + ' · ' + item.adminUser.role : 'system',
            fmtDate(item.createdAt)
          ]),
          renderCardList('История событий', registration.events, item => [item.eventName, item.page || '', fmtDate(item.createdAt)])
        ])
      );
    }

    function renderCardList(title, items, mapItem) {
      const box = node('div', { class:'stack' }, [node('h3', { text:title })]);
      if (!items || !items.length) {
        box.append(node('div', { class:'sub', text:'Пока пусто' }));
        return box;
      }
      items.slice(0, 8).forEach(item => {
        const lines = mapItem(item).filter(Boolean);
        box.append(node('div', { class:'muted-box' }, lines.map((line, index) =>
          node(index === 0 ? 'strong' : 'div', { text:String(line) })
        )));
      });
      return box;
    }

    async function loadApplications() {
      const data = await api('/api/admin/partner-applications');
      clear(applicationsNode);
      if (!data.applications.length) {
        applicationsNode.append(node('p', { class:'sub', text:'Заявок пока нет.' }));
        return;
      }
      data.applications.forEach(item => {
        applicationsNode.append(node('div', { class:'question' }, [
          node('div', {}, [
            node('strong', { text:item.lead.name }),
            node('span', { class:'sub', text:' ' + item.lead.email }),
            node('p', { text:[item.sphere, item.clientFlow, item.preferredFormat].filter(Boolean).join(' · ') || 'Детали не указаны' }),
            node('div', { class:'sub', text:fmtDate(item.createdAt) })
          ]),
          node('button', { class:'ghost', text:'Карточка', onclick:() => item.registrationId && loadRegistrationCard(item.registrationId) })
        ]));
      });
    }

    async function loadQuestions() {
      const data = await api('/api/admin/questions');
      clear(questionsNode);
      if (!data.questions.length) {
        questionsNode.append(node('p', { class:'sub', text:'Вопросов пока нет.' }));
        return;
      }
      data.questions.forEach(q => {
        questionsNode.append(node('div', { class:'question' }, [
          node('div', {}, [
            node('strong', { text:q.lead.name }),
            node('span', { class:'sub', text:' ' + q.lead.email }),
            node('p', { text:q.text }),
            node('div', { class:'sub', text:fmtDate(q.createdAt) })
          ]),
          node('button', { class:q.isAnswered ? 'secondary' : '', text:q.isAnswered ? 'Обработан' : 'Отметить', onclick:async () => {
            await api('/api/admin/questions/' + q.id, {
            method: 'PATCH',
            body: JSON.stringify({ isAnswered: true })
          });
            await loadQuestions();
          }})
        ]));
      });
    }

    async function sendBroadcast() {
      const text = broadcastText.value.trim();
      if (!text) {
        broadcastStatus.textContent = 'Введите текст новости.';
        return;
      }

      broadcastBtn.disabled = true;
      broadcastStatus.textContent = 'Отправляем...';
      try {
        const data = await api('/api/admin/telegram/broadcast', {
          method:'POST',
          body:JSON.stringify({ text })
        });
        broadcastStatus.textContent = 'Отправлено: ' + data.sent + ' из ' + data.total + (data.failed ? ', ошибок: ' + data.failed : '');
        broadcastText.value = '';
        await loadSummary();
      } catch (error) {
        broadcastStatus.textContent = error.message || 'Не удалось отправить.';
      } finally {
        broadcastBtn.disabled = false;
      }
    }

    async function loadAll() {
      await loadManagers();
      await Promise.all([loadSummary(), loadFunnel(), loadHotLeads(), loadRegistrations(), loadApplications(), loadQuestions(), loadUsers()]);
    }

    loginBtn.addEventListener('click', async () => {
      try {
        await api('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ login: login.value, password: password.value })
        });
        loginPanel.classList.add('hidden');
        appPanel.classList.remove('hidden');
        logoutBtn.classList.remove('hidden');
        await loadAll();
      } catch (error) {
        loginError.textContent = error.message;
      }
    });

    logoutBtn.addEventListener('click', async () => {
      await api('/api/admin/logout', { method: 'POST', body: '{}' });
      location.reload();
    });

    refreshBtn.addEventListener('click', loadAll);
    hotRefreshBtn.addEventListener('click', loadHotLeads);
    usersRefreshBtn.addEventListener('click', loadUsers);
    createUserBtn.addEventListener('click', createUser);
    broadcastBtn.addEventListener('click', sendBroadcast);
    funnelRefreshBtn.addEventListener('click', loadFunnel);
    [funnelFrom, funnelTo, funnelGroupBy].forEach(input => input.addEventListener('change', loadFunnel));
    fillStatusFilter();
    initFunnelDates();
    fillManagerFilter();
    queueTabs.querySelectorAll('[data-queue]').forEach(button => {
      button.addEventListener('click', async () => {
        currentQueue = button.dataset.queue || 'all';
        queueTabs.querySelectorAll('button').forEach(item => item.classList.toggle('secondary', item === button));
        await loadRegistrations();
      });
    });
    const defaultQueueButton = queueTabs.querySelector('[data-queue="all"]');
    if (defaultQueueButton) defaultQueueButton.classList.add('secondary');
    [managerFilter, telegramFilter, roomFilter, questionFilter, applicationFilter, statusFilter].forEach(input => {
      input.addEventListener('change', loadRegistrations);
    });

    loadAll()
      .then(() => {
        loginPanel.classList.add('hidden');
        appPanel.classList.remove('hidden');
        logoutBtn.classList.remove('hidden');
        const registrationFromUrl = new URLSearchParams(location.search).get('registration');
        if (registrationFromUrl) loadRegistrationCard(registrationFromUrl).catch(() => {});
      })
      .catch(() => {});
  </script>
</body>
</html>`;
}

adminRouter.get('/admin', (_req, res) => {
  res.type('html').send(adminPage());
});

adminRouter.post(
  '/api/admin/login',
  asyncHandler(async (req, res) => {
    const data = z.object({ login: z.string().trim(), password: z.string() }).parse(req.body);
    await ensureDefaultAdminUser();

    const login = data.login.toLowerCase();
    const adminUser = await prisma.adminUser.findFirst({
      where: {
        isActive: true,
        OR: [{ email: login }, { name: data.login }]
      }
    });

    const isLegacyLogin = data.login === env.ADMIN_LOGIN && data.password === env.ADMIN_PASSWORD;
    const isDbLogin = adminUser ? verifyPassword(data.password, adminUser.passwordHash) : false;

    if (!isDbLogin && !isLegacyLogin) {
      throw new AppError(401, 'Неверный логин или пароль');
    }

    const sessionAdmin = adminUser
      ? { id: adminUser.id, email: adminUser.email, role: adminUser.role }
      : { id: undefined, email: env.ADMIN_LOGIN, role: 'owner' };

    if (adminUser) {
      await prisma.adminUser.update({
        where: { id: adminUser.id },
        data: { lastLoginAt: new Date() }
      });
    }

    res.cookie('aspb_admin_session', createAdminSession(sessionAdmin), {
      httpOnly: true,
      sameSite: env.NODE_ENV === 'production' ? 'strict' : 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000
    });
    res.json({ ok: true });
  })
);

adminRouter.post('/api/admin/logout', (_req, res) => {
  res.clearCookie('aspb_admin_session');
  res.json({ ok: true });
});

adminRouter.get(
  '/api/admin/me',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, admin: (req as AdminRequest).admin });
  })
);

adminRouter.get(
  '/api/admin/managers',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const managers = await prisma.adminUser.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }]
    });

    res.json({ ok: true, managers });
  })
);

adminRouter.get(
  '/api/admin/users',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (_req, res) => {
    const users = await prisma.adminUser.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }]
    });

    res.json({ ok: true, roles: ADMIN_ROLES, users });
  })
);

adminRouter.post(
  '/api/admin/users',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const data = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(160),
      password: z.string().min(8).max(200),
      role: z.string().default('manager')
    }).parse(req.body);

    if (!isAdminRole(data.role)) {
      throw new AppError(400, 'Invalid admin role');
    }

    const user = await prisma.adminUser.create({
      data: {
        name: data.name,
        email: data.email.toLowerCase(),
        passwordHash: hashPassword(data.password),
        role: data.role
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true
      }
    });

    await audit(req as AdminRequest, {
      action: 'admin_user.create',
      entityType: 'admin_user',
      entityId: user.id,
      after: user
    });

    res.status(201).json({ ok: true, user });
  })
);

adminRouter.patch(
  '/api/admin/users/:id',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      role: z.string().optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(8).max(200).optional().or(z.literal(''))
    }).parse(req.body);
    const before = await prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, role: true, isActive: true }
    });

    if (!before) {
      throw new AppError(404, 'Admin user not found');
    }

    if (data.role && !isAdminRole(data.role)) {
      throw new AppError(400, 'Invalid admin role');
    }

    const user = await prisma.adminUser.update({
      where: { id },
      data: {
        name: data.name,
        role: data.role,
        isActive: data.isActive,
        passwordHash: data.password ? hashPassword(data.password) : undefined
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true
      }
    });

    await audit(req as AdminRequest, {
      action: 'admin_user.update',
      entityType: 'admin_user',
      entityId: user.id,
      before,
      after: user
    });

    res.json({ ok: true, user });
  })
);

adminRouter.get(
  '/api/admin/registrations',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        query: z.string().optional(),
        date: z.string().optional(),
        status: z.string().optional(),
        queue: z.string().optional(),
        managerId: z.string().optional(),
        telegram: z.string().optional(),
        room: z.string().optional(),
        hasQuestion: z.string().optional(),
        hasApplication: z.string().optional()
      })
      .parse(req.query);

    const dateFilter = query.date
      ? {
          gte: new Date(`${query.date}T00:00:00.000Z`),
          lt: new Date(`${query.date}T23:59:59.999Z`)
        }
      : undefined;

    const queueWhere: Prisma.RegistrationWhereInput =
      query.queue === 'hot'
        ? { OR: [{ isHot: true }, { questions: { some: {} } }, { partnerApplications: { some: {} } }, { roomEnteredAt: { not: null } }] }
        : query.queue === 'questions'
          ? { questions: { some: {} } }
          : query.queue === 'applications'
            ? { partnerApplications: { some: {} } }
            : query.queue === 'contracts'
              ? { crmStatus: { in: ['contract_pending', 'contract_signed', 'payout_due', 'paid'] } }
              : query.queue === 'today'
                ? { nextContactAt: { lte: new Date() } }
                : query.queue === 'new'
                  ? { crmStatus: 'new' }
                  : {};

    const leadFilters: Prisma.LeadWhereInput[] = [];
    if (query.telegram === 'yes') {
      leadFilters.push({ telegramChatId: { not: null } });
    }
    if (query.telegram === 'no') {
      leadFilters.push({ telegramChatId: null });
    }
    if (query.query) {
      leadFilters.push({
        OR: [
          { name: { contains: query.query, mode: 'insensitive' } },
          { email: { contains: query.query, mode: 'insensitive' } },
          { phone: { contains: query.query, mode: 'insensitive' } }
        ]
      });
    }
    const leadWhere: Prisma.LeadWhereInput | undefined = leadFilters.length ? { AND: leadFilters } : undefined;

    const where: Prisma.RegistrationWhereInput = {
      ...queueWhere,
      crmStatus: query.status || undefined,
      assignedManagerId: query.managerId || undefined,
      roomEnteredAt: query.room === 'yes' ? { not: null } : query.room === 'no' ? null : undefined,
      questions: query.hasQuestion === 'yes' ? { some: {} } : undefined,
      partnerApplications: query.hasApplication === 'yes' ? { some: {} } : undefined,
      webinarSession: dateFilter ? { scheduledAt: dateFilter } : undefined,
      lead: leadWhere
    };

    const registrations = await prisma.registration.findMany({
      where,
      include: {
        lead: true,
        webinarSession: true,
        assignedManager: { select: { id: true, name: true, email: true, role: true } },
        _count: { select: { questions: true, partnerApplications: true } }
      },
      orderBy: { registeredAt: 'desc' },
      take: 200
    });

    res.json({
      ok: true,
      registrations: registrations.map(item => ({
        id: item.id,
        status: item.status,
        crmStatus: item.crmStatus,
        managerNote: item.managerNote,
        isHot: item.isHot,
        assignedManagerId: item.assignedManagerId,
        assignedManager: item.assignedManager,
        nextContactAt: item.nextContactAt,
        registeredAt: item.registeredAt,
        roomEnteredAt: item.roomEnteredAt,
        telegramClickedAt: item.telegramClickedAt,
        questionCount: item._count.questions,
        partnerApplicationCount: item._count.partnerApplications,
        lead: {
          id: item.lead.id,
          name: item.lead.name,
          phone: item.lead.phone,
          email: item.lead.email,
          city: item.lead.city,
          professionalStatus: item.lead.professionalStatus,
          source: item.lead.source,
          utmSource: item.lead.utmSource,
          utmMedium: item.lead.utmMedium,
          utmCampaign: item.lead.utmCampaign,
          telegramChatId: item.lead.telegramChatId,
          telegramUsername: item.lead.telegramUsername,
          telegramFirstName: item.lead.telegramFirstName,
          telegramSubscribedAt: item.lead.telegramSubscribedAt
        },
        webinar: {
          id: item.webinarSession.id,
          scheduledAt: item.webinarSession.scheduledAt,
          status: item.webinarSession.status
        }
      }))
    });
  })
);

adminRouter.get(
  '/api/admin/hot-leads',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const registrations = await prisma.registration.findMany({
      where: {
        OR: [
          { isHot: true },
          { partnerApplications: { some: {} } },
          { questions: { some: {} } },
          { roomEnteredAt: { not: null } }
        ]
      },
      include: {
        lead: true,
        webinarSession: true,
        assignedManager: { select: { id: true, name: true, email: true, role: true } },
        _count: { select: { questions: true, partnerApplications: true } }
      },
      orderBy: [{ isHot: 'desc' }, { updatedAt: 'desc' }],
      take: 12
    });

    res.json({
      ok: true,
      registrations: registrations.map(item => ({
        id: item.id,
        crmStatus: item.crmStatus,
        isHot: item.isHot,
        assignedManagerId: item.assignedManagerId,
        assignedManager: item.assignedManager,
        nextContactAt: item.nextContactAt,
        roomEnteredAt: item.roomEnteredAt,
        telegramClickedAt: item.telegramClickedAt,
        questionCount: item._count.questions,
        partnerApplicationCount: item._count.partnerApplications,
        lead: {
          name: item.lead.name,
          phone: item.lead.phone,
          email: item.lead.email,
          professionalStatus: item.lead.professionalStatus,
          telegramChatId: item.lead.telegramChatId,
          telegramUsername: item.lead.telegramUsername,
          telegramFirstName: item.lead.telegramFirstName,
          telegramSubscribedAt: item.lead.telegramSubscribedAt
        },
        webinar: {
          scheduledAt: item.webinarSession.scheduledAt
        }
      }))
    });
  })
);

adminRouter.get(
  '/api/admin/registrations/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const registration = await prisma.registration.findUnique({
      where: { id },
      include: {
        lead: true,
        webinarSession: true,
        assignedManager: { select: { id: true, name: true, email: true, role: true } },
        questions: { orderBy: { createdAt: 'desc' } },
        partnerApplications: { orderBy: { createdAt: 'desc' } },
        events: { orderBy: { createdAt: 'desc' }, take: 100 }
      }
    });

    if (!registration) {
      throw new AppError(404, 'Registration not found');
    }

    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: 'registration', entityId: id },
      include: { adminUser: { select: { name: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30
    });

    res.json({ ok: true, registration, auditLogs });
  })
);

adminRouter.patch(
  '/api/admin/registrations/:id/status',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({ crmStatus: z.string() }).parse(req.body);

    if (!isCrmStatus(data.crmStatus)) {
      throw new AppError(400, 'Invalid CRM status');
    }

    const before = await prisma.registration.findUnique({ where: { id }, select: { crmStatus: true } });
    const registration = await prisma.registration.update({
      where: { id },
      data: { crmStatus: data.crmStatus }
    });

    await audit(req as AdminRequest, {
      action: 'registration.crm_status.update',
      entityType: 'registration',
      entityId: id,
      before,
      after: { crmStatus: registration.crmStatus }
    });

    res.json({ ok: true, registration });
  })
);

adminRouter.patch(
  '/api/admin/registrations/:id/hot',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({ isHot: z.boolean() }).parse(req.body);
    const before = await prisma.registration.findUnique({ where: { id }, select: { isHot: true } });
    const registration = await prisma.registration.update({
      where: { id },
      data: { isHot: data.isHot }
    });

    await audit(req as AdminRequest, {
      action: 'registration.hot.update',
      entityType: 'registration',
      entityId: id,
      before,
      after: { isHot: registration.isHot }
    });

    res.json({ ok: true, registration });
  })
);

adminRouter.patch(
  '/api/admin/registrations/:id/manager',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({
      assignedManagerId: z.string().optional().nullable(),
      nextContactAt: z.string().optional().nullable()
    }).parse(req.body);
    const before = await prisma.registration.findUnique({
      where: { id },
      select: { assignedManagerId: true, nextContactAt: true }
    });

    if (data.assignedManagerId) {
      const manager = await prisma.adminUser.findUnique({ where: { id: data.assignedManagerId } });
      if (!manager || !manager.isActive) {
        throw new AppError(400, 'Manager not found or inactive');
      }
    }

    const registration = await prisma.registration.update({
      where: { id },
      data: {
        assignedManagerId: data.assignedManagerId || null,
        nextContactAt: data.nextContactAt ? new Date(data.nextContactAt) : null
      }
    });

    await audit(req as AdminRequest, {
      action: 'registration.manager.update',
      entityType: 'registration',
      entityId: id,
      before,
      after: { assignedManagerId: registration.assignedManagerId, nextContactAt: registration.nextContactAt }
    });

    res.json({ ok: true, registration });
  })
);

adminRouter.post(
  '/api/admin/registrations/:id/telegram-reminder',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({ text: z.string().trim().max(1200).optional().or(z.literal('')) }).parse(req.body);
    const registration = await prisma.registration.findUnique({
      where: { id },
      include: { lead: true, webinarSession: true }
    });

    if (!registration) {
      throw new AppError(404, 'Registration not found');
    }

    if (!registration.lead.telegramChatId) {
      throw new AppError(400, 'У участника не подключен Telegram');
    }

    const accessToken = createAccessToken();
    await prisma.registrationToken.create({
      data: {
        registrationId: registration.id,
        tokenHash: hashToken(accessToken),
        purpose: 'admin_manual_telegram_reminder',
        expiresAt: getReplayExpiresAt(
          registration.webinarSession.scheduledAt,
          registration.webinarSession.durationMinutes,
          registration.webinarSession.replayAvailableHours
        )
      }
    });

    const roomUrl = new URL('/crisis_premium/webinar.html', env.PUBLIC_SITE_URL);
    roomUrl.searchParams.set('token', accessToken);
    const defaultText = [
      `${registration.lead.name}, напоминаем про вебинар АСПБ.`,
      '',
      `Начало: ${formatMoscowDate(registration.webinarSession.scheduledAt)} МСК`,
      '',
      `Ваша персональная комната: ${roomUrl.toString()}`
    ].join('\n');
    const text = data.text
      ? [data.text, '', `Ваша персональная комната: ${roomUrl.toString()}`].join('\n')
      : defaultText;

    await sendTelegramMessageToChat(registration.lead.telegramChatId, text);

    await prisma.event.create({
      data: {
        eventName: 'admin_manual_telegram_reminder',
        leadId: registration.leadId,
        registrationId: registration.id,
        webinarSessionId: registration.webinarSessionId,
        source: 'admin',
        page: 'admin'
      }
    });

    await audit(req as AdminRequest, {
      action: 'registration.telegram_reminder.send',
      entityType: 'registration',
      entityId: registration.id,
      after: { chatId: registration.lead.telegramChatId, textLength: text.length }
    });

    res.json({ ok: true, sent: true });
  })
);

adminRouter.patch(
  '/api/admin/registrations/:id/note',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({ managerNote: z.string().max(5000).optional().or(z.literal('')) }).parse(req.body);
    const before = await prisma.registration.findUnique({ where: { id }, select: { managerNote: true } });
    const registration = await prisma.registration.update({
      where: { id },
      data: { managerNote: data.managerNote || null }
    });

    await audit(req as AdminRequest, {
      action: 'registration.note.update',
      entityType: 'registration',
      entityId: id,
      before,
      after: { managerNote: registration.managerNote }
    });

    res.json({ ok: true, registration });
  })
);

adminRouter.get(
  '/api/admin/partner-applications',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const applications = await prisma.partnerApplication.findMany({
      include: {
        lead: true,
        registration: true,
        webinarSession: true
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });

    res.json({
      ok: true,
      applications: applications.map(application => ({
        id: application.id,
        registrationId: application.registrationId,
        sphere: application.sphere,
        city: application.city,
        clientFlow: application.clientFlow,
        experience: application.experience,
        comment: application.comment,
        preferredFormat: application.preferredFormat,
        status: application.status,
        createdAt: application.createdAt,
        lead: {
          name: application.lead.name,
          email: application.lead.email,
          phone: application.lead.phone
        },
        webinar: application.webinarSession
          ? {
              scheduledAt: application.webinarSession.scheduledAt
            }
          : null
      }))
    });
  })
);

adminRouter.post(
  '/api/admin/telegram/broadcast',
  requireAdmin,
  requireRole(['owner', 'admin']),
  asyncHandler(async (req, res) => {
    const data = z.object({ text: z.string().trim().min(3).max(2000) }).parse(req.body);
    const leads = await prisma.lead.findMany({
      where: {
        telegramChatId: { not: null }
      },
      select: {
        id: true,
        telegramChatId: true
      },
      take: 1000
    });

    const chatIds = Array.from(new Set(leads.map(lead => lead.telegramChatId).filter(Boolean))) as string[];
    let sent = 0;
    let failed = 0;

    for (const chatId of chatIds) {
      try {
        await sendTelegramMessageToChat(chatId, data.text);
        sent += 1;
      } catch (error) {
        failed += 1;
        console.error('[ASPБ telegram broadcast]', error);
      }
    }

    await prisma.event.create({
      data: {
        eventName: 'telegram_broadcast',
        source: 'admin',
        metadataJson: {
          total: chatIds.length,
          sent,
          failed,
          textLength: data.text.length
        }
      }
    });

    await audit(req as AdminRequest, {
      action: 'telegram.broadcast.send',
      entityType: 'telegram_broadcast',
      after: { total: chatIds.length, sent, failed, textLength: data.text.length }
    });

    res.json({ ok: true, total: chatIds.length, sent, failed });
  })
);

adminRouter.get(
  '/api/admin/questions',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const questions = await prisma.question.findMany({
      include: {
        lead: true,
        webinarSession: true
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });

    res.json({
      ok: true,
      questions: questions.map(question => ({
        id: question.id,
        text: question.text,
        isAnswered: question.isAnswered,
        adminNote: question.adminNote,
        createdAt: question.createdAt,
        lead: {
          name: question.lead.name,
          email: question.lead.email,
          phone: question.lead.phone
        },
        webinar: {
          scheduledAt: question.webinarSession.scheduledAt
        }
      }))
    });
  })
);

adminRouter.patch(
  '/api/admin/questions/:id',
  requireAdmin,
  requireRole(['owner', 'admin', 'manager']),
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const data = z.object({ isAnswered: z.boolean(), adminNote: z.string().optional() }).parse(req.body);
    const before = await prisma.question.findUnique({ where: { id }, select: { isAnswered: true, adminNote: true } });
    const question = await prisma.question.update({
      where: { id },
      data: {
        isAnswered: data.isAnswered,
        adminNote: data.adminNote
      }
    });

    await audit(req as AdminRequest, {
      action: 'question.update',
      entityType: 'question',
      entityId: id,
      before,
      after: { isAnswered: question.isAnswered, adminNote: question.adminNote }
    });

    res.json({ ok: true, question });
  })
);

adminRouter.get(
  '/api/admin/analytics/summary',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [pageViews, registrations, roomEntries, telegramClicks, telegramSubscribers, hotLeads, questions, partnerApplications] = await Promise.all([
      prisma.event.count({ where: { eventName: 'page_view' } }),
      prisma.registration.count(),
      prisma.registration.count({ where: { roomEnteredAt: { not: null } } }),
      prisma.registration.count({ where: { telegramClickedAt: { not: null } } }),
      prisma.lead.count({ where: { telegramChatId: { not: null } } }),
      prisma.registration.count({
        where: {
          OR: [
            { isHot: true },
            { partnerApplications: { some: {} } },
            { questions: { some: {} } },
            { roomEnteredAt: { not: null } }
          ]
        }
      }),
      prisma.question.count(),
      prisma.partnerApplication.count()
    ]);

    res.json({
      ok: true,
      summary: {
        pageViews,
        registrations,
        roomEntries,
        telegramClicks,
        telegramSubscribers,
        hotLeads,
        questions,
        partnerApplications,
        registrationRate: pageViews ? Number((registrations / pageViews).toFixed(3)) : 0
      }
    });
  })
);

adminRouter.get(
  '/api/admin/analytics/funnel',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        groupBy: z.enum(['source', 'utmSource', 'utmMedium', 'utmCampaign']).default('source')
      })
      .parse(req.query);
    const now = new Date();
    const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now;
    const dateRange = { gte: from, lte: to };
    const groupField = query.groupBy;
    const emptyGroup = () => ({
      visitors: 0,
      registrations: 0,
      telegramClicks: 0,
      telegramSubscribers: 0,
      roomEntries: 0,
      questions: 0,
      applications: 0,
      contracts: 0
    });
    const groups = new Map<string, ReturnType<typeof emptyGroup>>();
    const keyOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : 'direct/unknown');
    const groupFor = (value: unknown) => {
      const key = keyOf(value);
      if (!groups.has(key)) groups.set(key, emptyGroup());
      return groups.get(key)!;
    };

    const [visitorEvents, telegramClickEvents, registrations, telegramSubscribers, roomEntries, questions, applications, contracts] = await Promise.all([
      prisma.event.findMany({
        where: { eventName: 'page_view', createdAt: dateRange },
        select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true }
      }),
      prisma.event.findMany({
        where: { eventName: 'telegram_click', createdAt: dateRange },
        select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true }
      }),
      prisma.registration.findMany({
        where: { registeredAt: dateRange },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } }
      }),
      prisma.lead.findMany({
        where: { telegramSubscribedAt: dateRange },
        select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true }
      }),
      prisma.registration.findMany({
        where: { roomEnteredAt: dateRange },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } }
      }),
      prisma.question.findMany({
        where: { createdAt: dateRange },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } }
      }),
      prisma.partnerApplication.findMany({
        where: { createdAt: dateRange },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } }
      }),
      prisma.partnerApplication.findMany({
        where: {
          OR: [{ contractSignedAt: dateRange }, { status: { in: ['contract_signed', 'paid'] }, updatedAt: dateRange }]
        },
        include: { lead: { select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true } } }
      })
    ]);

    visitorEvents.forEach(item => { groupFor(item[groupField]).visitors += 1; });
    telegramClickEvents.forEach(item => { groupFor(item[groupField]).telegramClicks += 1; });
    registrations.forEach(item => { groupFor(item.lead[groupField]).registrations += 1; });
    telegramSubscribers.forEach(item => { groupFor(item[groupField]).telegramSubscribers += 1; });
    roomEntries.forEach(item => { groupFor(item.lead[groupField]).roomEntries += 1; });
    questions.forEach(item => { groupFor(item.lead[groupField]).questions += 1; });
    applications.forEach(item => { groupFor(item.lead[groupField]).applications += 1; });
    contracts.forEach(item => { groupFor(item.lead[groupField]).contracts += 1; });

    const summary = emptyGroup();
    for (const group of groups.values()) {
      summary.visitors += group.visitors;
      summary.registrations += group.registrations;
      summary.telegramClicks += group.telegramClicks;
      summary.telegramSubscribers += group.telegramSubscribers;
      summary.roomEntries += group.roomEntries;
      summary.questions += group.questions;
      summary.applications += group.applications;
      summary.contracts += group.contracts;
    }
    const rate = (part: number, total: number) => (total ? Number((part / total).toFixed(3)) : 0);
    const rows = [...groups.entries()]
      .map(([key, value]) => ({
        key,
        ...value,
        registrationRate: rate(value.registrations, value.visitors),
        telegramSubscribeRate: rate(value.telegramSubscribers, value.registrations),
        roomEntryRate: rate(value.roomEntries, value.registrations),
        applicationRate: rate(value.applications, value.registrations),
        contractRate: rate(value.contracts, value.applications)
      }))
      .sort((a, b) => b.applications - a.applications || b.registrations - a.registrations || b.visitors - a.visitors);

    res.json({
      ok: true,
      period: { from: from.toISOString(), to: to.toISOString() },
      groupBy: groupField,
      summary,
      rates: {
        registrationRate: rate(summary.registrations, summary.visitors),
        telegramClickRate: rate(summary.telegramClicks, summary.registrations),
        telegramSubscribeRate: rate(summary.telegramSubscribers, summary.registrations),
        roomEntryRate: rate(summary.roomEntries, summary.registrations),
        questionRate: rate(summary.questions, summary.roomEntries),
        applicationRate: rate(summary.applications, summary.registrations),
        contractRate: rate(summary.contracts, summary.applications)
      },
      groups: rows
    });
  })
);
