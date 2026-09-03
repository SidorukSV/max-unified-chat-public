import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("backend logger writes requests to BACKEND_LOG_FILE", async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "max-unified-chat-log-"));
    const logFile = path.join(tempDir, "backend.log");

    process.env.NODE_ENV = "test";
    process.env.REDIS_URL = "memory://file-logger-test";
    process.env.BACKEND_LOG_FILE = logFile;
    process.env.BACKEND_LOG_LEVEL = "info";

    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();

    t.after(async () => {
        await app.close();
        delete process.env.REDIS_URL;
        delete process.env.BACKEND_LOG_FILE;
        delete process.env.BACKEND_LOG_LEVEL;
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    const response = await app.inject({
        method: "GET",
        url: "/api/v1/version",
    });

    assert.equal(response.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const logContent = await fs.readFile(logFile, "utf-8");

    assert.match(logContent, /\/api\/v1\/version/);
    assert.match(logContent, /request completed/);
});
