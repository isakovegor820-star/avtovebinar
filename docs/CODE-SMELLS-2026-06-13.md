# CODE SMELL АУДИТ: АСПБ Автовезбинар

**Дата**: 2026-06-13
**Что ищем**: Проблемы, которые НЕ ломают работоспособность, но усложняют поддержку.

---

## ИТОГО: 65 code smells

| Категория | Backend | Frontend | Всего |
|-----------|:---:|:---:|:---:|
| Дублирование | 13 | 10 | **23** |
| Магические числа | 11 | 6 | **17** |
| Мёртвый код | 5 | 5 | **10** |
| Избыточная сложность | 4 | 5 | **9** |
| Несогласованный стиль | 6 | 12 | **18** |

---

## 📋 1. ДУБЛИРОВАНИЕ (23 шт.)

### Backend

| # | Файлы | Что дублируется |
|---|-------|-----------------|
| D-01 | `reminders.ts:74-88` + `email.ts:62-76` | `moscowDateKey()` и `addDaysKey()` — посимвольно идентичны |
| D-02 | `reminders.ts:112-127` + `telegramParticipantBot.ts:154-169` | `buildSegmentTip()` — одна структура, разный текст |
| D-03 | `telegram.ts:189-311` | Три функции `sendTelegramMessage*` — 75 строк copy-paste HTTP boilerplate |
| D-04 | `telegramParticipantBot.ts` + `telegramAdminBot.ts` | Polling loop (~60 строк): `pollOnce()`, `start()`, `stop()` — идентичны |
| D-05 | `helpers.ts:102-150` | `findRegistrationByToken` и `findRegistrationBySessionToken` — 90% общего кода |
| D-06 | `admin.ts:636-658` vs `691-707` | Маппинг registration → response в двух endpoint'ах |
| D-07 | `registration.ts:562-571` vs `658-667` | `liveState` объект строится дважды |
| D-08 | `registration.ts:589-602` vs `677-686` | `webinar` блок в JSON response — почти идентичен |
| D-09 | `reminders.ts:24-28` vs `46-52` | Два маппинга reminder kinds → поля БД (email + telegram) |
| D-10 | `webinarSessions.ts:20-29` vs `32-42` | `create` и `update` в upsert — 10 одинаковых полей |
| D-11 | `tokens.ts:39` vs `admin.ts:362` | `24 * 60 * 60 * 1000` (session TTL) в двух файлах |
| D-12 | `telegramParticipantBot.ts:486` + `telegramAdminBot.ts:161` + `telegramConsultantBot.ts:249` | Polling interval `3500` в трёх файлах |
| D-13 | `email.ts:78-97` vs `reminders.ts:90-110` | `formatRelativeScheduled` / `formatWebinarRelativeDate` — одна логика, разные имена |

### Frontend

| # | Файлы | Что дублируется |
|---|-------|-----------------|
| D-14 | `room.js:11-16` + `recordings.js:35-39` | `escapeHtml()` + `htmlEscapeNode` |
| D-15 | `access.js:30-33` + `recordings.js:30-33` | `setText(id, value)` |
| D-16 | `room.js:270-272` + `recordings.js:92-94` | `isAccessError()` — `[401, 403, 404]` |
| D-17 | `video.js:44-58` + `recordings.js:14-28` | `loadHlsScript()` — ~15 строк copy-paste |
| D-18 | `admin.js:11-23` + `utils.js:9-33` | `readCookie()` + `csrfHeaders()` |
| D-19 | `state.js:6-7` + `live-chat.js:6` | API base URL — посимвольно |
| D-20 | `video.js:283-288` | Badge rendering: `isTestMode` и `isLive` — посимвольно идентичные ветки |
| D-21 | `video.js:410-462` | `classList.add('hidden')` повторяется в двух ветках `isLiveVisual` / `else` |
| D-22 | `live-chat.js:64-67` | `authorLabel`: `agent_question` и default branches идентичны |
| D-23 | `success.js:61-63` + `room.js:97` | Мёртвые тернарники с идентичными ветками |

---

## 🔢 2. МАГИЧЕСКИЕ ЧИСЛА (17 шт.)

### Backend

| # | Файл:строка | Число | Что значит |
|---|-------------|-------|-----------|
| M-01 | `admin.ts:362` | `24 * 60 * 60 * 1000` | Admin session TTL (24h) |
| M-02 | `admin.ts:633,973,1072` | `take: 200` | Page size (3 места) |
| M-03 | `admin.ts:1182,1355,1408` | `30 * 24 * 60 * 60 * 1000` | Default analytics range (30 days) |
| M-04 | `app.ts:125-201` | `limit: 20, 6, 5, 90, 120, 10, 3` | Rate limiter thresholds (7 штук без комментариев) |
| M-05 | `telegram.ts:190,238,276` | `.slice(0, 3900)` | Telegram message limit (3 места) |
| M-06 | `reminders.ts:328` | `4815162342` | Advisory lock key (без комментария) |
| M-07 | `webinarSessions.ts:25,38` | `roomOpenBeforeMinutes: 15` | Room opens 15 min before |
| M-08 | `env.ts:62` | `3860` | Default video duration (~64 min) |
| M-09 | `registration.ts:65` | `20 * 60 * 1000` | Login token TTL (20 min) |
| M-10 | `registration.ts:634` | `24 * 60 * 60 * 1000` | Telegram token fallback (24h) |
| M-11 | `telegramParticipantBot.ts:486` | `3500` | Polling interval (ms) |

### Frontend

| # | Файл:строка | Число | Что значит |
|---|-------------|-------|-----------|
| M-12 | `video.js:244` | `568` | Default video duration |
| M-13 | `video.js:826` | `5000`, `3000` | Control hide delays (touch / desktop) |
| M-14 | `recordings.js:54` | `604800000` | 7-day "new" threshold |
| M-15 | `live-chat.js:19` | `['#1e40af', '#7c3aed', ...]` | Avatar colors (вне design system) |
| M-16 | `live-chat.js:206-207` | `4000`, `15000` | Chat poll interval bounds |
| M-17 | `analytics.js:18-64` | `8, 45, 105, 165...` | Insight timestamps (секунды) |

---

## 💀 3. МЁРТВЫЙ КОД (10 шт.)

| # | Файл:строка | Что мёртвого |
|---|-------------|-------------|
| DC-01 | `admin.ts:90-97` | Unreachable else branch в `requireAdmin()` |
| DC-02 | `helpers.ts:102-125` | `findRegistrationByToken()` — exported, но не вызывается (используется только для typeof) |
| DC-03 | `tokens.ts:74-76` | `verifyAdminSession()` — exported, не импортируется нигде |
| DC-04 | `reminders.ts:298-306` | `runTelegramFollowupJobOnce()` и `runReplayFollowupJobOnce()` — no-op stubs |
| DC-05 | `email.ts:214-218` | `sendReplayEmail()` — no-op stub, `{ sent: false, mode: 'disabled' }` |
| DC-06 | `video.js:169` | `activeEvent.type === 'final'` branch — уже отфильтрован guard'ом выше |
| DC-07 | `video.js:688-694` | `isLiveVisual ? togglePlayState() : togglePlayState()` — идентичные ветки |
| DC-08 | `success.js:61-63` | Тернарник с идентичными ветками (dateLabel) |
| DC-09 | `room.js:97` | `dayText = day === X || day === Y ? day : day` — no-op |
| DC-10 | `webinar.html:103-105` | Пустой `<nav>` с комментарием "удалено" |

---

## 🏗 4. ИЗБЫТОЧНАЯ СЛОЖНОСТЬ (9 шт.)

| # | Файл:строка | Суть |
|---|-------------|------|
| CX-01 | `admin.ts:571-591` | 6 уровней вложенных тернарников для `queueWhere` |
| CX-02 | `admin.ts:1168-1337` | Funnel analytics = 170 строк inline в route handler |
| CX-03 | `helpers.ts:36-45` | Re-export pass-through: символы из `roomLinks.ts` прокидываются через `helpers.ts` |
| CX-04 | `env.ts:207-249` | Test defaults вбиты в production env module |
| CX-05 | `state.js:33-37` | Module-level side effect: импорт `state.js` молча чистит localStorage |
| CX-06 | `analytics.js:16-65` | Контент вебинара (тексты, иконки, таймкоды) живёт в файле `analytics.js` |
| CX-07 | `registration.js:75-89` | 4 однострочных wrapper-функции (`getParticipantAccess`, `requestParticipantLogin` и т.д.) |
| CX-08 | `email.ts:199-203` | `labelByKind` Record — все 3 ключа маппятся в одну и ту же строку |
| CX-09 | `video.js` + `questions.js` + `room.js` + `live-chat.js` | 4+ модуля пишут в один DOM-элемент `chatActivity` без координации |

---

## 🎨 5. НЕСОГЛАСОВАННЫЙ СТИЛЬ (18 шт.)

| # | Файл:строка | Что не так |
|---|-------------|-----------|
| ST-01 | `live-chat.js` (весь файл) | `var` + `function()` vs `const`/`let` + arrow functions везде |
| ST-02 | `admin.js` (весь файл) | Без модулей, implicit globals от element IDs, phantom 4-space indent |
| ST-03 | `admin.html:190` | `<script src="admin.js">` без `defer`/`type="module"` |
| ST-04 | `main.js` + все imports | Cache-buster `?v=` строки: 6 разных версий, часть imports без версий |
| ST-05 | `roomLinks.ts:8` | `ROOM_EXCHANGE_TOKEN_PURPOSE = 'registration'` — имя и значение не совпадают |
| ST-06 | `logger.ts:5` | `(pino as unknown as typeof pino.default)` — double cast для ESM/CJS |
| ST-07 | `telegram.ts:219,255,293` | Deprecated `disable_web_page_preview` вместо `link_preview_options` |
| ST-08 | `telegramNews.ts:399-400` | `let` declarations после функций, которые их используют |
| ST-09 | `schema.prisma` (12+ полей) | `String` вместо `enum` для status/role/purpose — нет документации валидных значений |
| ST-10 | `schema.prisma:89` | `@default(568)` vs runtime default `3860` — schema default никогда не используется |
| ST-11 | `index.html:1039,1043` | Два разных `main.js` в одном HTML (`js/main.js` + корневой `main.js`) |
| ST-12 | `room.js:287-316` | Inline CSS через `style.cssText` + `innerHTML` vs Tailwind везде |
| ST-13 | `register.html:74,78` | `data-icon` атрибуты — декоративные, никто не читает |
| ST-14 | `success.html:238-243` | Захардкожены "2 часа" и "Online" рядом с динамическими данными |
| ST-15 | `webinar.html:128-129` | Два одинаковых `<!-- Autowebinar Player -->` комментария |
| ST-16 | `utils.js:71-76` | `formatTimelineTime` — misleading name (форматирует duration, не timeline position) |
| ST-17 | `registration.js:231` | `window.ASPBRegisterSubmit` — global hook, не вызывается нигде в HTML |
| ST-18 | `state.js:19-25,33-37` | `clearAccessToken()` + module-level side effect делают одно и то же |

---

## 🏆 ТОП-3 РЕФАКТОРИНГА С НАИБОЛЬШИМ ЭФФЕКТОМ

### 1. Общий модуль дат и Telegram-утилит
**Убирает**: D-01, D-02, D-03, D-04, D-12, D-13, M-05, M-11, ST-07
**Создать**: `src/lib/dateFormat.ts` (Moscow timezone), `src/lib/telegramSender.ts` (generic sender + polling factory)
**Экономия**: ~250 строк дублирования

### 2. Общие frontend-утилиты
**Убирает**: D-14, D-15, D-16, D-17, D-18, D-19
**Перенести в `utils.js`**: `escapeHtml`, `setText`, `isAccessError`, `loadHlsScript`, `readCookie`, API base URL
**Экономия**: ~80 строк + single source of truth

### 3. Named constants
**Убирает**: M-01 через M-17 (все 17 магических чисел)
**Создать**: `src/lib/constants.ts` (session TTL, page sizes, rate limits, polling intervals)
**Экономия**: самодокументирующийся код + одна точка изменения
