# Files and reminder callback transport

## Upload from 1C

`POST /api/v1/onec/attachments/upload`, service authentication using
`X-Onec-Api-Key` (or the existing bearer header). Authentication runs before body
parsing. Request JSON:

```json
{"filename":"Памятка.pdf","data_base64":"JVBERi0xLjQKdGVzdA=="}
```

Only these two fields are accepted. Base64 must be canonical, without whitespace
or a data-URI prefix. A file must be nonempty and at most **5 MiB (5,242,880 bytes)**.
Allowed extensions: `pdf`, `doc`, `docx`, `xls`, `xlsx`, `txt`, `png`, `jpg`, `jpeg`.
This extension allowlist is not a malware scanner or proof of content type.
Only trusted clinic operators should be allowed to choose outgoing files in 1C.

Success:

```json
{"ok":true,"filename":"Памятка.pdf","size":13,"attachment":{"type":"file","payload":{"token":"MAX-uploaded-token"}}}
```

All allowed formats, including pictures, are sent as downloadable `file` attachments,
not inline photos. The backend obtains the upload URL itself from the configured
MAX API (`POST /uploads?type=file`), accepts only HTTPS `fu.oneme.ru` URLs without
custom ports/credentials/fragments, and posts multipart field `data`. Redirects
are disabled on both requests. Bot/service secrets are never forwarded to the
upload host. A client cannot provide a URL, MAX token, MIME type, or upload type.
The provider reply is bounded to 64 KiB and only the file token is returned.
Files are not stored on backend disk or in Redis. Two uploads may run concurrently
per backend process, each bounded by `MAX_REQUEST_TIMEOUT_MS`; excess uploads return
429. The JSON body has a route-specific ~7 MiB limit; other routes retain their limit.
The reverse proxy must allow the upload route body size, preserve service auth and
allow the configured timeout. No extra public upload route is exposed.

Uploading alone never sends a message. 1C must persist the upload result, then use
the existing `POST /api/v1/onec/messages/outgoing` with the chosen recipient,
`client_message_id`, optional text and `attachments: [attachment]`.

## Delivery uncertainty and retry rules

The backend does not automatically retry upload, send, or callback requests.
`client_message_id` is correlation, **not a persistent backend idempotency key**.
A transport timeout/connection loss, HTTP 408, or generic MAX 5xx send failure
returns the existing HTTP 207 envelope with a per-message
`delivery_status: "unknown"`. Do not blindly resend: MAX may already have delivered
the message. Show the operator uncertain delivery and reconcile first.

Validation failures and explicit MAX 4xx rejections use `delivery_status: "not_sent"`.
The explicit provider code `attachment.not.ready` is returned as
`error: "attachment_not_ready"`, `delivery_status: "not_sent"`; 1C may schedule a
bounded delayed retry with the persisted token. Never re-upload just because send
timed out. Upload retries by themselves cannot duplicate a patient message, but
can create another unused MAX upload. Provider error text, URLs, and tokens are
not written to application error logs or returned in failure responses.

## Patient files

Before a `message_created` or `message_edited` event reaches Redis, each non-contact
attachment in `message.body.attachments` is replaced with a marker:

```json
{"type":"file","payload":{},"rejected":true}
```

No download occurs. 1C must detect the marker/type and issue its configured refusal
template instead of displaying the file. Actual `contact` attachments remain
unchanged, including `vcf_info`, `hash` and `max_info`, for existing HMAC/sender
verification. Callback source messages are unchanged. Historical queue items and
existing 1C records are not rewritten; 1C must also reject unsanitized old file events.

## Callback answers

`POST /api/v1/onec/callbacks/answer` keeps its existing authenticated contract:
`{callback_id, message: {text, attachments, notify}}`. The reminder flow can replace
the source keyboard with one `inline_keyboard` attachment containing callback
buttons (`type`, `text`, opaque `payload`, optional `intent`: `default`, `positive`,
`negative`). There are at most 100 rows, 10 buttons per row, 100 buttons total;
payloads are at most 1024 UTF-8 bytes. `attachments: []` removes the keyboard.
These callback-answer keyboards intentionally do not accept arbitrary attachment
types or button URL fields; normal outgoing messages retain their existing API.
Reminder business actions, signature checks, bot/user/appointment binding,
cancel-confirmation state and idempotency are owned by 1C, not interpreted on VDS.

Capability response now includes `attachment_upload`, `attachment_max_bytes`,
and `attachment_extensions` alongside existing `incoming_ack` and `callback_answer`.

Official API references (checked 2026-09-12):
[MAX file upload](https://dev.max.ru/docs-api/methods/POST/uploads),
[callback answer](https://dev.max.ru/docs-api/methods/POST/answers),
[message body](https://dev.max.ru/docs-api/objects/NewMessageBody).

## Verification boundaries

Automated backend tests use mocked MAX HTTP requests and the in-memory queue.
They verify serialization, validation, early authentication, upload URL constraints,
secret isolation, no retries and contact-preserving incoming minimization.
A real uploaded file/delivery and 1C form workflow still need an authorized test
with a test patient and bot. No production upload/deployment is implied by these tests.
