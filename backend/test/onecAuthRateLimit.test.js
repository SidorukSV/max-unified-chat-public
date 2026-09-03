import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = `
import assert from "node:assert/strict";

process.env.JWT_SECRET = "VeryStrongJwtSecret!2026-AlphaBeta";
process.env.NODE_ENV = "production";
process.env.ONEC_CONFIG_FILE = "__onec_auth_rate_limit_missing.yml";
process.env.ONEC_CONFIG = JSON.stringify(
  {
    url: "https://example.com/a",
    basicAuth: "base64_a",
    onecTotpSecret: "JBSWY3DPEHPK3PXP"
  }
);

const { authAttemptGuardTestUtils } = await import("./src/middleware/authAttemptGuard.js");
authAttemptGuardTestUtils.reset();

const { buildApp } = await import("./src/app.js");
const app = await buildApp();

const statuses = [];
for (let i = 0; i < 4; i += 1) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/onec",
    payload: {
      proof: {
        totp_code: "000000"
      },
      device_id: "onec-sync-worker-01"
    }
  });

  statuses.push(response.statusCode);

  if (i < 3) {
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "auth_attempt_failed");
  }
}

assert.deepEqual(statuses, [401, 401, 401, 429]);
await app.close();
`;

test("/api/v1/auth/onec enforces attempt budget and lockout on invalid TOTP", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", SCRIPT], {
        cwd: process.cwd(),
        env: { ...process.env },
        encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
});
