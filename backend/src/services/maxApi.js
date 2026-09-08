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
        throw new Error("max_bot_token_not_configured");
    }

    const timeout = createTimeoutSignal(config.maxRequestTimeoutMs);
    const queryString = query.toString();
    const url = `${appendMaxApiPath(endpointPath)}${queryString ? `?${queryString}` : ""}`;

    try {
        const response = await fetch(url, {
            method: "POST",
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
            const reason = data?.desc || data?.error || data?.message || response.statusText || "max_api_error";
            throw new Error(`max_api_request_failed:${response.status}:${reason}`);
        }

        return data;
    } finally {
        timeout.clear();
    }
}

export async function sendMaxMessage(payload) {
    const normalized = normalizeOutgoingMessagePayload(payload);
    return {
        client_message_id: normalized.client_message_id,
        max_response: await postMaxApi("/messages", normalized.query, normalized.body),
    };
}

export function normalizeCallbackAnswerPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || typeof payload.callback_id !== "string" || !payload.callback_id.trim()) {
        throw new Error("callback_id_required");
    }

    if (!payload.message || typeof payload.message !== "object" || Array.isArray(payload.message)) {
        throw new Error("callback_message_required");
    }

    const message = buildSendMessageBody(payload.message);
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
