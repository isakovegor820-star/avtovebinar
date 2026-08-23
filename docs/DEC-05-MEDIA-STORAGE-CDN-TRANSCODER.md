# DEC-05 — object storage, CDN и transcoder

Дата исследования: 23 августа 2026 года

Статус: **Yandex Object Storage `ru-central1` — технический candidate для MED-001; provider не утверждён, resource/DPA/budget/credentials отсутствуют, поэтому статус требования — `implemented`, не `verified`; self-hosted persistent volume остаётся compatibility-контуром**

## Provider decision gate — 23.08.2026

Перепроверены только официальные первичные источники Yandex Cloud. Object Storage описан как S3-compatible service, data centers находятся в России, а публичная privacy-страница заявляет соответствие инфраструктуры 152-ФЗ. Публичные docs подтверждают private access/IAM, presigned operations, multipart Create/UploadPart/ListParts/Complete/Abort, CORS, lifecycle deletion incomplete uploads, Audit Trails и 99,98% service summary. Pricing складывается из storage, operations и egress; первые 1 GB storage, 10 000 write/list, 100 000 read и 100 GB egress в месяц описаны как free allowance. Точная цена зависит от юрлица/валюты и должна быть зафиксирована в budget approval.

Эти источники **не** являются принятым для АСПБ DPA/поручением обработки, budget approval или доказательством exact region всех logs/backups/support access. В публичных docs также не найдена гарантия, что presigned `UploadPart` на выбранном contour обязательно вернёт per-part cryptographic checksum. Поэтому adapter подписывает exact `Content-Length`, использует checksum из `ListParts`, если provider его вернул, и в любом случае повторно считает SHA-256 в worker и сверяет final `HeadObject` size/MIME. Exact checksum behavior остаётся staging acceptance item.

## Решение

Текущий выбранный contour, не требующий передачи видео внешнему провайдеру:

1. PostgreSQL хранит только metadata, tenant-связи, checkpoints, jobs, checksums и audit; исходные видео/HLS/poster/OGG не записываются в БД.
2. Bytes хранятся в private persistent volume, общий для API и worker, вне web root. Каталоги создаются с `0700`, файлы — с `0600`; filesystem path не является публичным контрактом.
3. Same-origin multipart endpoint перед каждым part проверяет User session, active tenant membership, связь AUTHOR с Webinar, CSRF, expiry, точный part number, `Content-Length` и MIME. После `fsync` сохраняются SHA-256 ETag и server checkpoint; restart восстанавливается из файловых checkpoints.
4. Собственный durable worker с `ffprobe`/`ffmpeg` выполняет MP4/MOV/WebM signature/size/checksum/duration/codec validation, создаёт HLS VOD, JPEG poster и private OGG/Opus rendition.
5. Manifest, каждый segment/poster и Range выдаются только через cookie-authorized application gateway с повторной проверкой `Organization`, `Webinar`, `WebinarSession`, registration, private grant и replay expiry.
6. CDN выключен. S3-compatible adapter сохранён как необязательный будущий путь, но не активируется и не требует закупки/credentials для текущего контура.

Multipart recovery учитывает окно между provider-side `CompleteMultipartUpload` и application transaction: `NoSuchUpload` при повторном `ListParts` не теряет загрузку; server checkpoints позволяют повторить complete, а `HeadObject` подтверждает MIME/размер до создания одного deduplicated job.

Local adapter, S3 adapter и worker добавлены, но безопасный default остаётся `MEDIA_STORAGE_PROVIDER=unconfigured`. Выбор self-hosted не включает production deploy, не создаёт внешний ресурс и не изменяет реальные credentials.

### Граница соответствия MED-001

Self-hosted endpoint передаёт каждую часть потоково и не буферизует полный файл
в памяти, однако bytes всё равно проходят через Express. Это осознанное
следствие выбранного односерверного контура и не равно требуемому в MED-001
direct upload в object storage. Поэтому local contour не является буквальным
MED-001. Production-capable S3 adapter предоставляет direct presigned PUT и API
явно возвращает provider-neutral browser contract
`transport=direct_object_storage`, `credentials=omit`, `fullFileProxy=false`,
bounded signed TTL и требуемые CORS headers. Resume сверяет provider `ListParts`
с server checkpoint, complete идемпотентно подтверждает MIME/size через
`HeadObject`, а abort/expiry cleanup и reconciliation пишут privacy-safe
lifecycle audit без key/bucket/origin. Provider-neutral MED-001 имеет статус
`implemented`, но станет `verified` только после отдельного
provider/legal/budget решения и staging acceptance. Эта граница не
переименовывает local filesystem в «object storage» и не считается закрытой его
тестами.

## Почему не PostgreSQL для video bytes

PostgreSQL остаётся источником истины для транзакционных данных и авторизации. Большие исходники и HLS-сегменты имеют другой жизненный цикл и I/O-профиль; размещение их в таблицах увеличило бы WAL, размер backup/restore и конкуренцию дискового I/O с tenant/auth/CRM данными. Persistent media volume резервируется и восстанавливается отдельно, согласованно с DB snapshot.

## Decision matrix

| Критерий | Yandex Cloud | Selectel | AWS |
| --- | --- | --- | --- |
| Регион/право/DPA | Object Storage для региона Россия; заявлена применимость 152-ФЗ. Договор, поручение обработки, применимое право и DPA должны быть получены и проверены юристом до switch | Доступны российские регионы/пулы. Точный S3 pool, договор и DPA требуют письменного подтверждения | Зрелые EU-регионы, но российской region нет; трансграничную передачу и договорную схему нужно отдельно разрешить юридически |
| Private bucket/origin | Private bucket/IAM и HTTPS; S3 origin не публикуется | Requests private by default, bucket policy поддерживается | Private S3 + Origin Access Control — зрелый вариант |
| Multipart/API | S3-compatible Create/UploadPart/ListParts/Complete/Abort; AWS SDK совместим | S3 multipart, SigV4, CORS и presigned URL поддерживаются | Reference implementation, полный multipart API |
| CORS/signed operations | Bucket CORS и pre-signed operations; TTL ограничивает приложение | CORS и presigned URL; документация указывает 15-минутный срок подписи | Bucket CORS и presigned URLs |
| CDN private auth | Secure token — signed link на path с expiry, optional IP; signed-cookie эквивалент в рассмотренных документах не найден | Secure access доступен, но отдельно проверяется HLS/Range и origin hardening | CloudFront поддерживает signed URL и signed cookies; cookies удобны для набора HLS files |
| Range/HLS | Object reads/Range и CDN нужно подтвердить smoke/load тестом; приложение уже сохраняет `206`/`Content-Range` | Требуется provider acceptance | Зрелая поддержка, но юридический регион остаётся блокером |
| Incomplete multipart | Bucket lifecycle умеет удалять incomplete multipart; дополнительно работает application abort/cleanup через 24 часа | Bucket Lifecycle в compatibility table не поддерживается; документация предупреждает о постановке parts на удаление через 6 месяцев без гарантии срока и возлагает контроль на клиента | Lifecycle `AbortIncompleteMultipartUpload` |
| Стоимость, snapshot | Standard storage: 2,376 ₽/GB-month; первые 1 GB, 10k write/list и 100k read operations бесплатны. Первые 100 GB egress бесплатны; пример official price сверх 100 GB до 1 TB — 1,67994 ₽/GB. Перед закупкой пересчитать текущий прайс | Storage, requests и egress; запросить коммерческий расчёт для source + renditions + multipart residue + CDN | Storage/request/egress/CloudFront/MediaConvert либо Compute; currency/cross-border risk |
| Transcoding | Отдельный managed transcoder не нужен: платятся worker VM/container CPU/RAM/disk по секундам и внутренний трафик; нужен benchmark ₽/час видео | Можно запустить собственный worker в российском pool | Self-hosted ffmpeg или MediaConvert; последний имеет отдельный per-minute tariff |
| SLA/limits/observability | Object Storage заявляет 99,98% SLA и replication по availability zones; Monitoring/Audit Trails/bucket logs доступны. Квоты и alert delivery проверяются на staging | SLA/limits/metrics требуют contract review; S3 migration deadline 15.09.2026 нужно учесть | Самая зрелая observability, но не снимает legal blocker |
| Собственный ffmpeg | Да, Compute/Container worker | Да | Да |

Стоимость приведена только как снимок официальной публичной страницы на дату исследования, с НДС для российского договора. Бюджет считать по фактическим минутам source video, числу renditions, сроку хранения, просмотрам/Range и коэффициенту повторной обработки.

## Почему не прямой CDN switch

HLS — это manifest и множество ресурсов. Требование АСПБ требует перед каждым чтением заново проверять точные `Organization`, `Webinar`, `WebinarSession`, participant registration, private grant и replay policy. Короткая подпись URL уменьшает окно утечки, но не отзывает уже выданную ссылку немедленно. Поэтому текущий correctness contour проксирует private bytes через авторизационный gateway. До CDN switch нужны:

- edge authorization design с немедленным revoke либо явно утверждённым максимальным окном;
- защита origin от обхода CDN;
- HLS manifest rewrite и authorization каждого variant/segment/key;
- Range/seek acceptance и нагрузочный тест, доказывающий, что Node gateway не становится bottleneck;
- CDN request/access logs без query token и ПДн.

## Реализованный env-контракт

См. `.env.production.example`:

- `MEDIA_STORAGE_PROVIDER=unconfigured|local_fs|s3|test_fake`;
- `MEDIA_LOCAL_ROOT` — абсолютный private path вне `crisis_premium`; в Docker зафиксирован `/var/lib/aspb/media` на named volume, одинаковый для API и worker;
- `MEDIA_S3_ENDPOINT`, `MEDIA_S3_REGION`, `MEDIA_S3_BUCKET`;
- `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`;
- `MEDIA_S3_FORCE_PATH_STYLE`, `MEDIA_SIGNED_OPERATION_TTL_SECONDS`;
- `MEDIA_TRANSCODE_TIMEOUT_SECONDS`, `MEDIA_HLS_SEGMENT_SECONDS`;
- `MEDIA_FFMPEG_PATH`, `MEDIA_FFPROBE_PATH`;
- `MEDIA_WORK_ROOT`, `MEDIA_PROCESSING_SPACE_MULTIPLIER`,
  `MEDIA_PROCESSING_RESERVE_BYTES`, `MEDIA_MIN_FREE_INODES`;
- `MEDIA_WORKER_CONCURRENCY`, `CONTENT_WORKER_CONCURRENCY`,
  `MEDIA_QUEUE_ALERT_THRESHOLD`, `CONTENT_QUEUE_ALERT_THRESHOLD`;
- exact HTTPS allowlist `MEDIA_UPLOAD_CSP_ORIGINS`.

`test_fake` разрешён только при `NODE_ENV=test`. Production guard для `local_fs` требует абсолютный private root вне web root; readiness проверяет доступность и запись в volume без раскрытия пути. S3 guard требует полный real config и отклоняет HTTP/localhost endpoint. Secrets не входят в репозиторий и не должны использоваться совместно со STT/AI.

## Операционная точка утверждения self-hosted

До staging switch необходимо утвердить и проверить:

- persistent volume не является ephemeral container layer и одновременно смонтирован в API/worker;
- capacity/inode alerts и запас под source + временные renditions + повторную обработку;
- согласованный backup/restore пары PostgreSQL + media volume и контрольный playback после restore;
- права Unix, запуск container не от root, отсутствие volume/web-root в static routes;
- MP4/MOV/WebM, max size, повреждение, MIME/signature, duration limit, interrupted multipart, repeat complete, transcoder timeout, protected HLS/Range и cross-tenant acceptance;
- Node gateway load profile. Переход к нескольким application hosts требует общего private filesystem с доказанной семантикой либо отдельного решения о S3; локальные диски разных hosts не считаются одним storage.

## Внешняя точка утверждения для будущего S3/CDN

Только если позднее выбран внешний S3/CDN, до provider smoke обязательны письменные решения владельца бюджета и юриста/DPO:

- юридическое лицо поставщика, применимое право, DPA/поручение обработки, место всех replicas/backups/logs/support access;
- перечень субпроцессоров и порядок уведомления;
- удаление source/renditions/incomplete parts/backups и доказательство удаления;
- SLA/support, quotas, rate limits, budget alerts и согласованный месячный лимит;
- lifecycle policy и ключи service account/rotation в approved secret store.

## Официальные источники

- [Yandex Object Storage: S3 multipart API](https://yandex.cloud/en/docs/storage/s3/api-ref/multipart)
- [Yandex Object Storage: pre-signed URLs](https://yandex.cloud/en/docs/storage/concepts/pre-signed-urls)
- [Yandex Object Storage: access management and private/public access](https://yandex.cloud/en/docs/storage/security/overview)
- [Yandex Object Storage: operations, including CORS](https://yandex.cloud/en/docs/storage/operations/)
- [Yandex Object Storage: lifecycle](https://yandex.cloud/en/docs/storage/concepts/lifecycles)
- [Yandex Object Storage: quotas and limits](https://yandex.cloud/en/docs/storage/concepts/limits)
- [Yandex Object Storage: pricing](https://yandex.cloud/en/docs/storage/pricing)
- [Yandex Object Storage: service/SLA summary](https://yandex.cloud/en/services/storage)
- [Yandex Object Storage: Audit Trails events](https://yandex.cloud/en/docs/storage/at-ref)
- [Yandex Cloud: data privacy](https://yandex.cloud/en/security/data-privacy)
- [Yandex Cloud CDN: secure tokens](https://yandex.cloud/en/docs/cdn/concepts/secure-tokens)
- [Yandex Cloud CDN: pricing](https://yandex.cloud/en/docs/cdn/pricing)
- [Selectel: S3 compatibility](https://docs.selectel.ru/en/api/object-storage-s3/)
- [Selectel: incomplete multipart warning](https://docs.selectel.ru/en/s3/objects/upload-object/)
- [Selectel: infrastructure locations](https://docs.selectel.ru/en/infrastructure/locations/)
- [AWS S3: multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [AWS CloudFront: signed URL vs signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-choosing-signed-urls-cookies.html)
- [AWS Elemental MediaConvert: pricing](https://aws.amazon.com/mediaconvert/pricing/)
