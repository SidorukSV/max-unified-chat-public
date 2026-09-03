#!/usr/bin/env bash

# При явном запуске через `sh script.sh` shebang не учитывается. Перезапускаем
# скрипт в Bash до первой Bash-специфичной конструкции.
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi

  printf 'Ошибка: для запуска скрипта требуется Bash.\n' >&2
  exit 1
fi

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
ENV_FILE="${PROJECT_DIR}/backend/.env.production"
WEBHOOK_URL="${MAX_WEBHOOK_URL:-}"
MAX_API_BASE_URL="${MAX_API_BASE_URL:-https://platform-api2.max.ru}"
UPDATE_TYPES_JSON='["message_created","bot_started","bot_stopped","message_callback"]'
MAX_CA_CERT="${MAX_CA_CERT:-${SCRIPT_DIR}/certificates/russian-trusted-root-ca.pem}"

usage() {
  cat <<'EOF'
Подключает MAX-бота к webhook текущего сервера.

Использование:
  ./scripts/subscribe-max-webhook.sh [параметры]

Параметры:
  --url URL          Полный URL webhook. По умолчанию берётся MAX_WEBHOOK_URL,
                     либо первый домен из CORS_ALLOWED_ORIGINS и путь
                     /api/v1/max/webhook
  --env-file PATH    Файл с переменными окружения
                     (по умолчанию backend/.env.production)
  -h, --help         Показать справку

Необходимые переменные:
  MAX_BOT_TOKEN      Токен бота MAX

Необязательные переменные:
  MAX_WEBHOOK_SECRET Секрет заголовка X-Max-Bot-Api-Secret
  MAX_WEBHOOK_URL    Полный публичный HTTPS URL webhook
  MAX_CA_CERT        CA-сертификат API MAX
EOF
}

die() {
  printf 'Ошибка: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --url)
      (($# >= 2)) || die "для --url требуется значение"
      WEBHOOK_URL="$2"
      shift 2
      ;;
    --env-file)
      (($# >= 2)) || die "для --env-file требуется значение"
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "неизвестный параметр: $1"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "не найдена команда curl"
[[ -f "$MAX_CA_CERT" ]] || die "не найден CA-сертификат MAX: ${MAX_CA_CERT}"

read_env_value() {
  local name="$1"
  local line value

  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -m 1 -E "^[[:space:]]*${name}[[:space:]]*=" "$ENV_FILE" || true)"
  [[ -n "$line" ]] || return 0

  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [[ ${#value} -ge 2 ]]; then
    if [[ "$value" == \"*\" && "$value" == *\" ]] ||
       [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  printf '%s' "$value"
}

MAX_BOT_TOKEN="${MAX_BOT_TOKEN:-$(read_env_value MAX_BOT_TOKEN)}"
MAX_WEBHOOK_SECRET="${MAX_WEBHOOK_SECRET:-$(read_env_value MAX_WEBHOOK_SECRET)}"

if [[ -z "$WEBHOOK_URL" ]]; then
  WEBHOOK_URL="$(read_env_value MAX_WEBHOOK_URL)"
fi

if [[ -z "$WEBHOOK_URL" ]]; then
  CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-$(read_env_value CORS_ALLOWED_ORIGINS)}"
  PUBLIC_ORIGIN="${CORS_ALLOWED_ORIGINS%%,*}"
  PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"

  if [[ -n "$PUBLIC_ORIGIN" ]]; then
    WEBHOOK_URL="${PUBLIC_ORIGIN}/api/v1/max/webhook"
  fi
fi

[[ -n "$MAX_BOT_TOKEN" ]] ||
  die "MAX_BOT_TOKEN не задан ни в окружении, ни в ${ENV_FILE}"
[[ -n "$WEBHOOK_URL" ]] ||
  die "не удалось определить URL; задайте --url или MAX_WEBHOOK_URL"
[[ "$WEBHOOK_URL" == https://* ]] ||
  die "webhook должен использовать HTTPS: ${WEBHOOK_URL}"
[[ "$WEBHOOK_URL" != *[' "'\\$'\t'$'\r'$'\n']* ]] ||
  die "URL содержит недопустимые символы"

AUTHORITY="${WEBHOOK_URL#https://}"
AUTHORITY="${AUTHORITY%%/*}"
[[ -n "$AUTHORITY" && "$AUTHORITY" != *:* ]] ||
  die "в URL должен использоваться стандартный HTTPS-порт 443 без явного номера порта"

if [[ -n "$MAX_WEBHOOK_SECRET" ]]; then
  [[ "$MAX_WEBHOOK_SECRET" =~ ^[A-Za-z0-9_-]{5,256}$ ]] ||
    die "MAX_WEBHOOK_SECRET должен содержать 5–256 символов: A-Z, a-z, 0-9, _ или -"
  REQUEST_BODY="{\"url\":\"${WEBHOOK_URL}\",\"update_types\":${UPDATE_TYPES_JSON},\"secret\":\"${MAX_WEBHOOK_SECRET}\"}"
else
  printf 'Предупреждение: MAX_WEBHOOK_SECRET не задан; запросы webhook не будут защищены секретом.\n' >&2
  REQUEST_BODY="{\"url\":\"${WEBHOOK_URL}\",\"update_types\":${UPDATE_TYPES_JSON}}"
fi

RESPONSE_FILE="$(mktemp)"
trap 'rm -f -- "$RESPONSE_FILE"' EXIT

printf 'Подключение подписки на события MAX к %s\n' "$WEBHOOK_URL"
HTTP_STATUS="$(curl --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --cacert "$MAX_CA_CERT" \
  --output "$RESPONSE_FILE" \
  --write-out '%{http_code}' \
  --request POST \
  --header "Authorization: ${MAX_BOT_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data "$REQUEST_BODY" \
  "${MAX_API_BASE_URL%/}/subscriptions")" || die "не удалось вызвать MAX Bot API"

RESPONSE_BODY="$(<"$RESPONSE_FILE")"

if [[ "$HTTP_STATUS" != 2* ]]; then
  printf 'MAX Bot API вернул HTTP %s: %s\n' "$HTTP_STATUS" "$RESPONSE_BODY" >&2
  exit 1
fi

if ! grep -Eq '"success"[[:space:]]*:[[:space:]]*true' "$RESPONSE_FILE"; then
  printf 'MAX Bot API не подтвердил подписку: %s\n' "$RESPONSE_BODY" >&2
  exit 1
fi

printf 'Готово: подписка на message_created, bot_started, bot_stopped и message_callback подключена.\n'
