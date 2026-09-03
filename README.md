# MAX Unified Chat Backend

Отдельный публичный репозиторий backend-приложения для Единого чата и рассылок MAX.

Репозиторий содержит только backend/API и расширение 1С. Приложение предназначено для серверного обмена:

- MAX отправляет события на webhook backend;
- backend кладет входящие события в очередь/хранилище Redis;
- 1С регламентным заданием опрашивает backend/VDS и забирает сообщения;
- 1С отправляет исходящие сообщения через backend;
- backend передает исходящие сообщения в MAX.

## Состав

- `backend/` — Node.js/Fastify API-сервис.
- `onec/` — исходники расширения 1С.
- `deploy/nginx/` — reverse proxy для HTTPS и проксирования API.
- `scripts/subscribe-max-webhook.sh` — настройка webhook подписки MAX.
- `install-guide/DEBIAN-DOCKER.md` — инструкция развертывания на Debian через Docker.
- `ONEC-API.MD` — описание HTTP API 1С.

## Технологии

- Node.js 22
- Fastify
- Redis 7
- Docker / Docker Compose
- Nginx reverse proxy
- 1С HTTP-сервис/регламентный обмен

## Быстрый запуск на сервере

```bash
cp backend/.env.production.example backend/.env.production
cp backend/onec-config.example.yml backend/onec-config.yml

# заполнить секреты и URL 1С
nano backend/.env.production
nano backend/onec-config.yml

docker compose up -d --build
```

Проверка:

```bash
curl -k https://localhost/healthz
curl -k https://localhost/api/v1/version
```

## Важные ограничения

- Пользовательский веб-интерфейс в этот репозиторий не входит.
- Запись на прием через пользовательский веб-интерфейс не входит.
- Backend должен быть доступен MAX по публичному HTTPS URL.
- Реальные секреты не должны попадать в git.
