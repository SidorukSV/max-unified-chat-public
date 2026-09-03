# API обмена 1С ↔ VDS

Backend работает как публичный шлюз между MAX и 1С:

1. MAX отправляет webhook на VDS.
2. Backend проверяет секрет webhook и кладёт событие в Redis-очередь.
3. 1С регламентным заданием забирает входящие сообщения из backend.
4. 1С отправляет исходящие сообщения в backend.
5. Backend вызывает MAX Bot API `POST /messages`.

## Авторизация 1С

Все методы `/api/v1/onec/*` требуют сервисный ключ.

Можно передать ключ одним из способов:

```http
X-Onec-Api-Key: <ONEC_API_KEY>
```

или:

```http
Authorization: Bearer <ONEC_API_KEY>
```

Секрет задаётся в `backend/.env.production`:

```env
ONEC_API_KEY=replace_with_strong_random_service_key
```

## Входящие сообщения MAX для 1С

### `GET /api/v1/onec/messages/incoming`

1С вызывает метод по расписанию и забирает пачку входящих событий.

Параметры:

- `limit` — максимальное количество сообщений за один вызов. По умолчанию `ONEC_POLL_DEFAULT_LIMIT`, верхняя граница `ONEC_POLL_MAX_LIMIT`.

Пример:

```bash
curl "https://chat.example.com/api/v1/onec/messages/incoming?limit=50" \
  -H "X-Onec-Api-Key: ${ONEC_API_KEY}"
```

Ответ:

```json
{
  "messages": [
    {
      "id": "9aebd640-c52a-4f3d-a216-b9b6c5efb928",
      "received_at": "2026-09-03T13:00:00.000Z",
      "source": "max_webhook",
      "update_type": "message_created",
      "update": {
        "update_type": "message_created"
      }
    }
  ],
  "remaining": 0
}
```

`update` содержит исходный объект `Update` от MAX без изменений.

## Исходящие сообщения из 1С в MAX

### `POST /api/v1/onec/messages/outgoing`

1С передаёт одно сообщение или пачку сообщений. Backend отправляет их в MAX Bot API `POST /messages`.

Одинарный payload:

```json
{
  "client_message_id": "onec-message-0001",
  "user_id": 123456789,
  "text": "Здравствуйте",
  "notify": true
}
```

Пачка:

```json
{
  "messages": [
    {
      "client_message_id": "onec-message-0001",
      "user_id": 123456789,
      "text": "Здравствуйте"
    },
    {
      "client_message_id": "onec-message-0002",
      "chat_id": 987654321,
      "text": "Сообщение в чат"
    }
  ]
}
```

Поддерживаемые поля адресации:

- `user_id` / `userId`;
- `chat_id` / `chatId`.

Поддерживаемые поля тела сообщения:

- `text`;
- `attachments`;
- `link`;
- `notify`;
- `format`.

Дополнительный query-параметр MAX:

- `disable_link_preview` / `disableLinkPreview`.

Пример:

```bash
curl -X POST "https://chat.example.com/api/v1/onec/messages/outgoing" \
  -H "X-Onec-Api-Key: ${ONEC_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "client_message_id": "onec-message-0001",
    "user_id": 123456789,
    "text": "Здравствуйте"
  }'
```

Успешный ответ:

```json
{
  "ok": true,
  "sent": 1,
  "failed": 0,
  "results": [
    {
      "ok": true,
      "client_message_id": "onec-message-0001",
      "max_response": {
        "message": {}
      }
    }
  ]
}
```

Если часть сообщений не отправилась, backend возвращает HTTP `207` и детальный список результатов.

## Webhook MAX

### `POST /api/v1/max/webhook`

Публичный endpoint для Webhook-подписки MAX.

Backend:

- проверяет заголовок `X-Max-Bot-Api-Secret`, если задан `MAX_WEBHOOK_SECRET`;
- проверяет, что тело запроса — JSON-объект;
- кладёт объект `Update` в Redis-очередь;
- возвращает MAX `200 OK`, если событие принято в очередь.

Пример URL:

```text
https://chat.example.com/api/v1/max/webhook
```

Ответ:

```json
{
  "ok": true,
  "queued": true,
  "message_id": "9aebd640-c52a-4f3d-a216-b9b6c5efb928"
}
```

## MAX Bot API

Для отправки сообщений backend использует официальный endpoint MAX Bot API:

- `POST https://platform-api2.max.ru/messages`
- авторизация через заголовок `Authorization: <MAX_BOT_TOKEN>`

Практическое ограничение MAX: не более двух сообщений в секунду в один диалог/чат. Если на стороне 1С возможны массовые отправки в один и тот же диалог, нужно дозировать пачки либо добавить отдельный worker с rate-limit.
