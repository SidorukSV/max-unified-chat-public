# Развертывание Единого чата MAX на Debian через Docker

Инструкция предназначена для backend/API-приложения Единого чата и рассылок.

## 1. Требования

- Debian 12 или совместимая Linux-система.
- Публичный домен, направленный на VDS.
- Открытые входящие порты `80` и `443`.
- Docker Engine и Docker Compose.
- Домен должен корректно указывать на VDS: Caddy сам выпустит доверенный TLS-сертификат Let's Encrypt.
- Токен бота MAX.
- Сервисный ключ для обмена 1С ↔ VDS.

## 2. Установка Docker

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## 3. Подготовка проекта

```bash
git clone https://github.com/SidorukSV/max-unified-chat-public.git
cd max-unified-chat-public
cp backend/.env.production.example backend/.env.production
mkdir -p logs
```

## 4. Настройка backend

Откройте `backend/.env.production` и заполните значения:

```env
ONEC_API_KEY=replace_with_strong_random_service_key
MAX_WEBHOOK_SECRET=replace_with_max_webhook_secret
PUBLIC_DOMAIN=chat.example.com
MAX_BOT_TOKEN=replace_with_max_bot_token
MAX_WEBHOOK_URL=https://chat.example.com/api/v1/max/webhook
CORS_ALLOWED_ORIGINS=https://chat.example.com
```

Рекомендации:

- `ONEC_API_KEY` должен быть длинной случайной строкой, известной только 1С и backend.
- `MAX_WEBHOOK_SECRET` должен совпадать с секретом webhook-подписки MAX.
- `MAX_BOT_TOKEN` не передавать в 1С, если 1С отправляет сообщения только через backend.

## 5. Настройка обмена в 1С

В базе 1С нужно установить расширение `бит_МедицинаМАКС.cfe` и заполнить настройки раздела `MAX.VDS`:

```text
MAX_VDS_URL=https://chat.example.com
MAX_VDS_API_KEY=<ONEC_API_KEY>
MAX_VDS_POLL_LIMIT=50
MAX_VDS_LONG_POLL_WAIT_MS=25000
```

После установки расширения должно быть включено регламентное задание:

```text
бит_омни_ОбменСообщениямиMAXЧерезVDS
```

Задание вызывает backend методом long polling:

```text
GET https://chat.example.com/api/v1/onec/messages/incoming?limit=50&waitMs=25000
```

с заголовком:

```http
X-Onec-Api-Key: <ONEC_API_KEY>
```

Исходящие сообщения из 1С отправляются методом:

```text
POST https://chat.example.com/api/v1/onec/messages/outgoing
```

Формат payload и детали настроек описаны в `ONEC-API.MD`.

## 6. TLS-сертификаты

Сертификаты выпускает Caddy автоматически через Let's Encrypt.

Перед запуском проверьте:

- домен из `PUBLIC_DOMAIN` указывает на IP сервера;
- входящие порты `80` и `443` открыты;
- на сервере нет другого процесса, занимающего `80/443`.

## 7. Запуск

```bash
docker compose up -d --build
docker compose ps
```

Проверка:

```bash
curl https://chat.example.com/healthz
curl https://chat.example.com/api/v1/version
```

Проверка polling API:

```bash
curl "https://chat.example.com/api/v1/onec/messages/incoming?limit=1" \
  -H "X-Onec-Api-Key: ${ONEC_API_KEY}"
```

## 8. Подключение webhook MAX

После запуска backend выполните:

```bash
chmod +x scripts/subscribe-max-webhook.sh
./scripts/subscribe-max-webhook.sh --url https://chat.example.com/api/v1/max/webhook
```

Скрипт читает `MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET` и `MAX_WEBHOOK_URL` из `backend/.env.production`.

## 9. Обновление

```bash
git pull
docker compose up -d --build
docker compose logs -f backend
```

Если менялись секреты или домен, отредактируйте `backend/.env.production`, затем перезапустите:

```bash
docker compose restart backend
```

## 10. Диагностика

Логи контейнеров:

```bash
docker compose logs -f backend
docker compose logs -f gateway
docker compose logs -f redis
```

Файловый лог backend:

```bash
tail -f logs/backend.log
```

Проверка Redis:

```bash
docker compose exec redis redis-cli ping
```

Ожидаемый ответ: `PONG`.
