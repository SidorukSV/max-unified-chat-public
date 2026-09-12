import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "memory://callback-keyboard-test";
process.env.ONEC_API_KEY = "onec-test-key";
process.env.MAX_BOT_TOKEN = "max-token-test";
process.env.MAX_API_BASE_URL = "https://platform-api2.max.ru";
process.env.BACKEND_LOG_LEVEL = "silent";
const { buildApp } = await import("../src/app.js");
const headers = { "X-Onec-Api-Key": "onec-test-key" };
const button = (text, action, intent = "default") => ({ type: "callback", text, payload: `signed-action-${action}`, intent });
const keyboard = (buttons) => [{ type: "inline_keyboard", payload: { buttons } }];

test("callback transport preserves opaque payloads and danger/positive intents for both cancellation stages", async (t) => {
    const app = await buildApp();
    t.after(() => app.close());
    const calls = [];
    t.mock.method(global, "fetch", async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const stages = [
        { text: "Подтвердите приём", attachments: keyboard([
            [button("Подтвердить", "confirm", "positive")],
            [button("Перенести", "reschedule")], [button("Отменить", "cancel", "negative")],
        ]) },
        { text: "Вы уверены, что хотите отменить запись?", attachments: keyboard([
            [button("Да", "cancel_yes", "negative")], [button("Перенести запись", "reschedule")],
            [button("Нет", "cancel_no")],
        ]) },
        { text: "Приём подтверждён", attachments: [], notify: false },
    ];
    for (const [index, message] of stages.entries()) {
        const reply = await app.inject({ method: "POST", url: "/api/v1/onec/callbacks/answer", headers,
            payload: { callback_id: `callback-${index}`, message } });
        assert.equal(reply.statusCode, 200);
        assert.deepEqual(JSON.parse(calls[index].options.body), { message });
        assert.equal(calls[index].url, `https://platform-api2.max.ru/answers?callback_id=callback-${index}`);
        assert.equal(calls[index].options.redirect, "error");
    }
    assert.equal(calls.length, stages.length, "no automatic callbacks or 1C HTTP requests");
});

test("callback keyboard fails closed on malformed or oversized buttons before MAX request", async (t) => {
    const app = await buildApp();
    t.after(() => app.close());
    t.mock.method(global, "fetch", async () => assert.fail("invalid keyboard reached MAX"));
    const invalidAttachments = [
        {}, [{ type: "file", payload: { url: "https://evil.test/" } }],
        keyboard([[]]), keyboard("invalid"), keyboard([[null]]),
        keyboard([[{ ...button("Да", "confirm"), payload: " " }]]),
        keyboard([[{ ...button("Да", "confirm"), url: "https://evil.test/" }]]),
        keyboard([[{ ...button("Да", "confirm"), payload: "я".repeat(513) }]]),
        keyboard([[{ ...button("Да", "confirm"), intent: "arbitrary" }]]),
        keyboard(Array.from({ length: 101 }, () => [button("Да", "confirm")])),
    ];
    for (const attachments of invalidAttachments) {
        const reply = await app.inject({ method: "POST", url: "/api/v1/onec/callbacks/answer", headers,
            payload: { callback_id: "valid-id", message: { text: "Подтверждение", attachments } } });
        assert.equal(reply.statusCode, 400);
    }
});

test("outgoing attachment transport reports uncertainty and does not retry ambiguous delivery", async (t) => {
    const app = await buildApp();
    t.after(() => app.close());
    let count = 0;
    t.mock.method(global, "fetch", async () => {
        count += 1;
        throw new Error("upstream timeout with secret query token=hidden");
    });
    const reply = await app.inject({ method: "POST", url: "/api/v1/onec/messages/outgoing", headers,
        payload: { user_id: 123, client_message_id: "stable-message-id", attachments: [{ type: "file", payload: { token: "uploaded-token" } }] } });
    assert.equal(reply.statusCode, 207);
    assert.deepEqual(reply.json().results, [{ ok: false, client_message_id: "stable-message-id",
        error: "max_send_failed", delivery_status: "unknown" }]);
    assert.equal(count, 1);
    assert.doesNotMatch(reply.body, /hidden|uploaded-token|upstream/);
});

test("outgoing attachment reports explicit not-ready rejection separately from uncertain server failure", async (t) => {
    const app = await buildApp();
    t.after(() => app.close());
    for (const [status, body, expectedError, expectedDelivery] of [
        [400, { code: "attachment.not.ready" }, "attachment_not_ready", "not_sent"],
        [429, { message: "rate limit" }, "max_send_failed", "not_sent"],
        [500, { message: "provider failure secret" }, "max_send_failed", "unknown"],
        [408, {}, "max_send_failed", "unknown"],
    ]) {
        let count = 0;
        const mock = t.mock.method(global, "fetch", async () => {
            count += 1;
            return new Response(JSON.stringify(body), { status });
        });
        const reply = await app.inject({ method: "POST", url: "/api/v1/onec/messages/outgoing", headers,
            payload: { user_id: 123, text: "Памятка" } });
        assert.equal(reply.statusCode, 207);
        assert.equal(reply.json().results[0].delivery_status, expectedDelivery);
        assert.equal(reply.json().results[0].error, expectedError);
        assert.equal(count, 1);
        mock.mock.restore();
    }
});
