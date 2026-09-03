import { authMiddleware } from "../middleware/auth.js";
import { getRedisClient } from "../store/redisClient.js";
import { sendApiError } from "../utils/apiErrors.js";
import {
    getCatalogEmployeesBySpec,
    getCatalogSpecializationsBySchedule,
    getCatalogSurveyTemplateById,
    getCatalogSurveyTemplates,
} from "../services/onecRouter.js";

const APPOINTMENT_TYPES = new Set(["online", "phone", "phone_and_chat"]);
const SPECIALIZATION_ICON_CODES = new Set([
    "default",
    "therapy",
    "doctor",
    "cardiology",
    "dentistry",
    "surgery",
    "gynecology",
    "urology",
    "neurology",
    "ophthalmology",
    "pediatrics",
    "lab",
    "diagnostics",
    "xray",
    "vaccination",
    "cosmetology",
    "trichology",
    "physiotherapy",
]);

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function isValidAppointmentType(value) {
    return APPOINTMENT_TYPES.has(value);
}

function isValidIconCode(value) {
    if (value === undefined || value === null || value === "") return true;
    return typeof value === "string" && SPECIALIZATION_ICON_CODES.has(value.trim());
}

function validateCategoryPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return "payload_invalid";
    }

    if (!isUuid(payload.categoryId)) return "category_id_invalid";
    if (!isValidAppointmentType(payload.appointment_type)) return "appointment_type_invalid";
    if (typeof payload.isCartAllow !== "boolean") return "is_cart_allow_invalid";
    if (typeof payload.isDateRequired !== "boolean") return "is_date_required_invalid";
    if (typeof payload.isDoctorRequired !== "boolean") return "is_doctor_required_invalid";
    if (!Array.isArray(payload.employees)) return "employees_invalid";
    if (!Array.isArray(payload.specializations)) return "specializations_invalid";
    if (!Array.isArray(payload.services)) return "services_invalid";

    for (const employee of payload.employees) {
        if (!isUuid(employee?.doctorId)) return "employee_doctor_id_invalid";
        if (!isNonEmptyString(employee?.doctorTitle)) return "employee_doctor_title_invalid";
        if (!isNonEmptyString(employee?.doctorLastname)) return "employee_doctor_lastname_invalid";
        if (!isNonEmptyString(employee?.doctorFirstname)) return "employee_doctor_firstname_invalid";
        if (!isNonEmptyString(employee?.doctorPatronymic)) return "employee_doctor_patronymic_invalid";
        if (!Number.isFinite(employee?.doctorDuration)) return "employee_doctor_duration_invalid";
        if (!Array.isArray(employee?.specializations) || employee.specializations.some((id) => !isUuid(id))) {
            return "employee_specializations_invalid";
        }
    }

    for (const specialization of payload.specializations) {
        if (!isUuid(specialization?.specializationId)) return "specialization_id_invalid";
        if (!isNonEmptyString(specialization?.specializationTitle)) return "specialization_title_invalid";
        if (!isValidAppointmentType(specialization?.appointment_type)) return "specialization_appointment_type_invalid";
        if (!isNonEmptyString(specialization?.appointment_phone)) return "specialization_appointment_phone_invalid";
        if (!isValidIconCode(specialization?.iconCode)) return "specialization_icon_code_invalid";
    }

    for (const service of payload.services) {
        if (!isUuid(service?.serviceId)) return "service_id_invalid";
        if (!isNonEmptyString(service?.serviceTitle)) return "service_title_invalid";
        if (!Number.isFinite(service?.servicePrice)) return "service_price_invalid";
        if (!Number.isFinite(service?.serviceDuration)) return "service_duration_invalid";
        if (!isUuid(service?.specializationId)) return "service_specialization_id_invalid";
    }

    return null;
}

export async function catalogsRoutes(app) {
    app.get("/api/v1/catalogs/specializations",
        { preHandler: [authMiddleware] },
        async (req) => {
            const items = await getCatalogSpecializationsBySchedule();
            return { items };
        });

    app.get("/api/v1/catalogs/employees",
        { preHandler: [authMiddleware] },
        async (req) => {
            const { specializationId } = req.query || {};
            if (!specializationId) {
                return { items: [] };
            }

            const items = await getCatalogEmployeesBySpec({ specializationId });
            return { items };
        });

    app.get("/api/v1/catalogs/surveyTemplates",
        { preHandler: [authMiddleware] },
        async (req) => {
            const { surveyTemplateId } = req.query || {};

            if (surveyTemplateId) {
                const item = await getCatalogSurveyTemplateById({ surveyTemplateId });
                return { item };
            }

            const items = await getCatalogSurveyTemplates();
            return { items };
        });

    app.post("/api/v1/catalogs/categories/",
        { preHandler: [authMiddleware] },
        async (req, reply) => {
            if (req.user?.channel !== "1c") {
                return sendApiError(reply, 403, "forbidden_channel");
            }

            const validationError = validateCategoryPayload(req.body);
            if (validationError) {
                return sendApiError(reply, 400, validationError);
            }

            const redis = await getRedisClient();
            const payload = {
                ...req.body,
                updatedAt: new Date().toISOString(),
            };
            const redisKey = `onec:catalogs:category:${req.body.categoryId}`;
            await redis.set(redisKey, JSON.stringify(payload));

            return {
                ok: true,
                key: redisKey,
            };
        });
}
