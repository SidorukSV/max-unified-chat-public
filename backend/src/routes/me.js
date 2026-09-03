import { authMiddleware } from "../middleware/auth.js";
import {
    DEFAULT_APPLICATION_SETTINGS,
    getApplicationSettings,
    getBonusTransactions,
    getPatientById,
    getPatientsByPhone,
} from "../services/onecRouter.js";
import { sendApiError } from "../utils/apiErrors.js";

export async function meRoutes(app) {
    app.get("/api/v1/me",
        { preHandler: [authMiddleware] },
        async (req, reply) => {
            const { patient_id, phone, channel } = req.user;
            try {
                const [patient, patientsByPhone, applicationSettings] = await Promise.all([
                    getPatientById({ patient_id }),
                    getPatientsByPhone({ phone }).catch(() => []),
                    getApplicationSettings().catch((error) => {
                        req.log.warn({
                            endpoint: "/api/v1/me",
                            operation: "getApplicationSettings",
                            err: error,
                        }, "Failed to load application settings; using defaults");

                        return DEFAULT_APPLICATION_SETTINGS;
                    }),
                ]);

                const patientsByPhoneSorted = Array.isArray(patientsByPhone)
                    ? [...patientsByPhone].sort((a, b) => String(a?.fullName || "").toUpperCase()
                        .localeCompare(String(b?.fullName || "").toUpperCase()))
                    : [];

                return {
                    ...patient,
                    phone,
                    channel,
                    patients_by_phone: patientsByPhoneSorted,
                    ...applicationSettings,
                };
            } catch (error) {
                req.log.error({
                    endpoint: "/api/v1/me",
                    operation: "getPatientById",
                    err: error,
                }, "Failed to load profile");
                return sendApiError(reply, 502, "profile_unavailable");
            }
        });

    app.get("/api/v1/me/bonus-transactions",
        { preHandler: [authMiddleware] },
        async (req, reply) => {
            const { patient_id } = req.user;
            try {
                const transactions = await getBonusTransactions({ patient_id });
                return {
                    items: transactions,
                };
            } catch (error) {
                req.log.error({
                    endpoint: "/api/v1/me/bonus-transactions",
                    operation: "getBonusTransactions",
                    err: error,
                }, "Failed to load bonus transactions");
                return sendApiError(reply, 502, "bonus_transactions_unavailable");
            }
        });

}
