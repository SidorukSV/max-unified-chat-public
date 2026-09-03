import { authMiddleware } from "../middleware/auth.js";
import {
    createAppointmentDocument,
    getDoctorSchedule,
    getAppointmentsDocuments,
    getMedicalDocuments,
    getAppointmentsSchedule,
    getSurveysDocuments,
    getSurveyDocumentById,
    updateAppointmentDocument,
    updateSurveyDocument,
} from "../services/onecRouter.js";

function getRequestPayload(body) {
    if (!body) {
        return {};
    }

    if (typeof body === "string") {
        return JSON.parse(body || "{}");
    }

    return body;
}

export async function documentsRoutes(app) {
    app.get("/api/v1/documents/appointments",
        { preHandler: [authMiddleware] },
        async (req) => {
            const { patient_id } = req.user;
            const items = await getAppointmentsDocuments({ patient_id });

            return {
                items,
            };
        });

    app.get("/api/v1/documents/schedule",
        { preHandler: [authMiddleware] },
        async (req) => {
            const { doctorId, branchId, date, format } = req.query || {};

            if (!doctorId || !branchId) {
                return { items: [] };
            }

            const items = await getDoctorSchedule({
                doctorId,
                branchId,
                date,
                format,
            });

            return { items };
        });

    app.get("/api/v1/documents/medical",
        { preHandler: [authMiddleware] },
        async (req) => {
            const { patient_id } = req.user;
            const items = await getMedicalDocuments({ patient_id });

            return {
                items,
            };
        });

    app.get("/api/v1/documents/surveys",
        { preHandler: [authMiddleware] },
        async (req) => {
            const { patient_id } = req.user;
            const items = await getSurveysDocuments({ patient_id });

            return {
                items,
            };
        });

    app.get("/api/v1/documents/survey",
        { preHandler: [authMiddleware] },
        async (req) => {
            const { surveyId } = req.query || {};

            if (!surveyId) {
                return { item: null };
            }

            const item = await getSurveyDocumentById({ surveyId });
            return { item };
        });

    app.post("/api/v1/documents/appointments",
        { preHandler: [authMiddleware] },
        async (req) => {
            const { patient_id } = req.user;
            const payload = {
                ...getRequestPayload(req.body),
                patient_id,
            };

            const item = await createAppointmentDocument({ payload });
            return { item };
        });

    app.put("/api/v1/documents/appointments",
        { preHandler: [authMiddleware] },
        
        async (req) => {
            const { patient_id } = req.user;
            const payload = {
                ...getRequestPayload(req.body),
                patient_id,
            };

            const item = await updateAppointmentDocument({ payload });
            return { item };
        });

    app.put("/api/v1/documents/surveys",
        { preHandler: [authMiddleware] },
        async (req) => {
            const payload = getRequestPayload(req.body);
            const item = await updateSurveyDocument({ payload });
            return { item };
        });
}
