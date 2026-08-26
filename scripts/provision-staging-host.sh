#!/usr/bin/env bash

set -Eeuo pipefail

deploy_path="${1:-}"
public_host="${2:-}"
bind_port="${3:-}"
container_prefix="${4:-}"
postgres_container="${5:-}"

expected_public_host="staging.72-56-38-62.sslip.io"
expected_bind_port="5176"
expected_container_prefix="aspb-platform-staging"
expected_postgres_container="aspb-platform-staging-postgres"
staging_database="aspb_staging"
staging_role="aspb_staging_app"
staging_postgres_port="5434"
staging_certificate_name="aspb-autowebinar-staging"
public_origin="https://$public_host"
staging_secret_marker="isolated-v1"
staging_admin_login="staging-admin@aspb.test"

if [[ "$deploy_path" != /* || ! -d "$deploy_path" || -L "$deploy_path" ]]; then
  echo "STAGING deploy path must be an existing absolute non-symlink directory" >&2
  exit 1
fi
if [[ "$public_host" != "$expected_public_host" ]]; then
  echo "Refusing unreviewed STAGING hostname: $public_host" >&2
  exit 1
fi
if [[ "$bind_port" != "$expected_bind_port" ]]; then
  echo "Refusing unreviewed STAGING bind port: $bind_port" >&2
  exit 1
fi
if [[ "$container_prefix" != "$expected_container_prefix" ]]; then
  echo "Refusing unreviewed STAGING container prefix: $container_prefix" >&2
  exit 1
fi
if [[ "$postgres_container" != "$expected_postgres_container" ]]; then
  echo "Refusing unreviewed STAGING PostgreSQL container: $postgres_container" >&2
  exit 1
fi

for required_command in awk certbot docker flock getent nginx node openssl sed sudo; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required STAGING provisioning command: $required_command" >&2
    exit 1
  fi
done
deploy_lock_file=/tmp/aspb-autowebinar-deploy.lock
exec 9>"$deploy_lock_file"
if ! flock -n 9; then
  echo "Another deployment or STAGING provisioning action is already running" >&2
  exit 75
fi
resolved_public_ip="$(getent ahostsv4 "$public_host" | awk 'NR == 1 { print $1 }')"
if [[ "$resolved_public_ip" != "72.56.38.62" ]]; then
  echo "Reviewed STAGING hostname does not resolve to the reviewed server address" >&2
  exit 1
fi
if ! sudo -n true >/dev/null 2>&1; then
  echo "Passwordless sudo is required for reviewed Nginx/TLS provisioning" >&2
  exit 1
fi
if ! docker inspect "$postgres_container" >/dev/null 2>&1; then
  echo "Reviewed STAGING PostgreSQL container is unavailable: $postgres_container" >&2
  exit 1
fi
if [[ "$(docker inspect --format '{{.State.Running}}' "$postgres_container")" != "true" ]]; then
  echo "Reviewed STAGING PostgreSQL container is not running" >&2
  exit 1
fi

postgres_port_record="$(docker port "$postgres_container" 5432/tcp | head -n 1)"
if [[ ! "$postgres_port_record" =~ :${staging_postgres_port}$ ]]; then
  echo "STAGING PostgreSQL must expose container port 5432 on reviewed host port $staging_postgres_port" >&2
  exit 1
fi
postgres_host="${postgres_port_record%:*}"
if [[ "$postgres_host" == "0.0.0.0" ]]; then
  postgres_host="127.0.0.1"
fi
if [[ "$postgres_host" != "127.0.0.1" && "$postgres_host" != "172.17.0.1" ]]; then
  echo "Refusing unexpected STAGING PostgreSQL bind address: $postgres_host" >&2
  exit 1
fi

if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$bind_port" 2>/dev/null | grep -q .; then
  existing_api_id="$(docker ps -q --filter "name=^/${container_prefix}-api$")"
  if [[ -z "$existing_api_id" ]]; then
    echo "STAGING application port $bind_port is occupied by an unreviewed process" >&2
    exit 1
  fi
fi

env_file="$deploy_path/.env.production"
if [[ ! -f "$env_file" || -L "$env_file" ]]; then
  echo "STAGING .env.production must be a regular non-symlink file" >&2
  exit 1
fi
env_mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")"
if [[ "$env_mode" != "600" ]]; then
  echo "STAGING .env.production must have mode 0600 before provisioning" >&2
  exit 1
fi

read_env_value() {
  local name="$1" value
  value="$(sed -n "s/^${name}=//p" "$env_file" | tail -n 1)"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value:1:${#value}-2}" ;;
    \'*\') value="${value:1:${#value}-2}" ;;
  esac
  printf '%s' "$value"
}

set_env_value() {
  local key="$1" value="$2" temporary
  if [[ ! "$key" =~ ^[A-Z][A-Z0-9_]*$ || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "Refusing unsafe environment update for $key" >&2
    exit 1
  fi
  temporary="$(mktemp "$deploy_path/.env.production.XXXXXX")"
  chmod 600 "$temporary"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" {
      if (!replaced) print key "=" value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$env_file" > "$temporary"
  mv "$temporary" "$env_file"
}

backup_dir="$deploy_path/backups/staging-provision"
mkdir -p "$backup_dir"
chmod 700 "$deploy_path/backups" "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
env_backup="$backup_dir/env-production-$timestamp.backup"
if [[ -e "$env_backup" ]]; then
  echo "Refusing to overwrite an existing STAGING environment backup" >&2
  exit 1
fi
cp --preserve=mode,timestamps "$env_file" "$env_backup"
chmod 600 "$env_backup"

existing_database_url="$(read_env_value DATABASE_URL)"
existing_public_origin="$(read_env_value PUBLIC_SITE_URL)"
existing_secret_marker="$(read_env_value ASPB_STAGING_SECRET_SET_ID)"
staging_password="$(node --input-type=module -e '
  try {
    const value = new URL(process.argv[1]);
    if (value.username === "aspb_staging_app" && value.pathname === "/aspb_staging") {
      const password = decodeURIComponent(value.password);
      if (/^[a-f0-9]{64}$/.test(password)) process.stdout.write(password);
    }
  } catch {}
' "$existing_database_url")"
if [[ -z "$staging_password" ]]; then
  staging_password="$(openssl rand -hex 32)"
fi
if [[ ! "$staging_password" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Generated STAGING database credential failed validation" >&2
  exit 1
fi

isolated_hex_secret() {
  local key="$1" current
  current="$(read_env_value "$key")"
  if [[ "$existing_public_origin" == "$public_origin" && "$existing_secret_marker" == "$staging_secret_marker" && "$current" =~ ^[a-f0-9]{64}$ ]]; then
    printf '%s' "$current"
  else
    openssl rand -hex 32
  fi
}

staging_admin_password="$(read_env_value ADMIN_PASSWORD)"
if [[ "$existing_public_origin" != "$public_origin" || "$existing_secret_marker" != "$staging_secret_marker" || ! "$staging_admin_password" =~ ^Staging1-[a-f0-9]{48}$ ]]; then
  staging_admin_password="Staging1-$(openssl rand -hex 24)"
fi
staging_admin_cookie_secret="$(isolated_hex_secret ADMIN_COOKIE_SECRET)"
staging_ip_hash_secret="$(isolated_hex_secret IP_HASH_SECRET)"
staging_access_hash_secret="$(isolated_hex_secret WEBINAR_ACCESS_HASH_SECRET)"
staging_metrics_token="$(isolated_hex_secret METRICS_TOKEN)"
staging_media_origin_token="$(isolated_hex_secret WEBINAR_MEDIA_ORIGIN_TOKEN)"

postgres_owner="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$postgres_container" | sed -n 's/^POSTGRES_USER=//p' | tail -n 1)"
postgres_admin_database="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$postgres_container" | sed -n 's/^POSTGRES_DB=//p' | tail -n 1)"
postgres_owner="${postgres_owner:-postgres}"
postgres_admin_database="${postgres_admin_database:-$postgres_owner}"

role_exists="$(docker exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U "$postgres_owner" -d "$postgres_admin_database" -tAc "SELECT 1 FROM pg_roles WHERE rolname='$staging_role'")"
if [[ "$role_exists" != "1" ]]; then
  docker exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U "$postgres_owner" -d "$postgres_admin_database" \
    -c "CREATE ROLE $staging_role LOGIN PASSWORD '$staging_password'" >/dev/null
else
  docker exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U "$postgres_owner" -d "$postgres_admin_database" \
    -c "ALTER ROLE $staging_role WITH LOGIN PASSWORD '$staging_password'" >/dev/null
fi

database_exists="$(docker exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U "$postgres_owner" -d "$postgres_admin_database" -tAc "SELECT 1 FROM pg_database WHERE datname='$staging_database'")"
if [[ "$database_exists" != "1" ]]; then
  docker exec "$postgres_container" createdb -U "$postgres_owner" -O "$staging_role" "$staging_database"
fi
docker exec "$postgres_container" psql -v ON_ERROR_STOP=1 -U "$postgres_owner" -d "$postgres_admin_database" \
  -c "ALTER DATABASE $staging_database OWNER TO $staging_role" >/dev/null

postgres_scheme=postgresql
database_url="${postgres_scheme}://$staging_role:$staging_password@host.docker.internal:$staging_postgres_port/$staging_database?schema=public&connection_limit=10&pool_timeout=20"
backup_database_url="${postgres_scheme}://$staging_role:$staging_password@$postgres_host:$staging_postgres_port/$staging_database?schema=public"

set_env_value NODE_ENV production
set_env_value PORT 5174
set_env_value PUBLIC_SITE_URL "$public_origin"
set_env_value CORS_ORIGIN "$public_origin"
set_env_value ASPB_STAGING_SECRET_SET_ID "$staging_secret_marker"
set_env_value ADMIN_LOGIN "$staging_admin_login"
set_env_value ADMIN_PASSWORD "$staging_admin_password"
set_env_value ADMIN_COOKIE_SECRET "$staging_admin_cookie_secret"
set_env_value IP_HASH_SECRET "$staging_ip_hash_secret"
set_env_value WEBINAR_ACCESS_HASH_SECRET "$staging_access_hash_secret"
set_env_value METRICS_TOKEN "$staging_metrics_token"
set_env_value WEBINAR_MEDIA_ORIGIN_TOKEN "$staging_media_origin_token"
set_env_value DATABASE_URL "$database_url"
set_env_value PG_DATABASE_URL "$backup_database_url"
set_env_value ASPB_CONTAINER_PREFIX "$container_prefix"
set_env_value ASPB_BIND_PORT "$bind_port"
set_env_value COMPOSE_PROJECT_NAME "$container_prefix"
set_env_value EMAIL_MODE log
set_env_value E2E_EMAIL_OUTBOX_ENABLED off
set_env_value SMTP_HOST ''
set_env_value SMTP_USER ''
set_env_value SMTP_PASS ''
set_env_value MEDIA_STORAGE_PROVIDER unconfigured
set_env_value MEDIA_S3_ENDPOINT ''
set_env_value MEDIA_S3_BUCKET ''
set_env_value MEDIA_S3_ACCESS_KEY_ID ''
set_env_value MEDIA_S3_SECRET_ACCESS_KEY ''
set_env_value STT_PROVIDER unconfigured
set_env_value STT_YANDEX_API_KEY ''
set_env_value STT_YANDEX_FOLDER_ID ''
set_env_value STT_YANDEX_AUDIO_URI_PREFIX ''
set_env_value AI_ENRICHMENT_PROVIDER unconfigured
set_env_value AI_YANDEX_API_KEY ''
set_env_value AI_YANDEX_FOLDER_ID ''
set_env_value AI_YANDEX_MODEL_URI ''
set_env_value TELEGRAM_GROUP_URL https://t.me/example
set_env_value TELEGRAM_NOTIFY_MODE log
set_env_value TELEGRAM_ADMIN_BOT_TOKEN ''
set_env_value TELEGRAM_BOT_TOKEN ''
set_env_value TELEGRAM_PARTICIPANT_BOT_TOKEN ''
set_env_value TELEGRAM_CONSULTANT_BOT_TOKEN ''
set_env_value TELEGRAM_ADMIN_CHAT_ID ''
set_env_value TELEGRAM_OPERATIONAL_CHAT_ID ''
set_env_value TELEGRAM_ADMIN_BOT_POLLING off
set_env_value TELEGRAM_BOT_POLLING off
set_env_value TELEGRAM_PARTICIPANT_BOT_POLLING off
set_env_value TELEGRAM_CONSULTANT_BOT_POLLING off
set_env_value TELEGRAM_NEWS_BROADCAST off
set_env_value TELEGRAM_MANUAL_BROADCAST off
set_env_value TENANT_TELEGRAM_BOTS_ENABLED off
set_env_value RETENTION_APPLY_ENABLED off
set_env_value ADMIN_DEV_BYPASS false
set_env_value WEBINAR_TEST_ROOM_MODE off
set_env_value WEBINAR_PREVIEW_MODE off
chmod 600 "$env_file"

configured_origin="$(read_env_value PUBLIC_SITE_URL)"
configured_database_url="$(read_env_value DATABASE_URL)"
if [[ "$configured_origin" != "$public_origin" || "$configured_database_url" != *"/$staging_database?"* ]]; then
  echo "STAGING environment isolation verification failed" >&2
  exit 1
fi
if [[ "$configured_origin" == *"aspb-partners.ru"* || "$configured_database_url" == *"aspb_autowebinar"* ]]; then
  echo "STAGING environment still references a production marker" >&2
  exit 1
fi
for isolated_secret in ADMIN_COOKIE_SECRET IP_HASH_SECRET WEBINAR_ACCESS_HASH_SECRET METRICS_TOKEN WEBINAR_MEDIA_ORIGIN_TOKEN; do
  if [[ ! "$(read_env_value "$isolated_secret")" =~ ^[a-f0-9]{64}$ ]]; then
    echo "STAGING isolated secret validation failed for $isolated_secret" >&2
    exit 1
  fi
done
if [[ "$(read_env_value ASPB_STAGING_SECRET_SET_ID)" != "$staging_secret_marker" || "$(read_env_value ADMIN_LOGIN)" != "$staging_admin_login" ]]; then
  echo "STAGING secret isolation marker validation failed" >&2
  exit 1
fi

acme_root="/var/www/aspb-staging-acme"
nginx_available="/etc/nginx/sites-available/aspb-staging-autowebinar"
nginx_enabled="/etc/nginx/sites-enabled/aspb-staging-autowebinar"
sudo install -d -m 755 "$acme_root" /etc/nginx/sites-available /etc/nginx/sites-enabled
if sudo test -e "$nginx_available"; then
  sudo cp --preserve=mode,timestamps "$nginx_available" "$backup_dir/nginx-$timestamp.backup"
fi

initial_nginx="$(mktemp)"
cat > "$initial_nginx" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $public_host;

    location ^~ /.well-known/acme-challenge/ {
        root $acme_root;
    }

    location / {
        return 503;
    }
}
NGINX
sudo install -m 644 "$initial_nginx" "$nginx_available"
rm -f -- "$initial_nginx"
sudo ln -sfn "$nginx_available" "$nginx_enabled"
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --webroot -w "$acme_root" -d "$public_host" \
  --cert-name "$staging_certificate_name" \
  --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring

final_nginx="$(mktemp)"
cat > "$final_nginx" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $public_host;

    location ^~ /.well-known/acme-challenge/ {
        root $acme_root;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $public_host;

    ssl_certificate /etc/letsencrypt/live/$staging_certificate_name/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$staging_certificate_name/privkey.pem;
    client_max_body_size 5g;

    location / {
        proxy_pass http://127.0.0.1:$bind_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
sudo install -m 644 "$final_nginx" "$nginx_available"
rm -f -- "$final_nginx"
sudo nginx -t
sudo systemctl reload nginx

certificate_subject="$(sudo openssl x509 -in "/etc/letsencrypt/live/$staging_certificate_name/fullchain.pem" -noout -subject)"
if [[ "$certificate_subject" != *"$public_host"* ]]; then
  echo "Issued certificate subject does not match the reviewed STAGING hostname" >&2
  exit 1
fi

printf 'staging_provisioned=true\n'
printf 'staging_origin=%s\n' "$public_origin"
printf 'staging_database=%s\n' "$staging_database"
printf 'staging_container_prefix=%s\n' "$container_prefix"
printf 'staging_bind_port=%s\n' "$bind_port"
printf 'external_notifications=disabled\n'
printf 'environment_backup=%s\n' "$env_backup"
