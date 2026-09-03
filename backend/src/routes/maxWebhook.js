import crypto from "crypto";
import { config } from "../config.js";
import { enqueueIncomingMaxUpdate } from "../services/messageQueue.js";
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
            const queuedMessage = await enqueueIncomingMaxUpdate(req.body);

            req.log.info({
                endpoint: "/api/v1/max/webhook",
                updateType: req.body.update_type || null,
                messageId: queuedMessage.id,
            }, "MAX webhook queued for 1C polling");

            return {
                ok: true,
                queued: true,
                message_id: queuedMessage.id,
            };
        } catch (error) {
            req.log.error({
                endpoint: "/api/v1/max/webhook",
                updateType: req.body.update_type || null,
                err: error,
            }, "Failed to queue MAX webhook");

            return sendApiError(reply, 503, "max_webhook_queue_failed");
        }
    });
}
