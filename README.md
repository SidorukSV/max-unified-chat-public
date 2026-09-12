# MAX Unified Chat Backend

Отдельный публичный репозиторий backend-приложения для Единого чата и рассылок MAX.

Репозиторий содержит только backend/API и расширение 1С. Приложение предназначено для серверного обмена:

- MAX отправляет события на webhook backend;
- backend кладет входящие события в очередь/хранилище Redis;
- 1С регламентным заданием опрашивает backend/VDS и забирает сообщения;
- 1С отправляет исходящие сообщения через backend;
- backend передает исходящие сообщения в MAX.

## Состав

Напоминания за сутки/два часа, callback-подтверждение записи и редактор кнопок:
[обновление и настройка](install-guide/APPOINTMENT-REMINDERS.md).

Настраиваемые даты рассылок, смещение до/после даты контекста и ручной алгоритм:
[Событийная очередь и даты отправки — версия 1.1.0.36](install-guide/EVENT-DATES.md).

Предрелизные исправления, локальная приёмка и оставшиеся ограничения:
[расширение 1.1.0.36 / backend 1.0.7](install-guide/ACCEPTANCE-1.1.0.36.md).

- `backend/` — Node.js/Fastify API-сервис.
- `onec/` — исходники расширения 1С.
- `deploy/caddy/` — reverse proxy с автоматическим TLS и проксированием API.
- `scripts/subscribe-max-webhook.sh` — настройка webhook подписки MAX.
- `install-guide/DEBIAN-DOCKER.md` — инструкция развертывания на Debian через Docker.
- `ONEC-API.MD` — описание API backend, вызываемого из 1С.

## Технологии

- Node.js 22
- Fastify
- Redis 7
- Docker / Docker Compose
- Caddy reverse proxy с автоматическим Let's Encrypt TLS
- 1С: исходящий HTTPS-обмен регламентными заданиями, без входящей публикации 1С

## Быстрый запуск на сервере

```bash
cp backend/.env.production.example backend/.env.production

# заполнить секреты MAX и сервисный ключ 1С
nano backend/.env.production

docker compose up -d --build
```

Проверка:

```bash
curl https://chat.example.com/healthz
curl https://chat.example.com/api/v1/version
```

## Важные ограничения

- Пользовательский веб-интерфейс в этот репозиторий не входит.
- Запись на прием через пользовательский веб-интерфейс не входит.
- Backend должен быть доступен MAX по публичному HTTPS URL.
- Реальные секреты не должны попадать в git.

## Проверки backend

В каталоге `backend` выполните `npm test`. Тесты транспорта используют память и
подменённые HTTP-вызовы, не отправляют сообщения MAX и не подключаются к 1С.

Дополнительная проверка claim/ACK на уже запущенном тестовом Redis:

```bash
REDIS_QUEUE_TEST_URL=redis://127.0.0.1:6379 node --test test/incomingQueueRedis.test.js
```

Тест создаёт уникальный набор ключей `max:queue-regression:<uuid>`, удаляет только
эти ключи по завершении и не выполняет `FLUSHDB`, перезапуск Redis или контейнеров.
В обычном запуске без `REDIS_QUEUE_TEST_URL` этот интеграционный тест пропускается.
Контракт обработки с арендой и подтверждением описан в [ONEC-API.MD](ONEC-API.MD).
