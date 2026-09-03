import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "VeryStrongJwtSecret!2026-AlphaBeta";

const { validateAuthChannelProof } = await import("../src/routes/auth.js");

test("production + channel=web without proof is rejected with auth_channel_not_allowed", () => {
    const result = validateAuthChannelProof({
        nodeEnv: "production",
        channel: "web",
        proof: null,
        initData: null,
        maxBotToken: "token",
        maxInitDataMaxAgeSeconds: 300,
        devTotpSecret: "JBSWY3DPEHPK3PXP",
        devTotpPeriodSeconds: 30,
        devTotpWindow: 1,
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 403);
    assert.equal(result.errorCode, "auth_channel_not_allowed");
});

test("production + channel=max with invalid init_data is rejected", () => {
    const result = validateAuthChannelProof({
        nodeEnv: "production",
        channel: "max",
        proof: null,
        initData: "invalid-init-data",
        maxBotToken: "token",
        maxInitDataMaxAgeSeconds: 300,
        devTotpSecret: "JBSWY3DPEHPK3PXP",
        devTotpPeriodSeconds: 30,
        devTotpWindow: 1,
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 401);
    assert.equal(result.errorCode, "init_data_invalid");
});

test("non-production + channel=web with invalid TOTP is rejected", () => {
    const result = validateAuthChannelProof({
        nodeEnv: "development",
        channel: "web",
        proof: { totp_code: "000000" },
        initData: null,
        maxBotToken: "token",
        maxInitDataMaxAgeSeconds: 300,
        devTotpSecret: "JBSWY3DPEHPK3PXP",
        devTotpPeriodSeconds: 30,
        devTotpWindow: 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 401);
    assert.equal(result.errorCode, "dev_totp_invalid");
});

test("production + channel=1c with invalid TOTP is rejected by proof validation (not channel policy)", () => {
    const result = validateAuthChannelProof({
        nodeEnv: "production",
        channel: "1c",
        proof: { totp_code: "000000" },
        initData: null,
        maxBotToken: "token",
        maxInitDataMaxAgeSeconds: 300,
        devTotpSecret: "JBSWY3DPEHPK3PXP",
        devTotpPeriodSeconds: 30,
        devTotpWindow: 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 401);
    assert.equal(result.errorCode, "onec_totp_invalid");
});

test("production + channel=1c without configured TOTP secret is rejected", () => {
    const result = validateAuthChannelProof({
        nodeEnv: "production",
        channel: "1c",
        proof: { totp_code: "000000" },
        initData: null,
        maxBotToken: "token",
        maxInitDataMaxAgeSeconds: 300,
        devTotpSecret: "",
        devTotpPeriodSeconds: 30,
        devTotpWindow: 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.equal(result.errorCode, "onec_totp_not_configured");
});
