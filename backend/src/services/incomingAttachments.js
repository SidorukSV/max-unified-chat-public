// The receiver does not accept patient files. Retain presence/type for the 1C
// refusal template, but do not retain download URLs, tokens, names or previews.
// Contact payload must remain unchanged: 1C verifies its HMAC and sender binding.
export function minimizeIncomingAttachments(update) {
    if (!["message_created", "message_edited"].includes(update?.update_type)
        || !Array.isArray(update?.message?.body?.attachments)) return update;
    return {
        ...update,
        message: {
            ...update.message,
            body: {
                ...update.message.body,
                attachments: update.message.body.attachments.map((attachment) => {
                    if (attachment?.type === "contact") return attachment;
                    return {
                        type: typeof attachment?.type === "string" && attachment.type.length <= 64
                            ? attachment.type : "unsupported",
                        payload: {}, rejected: true,
                    };
                }),
            },
        },
    };
}
