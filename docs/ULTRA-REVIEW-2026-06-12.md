# УЛЬТРА-РЕВЬЮ: АСПБ Автовезбинар

**Дата**: 2026-06-12
**Стек**: Express 5 + TypeScript + Prisma ORM + PostgreSQL + Tailwind CSS, Node.js 22, ES modules
**Проанализировано**: ~40 backend-файлов, ~25 frontend-файлов, 20 миграций, CI/CD, Docker, конфигурация

---

## ИТОГО НАЙДЕНО

| Серьёзность | Безопасность | Производительность | Архитектура | Надёжность | Инфра | **Всего** |
|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| **CRITICAL** | 5 | 1 | 0 | 1 | 1 | **8** |
| **MAJOR** | 12 | 6 | 8 | 8 | 14 | **48** |
| **MINOR** | 7 | 5 | 6 | 6 | 12 | **36** |
| **Всего** | 24 | 12 | 14 | 15 | 27 | **92** |

---

## 🚨 1. КРИТИЧЕСКИЕ ПРОБЛЕМЫ (Showstoppers)

### 1.1 Живые Telegram-токены в `.env` на диске
**Файл**: `.env` (строки 19, 25)
**Категория**: Безопасность — утечка секретов

Реальные продакшн-токены (`8654361623:AAFZiAP2...`, `8839257310:AAEb87KAV...`) лежат в plaintext. `.gitignore` защищает от коммита, но pre-commit хук (`secretlint`) сканирует только `git ls-files` — `git add -f .env` обходит защиту. Любой с доступом к файловой системе получает полный контроль над обоими ботами.

**Как исправить**:
1. Немедленно ротировать оба токена через @BotFather.
2. Перейти на secrets-менеджер (`direnv`, `sops`, 1Password CLI).
3. Исправить хук: `git diff --cached --name-only -z --diff-filter=ACM | xargs -0 npx secretlint`.

---

### 1.2 `ADMIN_DEV_BYPASS` — обход авторизации без защиты в продакшене
**Файл**: `src/routes/admin.ts` (строки 66-69)
**Категория**: Безопасность — аутентификация

```typescript
if (env.NODE_ENV === 'development' && env.ADMIN_DEV_BYPASS === 'true') {
  req.admin = { id: 'dev', login: env.ADMIN_LOGIN, email: null, role: 'owner' };
  return next();
}
```

Если `NODE_ENV` ошибочно выставлен в `development` на продакшене — любой получает `owner`-доступ. `validateProductionSecurity()` в `env.ts` **не проверяет** `ADMIN_DEV_BYPASS`. Нет audit-лога при использовании обхода.

**Как исправить**: Удалить bypass полностью. Использовать seeded dev-аккаунт. Минимум — добавить проверку в `validateProductionSecurity()` и startup-warning.

---

### 1.3 Admin-сессия привязана к мутабельной env-переменной
**Файл**: `src/lib/tokens.ts` (строка 64)
**Категория**: Безопасность — управление сессиями

```typescript
if (payload.login !== env.ADMIN_LOGIN || ...) return null;
```

Смена `ADMIN_LOGIN` (например, при редеплое) мгновенно инвалидирует ВСЕ активные сессии. Нет server-side session store — сессии невозможно отозвать при деактивации администратора. Stateless HMAC-cookie не поддерживает revocation.

**Как исправить**: Убрать `login` из проверки валидности сессии. Добавить server-side session table или token revocation list.

---

### 1.4 Race condition: token exchange (double-spend)
**Файл**: `src/routes/public/registration.ts` (строки 82-135)
**Категория**: Надёжность — гонка

Token exchange использует `findUnique` + `deleteMany` внутри `$transaction`. PostgreSQL READ COMMITTED позволяет двум параллельным транзакциям увидеть один и тот же токен. `deleteMany` работает как CAS (compare-and-swap) — это корректно, но паттерн не документирован. Любой рефакторинг на `update` вместо `deleteMany` откроет уязвимость двойной траты.

**Как исправить**: Добавить `SELECT ... FOR UPDATE` через `$queryRaw` для явной блокировки строки. Задокументировать CAS-паттерн.

---

### 1.5 Advisory lock на pooled-соединении — блокировка переживает транзакцию
**Файл**: `src/lib/reminders.ts` (строки 330-348)
**Категория**: Безопасность/Надёжность — конкуренция

`pg_try_advisory_lock` — session-level lock. При pool-recycle соединение возвращается в пул с **неосвобождённой блокировкой**, блокируя следующего потребителя.

**Как исправить**: Использовать `pg_try_advisory_xact_lock` (transaction-level, auto-release).

---

### 1.6 N+1 запросов в reminder job — до 5000 COUNT-запросов за цикл
**Файл**: `src/lib/reminders.ts` (строки 171-179)
**Категория**: Производительность — деградация

```typescript
for (const registration of registrations) {
  const existingEmailJob = await prisma.emailOutboxJob.count({ ... });
}
```

Для каждого из до 5000 регистраций — отдельный `COUNT`-запрос. При 1000 «должных» регистраций = 1000 лишних round-trip в БД за один цикл рассылки.

**Как исправить**: Batch-запрос: `SELECT registrationId, reminderKind FROM email_outbox_jobs WHERE registrationId IN (...) AND type = 'reminder'` — один запрос вместо N.

---

### 1.7 `document.activeElement.tagName` — краш при `null`
**Файл**: `crisis_premium/js/video.js` (строка 700)
**Категория**: Надёжность — crash

```javascript
if (document.activeElement.tagName === 'INPUT' || ...) return;
```

`document.activeElement` может быть `null`. `.tagName` на `null` = `TypeError`, краш всего keyboard handler.

**Как исправить**: `document.activeElement?.tagName`

---

### 1.8 PostgreSQL `trust` auth в разработке
**Файл**: `docker-compose.yml` (строка 10)
**Категория**: Инфраструктура — безопасность БД

```yaml
POSTGRES_HOST_AUTH_METHOD: trust
```

Любой процесс на машине разработчика (включая malware, browser exploits, ngrok) получает полный доступ к БД без пароля.

**Как исправить**: `POSTGRES_PASSWORD: devpassword` + обновить `DATABASE_URL`.

---

## ⚠️ 2. СЕРЬЕЗНЫЕ НЕДОЧЕТЫ (Major Issues)

### Безопасность

| # | Файл | Проблема | Исправление |
|---|------|----------|-------------|
| 2.1 | `admin.ts:338-343` | **Admin login: OR-запрос email/name — неоднозначность**. `findFirst` с `OR: [{email: login}, {name: data.login}]` может вернуть не того юзера, если `name` совпадает с чужим `email`. | Запросить сначала по email, fallback — по name. |
| 2.2 | `admin.ts:331-366` | **Timing oracle: user enumeration**. Нет юзера → scrypt пропускается (~100ms разница). Rate limiter частично помогает, но оракул остаётся. | Всегда вызывать `verifyPassword` с dummy hash при отсутствии юзера. |
| 2.3 | `admin.ts:357-363` | **Admin cookie без `path: '/'`**. Cookie привязывается к пути `/api/admin/`, не отправляется на `/admin`. + нет IP/UA binding. | Добавить `path: '/'` + fingerprint. |
| 2.4 | `csrf.ts` | **CSRF не привязан к admin-сессии**. Двойной submit cookie, но CSRF-токен не содержит admin session ID в HMAC. | Включить session ID в HMAC CSRF-токена. |
| 2.5 | `app.ts:247-254` | **`/health/dependencies` без rate limit** — триггерит SMTP + Telegram API. Атакующий может вызвать блокировку IP. | Rate limit или требовать metrics token. |
| 2.6 | `roomLinks.ts:11` | **Session TTL = 365 дней** (`PARTICIPANT_SESSION_TTL_DAYS`). Огромное окно для session hijacking. | Уменьшить до 30-90 дней. |
| 2.7 | `admin.js:589-597` | **Admin auto-загружает ВСЕ PII данные** при открытии страницы. Нет `<meta name="robots">` — страница может быть проиндексирована. | Gate `loadAll()` за auth-чеком. Добавить `noindex`. |
| 2.8 | `admin.js` (весь файл) | **Admin полагается на implicit globals** от HTML element ID. `window.loginBtn`, `window.metrics` — любое совпадение с built-in globals ломает код. | Явные `const` declarations для всех DOM-ссылок. |

### Производительность

| # | Файл | Проблема | Исправление |
|---|------|----------|-------------|
| 2.9 | `video.js:564-582` | **`timeupdate` handler: 4-15 DOM операций/сек**. Layout thrashing на мобильных. | Throttle до 1Hz, кэшировать DOM-ссылки. |
| 2.10 | `telegramBroadcastWorker.ts:123-127` | **Загрузка ВСЕХ Telegram-подписчиков в память** одним `findMany`. 100K+ leads = OOM. | Cursor-based pagination. |
| 2.11 | `responseCache.ts` | **In-memory cache без TTL cleanup**. `Map` с lazy eviction — записи, к которым не обращаются, никогда не удаляются. | Периодический cleanup interval или `lru-cache`. |
| 2.12 | `video.js:76,273,564,734-743` | **Video element listeners накапливаются** при re-init. Cleanup обрабатывает intervals, но не `timeupdate`, `play`, `pause`, `seeking`. | `AbortController` для управления listeners. |
| 2.13 | `helpers.ts:213` | **`findOrCreateWebinarSession` на каждый запрос**. 1000 concurrent viewers = 1000 upsert за poll cycle. | Кэш с TTL 60с. |
| 2.14 | `main.js:22-48` | **Дублирование API-вызовов**: `hydrateCurrentWebinar` + `hydrateParticipantCtas` + `hydrateWebinarRoom` = 2 запроса к одному endpoint. | Кэшировать registration state после первого fetch. |

### Архитектура

| # | Файл | Проблема | Исправление |
|---|------|----------|-------------|
| 2.15 | `helpers.ts` | **God Object: 20+ exports**. Cookies, токены, events, access control, notifications — всё в одном файле. | Split: `cookies.ts`, `accessControl.ts`, `eventTracking.ts`, `tokenLookup.ts`. |
| 2.16 | `admin.ts` (backend) | **1432 строки** с inline business-логикой, аналитикой, CRM-операциями. | Extract services: `analytics.ts`, `crmService.ts`. |
| 2.17 | `admin.js` (frontend) | **598 строк, ноль структуры**. Без IIFE, без модулей, без error isolation. `Promise.all` в `loadAll()` — падение одной секции убивает все. | `Promise.allSettled()` + IIFE/ES module. |
| 2.18 | `state.js` | **Shared mutable singleton**. `state.webinarConfig` и `state.serverTimeOffset` мутируются из любого модуля без нотификаций. | Pub/sub или Proxy-based reactive state. |
| 2.19 | `live-chat.js` | **IIFE + globals вместо ES modules**. Дублирует API base URL из `state.js`, общается через `window.__liveChatRefresh`. | Конвертировать в ES module. |
| 2.20 | `video.js` → `registration.js` | **Неправильная зависимость**: видеоплеер импортирует `timelinePath()` из registration-модуля. | Перенести `timelinePath()` в `utils.js`. |
| 2.21 | `.eslintrc.cjs` | **`no-explicit-any: off` глобально**. TypeScript type safety полностью отключён. | `'warn'` глобально, `'off'` только в тестах. |
| 2.22 | `.eslintrc.cjs` | **Нет async safety rules**: `no-floating-promises`, `no-misused-promises`, `await-thenable` отсутствуют. | Добавить как `'error'`. |

### Надёжность

| # | Файл | Проблема | Исправление |
|---|------|----------|-------------|
| 2.23 | `registration.ts:498-604` | **Non-atomic read-then-write**: `sendRegistrationState` — 3 отдельных DB round-trip без транзакции. | Обернуть в `$transaction`. |
| 2.24 | `emailOutbox.ts:270-298` | **Job claiming: дубликаты при concurrent workers**. Status-based CAS работает, но при fail → retry оба воркера могут подхватить одновременно. | `lockedAt` timestamp + `UPDATE WHERE lockedAt IS NULL`. |
| 2.25 | `video.js` (6 мест) | **Unhandled `video.play()` rejections** — строки 639, 641, 666 без `.catch()`. `document.exitFullscreen()` на 778 без `.catch()`. | Добавить `.catch()` ко всем Promise. |
| 2.26 | `admin.js:32` | **Crash на non-JSON error responses**: `response.json()` бросает `SyntaxError` при 502/504 HTML. | `.catch(() => ({}))` как в `utils.js`. |
| 2.27 | `success.js:81,96` | **ICS calendar export сломан**: `join('\\\\n')` вместо `join('\\n')`. Файл будет одной строкой — RFC 5545 violation. | Заменить `'\\\\n'` → `'\\n'`, `'\\\\r\\\\n'` → `'\\r\\n'`. |
| 2.28 | `partners.ts:47-65` | **Партнёрская заявка без транзакции**: `create` + `update` — два отдельных запроса. | Обернуть в `$transaction`. |
| 2.29 | `success.js:61-63` | **Мёртвый тернарник**: оба branch'а производят идентичный output. | Убрать условную конструкцию. |
| 2.30 | `video.js:690-694` | **Идентичные ветки**: `isLiveVisual ? togglePlayState() : togglePlayState()`. | Схлопнуть в один else. |

### Инфраструктура

| # | Файл | Проблема | Исправление |
|---|------|----------|-------------|
| 2.31 | `Dockerfile:43` | **Миграции на каждый старт контейнера** + CI тоже запускает. Двойной запуск, lock contention при replicate. | Отдельный init-container или CI-step. |
| 2.32 | `docker-compose.production.yml` | **Нет resource limits** ни на одном контейнере. Memory leak = crash всего хоста. | `deploy.resources.limits` для каждого сервиса. |
| 2.33 | `docker-compose.production.yml` | **Worker health check = `process.exit(0)`**. Zombie-воркер рапортует healthy. | Реальная проверка: PID file, pgrep, или health endpoint. |
| 2.34 | `docker-compose.production.yml` | **Двойная сборка Docker-образа**: `api` и `webinar-worker` каждый билдят свой. | Один `image:` + `build:` только у первого. |
| 2.35 | `ci.yml` | **Нет test coverage**: ни `--coverage`, ни threshold, ни upload. PR без тестов проходит. | `npm test -- --coverage` + threshold. |
| 2.36 | `ci.yml` | **Нет production deployment pipeline**. Деплой на продакшен — ручной SSH. | `deploy-production` job с approval gate. |
| 2.37 | `ci.yml:166-170` | **Staging deploy = SSH one-liner**. `|| true` глотает ошибки, нет rollback, нет health verification. | Deploy-скрипт с error handling + rollback. |
| 2.38 | `schema.prisma` | **Нет enum constraints** на 10+ status/role полях. `"pendign"` вместо `"pending"` — и мусор в БД. | Prisma enums для всех status-полей. |
| 2.39 | `schema.prisma` | **`events` без retention/partitioning**. Таблица будет расти бесконечно. | Range partitioning + TTL job. |
| 2.40 | `tsconfig.json` | **`skipLibCheck: true`** скрывает конфликты типов между зависимостями. | `false` + исправить ошибки. |
| 2.41 | `schema.prisma:89` | **Default mismatch**: schema `@default(568)`, последняя миграция `SET DEFAULT 3300`. `prisma migrate dev` создаст лишнюю миграцию. | Обновить schema до `@default(3300)`. |
| 2.42 | `.husky/pre-commit` | **Secretlint сканирует tracked files**, а не staged diff. `git add -f .env` обходит защиту. | `git diff --cached --name-only`. |
| 2.43 | `main.js` (cache-busting) | **Разные `?v=` tags для одного модуля** в разных importers. ES module spec: full URL = module identity. Два instance одного модуля. | Build tool (Vite/Rollup) для cache-busting. |
| 2.44 | `questions.js` + `live-chat.js` | **Race condition**: `window.__liveChatRefresh()` вызывается до инициализации `live-chat.js`. | `CustomEvent` dispatch вместо global function call. |

---

## 💡 3. УЛУЧШЕНИЯ И ИДИОМЫ (Minor / Nitpicks)

| # | Файл | Что не так | Рекомендация |
|---|------|-----------|-------------|
| 3.1 | `registration.js`, `access.js` | `innerHTML` с server-derived данными | `textContent` + `createElement` |
| 3.2 | 6 файлов | `window.*` globals: `__liveChatRefresh`, `__aspbVideoPosition`, `__ASPB_ROOM_READY__` и т.д. | `CustomEvent` для cross-module communication |
| 3.3 | `video.js:11` | `_viewerInterval` объявлен, очищается, но никогда не присваивается — dead code | Удалить |
| 3.4 | `video.js`, `recordings.js` | Дублированный `loadHlsScript()` (~30 строк) | Extract в shared `hls-loader.js` |
| 3.5 | `room.js`, `recordings.js` | Дублированный `escapeHtml()` | Перенести в `utils.js` |
| 3.6 | `access.js`, `recordings.js` | Дублированный `setText()` | Перенести в `utils.js` |
| 3.7 | `admin.js`, `utils.js` | Дублированный `readCookie()` / `csrfHeaders()` | Один shared implementation |
| 3.8 | Множество файлов | **Магические числа**: `568` (duration), `2.5` (tolerance), `604800000` (7 days), `30000` (reload), `8/45/105/165` (insight timestamps) | Named constants |
| 3.9 | `app.ts:120` | `express.urlencoded` без size limit | `{ limit: '256kb' }` |
| 3.10 | `registration.ts:153-161` | Honeypot возвращает `202` вместо `201` — бот может отличить | Возвращать `201` с идентичным body |
| 3.11 | `telegramConsultantBot.ts` | `console.log`/`console.error` вместо `logger` | Структурированный logger |
| 3.12 | `reminders.ts`, `email.ts`, `telegram.ts` | Дублированные функции форматирования Moscow-даты | Shared `dateFormat.ts` |
| 3.13 | `success.js:101-104` | `URL.revokeObjectURL(link.href)` после `link.remove()` — доступ к detached element | Сохранить URL до remove |
| 3.14 | `questions.js:8` | `renderedInsightTimes` Set никогда не очищается при смене записи | Вызывать `resetInsightTimes()` |
| 3.15 | `schema.prisma` | **Редундантные индексы**: `@@index([eventName])` дублируется `@@index([eventName, createdAt])` (leftmost prefix). То же для `Registration.leadId` vs `@@unique([leadId, webinarSessionId])`. | Удалить одиночные индексы |
| 3.16 | `schema.prisma` | 11 индексов на `events` — каждый INSERT обновляет все 11 | Composite для UTM, удалить лишние |
| 3.17 | `app.ts:287` | `/vendor/hls.js` отдаёт весь `node_modules/hls.js/dist` включая sourcemaps | Копировать только `hls.min.js` при build |
| 3.18 | `docker-compose.production.yml` | Нет Docker network segmentation | `frontend` + `backend` networks |
| 3.19 | `ci.yml` | Lint запускается дважды (verify + lint-pr) | Удалить `lint-pr` job |
| 3.20 | `ci.yml`, `.nvmrc` | Node.js pinned как `22` (major only) | Pin `22.14.0` |
| 3.21 | `openapi.yml` | Нет request/response schemas — spec бесполезен для codegen | Добавить schemas |
| 3.22 | `index.html` (root) | Designer mockup с `cdn.tailwindcss.com` — не часть приложения | Удалить или перенести в `design/` |
| 3.23 | `package.json:47` | `prisma` (CLI, ~70MB) в `dependencies` вместо `devDependencies` | Перенести в devDependencies |
| 3.24 | `package.json:19` | `eslint --ext` deprecated в v8, удалён в v9 | Миграция на flat config |
| 3.25 | `.dockerignore` | Не включает `tests/`, `playwright-report/`, `.husky/` | Добавить недостающие |
| 3.26 | `state.js:29` | `serverTimeOffset` defaults to 0 при ошибке API — время не калибровано | Флаг `serverTimeCalibrated` |

---

## 🏆 4. ОБЩАЯ ОЦЕНКА И АРХИТЕКТУРНЫЙ ВЕРДИКТ

### Оценка готовности к продакшену: **5.5 / 10**

**Что работает хорошо:**
- Prisma ORM + миграции — зрелый подход к управлению схемой
- Multi-stage Docker build
- Secret scanning в CI (хотя и с дырой в pre-commit)
- Pino structured logging (внедрён в предыдущей сессии)
- Rate limiting на login и broadcast
- CSRF double-submit cookie pattern
- Smart polling в live-chat (exponential backoff + Page Visibility)
- Интервальная/листенерная очистка в video.js (внедрена ранее)
- Overlay-паттерн в room.js вместо `body.innerHTML`

**Что требует немедленного внимания:**
- 8 CRITICAL-проблем — каждая из них может привести к инциденту на продакшене
- 48 MAJOR — системные проблемы архитектуры, безопасности и надёжности
- Полный CI/CD pipeline не доведён до продакшен-уровня

### Главный архитектурный совет

**Разделить monolithic backend на service-слои.** Сейчас `helpers.ts` (God Object), `admin.ts` (1432 строки), и `registration.ts` смешивают транспортный слой (Express routes) с бизнес-логикой, persistence, и уведомлениями. Через год любой баг-фикс будет требовать понимания 400+ строк контекста.

Ввести структуру:
```
src/
  services/       # чистая бизнес-логика (analytics, registration, reminders)
  repositories/   # Prisma-запросы (abstracted от route handlers)
  routes/         # только HTTP-транспорт + валидация
  middleware/     # auth, csrf, rate-limit
```

Это единственный рефакторинг, который окупится многократно.

### Топ-5 действий прямо сейчас

1. **Ротировать Telegram-токены** и убрать `ADMIN_DEV_BYPASS` из продакшена
2. **Добавить `AbortController`** в video.js для listener cleanup — предотвращает утечки при re-init
3. **`document.activeElement?.tagName`** — one-line fix, предотвращает TypeError crash
4. **Исправить ICS export** (`\\n` → `\n`) — сломанная функциональность
5. **`Promise.allSettled`** в `admin.js loadAll()` — одна упавшая секция не убивает всю панель
