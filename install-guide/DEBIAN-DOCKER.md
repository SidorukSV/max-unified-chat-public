# Развертывание Единого чата MAX на Debian через Docker

Инструкция предназначена для отдельного backend/API-приложения Единого чата и рассылок.

## 1. Требования

- Debian 12 или совместимая Linux-система.
- Публичный домен, направленный на VDS.
- Открытые входящие порты `80` и `443`.
- Docker Engine и Docker Compose plugin.
- Доверенный TLS-сертификат для домена.
- Опубликованный HTTP-сервис 1С, доступный с VDS.
- Токен бота MAX и webhook secret.

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
cp backend/onec-config.example.yml backend/onec-config.yml
mkdir -p deploy/certs logs
```

## 4. Настройка backend

Откройте `backend/.env.production` и заполните значения:

```env
JWT_SECRET=replace_with_strong_random_secret
MAX_WEBHOOK_SECRET=replace_with_max_webhook_secret
MAX_BOT_TOKEN=replace_with_max_bot_token
MAX_WEBHOOK_URL=https://chat.example.com/api/v1/max/webhook
CORS_ALLOWED_ORIGINS=https://chat.example.com
```

`JWT_SECRET` должен быть случайной строкой не короче 32 символов.

## 5. Настройка подключения к 1С

Откройте `backend/onec-config.yml`:

```yaml
url: "https://example.com/base/hs/omni/v1"
basicAuth: "base64_login_password"
```

`url` — полный корень HTTP-сервиса 1С, включая имя базы и `/hs/omni/v1`.

## 6. TLS-сертификаты

Nginx ожидает:

- `deploy/certs/fullchain.pem`
- `deploy/certs/privkey.pem`

Можно использовать сертификаты Let's Encrypt или сертификаты, выпущенные инфраструктурой клиента.

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

Если менялись настройки 1С или секреты, отредактируйте `backend/.env.production` и `backend/onec-config.yml`, затем перезапустите:

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
