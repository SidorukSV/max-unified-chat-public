import { config } from "../config.js";
import { onecServiceAuthMiddleware } from "../middleware/serviceAuth.js";
import {
    acknowledgeIncomingMaxUpdates, claimIncomingMaxUpdatesLongPoll, getIncomingQueueLength,
    incomingLeaseMs, popIncomingMaxUpdates, popIncomingMaxUpdatesLongPoll,
} from "../services/messageQueue.js";
import { answerMaxCallback, normalizeCallbackAnswerPayload, sendMaxMessage } from "../services/maxApi.js";
import { sendApiError } from "../utils/apiErrors.js";

function parseLimit(rawLimit) {
    const parsed = Number(rawLimit || config.onecPollDefaultLimit);
    const fallback = config.onecPollDefaultLimit;
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;

    return Math.min(value, config.onecPollMaxLimit);
}

function parseWaitMs(rawWaitMs) {
    const parsed = Number(rawWaitMs || 0);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.min(Math.floor(parsed), 55000);
}

function normalizeOutgoingBatch(body) {
    if (Array.isArray(body?.messages)) {
        return body.messages;
    }

    if (body?.message && typeof body.message === "object" && !Array.isArray(body.message)) {
        return [body.message];
    }

    if (body && typeof body === "object" && !Array.isArray(body)) {
        return [body];
    }

    return [];
}

export async function onecExchangeRoutes(app) {
    app.get(
        "/api/v1/onec/capabilities",
        { preHandler: [onecServiceAuthMiddleware] },
        async () => ({ incoming_ack: true, callback_answer: true })
    );

    app.post(
        "/api/v1/onec/callbacks/answer",
        { preHandler: [onecServiceAuthMiddleware] },
        async (req, reply) => {
            let normalized;
            try {
                normalized = normalizeCallbackAnswerPayload(req.body);
            } catch (error) {
                return sendApiError(reply, 400, error.message);
            }

            try {
                return { ok: true, ...(await answerMaxCallback(normalized)) };
            } catch {
                req.log.error({ event: "max_callback_answer_failed" },
                    "Failed to answer MAX callback");
                return sendApiError(reply, 502, "max_callback_answer_failed");
            }
        }
    );

    app.get(
        "/api/v1/onec/messages/incoming",
        { preHandler: [onecServiceAuthMiddleware] },
        async (req, reply) => {
            if (req.query?.ack !== undefined && !["true", "false"].includes(req.query.ack)) {
                return sendApiError(reply, 400, "incoming_ack_mode_invalid");
            }
            const limit = parseLimit(req.query?.limit);
            const waitMs = parseWaitMs(req.query?.waitMs);
            const durable = req.query?.ack === "true";
            const messages = durable
                ? await claimIncomingMaxUpdatesLongPoll(limit, waitMs)
                : waitMs > 0
                ? await popIncomingMaxUpdatesLongPoll(limit, waitMs)
                : await popIncomingMaxUpdates(limit);
            const remaining = await getIncomingQueueLength();

            req.log.info({
                event: "onec_incoming_messages_polled",
                deliveredCount: messages.length,
                remaining,
                waitMs,
                durable,
            }, "1C polled incoming MAX messages");

            return {
                messages,
                remaining,
                ...(durable ? { lease_ms: incomingLeaseMs } : {}),
            };
        }
    );

    app.post(
        "/api/v1/onec/messages/incoming/ack",
        { preHandler: [onecServiceAuthMiddleware] },
        async (req, reply) => {
            const receipts = req.body?.receipts;
            if (!Array.isArray(receipts) || !receipts.length || receipts.length > config.onecPollMaxLimit
                || receipts.some((receipt) => typeof receipt !== "string" || !receipt.trim() || receipt.length > 128)) {
                return sendApiError(reply, 400, "incoming_receipts_invalid");
            }
            const acknowledged = await acknowledgeIncomingMaxUpdates(receipts);
            req.log.info({ event: "onec_incoming_messages_acknowledged", acknowledged },
                "1C acknowledged processed MAX events");
            return { ok: true, acknowledged };
        }
    );

    app.post(
        "/api/v1/onec/messages/outgoing",
        { preHandler: [onecServiceAuthMiddleware] },
        async (req, reply) => {
            const messages = normalizeOutgoingBatch(req.body);
            if (!messages.length) {
                return sendApiError(reply, 400, "outgoing_messages_required");
            }

            const results = [];
            for (const message of messages) {
                try {
                    results.push({
                        ok: true,
                        ...(await sendMaxMessage(message)),
                    });
                } catch (error) {
                    req.log.error({
                        event: "max_outgoing_message_failed",
                        err: error,
                        clientMessageId: message?.client_message_id || message?.clientMessageId || null,
                    }, "Failed to send outgoing message to MAX");

                    results.push({
                        ok: false,
                        client_message_id: message?.client_message_id || message?.clientMessageId || null,
                        error: error?.message || "max_send_failed",
                    });
                }
            }

            const failed = results.filter((result) => !result.ok).length;
            reply.code(failed ? 207 : 200);

            return {
                ok: failed === 0,
                sent: results.length - failed,
                failed,
                results,
            };
        }
    );
}
