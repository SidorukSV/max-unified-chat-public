import { config } from "../config.js";
import { onecServiceAuthMiddleware } from "../middleware/serviceAuth.js";
import { getIncomingQueueLength, popIncomingMaxUpdates } from "../services/messageQueue.js";
import { sendMaxMessage } from "../services/maxApi.js";
import { sendApiError } from "../utils/apiErrors.js";

function parseLimit(rawLimit) {
    const parsed = Number(rawLimit || config.onecPollDefaultLimit);
    const fallback = config.onecPollDefaultLimit;
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;

    return Math.min(value, config.onecPollMaxLimit);
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
        "/api/v1/onec/messages/incoming",
        { preHandler: [onecServiceAuthMiddleware] },
        async (req) => {
            const limit = parseLimit(req.query?.limit);
            const messages = await popIncomingMaxUpdates(limit);
            const remaining = await getIncomingQueueLength();

            req.log.info({
                event: "onec_incoming_messages_polled",
                deliveredCount: messages.length,
                remaining,
            }, "1C polled incoming MAX messages");

            return {
                messages,
                remaining,
            };
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
