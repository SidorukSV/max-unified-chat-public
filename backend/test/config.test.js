import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const runConfigImport = (extraEnv = {}) => {
    const env = { ...process.env };

    Object.assign(env, extraEnv);

    return spawnSync(process.execPath, ["-e", 'import("./src/config.js").then(({ config }) => console.log(JSON.stringify(config)))'], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
    });
};

test("backend config import succeeds with service-only exchange settings", () => {
    const result = runConfigImport({
        NODE_ENV: "production",
        ONEC_API_KEY: "test-service-key",
    });

    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(config.nodeEnv, "production");
    assert.equal(config.onecApiKey, "test-service-key");
    assert.equal(config.maxApiBaseUrl, "https://platform-api2.max.ru");
});

test("backend config parses polling limits with defaults", () => {
    const result = runConfigImport({
        ONEC_POLL_DEFAULT_LIMIT: "25",
        ONEC_POLL_MAX_LIMIT: "75",
    });

    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(config.onecPollDefaultLimit, 25);
    assert.equal(config.onecPollMaxLimit, 75);
});
