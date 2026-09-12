import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "memory://max-attachment-test";
process.env.ONEC_API_KEY = "onec-test-key";
process.env.MAX_BOT_TOKEN = "max-token-test";
process.env.MAX_API_BASE_URL = "https://platform-api2.max.ru";
process.env.BACKEND_LOG_LEVEL = "silent";
const { buildApp } = await import("../src/app.js");
const { normalizeAttachmentUpload, validateMaxUploadUrl, attachmentMaxBytes } = await import("../src/services/maxAttachments.js");
const { createIncomingEnvelope } = await import("../src/services/messageQueue.js");
const headers = { "X-Onec-Api-Key": "onec-test-key" };
const validPayload = { filename: "Памятка.pdf", data_base64: Buffer.from("%PDF-1.4\ntest").toString("base64") };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("attachment validation rejects paths, URL inputs, unapproved extensions and malformed base64", () => {
    const good = normalizeAttachmentUpload(validPayload);
    assert.equal(good.filename, "Памятка.pdf");
    assert.equal(good.mimeType, "application/pdf");
    for (const filename of ["../file.pdf", "C:\\file.pdf", "report.pdf:stream", "a.exe", "a.pdf.exe", " a.pdf", "a.pdf\n", "a\u202efdp.exe", ".pdf"]) {
        assert.throws(() => normalizeAttachmentUpload({ ...validPayload, filename }));
    }
    for (const data_base64 of ["", "QQ", "QQ==\n", "Q!==", "QR==", "data:application/pdf;base64,QQ==", 1]) {
        assert.throws(() => normalizeAttachmentUpload({ ...validPayload, data_base64 }));
    }
    assert.throws(() => normalizeAttachmentUpload({ ...validPayload, url: "https://attacker.example/" }));
    assert.throws(() => normalizeAttachmentUpload({ ...validPayload,
        data_base64: Buffer.alloc(attachmentMaxBytes + 1).toString("base64") }), /attachment_size_invalid/);
    assert.equal(normalizeAttachmentUpload({ ...validPayload,
        data_base64: Buffer.alloc(attachmentMaxBytes).toString("base64") }).bytes.length, attachmentMaxBytes);
});

test("upload URL is limited to official HTTPS file-upload host, with no redirects or credentials", () => {
    assert.equal(validateMaxUploadUrl("https://fu.oneme.ru/upload.do?sig=opaque"), "https://fu.oneme.ru/upload.do?sig=opaque");
    for (const url of ["http://fu.oneme.ru/x", "https://fu.oneme.ru.evil.test/x", "https://127.0.0.1/x",
        "https://fu.oneme.ru:444/x", "https://user:pass@fu.oneme.ru/x", "https://fu.oneme.ru/x#fragment",
        "file:///etc/passwd", "https://iu.oneme.ru/upload.do", null]) {
        assert.throws(() => validateMaxUploadUrl(url), /max_upload_url_rejected/);
    }
});

test("attachment endpoint authenticates before handling file body and rejects invalid payload without network", async (t) => {
    const app = await buildApp();
    t.after(() => app.close());
    t.mock.method(global, "fetch", async () => assert.fail("must not upload invalid requests"));
    const noAuth = await app.inject({ method: "POST", url: "/api/v1/onec/attachments/upload", payload: validPayload });
    assert.equal(noAuth.statusCode, 401);
    const invalid = await app.inject({ method: "POST", url: "/api/v1/onec/attachments/upload", headers,
        payload: { ...validPayload, filename: "bad.exe" } });
    assert.equal(invalid.statusCode, 400);
    const tooBig = await app.inject({ method: "POST", url: "/api/v1/onec/attachments/upload", headers,
        payload: { ...validPayload, data_base64: "A".repeat(8 * 1024 * 1024) } });
    assert.equal(tooBig.statusCode, 413);
});

test("attachment upload uses MAX-issued URL, no secret on multipart request, and never sends a message", async (t) => {
    const app = await buildApp();
    t.after(() => app.close());
    const calls = [];
    t.mock.method(global, "fetch", async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
            ? jsonResponse({ url: "https://fu.oneme.ru/upload.do?signature=opaque" })
            : jsonResponse({ token: "uploaded-token", ignored: "private-provider-field" });
    });
    const reply = await app.inject({ method: "POST", url: "/api/v1/onec/attachments/upload", headers, payload: validPayload });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(reply.json(), { ok: true, filename: "Памятка.pdf", size: 13,
        attachment: { type: "file", payload: { token: "uploaded-token" } } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://platform-api2.max.ru/uploads?type=file");
    assert.equal(calls[0].options.headers.Authorization, "max-token-test");
    assert.equal(calls[1].url, "https://fu.oneme.ru/upload.do?signature=opaque");
    assert.equal(calls[1].options.headers, undefined);
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(calls[1].options.redirect, "error");
    const file = calls[1].options.body.get("data");
    assert.equal(file.name, "Памятка.pdf");
    assert.equal(file.type, "application/pdf");
    assert.equal(await file.text(), "%PDF-1.4\ntest");
});

test("attachment errors neither reveal upload URLs/tokens nor retry on invalid provider replies", async (t) => {
    const app = await buildApp();
    t.after(() => app.close());
    for (const firstResponse of [
        { url: "https://127.0.0.1/internal?secret=hidden" },
        { url: "https://fu.oneme.ru/upload.do", unexpected: "x".repeat(65537) },
    ]) {
        let count = 0;
        const mock = t.mock.method(global, "fetch", async () => { count += 1; return jsonResponse(firstResponse); });
        const reply = await app.inject({ method: "POST", url: "/api/v1/onec/attachments/upload", headers, payload: validPayload });
        assert.equal(reply.statusCode, 502);
        assert.equal(reply.json().error, "max_attachment_upload_failed");
        assert.equal(count, 1);
        assert.doesNotMatch(reply.body, /secret|hidden|127\.0\.0/);
        mock.mock.restore();
    }
});

test("incoming file metadata is minimized but contact signature fields and sender are preserved", () => {
    const contact = { type: "contact", payload: { vcf_info: "signed\r\nVCF", hash: "signature", max_info: { user_id: 123 } } };
    const update = { update_type: "message_created", message: { sender: { user_id: 123 }, body: {
        mid: "message-1", text: "вложение",
        attachments: [{ type: "file", payload: { url: "https://download.example/secret", token: "secret" }, filename: "analysis.pdf" }, contact],
    } } };
    const minimized = createIncomingEnvelope(update).update;
    assert.deepEqual(minimized.message.body.attachments[0], { type: "file", payload: {}, rejected: true });
    assert.deepEqual(minimized.message.body.attachments[1], contact);
    assert.deepEqual(minimized.message.sender, update.message.sender);
    assert.doesNotMatch(JSON.stringify(minimized), /download\.example|analysis\.pdf/);
    assert.equal(update.message.body.attachments[0].payload.token, "secret", "do not mutate caller payload");
    const callback = { ...update, update_type: "message_callback", callback: { payload: "opaque", user: { user_id: 123 } } };
    assert.deepEqual(createIncomingEnvelope(callback).update, callback);
});

test("attachment upload concurrency is bounded and releases slots after a failure", async (t) => {
    const app = await buildApp();
    t.after(() => app.close());
    const blocked = [];
    let notifyTwo;
    const twoStarted = new Promise((resolve) => { notifyTwo = resolve; });
    t.mock.method(global, "fetch", () => new Promise((resolve) => {
        blocked.push(resolve);
        if (blocked.length === 2) notifyTwo();
    }));
    const request = () => app.inject({ method: "POST", url: "/api/v1/onec/attachments/upload", headers, payload: validPayload });
    const first = request();
    const second = request();
    await twoStarted;
    const busy = await request();
    assert.equal(busy.statusCode, 429);
    assert.equal(busy.json().error, "attachment_upload_busy");
    assert.equal(blocked.length, 2);
    for (const resolve of blocked) resolve(jsonResponse({ error: "upstream unavailable" }, 503));
    assert.equal((await first).statusCode, 502);
    assert.equal((await second).statusCode, 502);
    t.mock.restoreAll();
    t.mock.method(global, "fetch", async () => jsonResponse({ error: "upstream unavailable" }, 503));
    const next = await request();
    assert.equal(next.statusCode, 502, "released slot must reach upstream, not report busy");
});
