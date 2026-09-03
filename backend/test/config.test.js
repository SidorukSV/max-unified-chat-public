import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const runConfigImport = (jwtSecret, extraEnv = {}) => {
    const env = { ...process.env };

    delete env.JWT_SECRET;
    delete env.ONEC_CONFIG;
    env.ONEC_CONFIG_FILE = "__config_test_missing.yml";

    if (jwtSecret !== undefined) {
        env.JWT_SECRET = jwtSecret;
    }

    Object.assign(env, extraEnv);

    return spawnSync(process.execPath, ["-e", 'import("./src/config.js")'], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
    });
};

test("backend startup fails when JWT_SECRET is missing or empty", () => {
    const result = runConfigImport("");

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JWT_SECRET is required/);
});

test("backend startup fails when JWT_SECRET is too short", () => {
    const result = runConfigImport("short-secret");

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 32 characters long/);
});

test("backend startup succeeds with a strong JWT_SECRET", () => {
    const result = runConfigImport("VeryStrongJwtSecret!2026-AlphaBeta");

    assert.equal(result.status, 0);
});

test("backend startup supports onecTotpSecret in the single 1C config", () => {
    const result = runConfigImport("VeryStrongJwtSecret!2026-AlphaBeta", {
        ONEC_CONFIG: JSON.stringify(
            {
                url: "https://example.com/a",
                basicAuth: "base64_a",
                onecTotpSecret: "JBSWY3DPEHPK3PXP",
            }
        ),
    });

    assert.equal(result.status, 0);
});

test("backend startup rejects multiple 1C configs", () => {
    const result = runConfigImport("VeryStrongJwtSecret!2026-AlphaBeta", {
        ONEC_CONFIG: JSON.stringify([
            {
                url: "https://example.com/a",
                basicAuth: "base64_a",
            },
            {
                url: "https://example.com/b",
                basicAuth: "base64_b",
            },
        ]),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one 1C config/);
});
