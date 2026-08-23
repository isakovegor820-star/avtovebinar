# DEC-06 — STT и AI providers

Дата исследования: 23 августа 2026 года

Статус: **техническая рекомендация и adapters готовы; DPA/no-training/retention и production activation не утверждены**

## Решение

Рекомендуемый технический contour:

- STT: Yandex SpeechKit v3 asynchronous recognition;
- AI suggestions: Yandex Foundation Models с structured JSON schema;
- domain остаётся provider-neutral через `SpeechToTextAdapter` и `ContentEnrichmentAdapter`;
- `STT_PROVIDER=unconfigured` и `AI_ENRICHMENT_PROVIDER=unconfigured` остаются production defaults;
- AI создаёт только suggestions/provenance; публикация всегда отдельное действие человека.

Решение не означает принятия provider terms. Production switch заблокирован до письменной проверки обработки ПДн/конфиденциального юридического контента, запрета обучения, retention/delete и субпроцессоров.

## Provider decision gate — 23.08.2026

Официальные docs подтвердили v3 async submit/status/result/delete, `ru-RU`, OGG Opus, timestamps и speaker labeling. Speaker labeling доступен в `FULL_DATA` для mono и ограничен двумя speakers. Для async bucket input опубликованы лимиты 1 GB/4 часа, 500 submit/hour, 5 status checks/second для API v3 и 10 000 billable audio hours/day; provider хранит recognition result до 3 суток, поэтому application вызывает delete сразу после получения или terminal failure. Аудит provider событий публично описан через Audit Trails.

Не найдено достаточного публичного первичного доказательства проектного DPA/поручения, запрета обучения/улучшения модели на контенте АСПБ, deletion SLA для logs/backups, native v3 custom dictionary и provider-reported immutable model version. Webhook в рассмотренном v3 API не найден, поэтому adapter использует polling; webhook route не создавался. Поэтому Yandex SpeechKit остаётся **technical candidate**, `TRN-001=implemented`, provider activation — `blocked_external`.

## Decision matrix

| Критерий | Yandex SpeechKit / Foundation Models | SaluteSpeech / GigaChat | Safe fallback |
| --- | --- | --- | --- |
| Регион/DPA | Российский cloud contour технически согласуется с DEC-05; точное место обработки, support access, DPA и применимое право получить письменно | Российский provider contour; те же договорные вопросы требуют письменного ответа | `unconfigured`: контент не отправляется третьей стороне |
| Русский язык | Нативная поддержка русского; v3 normalization | Русский поддерживается | Ручной transcript/editor |
| Timestamps/speakers | v3 result содержит word/segment timestamps; speaker labeling доступен и ограничен документированными условиями | Async recognition доступно; качество timestamps/diarization проверять на legal corpus | Нет автоматического STT |
| Юридические термины/словарь | Tenant dictionary передаётся adapter contract; reviewed public API не доказывает полноценный custom-vocabulary parameter для v3, поэтому обязателен corpus WER/term recall test и human review | Документировано улучшение распознавания; точные quotas/эффект словаря проверять | Dictionary используется редактором и AI prompt, без обещания provider accuracy |
| Размер/длительность | Async quota docs: до 1 GB и 4 часов; покрывает лимит АСПБ 4 GB source после private audio normalization и 180 минут | Проверить лимиты exact async contract; GigaChat file storage не является заменой STT | Worker fail closed |
| Async/webhook | Async operation submit + poll + result; webhook в рассмотренном v3 API не найден | Async endpoint есть; callback semantics отдельно принять | Durable job с bounded retry |
| Retry/idempotency | Correlation/dedup key задаёт приложение; provider operation lifecycle и повторный result/delete покрыты adapter tests. Staging обязан проверить timeout, 429/5xx, malformed stream и duplicate submit | Проверить provider request-id/idempotency и recovery | DB dedup и safe failure code; no auto-publish |
| Provider-side deletion | SpeechKit имеет `deleteRecognition`; adapter вызывает delete и fail closed при неподтверждённой очистке. Документированное хранение результата — до 3 дней, но договор должен охватить logs/backups | GigaChat file API позволяет delete; внутренние logs/backups/retention требуют договора | Local data остаётся в private storage/DB по retention matrix |
| Стоимость | STT тарифицируется по длительности/каналам; AI — по input/output tokens/model. Перед switch пересчитать российский contract price на 180-minute corpus и worst-case retries | SaluteSpeech/GigaChat требуют коммерческого расчёта для юрлица; GigaChat model page публикует token basis | Ручная обработка дороже, но не создаёт external processing |
| Model/version provenance | Adapter сохраняет provider и configured model ID; provider-reported immutable version остаётся nullable, потому что reviewed API её не доказал | Нужен exact model ID/version/changelog contract | Local prompt/template version сохраняется всегда |
| Запрет обучения | В рассмотренной public API documentation достаточное обязательство «не использовать customer content для обучения» не найдено. Нужна письменная договорная гарантия | То же: не выводить из маркетингового описания | Пока гарантии нет — provider остаётся `unconfigured` |

Цена — не одно число: для STT считать секунды × каналы × retries, для AI — input/output tokens × модель. Прайс и бесплатные квоты меняются; перед approval нужен сохранённый расчёт из provider calculator для P50/P95/worst-case usage.

## Реализованный contract

`YandexSpeechToTextAdapter`:

- получает только private OGG/Opus URI, построенный сервером из `audioStorageKey`;
- submit-ит async recognition с русским языком, normalization и speaker labeling;
- durable worker submit-ит ровно одну server-bound operation, хранит provider job ID только в private job metadata, а затем poll-ит по одному bounded шагу;
- нормализует final segments, word timestamps и channel/speaker labels;
- не возвращает provider response наружу и использует safe error codes;
- после чтения вызывает `deleteRecognition`; неподтверждённая очистка считается ошибкой;
- возобновляет polling/cleanup после restart, классифицирует 408/429/5xx как retryable, имеет bounded backoff/dead-letter/cancel и idempotent result persistence;
- записывает provider/model/configured version provenance без transcript text, signed URI и secrets;
- не публикует transcript.

`YandexContentEnrichmentAdapter`:

- запрашивает только schema-constrained suggestions;
- локально повторно валидирует ответ Zod;
- запрещает персонализированный юридический совет, выдуманных участников и auto-publication в system instruction;
- сохраняет provider/model/template provenance без API key, raw token или signed URL;
- malformed output fail closed.

## Env-контракт

См. `.env.production.example`:

- `STT_PROVIDER=unconfigured|yandex_speechkit|test_fake`;
- `STT_YANDEX_API_KEY`, `STT_YANDEX_FOLDER_ID`, четыре API endpoints;
- `STT_YANDEX_AUDIO_URI_PREFIX`, model, poll interval и timeout;
- `AI_ENRICHMENT_PROVIDER=unconfigured|yandex_foundation_models|test_fake`;
- `AI_YANDEX_API_KEY`, `AI_YANDEX_FOLDER_ID`, `AI_YANDEX_MODEL_URI`, endpoint и timeout.

Keys должны находиться только в approved secret store, иметь отдельные service identities/quotas и не переиспользовать S3 credentials. `test_fake` production guard запрещает.

## Provider acceptance до switch

- подписанный DPA/поручение обработки, регион всех данных/logs/backups и список субпроцессоров;
- письменный запрет training/model improvement на переданном контенте либо явное разрешение АСПБ;
- подтверждённые retention/delete SLA и deletion evidence;
- MP4-derived Opus corpus: русский legal WER, term recall, timestamps, 1/2 speakers, шум;
- 180 минут, maximum normalized audio size, timeout, 429/5xx, malformed/partial NDJSON;
- repeat submit/poll/result/delete и worker restart без duplicate transcript/publication;
- AI prompt injection/red-team, schema drift, model change и quality regression;
- cost cap/alerts и exact model allowlist.

## Официальные источники

- [SpeechKit v3: asynchronous submit](https://yandex.cloud/ru-kz/docs/speechkit/stt-v3/api-ref/AsyncRecognizer/recognizeFile)
- [SpeechKit v3: recognition result](https://yandex.cloud/ru-kz/docs/speechkit/stt-v3/api-ref/AsyncRecognizer/getRecognition)
- [SpeechKit v3: delete recognition](https://yandex.cloud/ru-kz/docs/speechkit/stt-v3/api-ref/AsyncRecognizer/deleteRecognition)
- [SpeechKit: speaker labeling](https://yandex.cloud/en/docs/speechkit/stt/speaker-labeling)
- [Yandex Cloud quotas and limits](https://yandex.cloud/en/docs/overview/concepts/quotas-limits)
- [SpeechKit: asynchronous recognition and three-day result retention](https://yandex.cloud/ru-kz/docs/speechkit/stt/transcribation)
- [SpeechKit Audit Trails: async recognition event](https://yandex.cloud/en/docs/audit-trails/audit/ai/speechkit/stt/events-ref/RecognizeSpeechAsync)
- [SpeechKit pricing](https://yandex.cloud/ru/docs/speechkit/pricing)
- [Foundation Models: async completion](https://yandex.cloud/ru-kz/docs/foundation-models/text-generation/api-ref/TextGenerationAsync/completion)
- [Foundation Models pricing](https://yandex.cloud/ru/docs/foundation-models/pricing)
- [SaluteSpeech: asynchronous recognition](https://developers.sber.ru/docs/ru/salutespeech/rest/async-general)
- [SaluteSpeech: recognition improvement](https://developers.sber.ru/docs/ru/salutespeech/guides/recognition/improvement)
- [GigaChat model/version and token basis](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-2-pro)
- [GigaChat API tariffs](https://developers.sber.ru/docs/ru/gigachat/api/tariffs)
- [GigaChat file storage/delete](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/files-storage)
