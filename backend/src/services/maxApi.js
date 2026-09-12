import { config } from "../config.js";

function createTimeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        clear: () => clearTimeout(timeout),
    };
}

function appendMaxApiPath(endpointPath) {
    const normalizedBaseUrl = String(config.maxApiBaseUrl || "").replace(/\/+$/, "");
    let base;
    try { base = new URL(normalizedBaseUrl); } catch { /* rejected below before fetch */ }
    if (!base || base.protocol !== "https:" || base.username || base.password) {
        const error = new Error("max_api_https_required");
        error.delivery_status = "not_sent";
        throw error;
    }
    const normalizedEndpointPath = endpointPath.startsWith("/")
        ? endpointPath
        : `/${endpointPath}`;

    return normalizedBaseUrl.concat(normalizedEndpointPath);
}

function buildSendMessageQuery({ user_id, userId, chat_id, chatId, disable_link_preview, disableLinkPreview }) {
    const params = new URLSearchParams();
    const resolvedUserId = user_id ?? userId;
    const resolvedChatId = chat_id ?? chatId;
    const resolvedDisableLinkPreview = disable_link_preview ?? disableLinkPreview;

    if (resolvedUserId !== undefined && resolvedUserId !== null && String(resolvedUserId).trim()) {
        params.set("user_id", String(resolvedUserId).trim());
    }

    if (resolvedChatId !== undefined && resolvedChatId !== null && String(resolvedChatId).trim()) {
        params.set("chat_id", String(resolvedChatId).trim());
    }

    if (typeof resolvedDisableLinkPreview === "boolean") {
        params.set("disable_link_preview", String(resolvedDisableLinkPreview));
    }

    return params;
}

function buildSendMessageBody(payload) {
    const body = {};

    for (const key of ["text", "attachments", "link", "notify", "format"]) {
        if (payload[key] !== undefined) {
            body[key] = payload[key];
        }
    }

    return body;
}

export function normalizeOutgoingMessagePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("outgoing_message_invalid");
    }

    const query = buildSendMessageQuery(payload);
    if (!query.has("user_id") && !query.has("chat_id")) {
        throw new Error("recipient_required");
    }

    const body = buildSendMessageBody(payload);
    if (!body.text && !body.attachments && !body.link) {
        throw new Error("message_body_required");
    }

    return {
        query,
        body,
        client_message_id: payload.client_message_id || payload.clientMessageId || null,
    };
}

async function postMaxApi(endpointPath, query, body) {
    if (!config.maxBotToken) {
        const error = new Error("max_bot_token_not_configured");
        error.delivery_status = "not_sent";
        throw error;
    }

    const queryString = query.toString();
    const url = `${appendMaxApiPath(endpointPath)}${queryString ? `?${queryString}` : ""}`;
    const timeout = createTimeoutSignal(config.maxRequestTimeoutMs);

    try {
        const response = await fetch(url, {
            method: "POST",
            redirect: "error",
            headers: {
                Authorization: config.maxBotToken,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: timeout.signal,
        });

        const data = await response.json()
            .catch(async () => ({ raw: await response.text().catch(() => "") }));

        if (!response.ok) {
            // Provider text may contain echoed patient data or URLs/tokens.
            const error = new Error(`max_api_request_failed:${response.status}`);
            error.delivery_status = response.status >= 400 && response.status < 500 && response.status !== 408
                ? "not_sent" : "unknown";
            // This explicit provider rejection permits a later attachment retry;
            // transport timeouts never do. We do not retry requests here.
            if (data?.code === "attachment.not.ready") {
                error.code = "attachment_not_ready";
                error.delivery_status = "not_sent";
            }
            throw error;
        }

        return data;
    } finally {
        timeout.clear();
    }
}

export async function sendMaxMessage(payload) {
    let normalized;
    try { normalized = normalizeOutgoingMessagePayload(payload); }
    catch (error) {
        error.delivery_status = "not_sent";
        throw error;
    }
    const response = await postMaxApi("/messages", normalized.query, normalized.body);
    const message = response?.message ?? response;
    const mid = (message?.body ?? message)?.mid;
    if (response?.success === false || response?.ok === false || typeof mid !== "string" || !mid.trim()) {
        const error = new Error("max_delivery_unconfirmed");
        // HTTP 200 is not proof of delivery; preserve ambiguity rather than invite a duplicate.
        error.delivery_status = "unknown";
        throw error;
    }
    return {
        client_message_id: normalized.client_message_id,
        delivery_status: "sent",
        max_response: response,
    };
}

function validateCallbackKeyboard(attachments) {
    if (attachments === undefined || attachments === null) return;
    if (!Array.isArray(attachments) || attachments.length > 1) throw new Error("callback_attachments_invalid");
    for (const attachment of attachments) {
        const rows = attachment?.payload?.buttons;
        if (attachment?.type !== "inline_keyboard" || !Array.isArray(rows) || !rows.length || rows.length > 100
            || Object.keys(attachment).some((key) => !["type", "payload"].includes(key))
            || Object.keys(attachment.payload).some((key) => key !== "buttons")) {
            throw new Error("callback_keyboard_invalid");
        }
        let count = 0;
        for (const row of rows) {
            if (!Array.isArray(row) || !row.length || row.length > 10) throw new Error("callback_keyboard_invalid");
            for (const button of row) {
                count += 1;
                if (count > 100 || !button || typeof button !== "object" || Array.isArray(button)
                    || button.type !== "callback" || typeof button.text !== "string" || !button.text.trim()
                    || button.text.length > 128 || typeof button.payload !== "string" || !button.payload.trim()
                    || Buffer.byteLength(button.payload, "utf8") > 1024
                    || Object.keys(button).some((key) => !["type", "text", "payload", "intent"].includes(key))
                    || (button.intent !== undefined && !["default", "positive", "negative"].includes(button.intent))) {
                    throw new Error("callback_button_invalid");
                }
            }
        }
    }
}

export function normalizeCallbackAnswerPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || typeof payload.callback_id !== "string" || !payload.callback_id.trim() || payload.callback_id.length > 1024) {
        throw new Error("callback_id_required");
    }

    if (!payload.message || typeof payload.message !== "object" || Array.isArray(payload.message)) {
        throw new Error("callback_message_required");
    }

    const message = buildSendMessageBody(payload.message);
    if (message.text !== undefined && message.text !== null
        && (typeof message.text !== "string" || message.text.length > 4000)) {
        throw new Error("callback_message_invalid");
    }
    validateCallbackKeyboard(message.attachments);
    if (!message.text && !message.attachments && !message.link) {
        throw new Error("callback_message_required");
    }

    const query = new URLSearchParams({ callback_id: payload.callback_id });
    if (typeof payload.disable_link_preview === "boolean") {
        query.set("disable_link_preview", String(payload.disable_link_preview));
    }

    // Current MAX API answers callbacks by editing the source message, not by
    // sending an obsolete notification-only response or by addressing a user.
    return { query, body: { message } };
}

export async function answerMaxCallback(normalized) {
    const data = await postMaxApi("/answers", normalized.query, normalized.body);
    if (data?.success !== true) {
        throw new Error("max_callback_answer_rejected");
    }

    return { max_response: data };
}
