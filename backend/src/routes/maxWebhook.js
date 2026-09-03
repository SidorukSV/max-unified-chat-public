import crypto from "crypto";
import { config } from "../config.js";
import { forwardMaxWebhookUpdateToOneC } from "../services/onecRouter.js";
import { sendApiError } from "../utils/apiErrors.js";

function getHeaderValue(value) {
    if (Array.isArray(value)) {
        return value[0] || "";
    }

    return typeof value === "string" ? value : "";
}

export function isMaxWebhookSecretValid(headerValue, expectedSecret) {
    const expected = typeof expectedSecret === "string" ? expectedSecret : "";

    if (!expected) {
        return true;
    }

    const received = getHeaderValue(headerValue);

    if (!received) {
        return false;
    }

    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);

    if (expectedBuffer.length !== receivedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isObjectPayload(payload) {
    return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}

function isConfigurationError(error) {
    const message = error?.message || "";

    return message.startsWith("onec_config_")
        || message === "onec_config_not_found"
        || message === "max_bot_id_missing";
}

export async function maxWebhookRoutes(app) {
    app.post("/api/v1/max/webhook", async (req, reply) => {
        const secretHeader = req.headers["x-max-bot-api-secret"];

        if (!isMaxWebhookSecretValid(secretHeader, config.maxWebhookSecret)) {
            req.log.warn({
                endpoint: "/api/v1/max/webhook",
                hasSecretHeader: Boolean(getHeaderValue(secretHeader)),
            }, "MAX webhook rejected because secret did not match");

            return sendApiError(reply, 401, "max_webhook_secret_invalid");
        }

        if (!isObjectPayload(req.body)) {
            return sendApiError(reply, 400, "max_update_invalid");
        }

        try {
            await forwardMaxWebhookUpdateToOneC(req.body);

            req.log.info({
                endpoint: "/api/v1/max/webhook",
                updateType: req.body.update_type || null,
            }, "MAX webhook forwarded to 1C");

            return {
                ok: true,
            };
        } catch (error) {
            req.log.error({
                endpoint: "/api/v1/max/webhook",
                updateType: req.body.update_type || null,
                err: error,
            }, "Failed to forward MAX webhook to 1C");

            if (isConfigurationError(error)) {
                return sendApiError(reply, 503, "onec_webhook_target_not_configured");
            }

            return sendApiError(reply, 502, "onec_webhook_forward_failed");
        }
    });
}
