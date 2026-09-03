import test from "node:test";
import assert from "node:assert/strict";
import { verifyDevTotpCode } from "../src/auth/devTotp.js";

const TEST_SECRET = "JBSWY3DPEHPK3PXP";

test("verifyDevTotpCode returns true for valid code in active step", () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;

    const valid = verifyDevTotpCode({
        code: "324550",
        secret: TEST_SECRET,
        periodSeconds: 30,
        window: 0,
    });

    Date.now = originalNow;

    assert.equal(valid, true);
});

test("verifyDevTotpCode returns false for invalid code", () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;

    const valid = verifyDevTotpCode({
        code: "000000",
        secret: TEST_SECRET,
        periodSeconds: 30,
        window: 0,
    });

    Date.now = originalNow;

    assert.equal(valid, false);
});
