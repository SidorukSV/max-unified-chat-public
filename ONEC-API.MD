# ONEC API

## Базовый URL HTTP-сервиса 1С

В `backend/onec-config.yml` указывается полный корень опубликованного HTTP-сервиса, включая имя базы и `/hs/omni/v1`:

```yaml
url: "https://example.com/base/hs/omni/v1"
basicAuth: "base64_login_password"
```

Backend добавляет к этому значению пути конкретных методов.

## Настройки видимости страниц

### `GET /settings`

Backend запрашивает этот метод 1С при загрузке профиля пользователя.

#### Ответ

```json
{
  "visibility_pages": {
    "bonuses": true,
    "survey": true
  }
}
```

- `bonuses` управляет видимостью страницы и элементов интерфейса бонусов.
- `survey` управляет видимостью списка, карточек и страниц анкет.
- Только явное значение `false` отключает страницу. Отсутствующие или некорректные значения считаются `true` для обратной совместимости.

Соответствие настройкам 1С:

- `bonuses` — `бит_омни_Настройки.Идентификатор = "ВыводитьБонусы"`;
- `survey` — `бит_омни_Настройки.Идентификатор = "ВыводитьАнкеты"`.

## Авторизация для 1C

### `POST /api/v1/auth/onec`

Отдельный метод авторизации для интеграции 1C. Используется тот же JWT-механизм, что и для остальных каналов (access + refresh token), но канал фиксирован как `channel=1c`.

#### Входной payload

```json
{
  "proof": {
    "totp_code": "123456"
  },
  "device_id": "onec-sync-worker-01"
}
```

- `proof.totp_code` — обязательный TOTP код.
- TOTP секрет берётся из единственного конфига 1C: `onecTotpSecret`.
- Применяется анти-брутфорс защита: лимит попыток и временный lockout. При неверном proof возвращается унифицированная ошибка `auth_attempt_failed`, при превышении лимита — `auth_rate_limited` (429 + `Retry-After`).

#### Успешный ответ

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<jwt>",
  "expires_in": 900,
  "channel": "1c"
}
```

## Загрузка каталога категорий из 1C

### `POST /api/v1/catalogs/categories/`

Метод принимает структуру категории из 1C и сохраняет её в Redis для дальнейшей реализации умного поиска.

Требования:
- `Authorization: Bearer <access_token>` обязателен.
- Токен должен быть выпущен через `POST /api/v1/auth/onec` и содержать `channel=1c`.

#### Входной payload

```json
{
  "categoryId": "00000000-0000-0000-0000-000000000000",
  "appointment_type": "online",
  "isCartAllow": true,
  "isDateRequired": true,
  "isDoctorRequired": true,
  "employees": [
    {
      "doctorId": "00000000-0000-0000-0000-000000000001",
      "doctorTitle": "Врач",
      "doctorLastname": "Иванов",
      "doctorFirstname": "Иван",
      "doctorPatronymic": "Иванович",
      "doctorDuration": 30,
      "specializations": [
        "00000000-0000-0000-0000-000000000010"
      ]
    }
  ],
  "specializations": [
    {
      "specializationId": "00000000-0000-0000-0000-000000000010",
      "specializationTitle": "Терапия",
      "appointment_type": "phone",
      "appointment_phone": "+79990000000",
      "iconCode": "therapy"
    }
  ],
  "services": [
    {
      "serviceId": "00000000-0000-0000-0000-000000000100",
      "serviceTitle": "Первичный приём",
      "servicePrice": 2500,
      "serviceDuration": 30,
      "specializationId": "00000000-0000-0000-0000-000000000010"
    }
  ]
}
```

#### Валидация

- `categoryId`, `doctorId`, `specializationId`, `serviceId` — UUID.
- `appointment_type` — одно из: `online`, `phone`, `phone_and_chat`.
- `iconCode` у специализации — опциональный код иконки из белого списка:
  `default`, `therapy`, `doctor`, `cardiology`, `dentistry`, `surgery`,
  `gynecology`, `urology`, `neurology`, `ophthalmology`, `pediatrics`, `lab`,
  `diagnostics`, `xray`, `vaccination`, `cosmetology`, `trichology`,
  `physiotherapy`.
- Флаги `isCartAllow`, `isDateRequired`, `isDoctorRequired` — boolean.
- `employees`, `specializations`, `services` — массивы с валидной структурой.

#### Успешный ответ

```json
{
  "ok": true,
  "key": "onec:catalogs:category:<categoryId>"
}
```

## Хранение в Redis

Каждая категория сохраняется по ключу:

`onec:catalogs:category:<categoryId>`

Значение: JSON объекта категории + служебное поле `updatedAt` (ISO timestamp).

## Webhook MAX -> 1C

### `POST /api/v1/max/webhook`

Публичный endpoint для Webhook-подписки MAX. Принимает объект `Update` от MAX и синхронно пересылает его в 1C методом `POST` на `/v1/webhook`.

Тело запроса пересылается в 1C без обёртки и изменений.

#### Переменные окружения

- `MAX_WEBHOOK_SECRET` — секрет из подписки MAX. Если задан, backend проверяет заголовок `X-Max-Bot-Api-Secret`.
- `MAX_WEBHOOK_FORWARD_TIMEOUT_MS` — таймаут пересылки в 1C, по умолчанию `25000`.

#### Настройка подписки MAX

После деплоя endpoint должен быть доступен по HTTPS на 443 порту, например:

```text
https://chat.example.com/api/v1/max/webhook
```

Пример регистрации подписки:

```bash
curl -X POST "https://platform-api.max.ru/subscriptions" \
  -H "Authorization: ${MAX_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
  "url": "https://chat.example.com/api/v1/max/webhook",
    "update_types": ["message_created", "bot_started"],
    "secret": "'"${MAX_WEBHOOK_SECRET}"'"
  }'
```

Если 1C вернёт ошибку или не ответит до таймаута, backend вернёт MAX код `502`, чтобы доставка считалась неуспешной и MAX мог выполнить повторную попытку.
