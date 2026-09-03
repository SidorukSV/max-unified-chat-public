import test from "node:test";
import assert from "node:assert/strict";

const JWT_SECRET = "VeryStrongJwtSecret!2026-AlphaBeta";
const ONEC_BASE_URL = "https://example.com/base/hs/omni/v1";

function createJsonResponse(status, payload, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return headers[name.toLowerCase()] ?? null;
            },
        },
        async json() {
            return payload;
        },
        async text() {
            return typeof payload === "string" ? payload : JSON.stringify(payload);
        },
    };
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = "test";
process.env.ONEC_CONFIG_FILE = "__settings_visibility_test_missing.yml";
process.env.ONEC_CONFIG = JSON.stringify({
    url: ONEC_BASE_URL,
    basicAuth: "base64_login_password",
});

const originalFetch = global.fetch;
let settingsResponse = createJsonResponse(200, {
    visibility_pages: {
        bonuses: false,
        survey: true,
    },
});

global.fetch = async (url) => {
    if (url === `${ONEC_BASE_URL}/startIBSession`) {
        return createJsonResponse(200, {}, {
            "set-cookie": "ibsession=settings-test-cookie; Path=/; HttpOnly",
        });
    }

    if (url.startsWith(`${ONEC_BASE_URL}/catalogs/clients/?search_type=ByID`)) {
        return createJsonResponse(200, {
            id: "patient-1",
            fullName: "Иванов Иван Иванович",
        });
    }

    if (url.startsWith(`${ONEC_BASE_URL}/catalogs/clients/?search_type=ByPhone`)) {
        return createJsonResponse(200, [{
            id: "patient-1",
            fullName: "Иванов Иван Иванович",
        }]);
    }

    if (url === `${ONEC_BASE_URL}/settings`) {
        return settingsResponse;
    }

    return createJsonResponse(404, { error: "not_found" });
};

const { buildApp } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const app = await buildApp();
const accessToken = signAccessToken({
    patient_id: "patient-1",
    phone: "+79990001122",
    channel: "max",
});

test.after(async () => {
    await app.close();
    global.fetch = originalFetch;
    delete process.env.ONEC_CONFIG;
    delete process.env.ONEC_CONFIG_FILE;
});

test("/api/v1/me exposes visibility_pages loaded from 1C /settings", async () => {
    const response = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().visibility_pages, {
        bonuses: false,
        survey: true,
    });
});

test("/api/v1/me falls back to visible pages when 1C /settings is unavailable", async () => {
    settingsResponse = createJsonResponse(500, {
        error: "settings_unavailable",
    });

    const response = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().visibility_pages, {
        bonuses: true,
        survey: true,
    });
});
