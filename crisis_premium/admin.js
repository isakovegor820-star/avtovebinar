let CRM_STATUSES = [];
// Объявлены явно: иначе fillManagerFilter() на старте читает activeManagers ДО loadManagers()
// → ReferenceError → инициализация падает, не навешиваются обработчики табов/фильтров.
let activeManagers = [];
let currentQueue = 'all';

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Admin UI element #${id} is missing`);
  return element;
}

const loginBtn = requiredElement('loginBtn');
const loginForm = requiredElement('loginForm');
const login = requiredElement('login');
const password = requiredElement('password');
const otp = requiredElement('otp');
const otpField = requiredElement('otpField');
const mfaSetup = requiredElement('mfaSetup');
const loginPanel = requiredElement('loginPanel');
const appPanel = requiredElement('appPanel');
const logoutBtn = requiredElement('logoutBtn');
const loginError = requiredElement('loginError');
const refreshBtn = requiredElement('refreshBtn');
const chatRefreshBtn = requiredElement('chatRefreshBtn');
const hotRefreshBtn = requiredElement('hotRefreshBtn');
const usersRefreshBtn = requiredElement('usersRefreshBtn');
const createUserBtn = requiredElement('createUserBtn');
const broadcastBtn = requiredElement('broadcastBtn');
const funnelRefreshBtn = requiredElement('funnelRefreshBtn');
const funnelFrom = requiredElement('funnelFrom');
const funnelTo = requiredElement('funnelTo');
const funnelAttribution = requiredElement('funnelAttribution');
const funnelMetrics = requiredElement('funnelMetrics');
const queueTabs = requiredElement('queueTabs');
const managerFilter = requiredElement('managerFilter');
const telegramFilter = requiredElement('telegramFilter');
const roomFilter = requiredElement('roomFilter');
const questionFilter = requiredElement('questionFilter');
const applicationFilter = requiredElement('applicationFilter');
const statusFilter = requiredElement('statusFilter');
const queryInput = requiredElement('queryInput');
const dateInput = requiredElement('dateInput');
const registrationsNode = requiredElement('registrationsNode');
const applicationsNode = requiredElement('applicationsNode');
const hotLeadsNode = requiredElement('hotLeadsNode');
const modChatNode = requiredElement('modChatNode');
const liveChatNode = requiredElement('liveChatNode');
const liveChatStatus = requiredElement('liveChatStatus');
const broadcastText = requiredElement('broadcastText');
const broadcastStatus = requiredElement('broadcastStatus');
const newUserRole = requiredElement('newUserRole');
const userAdminSection = requiredElement('userAdminSection');
const usersList = requiredElement('usersList');

    function showToast(message, isError) {
      var t = document.createElement('div');
      t.textContent = message;
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:12px;font-size:14px;z-index:10000;transition:opacity .3s;max-width:480px;text-align:center;' + (isError ? 'background:#dc2626;color:#fff' : 'background:#041627;color:#fff');
      document.body.appendChild(t);
      setTimeout(function() { t.style.opacity = '0'; setTimeout(function() { t.remove(); }, 300); }, 3000);
    }

    function readCookie(name) {
      const prefix = name + '=';
      const item = document.cookie
        .split(';')
        .map(value => value.trim())
        .find(value => value.startsWith(prefix));
      return item ? decodeURIComponent(item.slice(prefix.length)) : '';
    }

    function csrfHeaders() {
      const token = readCookie('aspb_csrf_token');
      return token ? { 'x-csrf-token': token } : {};
    }

    async function api(path, options) {
      const requestOptions = options || {};
      const response = await fetch(path, {
        ...requestOptions,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders(), ...(requestOptions.headers || {}) }
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

    async function loadCrmStatuses() {
      const data = await api('/api/admin/crm-statuses');
      CRM_STATUSES = data.statuses || [];
      fillStatusFilter();
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
                try {
                  await api('/api/admin/users/' + user.id, { method:'PATCH', body:JSON.stringify({ isActive:!user.isActive }) });
                  await loadUsers();
                } catch (err) { showToast(err.message || 'Не удалось изменить статус', true); }
              }}),
              node('button', { text:'Сохранить роль', onclick:async () => {
                try {
                  await api('/api/admin/users/' + user.id, { method:'PATCH', body:JSON.stringify({ role:roleSelect.value }) });
                  showToast('Роль сохранена');
                  await loadUsers();
                } catch (err) { showToast(err.message || 'Не удалось сохранить роль', true); }
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
        showToast('Заполните имя, email и пароль.', true);
        return;
      }

      try {
        await api('/api/admin/users', {
          method:'POST',
          body:JSON.stringify({ name, email, password, role:newUserRole.value || 'manager' })
        });
        showToast('Менеджер добавлен');
        document.getElementById('newUserName').value = '';
        document.getElementById('newUserEmail').value = '';
        document.getElementById('newUserPassword').value = '';
        await loadUsers();
      } catch (err) {
        // Частая причина — слабый пароль (нужно ≥12 символов, буквы и цифры) или дубликат email.
        showToast(err.message || 'Не удалось создать пользователя', true);
      }
    }

    async function loadSummary() {
      const data = await api('/api/admin/analytics/summary');
      const items = [
        ['Уникальные посетители', data.summary.uniqueVisitors],
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

    function fmtNum(value) {
      return Number(value || 0).toLocaleString('ru-RU');
    }

    async function loadFunnel() {
      const params = new URLSearchParams();
      if (funnelFrom.value) params.set('from', funnelFrom.value);
      if (funnelTo.value) params.set('to', funnelTo.value);
      params.set('attribution', funnelAttribution.value || 'firstTouch');
      const data = await api('/api/admin/analytics/funnel?' + params.toString());
      renderFunnelMetrics(data);
    }

    function flowStep(num, cap) {
      return node('div', { class:'fn-flow__step' }, [
        node('span', { class:'fn-flow__num', text:num }),
        node('span', { class:'fn-flow__cap', text:cap })
      ]);
    }

    // Этап воронки: счётчик + полоса, ширина которой = конверсия к СВОЕЙ базе.
    // База подписана явно («от регистраций» и т.д.) — раньше проценты считались от
    // разных знаменателей без подписи, из-за чего «6 / 0.1%» и «1 / 16.7%» путали.
    function stageNode(index, name, count, rate, baseLabel, baseCount) {
      const stage = node('div', { class:'fn-stage', 'data-zero': count ? null : '1' }, [
        node('div', { class:'fn-stage__top' }, [
          node('span', { class:'fn-stage__idx', text:String(index) }),
          node('span', { class:'fn-stage__name', text:name }),
          node('span', { class:'fn-stage__count', text:fmtNum(count) })
        ])
      ]);
      const fill = node('div', { class:'fn-stage__fill' });
      const widthPct = rate === null ? 100 : Math.max(0, Math.min(1, Number(rate) || 0)) * 100;
      fill.style.width = widthPct + '%';
      const track = node('div', { class:'fn-stage__track' }, [fill]);
      let conv;
      if (rate === null) {
        conv = node('span', { class:'fn-stage__conv', text:'вершина воронки' });
      } else if (!baseCount) {
        conv = node('span', { class:'fn-stage__conv', text:'нет базы' });
      } else {
        conv = node('span', { class:'fn-stage__conv' }, [
          node('b', { text:pct(rate) }),
          document.createTextNode(' от ' + baseLabel)
        ]);
      }
      stage.append(node('div', { class:'fn-stage__barrow' }, [track, conv]));
      return stage;
    }

    function tgChip(count, label, rate, base) {
      return node('div', { class:'fn-tg' }, [
        node('b', { text:fmtNum(count) }),
        node('span', { text:label }),
        node('em', { text:base ? pct(rate) : '—' })
      ]);
    }

    function renderFunnelMetrics(data) {
      const s = data.summary;
      const r = data.rates;
      clear(funnelMetrics);
      const root = node('div', { class:'fn' });

      const overall = s.visitors ? s.contracts / s.visitors : 0;
      root.append(node('p', {
        class:'sub',
        text:data.attribution === 'lastTouch'
          ? 'Модель атрибуции: последний источник перед первой регистрацией.'
          : 'Модель атрибуции: первый источник посетителя в выбранном периоде.'
      }));
      root.append(node('div', { class:'fn-hero' }, [
        node('div', { class:'fn-flow' }, [
          flowStep(fmtNum(s.visitors), 'Посетители'),
          node('span', { class:'fn-flow__arrow', text:'→' }),
          flowStep(fmtNum(s.registrations), 'Регистрации'),
          node('span', { class:'fn-flow__arrow', text:'→' }),
          flowStep(fmtNum(s.contracts), 'Договоры')
        ]),
        node('div', { class:'fn-hero__conv' }, [
          node('b', { text:pct(overall) }),
          node('span', { text:'посетитель → договор' })
        ])
      ]));

      root.append(node('div', { class:'fn-stages' }, [
        stageNode(1, 'Посетители', s.visitors, null, '', s.visitors),
        stageNode(2, 'Регистрации', s.registrations, r.registrationRate, 'посетителей', s.visitors),
        stageNode(3, 'Вход в комнату', s.roomEntries, r.roomEntryRate, 'регистраций', s.registrations),
        stageNode(4, 'Вопросы', s.questions, r.questionRate, 'регистраций', s.registrations),
        stageNode(5, 'Заявки', s.applications, r.applicationRate, 'регистраций', s.registrations),
        stageNode(6, 'Договоры', s.contracts, r.contractRate, 'заявок', s.applications)
      ]));

      root.append(node('div', { class:'fn-branch' }, [
        node('div', { class:'fn-branch__title' }, [
          document.createTextNode('Telegram '),
          node('span', { text:'— от регистраций' })
        ]),
        node('div', { class:'fn-branch__items' }, [
          tgChip(s.telegramClicks, 'клики', r.telegramClickRate, s.registrations),
          tgChip(s.telegramSubscribers, 'подписки', r.telegramSubscribeRate, s.registrations)
        ])
      ]));

      if (data.dataQuality?.warnings?.length) {
        root.append(node('p', {
          class:'sub',
          text:`Качество данных: ${data.dataQuality.warnings.join(' ')} Покрытие visitor ID — ${pct(data.dataQuality.visitorIdCoverage)}.`
        }));
      }

      funnelMetrics.append(root);
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
          node('th', { text:'Премьера записи' }),
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
          node('div', { class:'row' }, [node('span', { text:'Премьера записи' }), node('strong', { text:fmtDate(registration.webinarSession.scheduledAt) })]),
          node('div', { class:'row' }, [node('span', { text:'Комната' }), node('strong', { text:registration.roomEnteredAt ? fmtDate(registration.roomEnteredAt) : 'не заходил' })]),
          node('label', { class:'stack' }, [node('span', { text:'Ответственный менеджер' }), managerSelect]),
          node('label', { class:'stack' }, [node('span', { text:'Следующий контакт' }), nextContact]),
          node('button', { class:'secondary', text:'Сохранить менеджера/контакт', onclick:async () => {
            try {
              await api('/api/admin/registrations/' + id + '/manager', {
                method:'PATCH',
                body:JSON.stringify({ assignedManagerId:managerSelect.value || null, nextContactAt:nextContact.value ? new Date(nextContact.value).toISOString() : null })
              });
              showToast('Сохранено');
              await Promise.all([loadRegistrations(), loadHotLeads(), loadRegistrationCard(id)]);
            } catch (err) { showToast(err.message || 'Не удалось сохранить', true); }
          }}),
          node('div', { class:registration.lead.telegramChatId ? 'telegram-box connected' : 'telegram-box' }, [
            node('h3', { text:registration.lead.telegramChatId ? 'Telegram подключен' : 'Telegram не подключен' }),
            node('div', { class:'row' }, [node('span', { text:'Username' }), node('strong', { text:registration.lead.telegramUsername ? '@' + registration.lead.telegramUsername.replace(/^@/, '') : '—' })]),
            node('div', { class:'row' }, [node('span', { text:'Имя в Telegram' }), node('strong', { text:registration.lead.telegramFirstName || '—' })]),
            node('div', { class:'row' }, [node('span', { text:'Подключен' }), node('strong', { text:registration.lead.telegramSubscribedAt ? fmtDate(registration.lead.telegramSubscribedAt) : '—' })]),
            node('div', { class:'action-row' }, [
              tgUrl ? node('a', { href:tgUrl, target:'_blank', text:'Написать' }) : node('span', { class:'sub', text:'Нет username' }),
              node('button', { class:'ghost', text:'Отправить напоминание', onclick:async () => {
                try {
                  await api('/api/admin/registrations/' + id + '/telegram-reminder', { method:'POST', body:JSON.stringify({ text:manualReminderText }) });
                  showToast('Напоминание отправлено');
                } catch (err) { showToast(err.message || 'Не удалось отправить напоминание', true); }
              }}),
              node('button', { class:registration.isHot ? 'secondary' : '', text:registration.isHot ? 'Горячий' : 'Пометить горячим', onclick:async () => {
                try {
                  await api('/api/admin/registrations/' + id + '/hot', { method:'PATCH', body:JSON.stringify({ isHot:!registration.isHot }) });
                  await Promise.all([loadHotLeads(), loadRegistrations(), loadSummary(), loadRegistrationCard(id)]);
                } catch (err) { showToast(err.message || 'Не удалось обновить статус', true); }
              }})
            ])
          ]),
          node('label', { class:'stack' }, [node('span', { text:'CRM-статус' }), statusSelect]),
          node('button', { text:'Сохранить статус', onclick:async () => {
            try {
              await api('/api/admin/registrations/' + id + '/status', { method:'PATCH', body:JSON.stringify({ crmStatus: statusSelect.value }) });
              showToast('Статус сохранён');
              await Promise.all([loadRegistrations(), loadSummary(), loadRegistrationCard(id)]);
            } catch (err) { showToast(err.message || 'Не удалось сохранить статус', true); }
          }}),
          node('label', { class:'stack' }, [node('span', { text:'Заметка менеджера' }), note]),
          node('button', { class:'secondary', text:'Сохранить заметку', onclick:async () => {
            try {
              await api('/api/admin/registrations/' + id + '/note', { method:'PATCH', body:JSON.stringify({ managerNote: note.value }) });
              showToast('Заметка сохранена');
              await loadRegistrationCard(id);
            } catch (err) { showToast(err.message || 'Не удалось сохранить заметку', true); }
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

    // Левая панель: модераторский чат вопросов. На каждом сообщении 3 действия —
    // ответить (публикует ответ модератора в эфир), переслать (в Telegram менеджеру),
    // забанить/разбанить (блокирует участника в чате и скрывает его сообщения из эфира).
    async function loadQuestions() {
      const data = await api('/api/admin/questions');
      clear(modChatNode);
      if (!data.questions.length) {
        modChatNode.append(node('div', { class:'chat-empty', text:'Вопросов пока нет.' }));
        return;
      }
      data.questions.forEach(q => {
        const meta = node('div', { class:'meta' }, [ node('span', { text:fmtDate(q.createdAt) }) ]);
        if (q.isAnswered) meta.append(node('span', { class:'badge ans', text:'отвечено' }));
        if (q.forwardedAt) meta.append(node('span', { class:'badge fwd', text:'переслано' }));
        if (q.chatBanned) meta.append(node('span', { class:'badge ban', text:'забанен' }));

        const replyInput = node('textarea', { class:'mod-reply', placeholder:'Ответ модератора в чат…' });

        const replyBtn = node('button', { text:'Ответить', onclick:async () => {
          const text = replyInput.value.trim();
          if (text.length < 2) { showToast('Введите текст ответа', true); return; }
          replyBtn.disabled = true;
          try {
            await api('/api/admin/questions/' + q.id + '/reply', {
              method: 'POST',
              body: JSON.stringify({ text })
            });
            showToast('Ответ модератора опубликован в чате');
            replyInput.value = '';
            await Promise.allSettled([loadQuestions(), loadLiveMirror()]);
          } catch (err) {
            showToast(err.message || 'Не удалось отправить ответ', true);
          } finally {
            replyBtn.disabled = false;
          }
        }});

        const forwardBtn = node('button', { class:'secondary', text:q.forwardedAt ? 'Переслать снова' : 'Переслать', onclick:async () => {
          forwardBtn.disabled = true;
          try {
            const res = await api('/api/admin/questions/' + q.id + '/forward', { method:'POST', body:'{}' });
            showToast(res.telegramSent ? 'Вопрос переслан менеджеру в Telegram' : 'Вопрос отмечен пересланным (Telegram отключён)');
            await loadQuestions();
          } catch (err) {
            showToast(err.message || 'Не удалось переслать', true);
          } finally {
            forwardBtn.disabled = false;
          }
        }});

        const banBtn = node('button', { class:'ghost', text:q.chatBanned ? 'Разбанить' : 'Забанить', onclick:async () => {
          if (!q.chatBanned && !confirm('Забанить участника ' + q.lead.name + ' в чате? Его сообщения скроются из премьеры записи, новые он отправить не сможет.')) return;
          banBtn.disabled = true;
          try {
            await api('/api/admin/registrations/' + q.registrationId + '/chat-ban', {
              method: 'POST',
              body: JSON.stringify({ banned: !q.chatBanned })
            });
            showToast(q.chatBanned ? 'Участник разбанен' : 'Участник забанен в чате');
            await Promise.allSettled([loadQuestions(), loadLiveMirror()]);
          } catch (err) {
            showToast(err.message || 'Не удалось изменить бан', true);
          } finally {
            banBtn.disabled = false;
          }
        }});

        modChatNode.append(node('div', { class:'mod-msg' + (q.chatBanned ? ' banned' : '') }, [
          node('div', { class:'who' }, [
            document.createTextNode(q.lead.name + ' '),
            node('span', { text:q.lead.email })
          ]),
          meta,
          node('div', { class:'body', text:q.text }),
          replyInput,
          node('div', { class:'mod-actions' }, [ replyBtn, forwardBtn, banBtn ])
        ]));
      });
    }

    // Правая панель: read-only зеркало публичного чата эфира (как видит участник).
    async function loadLiveMirror() {
      let data;
      try {
        data = await api('/api/admin/webinar/chat/live');
      } catch (err) {
        clear(liveChatNode);
        liveChatNode.append(node('div', { class:'chat-empty', text:err.message || 'Не удалось загрузить премьеру записи.' }));
        return;
      }
      const statusLabel = data.webinarStatus === 'live' ? '· идёт премьера записи'
        : data.webinarStatus === 'finished' ? '· премьера завершена'
        : '· вне премьеры';
      if (liveChatStatus) liveChatStatus.textContent = statusLabel;

      const atBottom = liveChatNode.scrollHeight - liveChatNode.scrollTop - liveChatNode.clientHeight < 60;
      clear(liveChatNode);
      if (!data.messages.length) {
        liveChatNode.append(node('div', { class:'chat-empty', text:'Сообщений в чате премьеры пока нет.' }));
        return;
      }
      data.messages.forEach(m => {
        liveChatNode.append(node('div', { class:'live-msg ' + (m.kind || '') }, [
          node('span', { class:'who', text:(m.authorName || 'Участник') + ': ' }),
          node('span', { class:'body', text:m.message })
        ]));
      });
      // Автоскролл к низу, только если пользователь уже был внизу (не дёргаем при чтении истории).
      if (atBottom) liveChatNode.scrollTop = liveChatNode.scrollHeight;
    }

    async function sendBroadcast() {
      const text = broadcastText.value.trim();
      if (!text) {
        broadcastStatus.textContent = 'Введите текст новости.';
        return;
      }

      broadcastBtn.disabled = true;
      broadcastStatus.textContent = 'Проверяем согласия получателей...';
      try {
        const preview = await api('/api/admin/telegram/broadcast/preview', {
          method:'POST',
          body:JSON.stringify({ text })
        });
        if (!preview.enabled) {
          broadcastStatus.textContent = 'Ручная рекламная рассылка выключена feature flag.';
          return;
        }
        const confirmed = window.confirm(
          'Получателей: ' + preview.total + '. Канал: Telegram. Версия согласия: ' +
          preview.consentDocumentVersion + '. Поставить сообщение в очередь?'
        );
        if (!confirmed) {
          broadcastStatus.textContent = 'Отправка отменена после preview.';
          return;
        }
        const data = await api('/api/admin/telegram/broadcast', {
          method:'POST',
          body:JSON.stringify({
            text,
            confirmRecipientCount: preview.total,
            idempotencyKey: window.crypto.randomUUID()
          })
        });
        if (data.queued) {
          broadcastStatus.textContent = 'Рассылка поставлена в очередь: ' + data.total + ' получателей. Отправка идет в фоне.';
        } else {
          broadcastStatus.textContent = 'Получателей для рассылки нет.';
        }
        broadcastText.value = '';
        await loadBroadcastStatus();
        await loadSummary();
      } catch (error) {
        broadcastStatus.textContent = error.message || 'Не удалось отправить.';
      } finally {
        broadcastBtn.disabled = false;
      }
    }

    async function loadBroadcastStatus() {
      try {
        const data = await api('/api/admin/telegram/broadcast/current');
        if (!data.job) return;
        const job = data.job;
        if (job.status === 'pending' || job.status === 'sending' || job.status === 'failed') {
          broadcastStatus.textContent = 'Последняя рассылка: ' + job.status + ', отправлено ' + job.sent + ' из ' + job.total + '.';
        } else if (job.status === 'completed') {
          broadcastStatus.textContent = 'Последняя рассылка завершена: ' + job.sent + ' из ' + job.total + '.';
        }
      } catch (error) {
        console.warn('Не удалось загрузить статус Telegram-рассылки', error);
      }
    }

    async function loadAll() {
      // allSettled: сбой одного раздела (например, прав не хватает) не должен гасить
      // остальные. Справочники грузим первыми — от них зависят рендеры менеджеров/статусов.
      await Promise.allSettled([loadManagers(), loadCrmStatuses()]);
      const sections = [
        ['сводка', loadSummary], ['воронка', loadFunnel], ['горячие лиды', loadHotLeads],
        ['регистрации', loadRegistrations], ['заявки', loadApplications], ['вопросы', loadQuestions],
        ['премьера записи', loadLiveMirror],
        ['пользователи', loadUsers], ['статус рассылки', loadBroadcastStatus],
      ];
      const results = await Promise.allSettled(sections.map(([, fn]) => fn()));
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? sections[i][0] : null))
        .filter(Boolean);
      if (failed.length) {
        showToast('Не загрузились разделы: ' + failed.join(', '), true);
      }
    }

    loginForm.addEventListener('submit', async event => {
      event.preventDefault();
      loginError.textContent = '';
      loginBtn.disabled = true;
      loginBtn.textContent = 'Проверяем...';
      try {
        const result = await api('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ login: login.value, password: password.value, otp: otp.value.trim() || undefined })
        });
        if (result.mfaSetupRequired) {
          otpField.classList.remove('hidden');
          otp.required = true;
          mfaSetup.classList.remove('hidden');
          mfaSetup.textContent = 'Добавьте в приложение-аутентификатор ключ: ' + result.secret +
            '. Затем введите текущий 6-значный код. Ключ больше не будет показан после входа.';
          loginError.textContent = 'Для всех администраторов требуется MFA.';
          otp.focus();
          return;
        }
        if (result.mfaRequired) {
          otpField.classList.remove('hidden');
          otp.required = true;
          loginError.textContent = 'Введите 6-значный код из приложения-аутентификатора.';
          otp.focus();
          return;
        }
        if (!result.authenticated) {
          loginError.textContent = 'Вход не завершён.';
          return;
        }
        loginPanel.classList.add('hidden');
        appPanel.classList.remove('hidden');
        logoutBtn.classList.remove('hidden');
        startLiveMirrorPoll();
        await loadAll();
      } catch (error) {
        loginError.textContent = error.message;
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = otpField.classList.contains('hidden') ? 'Войти' : 'Подтвердить вход';
      }
    });
    loginBtn.type = 'submit';
    loginForm.removeAttribute('inert');
    loginForm.removeAttribute('aria-busy');

    logoutBtn.addEventListener('click', async () => {
      await api('/api/admin/logout', { method: 'POST', body: '{}' });
      location.reload();
    });

    refreshBtn.addEventListener('click', loadAll);
    chatRefreshBtn.addEventListener('click', () => Promise.allSettled([loadQuestions(), loadLiveMirror()]));
    // Авто-обновление правой панели (эфир), как у участника. Только когда админка видна.
    let liveMirrorTimer = null;
    function startLiveMirrorPoll() {
      if (liveMirrorTimer) return;
      liveMirrorTimer = setInterval(() => {
        if (!appPanel.classList.contains('hidden')) loadLiveMirror().catch(() => {});
      }, 5000);
    }
    hotRefreshBtn.addEventListener('click', loadHotLeads);
    usersRefreshBtn.addEventListener('click', loadUsers);
    createUserBtn.addEventListener('click', createUser);
    broadcastBtn.addEventListener('click', sendBroadcast);
    funnelRefreshBtn.addEventListener('click', loadFunnel);
    [funnelFrom, funnelTo, funnelAttribution].forEach(input => input.addEventListener('change', loadFunnel));
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

    // Авторизационный гейт: loadAll() теперь устойчив (allSettled) и не реджектит при сбоях
    // разделов, поэтому решение «показать панель или форму логина» принимаем по /api/admin/me.
    api('/api/admin/me')
      .then(() => {
        loginPanel.classList.add('hidden');
        appPanel.classList.remove('hidden');
        logoutBtn.classList.remove('hidden');
        startLiveMirrorPoll();
        const registrationFromUrl = new URLSearchParams(location.search).get('registration');
        return loadAll().then(() => {
          if (registrationFromUrl) loadRegistrationCard(registrationFromUrl).catch(() => {});
        });
      })
      .catch(() => {
        // Не авторизованы — остаёмся на форме логина.
      });
