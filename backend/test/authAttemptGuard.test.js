import test from "node:test";
import assert from "node:assert/strict";
import {
    consumeAuthAttemptBudget,
    recordAuthAttempt,
    authAttemptGuardTestUtils,
} from "../src/middleware/authAttemptGuard.js";

const policy = {
    windowMs: 1000,
    limit: 2,
    lockMs: 500,
    lockAfterFailures: 2,
};

test.afterEach(() => {
    authAttemptGuardTestUtils.reset();
});

test("returns 429 signal when per-window limit is exceeded and resets after window", () => {
    let now = 1000;
    authAttemptGuardTestUtils.setNowProvider(() => now);

    const dimensions = { ip: "1.1.1.1", phone: "+79990001122" };

    const first = consumeAuthAttemptBudget({ scope: "auth_phone", dimensions, policy });
    const second = consumeAuthAttemptBudget({ scope: "auth_phone", dimensions, policy });
    const limited = consumeAuthAttemptBudget({ scope: "auth_phone", dimensions, policy });

    assert.equal(first.limited, false);
    assert.equal(second.limited, false);
    assert.equal(limited.limited, true);

    now = 2501;

    const afterWindowReset = consumeAuthAttemptBudget({ scope: "auth_phone", dimensions, policy });
    assert.equal(afterWindowReset.limited, false);
});

test("applies temporary lock after consecutive failures and unlocks after backoff", () => {
    let now = 10_000;
    authAttemptGuardTestUtils.setNowProvider(() => now);

    const dimensions = { ip: "2.2.2.2", session: "a_session" };

    consumeAuthAttemptBudget({ scope: "auth_select_patient", dimensions, policy });
    recordAuthAttempt({ scope: "auth_select_patient", dimensions, success: false, policy });

    consumeAuthAttemptBudget({ scope: "auth_select_patient", dimensions, policy });
    recordAuthAttempt({ scope: "auth_select_patient", dimensions, success: false, policy });

    const locked = consumeAuthAttemptBudget({ scope: "auth_select_patient", dimensions, policy });
    assert.equal(locked.limited, true);

    now = 11_100;
    const afterLock = consumeAuthAttemptBudget({ scope: "auth_select_patient", dimensions, policy });
    assert.equal(afterLock.limited, false);
});
