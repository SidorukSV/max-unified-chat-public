import crypto from "crypto";
import { config } from "../config.js";
import { sendApiError } from "../utils/apiErrors.js";

function getHeaderValue(value) {
    if (Array.isArray(value)) {
        return value[0] || "";
    }

    return typeof value === "string" ? value : "";
}

export function extractServiceApiKey(req) {
    const directHeader = getHeaderValue(req.headers["x-onec-api-key"]).trim();
    if (directHeader) {
        return directHeader;
    }

    const authorization = getHeaderValue(req.headers.authorization).trim();
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    return bearerMatch?.[1]?.trim() || "";
}

export function isServiceApiKeyValid(receivedKey, expectedKey) {
    const expected = typeof expectedKey === "string" ? expectedKey.trim() : "";
    const received = typeof receivedKey === "string" ? receivedKey.trim() : "";

    if (!expected || !received) {
        return false;
    }

    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);

    if (expectedBuffer.length !== receivedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function onecServiceAuthMiddleware(req, reply) {
    if (!config.onecApiKey) {
        return sendApiError(reply, 503, "onec_api_key_not_configured");
    }

    const receivedKey = extractServiceApiKey(req);
    if (!isServiceApiKeyValid(receivedKey, config.onecApiKey)) {
        req.log.warn({
            event: "onec_service_auth_rejected",
            hasApiKey: Boolean(receivedKey),
        }, "1C service request rejected");

        return sendApiError(reply, 401, "onec_api_key_invalid");
    }
}
