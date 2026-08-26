# Отчёт о реализации исправлений автовебинара АСПБ

**Дата:** 25 августа 2026
**Основание:** `AUDIT-PRELAUNCH-2026-08-25.md` и `PRODUCTION-REMEDIATION-PLAN-2026-08-25.md`
**Контур проверки:** LOCAL, PostgreSQL test schema, Chromium Playwright
**Вердикт:** `CONDITIONAL GO` только для перехода на STAGING. Production остаётся `BLOCK` до раздела «Обязательные внешние гейты».

## 1. Итог реализации

Кодовые причины подтверждённых AUD-001…AUD-031 исправлены либо закрыты тестовым контрактом. Добавлены миграции данных, очередей и DB-инвариантов, усилены регистрация, attribution, аналитика, session/video runtime, privacy, идемпотентность, readiness, интерфейс, backup/restore и release gate.

Полный локальный regression gate после исправлений:

| Проверка | Фактический результат |
|---|---:|
| CSS production build | PASS |
| ESLint | PASS |
| TypeScript build | PASS |
| Prisma schema validate | PASS |
| Unit/integration | 53/53 файлов, 406/406 тестов PASS |
| Playwright Chromium E2E | 30/30 тестов PASS |
| Полный `release:verify` на чистой test schema | 3/3 последовательных прогонов PASS |
| Повтор E2E-сценария video loading после устранения test race | 10/10 PASS |
| `git diff --check` | PASS |
| `npm audit --omit=dev` | 0 уязвимостей |
| Полный `npm audit` после обновления lock-файла | 0 уязвимостей |

Логи уровня error во время unit/integration-прогона были ожидаемыми доказательствами сценариев SMTP/CRM/Telegram failure, retry, rate limit и dead-letter; сам gate завершился с кодом 0.

Из-за проблем Node ESM с кириллицей в абсолютном пути рабочей директории полный test/E2E gate выполнен из побайтово синхронизированной ASCII-копии проекта с чистым `npm ci --ignore-scripts`, тем же `package-lock.json` и локальной test schema. CSS, lint, build и Prisma validate дополнительно выполнены непосредственно либо на той же ASCII-копии; CI/deploy contract, backup syntax, workflow YAML и `git diff --check` проверены в исходной директории. Production/CI checkout должен использовать ASCII-путь.

## 2. Что исправлено

| Ticket | Audit ID | Статус code/local | Реализованный результат |
|---|---|---|---|
| REL-001 | AUD-024 | Готово локально | Безопасная additive test preparation, реальный readiness probe, cold-start timeout, стабильные fixtures, 3/3 зелёных полных gate, JUnit/HTML evidence и обязательный staging health smoke перед production |
| OBS-001 | AUD-001 | Готово | First/last-touch attribution, UTM, gclid/yclid, referrer/landing context без query и ПДн |
| OBS-002 | AUD-002, 016, 030 | Готово локально | Версионированная taxonomy, дедупликация, очередь/retry, `Retry-After`, pagehide/online delivery, ключевые funnel/video/CTA события |
| WEB-001 | AUD-003 | Готово локально | Media source не зависит от reduced-motion; preference ограничивает движение, а не видео |
| WEB-002 | AUD-004 | Готово | Финальный CTA и end-state синхронизированы с timeline и сохраняются после завершения |
| WEB-003 | AUD-005, 006, 009 | Готово локально | Разделены versioned/legacy sessions, исправлены cache/state transitions и отображение timezone |
| WEB-004 | AUD-007, 008 | Готово | Разделены user pause/background pause, chat пересобирается после rewind, восстановление позиции не теряется из-за гонки инициализации |
| LEAD-001 | AUD-011 | Готово | Нормализация и строгая регистрационная валидация, field errors, consent-aware storage, понятные ошибки имени/телефона/email |
| LEAD-002 | AUD-010, 012 | Готово | Partner form закрыта без доступа; API строго валидирует payload и требует idempotency key |
| NOTIFY-001 | AUD-014 | Готово локально | Durable manager Telegram outbox, dedup, bounded retry/backoff, permanent failure и dead-letter |
| SEC-001 | AUD-013, 015 | Готово | Одноразовые opaque unsubscribe capabilities: hash-only storage, expiry, POST mutation; token-in-path endpoint удалён |
| PLAT-001 | AUD-023 | Готово | Устранён duplicate ID; onboarding, invitation и MFA E2E проходят |
| OPS-001 | AUD-025, 026 | Готово локально | Readiness проверяет DB/media/default webinar; честный 503; production требует `EMAIL_MODE=send`; README синхронизирован |
| UI-001 | AUD-017 | Готово | Устранены mobile/tablet overflow, включая динамический wizard на 320 px и safe responsive controls |
| UI-002 | AUD-018–022, 027–029 | Готово локально | Keyboard tabs, labels, group semantics, controlled live regions, contrast, skip links, accessible names, русская microcopy |
| SEO-001 | AUD-031 | Готово локально | Canonical/robots/sitemap/noindex и технические metadata приведены к единому контракту |
| EXT-001 | Остаточные риски | Не выполнено | Нужны реальные STAGING-провайдеры, панели, устройства и эксплуатационный доступ |

Дополнительно устранены дефекты, найденные уже при повторной регрессии:

- rollout middleware больше не блокирует соседние `/v1` routers;
- приватная загрузка evidence не зависит от публичного каталога;
- принятие AI chapter не считается изменением опубликованной расшифровки;
- ручное сохранение creator wizard не теряется за завершившимся autosave;
- восстановление viewer progress ждёт готовность общего video controller;
- TestFakeMediaStorage корректно участвует в readiness;
- два уязвимых dev-транзитивных пакета обновлены до `brace-expansion 5.0.9` и `nanoid 3.3.18`.

## 3. Изменения данных и эксплуатации

Перед выкладкой требуется последовательно применить три additive-миграции:

- `prisma/migrations/20260825143000_audit_backend_durability/migration.sql`;
- `prisma/migrations/20260825150000_restore_safe_analytics_function/migration.sql`;
- `prisma/migrations/20260825151000_webinar_metadata_command/migration.sql`.

Они добавляют и исправляют:

- first/last attribution поля в `leads`;
- idempotency/fingerprint для `partner_applications`;
- `unsubscribe_tokens` с hash-only token storage;
- `manager_telegram_notification_jobs` с индексами, dedup и ссылочной целостностью;
- переносимый `search_path` для рекурсивной функции проверки analytics metadata, без которого восстановление `pg_dump` падало на `COPY events`;
- DB constraint `webinar_commands_action_check` с поддержкой `metadata_update`, без которого creator autosave и resumable media flow получали 500 на чистой БД.

Миграции не удаляют существующие таблицы и допускают исторические partner rows без idempotency key. Все 80 каталогов миграций применяются с нуля в каждом полном gate. До production всё равно обязательны backup и проверка времени DDL на копии production-БД.

Локальный restore drill фактически выполнен: новый dump был восстановлен в отдельную БД, восстановление завершилось с кодом 0, а read-only counts совпали со снимком-источником (`_prisma_migrations` 81, webinars 14, registrations 7, events 10, unsubscribe tokens 0, manager jobs 0). Изолированная recovery-БД и временный backup после проверки удалены. Последующая additive-миграция ограничения команд отдельно подтверждена тремя чистыми bootstrap-прогонами.

CI дополнительно сохраняет `test-results` и `playwright-report`, выполняет полный dependency audit и не разрешает production job без успешного `staging-smoke`. Smoke проверяет `/health` и `/health/ready`; это health/readiness gate, а не замена полной внешней STAGING-приёмки.

## 4. Консолидированная interface-проверка

В полном режиме проверены шесть направлений: accessibility, layout, UX writing, typography, colors и UI polish. Общие симптомы объединялись по корневой причине. Исправлены keyboard flow, focus/labels, live regions, overflow, responsive controls, контраст вторичного текста, icon semantics, skip links, технический английский и неясные состояния ошибок.

Runtime E2E подтверждает keyboard/mobile состояния в Chromium, включая 320 px. Статический viewport sweep охватил 24 страницы × 9 ширин. Реальные Safari/iOS, Firefox и Android остаются отдельным внешним гейтом.

## 5. Обязательные внешние гейты до production

Production нельзя открывать, пока нет фактических доказательств по каждому пункту:

1. **STAGING parity:** тот же image/artifact, production-like env, HTTPS, reverse proxy, cookies, CORS и реальные secrets из secret manager.
2. **База и rollback:** повторить доказанный локально backup/restore на production-like clone, измерить DDL, применить миграции и отрепетировать rollback приложения на предыдущий SHA без потери новых данных.
3. **SMTP:** verify, письмо в реальные тестовые inbox, SPF/DKIM/DMARC, spam placement, magic/unsubscribe links и timezone reminders.
4. **CRM:** form → API → DB → CRM, mapping first/last UTM, dedup, retry, manager visibility и купивший/повторный пользователь.
5. **Telegram:** реальные тестовые боты/чаты, 429/timeout/retry/dead-letter, revoke consent и отсутствие дублей.
6. **Analytics:** Network → receiver → GA4/Метрика/другая панель; имена, параметры, UTM, session/user IDs, отсутствие ПДн, дубли и lag.
7. **Видео:** реальный HLS/CDN и MP4 fallback на iPhone Safari, desktop Safari, Android Chrome и Firefox; autoplay, sound, background, lock screen, rotation, PiP/AirPlay где применимо.
8. **Performance:** cold/warm Lighthouse/Core Web Vitals на production-like сети, 4× CPU slowdown, cache headers и media delivery.
9. **Security:** разрешённый staging scan, CSRF/CORS/cookie/header verification, IDOR checks и webhook signature checks.
10. **Платежи:** в репозитории контура оплаты нет. Если продажа ведёт во внешний checkout, весь success/failure/callback/webhook/double-charge/access path нужно проверить отдельно в sandbox.
11. **Чистый CI:** локальные 3/3 уже получены; повторить три последовательных gate в доверенном CI на exact release SHA с сохранёнными traces/reports.
12. **Наблюдаемость:** dashboard/alerts для API 5xx/429, registration, outbox lag/dead-letter, CRM, SMTP, Telegram, video errors и analytics delivery.

## 6. Порядок вывода в production

1. Зафиксировать content lock и exact release SHA; не включать посторонние audit-temporary файлы в артефакт.
2. Собрать immutable image в CI и выполнить CSS → lint → build → 406 tests → 30 E2E → audit.
3. Сделать backup STAGING/production, проверить restore и оценить DDL на clone.
4. Применить миграцию на STAGING, выполнить все пункты внешней приёмки и собрать evidence по correlation IDs.
5. Провести Go/No-Go: открытых P0/P1 нет, blocking P2 нет, остаточные риски подписаны владельцами.
6. Применить миграцию production в согласованное окно; затем развернуть exact проверенный image.
7. Открыть ограниченный трафик, выполнить smoke: landing → registration → email → room → video → CTA → partner lead → CRM/Telegram/analytics.
8. Наблюдать минимум 60 минут; при breach порогов выключить кампанию/registration или откатить приложение по runbook.
9. После 24 и 72 часов проверить заявки, дубли, очереди, доставляемость, video errors и расхождение аналитики.

## 7. Остаточные риски

- Не было доступов к STAGING, production URL, CRM, SMTP, Telegram, analytics и video CDN.
- Не выполнялись реальные списания и payment webhooks; в локальном продукте оплаты нет.
- Не выполнены физические iPhone/Android и реальные Safari/Firefox проходы.
- Не выполнены production load test, chaos/failover и deploy rollback. Локальный backup/restore доказан, но ещё не повторён на production-like clone.
- Full local gate выполнен три раза подряд после финальных правок; остаются три доверенных CI-прогона на зафиксированном exact release SHA и immutable artifact.
- Browserslist сообщает об устаревшей базе `caniuse-lite`; это не ломает сборку, но базу следует обновить отдельным контролируемым dependency PR и повторить visual regression.

До закрытия этих пунктов корректный итоговый статус — `CONDITIONAL GO` на STAGING и `BLOCK` на production, а не `GO`.
