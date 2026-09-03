import { config } from "../config.js";

let ibSessionCookie = null;

export const DEFAULT_APPLICATION_SETTINGS = Object.freeze({
    visibility_pages: Object.freeze({
        bonuses: true,
        survey: true,
    }),
});

function validateOneCConfig(oneCConfig) {
    if (!oneCConfig) {
        throw new Error("onec_config_not_found");
    }

    if (!oneCConfig.url) {
        throw new Error("onec_config_url_missing");
    }

    if (!oneCConfig.basicAuth) {
        throw new Error("onec_config_basic_auth_missing");
    }

    return oneCConfig;
}

function resolveOneCConfigByUrl(path) {
    const oneCConfig = config.oneCConfig;

    if (!oneCConfig?.url || !path.startsWith(oneCConfig.url)) {
        return null;
    }

    return validateOneCConfig(oneCConfig);
}

function parseIbSessionCookie(setCookieHeader) {
    if (!setCookieHeader) {
        return null;
    }

    const match = setCookieHeader.match(/ibsession=([^;,\s]+)/i);
    if (!match?.[1]) {
        return null;
    }

    return `ibsession=${match[1]}`;
}

function appendOneCPath(baseUrl, endpointPath) {
    const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
    const normalizedEndpointPath = endpointPath.startsWith("/")
        ? endpointPath
        : `/${endpointPath}`;

    return normalizedBaseUrl.concat(normalizedEndpointPath);
}

function createTimeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        clear: () => clearTimeout(timeout),
    };
}

export async function onecFetch(path, options = {}) {
    const oneCConfig = resolveOneCConfigByUrl(path);
    const { headers: optionHeaders, ...restOptions } = options;
    const hasBody = options.body !== undefined;
    const initialHeaders = new Headers(optionHeaders || {});
    const hasCookieHeader = initialHeaders.has("Cookie");

    const requestWithCookie = async (cookie) => {
        const headers = new Headers(optionHeaders || {});

        if (hasBody && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }

        if (cookie && !hasCookieHeader) {
            headers.set("Cookie", cookie);
        }

        return fetch(path, {
            ...restOptions,
            headers,
        });
    };

    let storedCookie = oneCConfig ? ibSessionCookie : null;
    if (oneCConfig && !storedCookie && !hasCookieHeader) {
        storedCookie = await startOneCSession(oneCConfig);
    }

    let res = await requestWithCookie(storedCookie);

    // 1C can invalidate IB sessions unexpectedly.
    // If the cookie became stale, recreate the session and retry once.
    if (res.status >= 400 && oneCConfig && !hasCookieHeader) {
        ibSessionCookie = null;
        const refreshedCookie = await startOneCSession(oneCConfig);
        res = await requestWithCookie(refreshedCookie);
        storedCookie = refreshedCookie;
    }

    const data = await res.json().
        catch(async () => { return await res.text().catch(() => "") });
    
    let isJsonResponse = true;
    if (typeof(data) === typeof(String)) {
        isJsonResponse = false;
    }

    if (!res.ok) {
        const reason = data.desc
            || data.error
            || (!isJsonResponse ? data : JSON.stringify(data))
            || "api_error";
        throw new Error(reason);
    }

    return isJsonResponse ? data : {};
}

export function getOneCConfig() {
    return validateOneCConfig(config.oneCConfig);
}

export function normalizeApplicationSettings(payload) {
    const visibilityPages = payload?.visibility_pages;

    return {
        visibility_pages: {
            bonuses: visibilityPages?.bonuses !== false,
            survey: visibilityPages?.survey !== false,
        },
    };
}

export async function getApplicationSettings() {
    const oneCConfig = getOneCConfig();
    const endpoint = "/settings";

    try {
        const data = await onecFetch(appendOneCPath(oneCConfig.url, endpoint), {
            method: "GET",
            headers: {
                Authorization: `Basic ${oneCConfig.basicAuth}`,
            },
        });

        return normalizeApplicationSettings(data);
    } catch (error) {
        throw new Error(`onec_request_failed:endpoint=${endpoint};operation=getApplicationSettings;reason=${error.message}`);
    }
}

export async function startOneCSessions() {
    if (config.oneCConfig) {
        await startOneCSession(config.oneCConfig);
    }
}

export async function finishOneCSessions() {
    if (config.oneCConfig) {
        await finishOneCSession(config.oneCConfig);
    }
}

async function startOneCSession(oneCConfig) {
    const startUrl = oneCConfig.url.concat("/startIBSession");

    try {
        const res = await fetch(startUrl, {
            method: "HEAD",
            headers: {
                Authorization: `Basic ${oneCConfig.basicAuth}`,
                IBSession: "start",
            },
        });

        if (!res.ok) {
            return null;
        }

        const cookie = parseIbSessionCookie(res.headers.get("set-cookie"));
        if (!cookie) {
            return null;
        }

        ibSessionCookie = cookie;
        return cookie;
    } catch {
        return null;
    }
}

async function finishOneCSession(oneCConfig) {
    const finishUrl = oneCConfig.url.concat("/finishIBSession");
    const cookie = ibSessionCookie;

    try {
        const res = await fetch(finishUrl, {
            method: "HEAD",
            headers: {
                Authorization: `Basic ${oneCConfig.basicAuth}`,
                IBSession: "finish",
                ...(cookie ? { Cookie: cookie } : {}),
            },
        });

    } catch {
        // no-op: session cleanup is best effort
    } finally {
        ibSessionCookie = null;
    }
}

export async function getPatientsByPhone({ phone}) {
    const oneCConfig = getOneCConfig();
    const endpoint = "/catalogs/clients";
    let data;
    try {
        data = await onecFetch(oneCConfig.url.concat(`${endpoint}/?search_type=ByPhone&phone=${phone}`), {
            method: "GET",
            headers: {
                Authorization: `Basic ${oneCConfig.basicAuth}`,
            },
        });
    } catch (error) {
        throw new Error(`onec_request_failed:endpoint=${endpoint};operation=getPatientsByPhone;reason=${error.message}`);
    }

    if (data?.error) {
        return [];
    }
    else { 
        return data; 
    }

}

export async function getPatientById({ patient_id}) {
    const oneCConfig = getOneCConfig();
    const endpoint = "/catalogs/clients";
    let data;
    try {
        data = await onecFetch(oneCConfig.url.concat(`${endpoint}/?search_type=ByID&patient_id=${patient_id}`), {
            method: "GET",
            headers: {
                Authorization: `Basic ${oneCConfig.basicAuth}`,
            },
        });
    } catch (error) {
        throw new Error(`onec_request_failed:endpoint=${endpoint};operation=getPatientById;reason=${error.message}`);
    }

    if (data?.error) {
        return [];
    }
    else { 
        return data; 
    }

}

export async function getBonusTransactions({ patient_id }) {
    const oneCConfig = getOneCConfig();
    const endpoint = "/transactions/bonus";
    let data;
    try {
        data = await onecFetch(oneCConfig.url.concat(endpoint), {
            method: "POST",
            headers: {
                Authorization: `Basic ${oneCConfig.basicAuth}`,
            },
            body: JSON.stringify({ patient_id }),
        });
    } catch (error) {
        throw new Error(`onec_request_failed:endpoint=${endpoint};operation=getBonusTransactions;reason=${error.message}`);
    }

    if (!Array.isArray(data)) {
        return [];
    }

    return data.map((transaction) => {
        const normalizedOperation = String(transaction?.operation || "").toLowerCase();
        const operation = normalizedOperation === "расход" || normalizedOperation === "debit"
            ? "debit"
            : "credit";

        return {
            operation,
            sum: Number(transaction?.sum || 0),
            description: transaction?.description || "",
            date: transaction?.date || transaction?.Date || transaction?.date_time || null,
            operation_sum: transaction?.operation_sum !== undefined
                ? Number(transaction.operation_sum)
                : undefined,
        };
    });
}

export async function getAppointmentsDocuments({ patient_id }) {
    const oneCConfig = getOneCConfig();
    const data = await onecFetch(oneCConfig.url.concat(`/documents/appointments?search_type=ByPatient&patient_id=${patient_id}`), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!Array.isArray(data)) {
        return [];
    }

    return data;
}

export async function getSurveysDocuments({ patient_id }) {
    const oneCConfig = getOneCConfig();
    const params = new URLSearchParams({
        search_type: "ByPatient",
        patient_id,
    });

    const data = await onecFetch(oneCConfig.url.concat(`/documents/surveys?${params}`), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!Array.isArray(data)) {
        return [];
    }

    return data;
}

export async function getSurveyDocumentById({ surveyId }) {
    const oneCConfig = getOneCConfig();
    const params = new URLSearchParams({
        search_type: "ByID",
        surveyId,
    });

    return onecFetch(oneCConfig.url.concat(`/documents/surveys/?${params}`), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });
}

export async function getMedicalDocuments({ patient_id }) {
    const oneCConfig = getOneCConfig();
    const params = new URLSearchParams({
        patient_id,
    });

    const data = await onecFetch(oneCConfig.url.concat(`/documents/medical?search_type=ByPatient&${params}`), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!Array.isArray(data)) {
        return [];
    }

    return data;
}

export async function getAppointmentsSchedule({ specializationId }) {
    const oneCConfig = getOneCConfig();
    const params = new URLSearchParams();
    if (specializationId) {
        params.set("specializationId", specializationId);
    }

    const data = await onecFetch(oneCConfig.url.concat(`/documents/schedule${params.toString() ? `?${params}` : ""}`), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!Array.isArray(data)) {
        return [];
    }

    return data;
}

export async function getCatalogSpecializationsBySchedule() {
    const oneCConfig = getOneCConfig();
    const data = await onecFetch(oneCConfig.url.concat("/catalogs/specializations?search_type=BySchedule"), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!Array.isArray(data)) {
        return [];
    }

    return data;
}

export async function getCatalogEmployeesBySpec({ specializationId }) {
    const oneCConfig = getOneCConfig();
    const params = new URLSearchParams({
        search_type: "BySpec",
        specializationId,
    });
    const data = await onecFetch(oneCConfig.url.concat(`/catalogs/employees?${params}`), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!Array.isArray(data)) {
        return [];
    }

    return data;
}

export async function getCatalogSurveyTemplates() {
    const oneCConfig = getOneCConfig();
    const data = await onecFetch(oneCConfig.url.concat("/catalogs/surveyTemplates"), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!Array.isArray(data)) {
        return [];
    }

    return Promise.all(data.map((template) => enrichSurveyTemplateAnswerItems({ oneCConfig, template })));
}

export async function getCatalogSurveyTemplateById({ surveyTemplateId }) {
    const oneCConfig = getOneCConfig();
    const params = new URLSearchParams({
        search_type: "ByID",
        surveyTemplateId,
    });
    const template = await onecFetch(oneCConfig.url.concat(`/catalogs/surveyTemplates/?${params}`), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!template || typeof template !== "object") {
        return null;
    }

    return enrichSurveyTemplateAnswerItems({ oneCConfig, template });
}

async function enrichSurveyTemplateAnswerItems({ oneCConfig, template }) {
    const questionItems = Array.isArray(template?.questionItems) ? template.questionItems : [];
    const enrichedQuestions = await Promise.all(
        questionItems.map(async (questionItem) => {
            const questionOptions = questionItem?.questionOptions || {};
            const answerType = String(questionOptions?.answerType || "").trim().toLowerCase();
            const answerEndpoint = questionOptions?.answerEndpoint;

            if (answerType !== "valueininfobase" || !answerEndpoint) {
                return questionItem;
            }

            const dynamicAnswerItems = await loadAnswerItemsByEndpoint({
                oneCConfig,
                answerEndpoint,
                idOptionKey: questionOptions?.answerEndpoint_IdOption,
                titleOptionKey: questionOptions?.answerEndpoint_TitleOption,
            });

            return {
                ...questionItem,
                questionOptions: {
                    ...questionOptions,
                    answerItems: dynamicAnswerItems,
                },
            };
        }),
    );

    return {
        ...template,
        questionItems: enrichedQuestions,
    };
}

async function loadAnswerItemsByEndpoint({ oneCConfig, answerEndpoint, idOptionKey, titleOptionKey }) {
    if (Array.isArray(answerEndpoint)) {
        return answerEndpoint.map((value, index) => ({
            answerId: String(index + 1),
            answerTitle: String(value ?? ""),
        }));
    }

    if (typeof answerEndpoint !== "string" || !answerEndpoint.trim()) {
        return [];
    }

    const endpointPath = answerEndpoint.startsWith("/")
        ? answerEndpoint
        : `/${answerEndpoint}`;
    const data = await onecFetch(oneCConfig.url.concat(endpointPath), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    }).catch(() => []);

    if (!Array.isArray(data)) {
        return [];
    }

    const idKey = String(idOptionKey || "id");
    const titleKey = String(titleOptionKey || "title");

    return data.map((item, index) => {
        if (item && typeof item === "object") {
            const answerId = item[idKey] ?? item.id ?? index + 1;
            const answerTitle = item[titleKey] ?? item.title ?? answerId;
            return {
                answerId: String(answerId),
                answerTitle: String(answerTitle ?? ""),
            };
        }

        return {
            answerId: String(index + 1),
            answerTitle: String(item ?? ""),
        };
    });
}

export async function getDoctorSchedule({ doctorId, branchId, date, format }) {
    const oneCConfig = getOneCConfig();
    const params = new URLSearchParams({
        doctorId,
        branchId,
    });

    if (date) {
        params.set("date", date);
    }

    if (format) {
        params.set("format", format);
    }

    const data = await onecFetch(oneCConfig.url.concat(`/documents/schedule?${params}`), {
        method: "GET",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
    });

    if (!Array.isArray(data)) {
        return [];
    }

    return data;
}

export async function createAppointmentDocument({ payload }) {
    const oneCConfig = getOneCConfig();
    return onecFetch(oneCConfig.url.concat("/documents/appointments"), {
        method: "POST",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
        body: JSON.stringify(payload),
    });
}

export async function updateAppointmentDocument({ payload }) {
    const oneCConfig = getOneCConfig();
    return onecFetch(oneCConfig.url.concat("/documents/appointments"), {
        method: "PUT",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
        body: JSON.stringify(payload),
    });
}

export async function updateSurveyDocument({ payload }) {
    const oneCConfig = getOneCConfig();
    return onecFetch(oneCConfig.url.concat("/documents/surveys"), {
        method: "PUT",
        headers: {
            Authorization: `Basic ${oneCConfig.basicAuth}`,
        },
        body: JSON.stringify(payload),
    });
}

export async function forwardMaxWebhookUpdateToOneC(update) {
    const oneCConfig = getOneCConfig();
    const botId = String(config.maxBotId || "").trim();
    if (!botId) {
        throw new Error("max_bot_id_missing");
    }

    const endpoint = `/webhook/${encodeURIComponent(botId)}`;
    const timeout = createTimeoutSignal(config.maxWebhookForwardTimeoutMs);

    try {
        const result = await onecFetch(appendOneCPath(oneCConfig.url, endpoint), {
            method: "POST",
            headers: {
                Authorization: `Basic ${oneCConfig.basicAuth}`,
            },
            body: JSON.stringify(update),
            signal: timeout.signal,
        });

        return {
            result,
        };
    } catch (error) {
        const isTimeout = error?.name === "AbortError" || error?.name === "TimeoutError";
        const reason = isTimeout ? "timeout" : (error?.message || "api_error");
        throw new Error(`onec_request_failed:endpoint=${endpoint};operation=forwardMaxWebhook;reason=${reason}`);
    } finally {
        timeout.clear();
    }
}
