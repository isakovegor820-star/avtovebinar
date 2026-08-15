# Отчёт об устранении замечаний SITE-COMPLIANCE-AUDIT-2026-07-30

**Дата локальной и production-проверки:** 31.07.2026
**Объект:** `/Users/egor/Desktop/АВТОВЕБИНАР` и публичный сайт `https://aspb-partners.ru`
**Статус:** compliance-релиз развёрнут в production; публичные P0-контроли и миграции проверены. Общее соответствие **НЕ ПОДТВЕРЖДЕНО** из-за отсутствующих организационных, реестровых и инфраструктурных доказательств.
**Ограничение:** это отчёт о коде и доступных извне фактах, а не заключение о полном соответствии ООО «АСПБ» требованиям законодательства.

## 1. Временно отключённые процессы

1. В production подтверждены `TELEGRAM_MANUAL_BROADCAST=off` и `TELEGRAM_NEWS_BROADCAST=off`. Новые Telegram-маркетинговые сценарии не запускать до ручной проверки уведомления о трансграничной передаче.
2. Email-доставка оставлена в честном degraded-режиме `EMAIL_MODE=log`: адрес `smtp.invalid` не прошёл verify, поэтому `send` не включался. После регистрации ссылка и дата показываются сразу; email не заявляется единственным способом входа.
3. Публичная статическая выдача MP4/HLS закрыта; файлы остаются в read-only mount и доступны приложению только через защищённые endpoint.
4. Никакие уведомления в Роскомнадзор не подавались; подготовлен только checklist для ручной сверки.

Журналы, существующие согласия, сведения о возможных рассылках и 22 failed email jobs не удалялись.

## 2. Таблица исправлений

Обозначения production: **✅** — технически развёрнуто и проверено; **⚠️** — требуется ручное, юридическое или организационное подтверждение.

| ID | Было | Изменение | Основные файлы | Тест/доказательство | Правовая причина | Статус production |
|---|---|---|---|---|---|---|
| P0-1 / A-03 | Публичный `/crisis_premium/assets/webinar.mp4` | Статическая раздача MP4/WebM/MOV/HLS/сегментов запрещена; media исключены из Docker context; видео выдаётся через endpoint, проверяющий participant session, регистрацию, webinar session и срок доступа; внутренний origin не возвращается публичным API | `.dockerignore`, `src/app.ts`, `src/routes/public/media.ts`, `src/routes/public/recordings.ts` | Integration: анонимные GET/HEAD/Range к прямому пути дают 404; API без сессии закрыт; сессия и Range проверены. E2E: запись использует `/api/media/recording/:id/video` | Контроль доступа, договорные и авторские риски; само наличие MP4 без установленных ПДн не квалифицировалось как нарушение 152-ФЗ | **✅** 31.07: legacy и mounted MP4 HEAD/Range, HLS manifest и TS → 404; в образе media-файлов 0 |
| P0-2 / A-01, A-09 | Один обязательный checkbox объединял ПДн, политику и условия; доказательство сводилось к boolean/версии | Отдельные обязательные действия для ПДн и условий; отдельные необязательные email/Telegram согласия, все unchecked; сохраняются версия и hash текста, цели, данные, операции, срок, каналы, форма, IP-hash, UA и отзыв; evidence append-only | `crisis_premium/register.html`, `crisis_premium/js/registration.js`, `src/routes/public/registration.ts`, `src/lib/consentDocuments.ts`, `prisma/schema.prisma`, migration `20260730150000_compliance_controls` | Vitest проверяет четыре независимых решения и evidence. E2E подтверждает регистрацию при отказе от обоих рекламных каналов. Полный migrate deploy на чистой схеме: 27/27; UPDATE/DELETE evidence заблокированы DB-trigger | С 01.09.2025 согласие должно оформляться отдельно от других подтверждаемых документов: [официальный Закон №156-ФЗ](https://publication.pravo.gov.ru/document/0001202506240021) | **✅** обе миграции применены; production-форма показывает 4 отдельных unchecked checkbox |
| P0-3 / A-02, A-10 | Ручная рассылка выбирала всех с `telegramChatId` | Feature flag off; снапшот только действующих Telegram-согласий нужной версии; основание на каждого получателя; повторная проверка согласия перед каждой отправкой; инициатор, idempotency key, preview, журнал; `/unsubscribe`, `/stop` и «стоп» отзывают только Telegram-рекламу | `src/lib/telegramBroadcastWorker.ts`, `src/routes/admin.ts`, `src/lib/telegramParticipantBot.ts`, `crisis_premium/admin.js`, schema/migration | Unit/integration: отозвавший согласие до отправки не получает сообщение; повторная отправка защищена; permanent/retry ошибки проверены | Предварительное согласие и прекращение рекламы по требованию адресата: [разъяснение ФАС по ст. 18 Закона №38-ФЗ](https://fas.gov.ru/pages/contacts/requests/obrazczyi-dokumentov/poryadok-podachi-zhalob-na-nezakonnuyu-sms-reklamu.html) | **✅/⚠️** код развёрнут; оба production-флага `off`; реальная рекламная отправка намеренно не выполнялась |
| P0-4 / A-04 | Public health раскрывал режимы, имена ботов и очереди | Публичный ответ строго `{ok:true}` либо `{ok:false,status:"degraded"}`; SMTP `log` считается degraded; детали вынесены в защищённый endpoint | `src/lib/health.ts`, `src/app.ts` | Integration проверяет точную форму public JSON и авторизацию details | Минимизация служебной информации; меры безопасности по ст. 19 Закона №152-ФЗ и ст. 16 Закона №149-ФЗ | **✅** public отвечает точной сокращённой схемой; `/details` без token → 401 |
| P0-5 / A-05 | Запись называлась прямым эфиром, использовались обещающие формулировки о выплате | Пользовательский текст, email и Telegram приведены к «премьере записи»; подготовленные сообщения обозначены; вознаграждение зависит от подписанного договора и фактического выполнения условий, результат не гарантируется | `crisis_premium/index.html`, `register.html`, `webinar.html`, `js/room.js`, email/Telegram-модули и сценарий чата | Статический поиск не находит запрещённых обещаний; E2E проверяет пользовательские статусы комнаты | Риск недостоверной или вводящей в заблуждение рекламы; окончательная квалификация — ФАС/суд | **✅** production-лендинг и форма проверены в браузере; формат указан как премьера записи, доход не гарантируется |
| P0-6 / A-06 | В режиме `smtp.mode=log` обещалось письмо; jobs могли исчерпывать retry без отдельного evidence; `emailSentAt` мог быть двусмысленным | Рабочая ссылка показывается сразу; есть восстановление доступа; в `log` письмо не enqueue/не отмечается отправленным; exhausted jobs переносятся в dead-letter и логируют alert без открытых адресов/URL | `src/routes/public/registration.ts`, `src/lib/email.ts`, `src/lib/emailOutbox.ts`, schema/migration, страницы регистрации/успеха/доступа | Unit/integration проверяют retry, dead-letter, отсутствие `emailSentAt` без SMTP и маскирование; E2E проверяет немедленный и восстановленный доступ | Честная информация об услуге и операционная доступность; автоматическая квалификация по 152-ФЗ не заявляется | **✅/⚠️** честный degraded UX развёрнут; SMTP verify не прошёл, поэтому `EMAIL_MODE=log`; 22 старых failed jobs сохранены |
| P1-7 / A-07 | `aspb_visitor_id` на 180 дней появлялся до выбора, «Отклонить» не выключало аналитику | Persistent visitor ID выдаётся только при `aspb_cookie_consent=accepted`; отказ удаляет старый ID; до согласия/при отказе события только агрегированные, без visitor/IP/UA/UTM/source/metadata/lead/registration | `src/lib/visitor.ts`, `src/routes/public/events.ts`, `src/routes/public/helpers.ts`, `crisis_premium/cookie-consent.js`, `privacy.html` | Integration проверяет cookie и минимизацию событий; E2E проверяет отсутствие visitor ID до и после отказа | Соответствие заявленному основанию, минимизация и реальный opt-out | **✅** production-баннер и отказ проверены в браузере; до выбора persistent storage пуст |
| P1-8 / A-08 | Сроки не определены; очищались только IP-hash/UA | Создана матрица сроков и versioned retention job: токены, подробные events, UTM, audit traces, чат, вопросы, terminal outbox, Telegram ID и старые лиды; каждый запуск имеет status/result/error | `docs/RETENTION-MATRIX-2026-07-30.md`, `src/lib/retention.ts`, schema/migration | Integration создаёт просроченные записи, выполняет sweep и проверяет очистку и `retention_runs` | Ограничение хранения и прекращение обработки по достижении цели; HMAC IP/visitor ID учитываются как псевдонимизированные | **✅/⚠️** job и migration развёрнуты; production-run зафиксирован как successful; сроки должны утвердить DPO, юрист и владелец процесса |
| P1-9 / A-10 | Email-отписка затрагивала общий отзыв ПДн | Раздельные поля и append-only события отзыва для email, Telegram и общего ПДн; канал, причина и версия отозванного согласия; email-отписка сохраняет Telegram и организационные основания | schema/migration, `src/routes/public/registration.ts`, `src/lib/telegramParticipantBot.ts` | Integration и E2E проверяют независимую email-отписку и immutable revoke evidence | Разные цели и основания обработки нельзя смешивать; рекламная отписка не равна общему отзыву ПДн | **✅** миграция и код развёрнуты; независимая отписка проверена integration/E2E |
| P1-10 / A-11 | Вопрос публиковался с именем/статусом без ясного решения пользователя | Вопрос private по умолчанию; отдельный checkbox публикации; псевдоним по умолчанию или выбранное имя; точное уведомление о получателях/сроке; запрет данных клиентов, специальных категорий и конфиденциальных сведений; отдельное evidence публикации | `crisis_premium/webinar.html`, `crisis_premium/js/questions.js`, `src/routes/public/partners.ts`, schema/migration, `chat-rules.html` | Integration проверяет private/public режим и evidence; E2E публикует вопрос только после явного checkbox | Прозрачность цели и предоставления ПДн другим участникам; минимизация свободного текста | **✅/⚠️** код развёрнут; live-вопрос не отправлялся, чтобы не создавать production-данные |
| P2-11 | Публичные документы не совпадали с фактическими процессами и не имели полного versioned содержания | Переписаны политика, согласие ПДн и условия; добавлены отдельное рекламное согласие и правила чата; указаны оператор, версия, дата действия, цели, данные, операции, основания, получатели, сроки, права и отзыв | `privacy.html`, `consent.html`, `terms.html`, `marketing-consent.html`, `chat-rules.html`, `legal.css` | Hash/версия документов используются при записи evidence; вручную проверены 5 legal pages на viewport 390×844: горизонтальный overflow 0 | Доказуемость содержания согласия и прозрачность фактической обработки | **✅/⚠️** документы опубликованы; финальное визирование российского юриста/DPO не подтверждено |
| P2-12 / A-12, A-13, часть A-14 | Не представлены карточка оператора, трансграничная квитанция, локализация и договоры | Подготовлен ручной checklist без фиктивных сведений и без автоматической подачи; цели, данные, субъекты, Telegram, БД/backups, подрядчики и approval gate перечислены | `docs/RKN-MANUAL-CHECKLIST-2026-07-30.md` | Проверен только комплект полей/checklist; внешние доказательства не получены | Ст. 12 и 22 Закона №152-ФЗ; процедура трансграничной передачи изменена [Законом №266-ФЗ](https://publication.pravo.gov.ru/Document/View/0001202207140080) | **⚠️ не подтверждено**; подача запрещена без юриста, DPO и руководителя |
| P3-13 / A-15 | `/api/csrf` отдавал два разных `Set-Cookie` | Один источник token/cookie; повторный GET стабилен и не создаёт конфликт | `src/lib/csrf.ts`, `src/routes/public.ts` | Integration: один Set-Cookie, JSON=cookie, следующий POST проходит, повторный GET без нового cookie | Надёжность CSRF-защиты и воронки регистрации | **✅** один Set-Cookie; JSON=cookie; повторный GET стабилен и не выдаёт новый cookie |
| P3-14 / часть A-14 | Парольный admin login без обязательного MFA/session revoke evidence | Обязательный TOTP для всех активных admin; enrollment; зашифрованный secret; session version и revoke-all; disabled user/session-version проверяются; rate limit, роли и audit сохранены; токены не помещаются в URL | `src/lib/mfa.ts`, `src/routes/admin.ts`, `crisis_premium/admin.html`, `admin.js`, schema/migration | Unit/integration и E2E проверяют enrollment/login для ролей и invalidated session | Мера снижения риска несанкционированного доступа; не заменяет модель угроз и набор мер ФСТЭК | **✅/⚠️** MFA/session controls развёрнуты; enrollment действующих администраторов требует операционного подтверждения |
| P3-15 | Воронка не объясняла формат, каналы, отказ и публичность вопроса; optional статус мог отправляться первым значением | Нейтральный `professionalStatus=Не выбрано`; необязательные поля не required; честный формат, немедленный доступ, отдельные каналы рекламы/отзыва, чат private по умолчанию; labels/focusable controls сохранены; mobile legal CSS добавлен | страницы регистрации, успеха, доступа, комнаты, legal pages и соответствующий JS/CSS | E2E регистрации/access/mobile; role/name locators для dialog/checkbox/heading; ручной browser QA формы и legal pages на 390×844 | Осознанный выбор пользователя, снижение жалоб и ошибок регистрации | **✅** production browser QA: честная копия, четыре unchecked согласия, neutral status, 390×844 без overflow, доступные имена у focusable controls |

## 3. Что исправлено и проверено

- Production API запущен на образе `sha256:344fa3cb04d1292fe8848ed043a9ce5eaa733e69ed3ec80a6112b18a74dd019d`; container `running/healthy`, restart count 0.
- В production успешно применены `20260729120000_visitor_analytics` и `20260730150000_compliance_controls`; всего Prisma видит 27 миграций.
- Анонимные legacy/mounted MP4 HEAD и Range, HLS manifest и TS segment возвращают 404; несмонтированный Docker image содержит 0 MP4/WebM/MOV/M3U8/TS.
- `/metrics`, `/api/admin/me`, `/health/dependencies/details` без авторизации возвращают 401; public dependencies отдаёт только `{"ok":false,"status":"degraded"}` с HTTP 503.
- CSRF: первый GET отдаёт один `Set-Cookie`, JSON-токен совпадает с cookie; повторный GET стабилен и не выдаёт новый cookie.
- `npm run build` — успешно.
- `npm run lint` — успешно.
- `npm test` — 6 test files, 96/96 тестов, включая integration с PostgreSQL.
- `npm run e2e` — 12/12 Chromium: регистрация без marketing consent, cookie decline, email unsubscribe, восстановление доступа, admin MFA, video/session, mobile overflow.
- `git diff --check` — успешно.
- Production browser QA на 390×844: горизонтальный overflow отсутствует; форма имеет четыре unchecked checkbox, нейтральный статус, честный cookie-баннер; у 22 focusable controls есть accessible name, положительных `tabindex` нет.

Тестовые логи с `network down`, SMTP failure, Telegram 429/blocked являются намеренно смоделированными ветками и завершились зелёными assertions.

## 4. Что осталось за пределами технического deploy

- Реальный SMTP не настроен; `smtp.invalid` не разрешается в DNS. До прохождения verify и отправки на согласованный тестовый адрес режим остаётся `log`.
- 22 старых failed email jobs не удалялись; требуют операционного разбора.
- Production-отправка рекламы, live-вопроса и новой регистрации не выполнялись, чтобы не создавать лишние production-данные. Их ветки покрыты integration/E2E.
- Production retention run зафиксирован как successful и не нашёл просроченных записей; сами сроки ещё не утверждены DPO/юристом/владельцами процессов.
- Код и отчёт остаются в грязном рабочем дереве; staged/commit/push не выполнялись, посторонние изменения сохранены.

## 5. Решения и доказательства, которых не хватает

### Требует решения руководителя

- утверждение бизнес-сроков хранения;
- решение о подрядчике/реквизитах SMTP и о будущем запуске Telegram-маркетинга;
- письменное разрешение на подачу/изменение уведомлений РКН;
- владельцы и бюджет для регулярных restore-test, pentest, обучения и устранения инфраструктурных gaps.

### Требует российского юриста и DPO

- финальное визирование versioned текстов и матрицы оснований/сроков;
- сверка реестровой карточки ООО «АСПБ» по ИНН `6452098049`;
- определение иностранного получателя/стран Telegram по актуальным условиям и фактам, без угадывания;
- проверка и, только при необходимости, подготовка уведомления о трансграничной передаче;
- квалификация организационных и рекламных сообщений, рекламных формулировок и условий партнёрского договора.

### Невозможно подтвердить без инфраструктуры/документов

- российское местонахождение primary PostgreSQL и всех backup;
- актуальные поручения хостингу, SMTP, Telegram, CRM/мониторингу и субподрядчикам;
- модель угроз, уровень защищённости ИСПДн и применимый набор мер ФСТЭК №21;
- полные RPO/RTO, шифрование/key management, incident response; разовый restore-test сделан, но регулярный процесс не доказан;
- полный lifecycle admin-доступов и периодический review ролей;
- реальные логи согласий, рекламных отправок, отписок, удаления и возможных инцидентов;
- реальная доставка на внешний тестовый адрес и причина 22 failed jobs.

## 6. Выполненный deploy и rollback

1. До изменений создан дамп `/opt/db-backups/aspb-pre-compliance-20260731T152409Z.sql.gz`; `gzip` проверен, дамп успешно восстановлен во временную БД: 17 public tables, 25 дорелизных migrations. Временная БД после проверки удалена.
2. Создан source snapshot `/opt/aspb-rollback/source-pre-compliance-20260731T152409Z.tar.gz`; зафиксирован предыдущий image `sha256:89665afaa8e975a8d204c3c734906472aafe91ea5c0e368e1864bfe457e65f47`.
3. Release archive передан с SHA-256 `b709d5b87fb9cc1a9c4a0d247ef4a2ef02565f27387aaed1cbd0acef305684e9`; media в архив не включались.
4. Preflight первый раз остановил релиз до миграций и restart из-за неверно зашитого username Telegram-бота. Фактический `aspb_partners_bot` сверен с текущим health и зафиксирован как deployment pin. Простоя и отправки не было.
5. При повторном запуске environment validation, обе миграции, build, start, API health и worker heartbeat завершились успешно.
6. Post-deploy log review выявил один нечитаемый JPEG в первом образе. Runtime COPY переведён на `--chown=node:node`, в Dockerfile добавлен build-check читаемости. Финальный image: `sha256:344fa3cb04d1292fe8848ed043a9ce5eaa733e69ed3ec80a6112b18a74dd019d`; фотография → HTTP 200, нечитаемых static-файлов от имени `node` — 0, новые логи без ошибок.
7. Rollback точки сохранены. Миграции аддитивные; автоматическая destructive down-migration не допускается, чтобы не потерять evidence. В случае отката public media должны остаться закрытыми.

## 7. Итог

Compliance-релиз технически развёрнут и существенно снизил подтверждённые риски. Это не гарантирует отсутствие штрафа и не делает ООО «АСПБ» автоматически соответствующим всем требованиям. До представления карточки РКН, квитанции о трансграничном уведомлении или мотивированного решения о его неприменимости, договоров с обработчиками, модели угроз и доказательств локализации общий статус остаётся **НЕ ПОДТВЕРЖДЁН**.
