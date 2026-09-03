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

export async function sendMaxMessage(payload) {
    if (!config.maxBotToken) {
        throw new Error("max_bot_token_not_configured");
    }

    const normalized = normalizeOutgoingMessagePayload(payload);
    const timeout = createTimeoutSignal(config.maxRequestTimeoutMs);
    const queryString = normalized.query.toString();
    const url = `${appendMaxApiPath("/messages")}${queryString ? `?${queryString}` : ""}`;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: config.maxBotToken,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(normalized.body),
            signal: timeout.signal,
        });

        const data = await response.json()
            .catch(async () => ({ raw: await response.text().catch(() => "") }));

        if (!response.ok) {
            const reason = data?.desc || data?.error || data?.message || response.statusText || "max_api_error";
            throw new Error(`max_api_request_failed:${response.status}:${reason}`);
        }

        return {
            client_message_id: normalized.client_message_id,
            max_response: data,
        };
    } finally {
        timeout.clear();
    }
}
