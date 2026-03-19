const { buildIncomingWebhookPayload } = require('./webhookPayload');
const { generateMedicalReply } = require('./medicalAiAssistant');

const FALLBACK_REPLY_TEXT = 'We received your request and will connect you with a medical advisor shortly.';

function canUseAi(aiConfig) {
    return Boolean(
        aiConfig
        && aiConfig.baseUrl
        && aiConfig.apiKey
        && aiConfig.model
    );
}

function decideReply(payload) {
    if (payload.fromMe) {
        return { shouldReply: false, reason: 'from_me' };
    }
    if (payload.isGroup) {
        return { shouldReply: false, reason: 'group_message' };
    }
    if (!String(payload.body || '').trim()) {
        return { shouldReply: false, reason: 'empty_message' };
    }
    if (!String(payload.senderAccount?.jid || '').trim()) {
        return { shouldReply: false, reason: 'missing_sender' };
    }
    return { shouldReply: true, reason: 'eligible' };
}

function buildBaseResult(payload, decision) {
    return {
        success: true,
        event: 'whatsapp.webhook_processed',
        requestId: payload.requestId,
        incoming: payload,
        decision,
        ai: {
            used: false,
            triage: {
                isDiseaseConsultation: false,
                needRag: false,
                keywords: [],
                reason: ''
            },
            triageRaw: '',
            rag: {
                searched: false,
                resultsCount: 0,
                results: []
            },
            error: ''
        },
        reply: {
            to: payload.senderAccount?.jid || '',
            text: ''
        }
    };
}

async function handleIncomingWebhookMessage({
    incomingPayload,
    aiConfig = {},
    ragConfig = {},
    generateReply = generateMedicalReply
}) {
    const normalizedPayload = buildIncomingWebhookPayload(
        incomingPayload || {},
        incomingPayload?.to || ''
    );
    const decision = decideReply(normalizedPayload);
    const result = buildBaseResult(normalizedPayload, decision);

    if (!decision.shouldReply) {
        return result;
    }

    if (!canUseAi(aiConfig)) {
        result.decision.reason = 'ai_not_configured';
        result.reply.text = FALLBACK_REPLY_TEXT;
        return result;
    }

    result.ai.used = true;
    try {
        const aiResult = await generateReply({
            messageText: normalizedPayload.body,
            aiConfig,
            ragConfig
        });

        result.ai.triage = aiResult?.triage || result.ai.triage;
        result.ai.triageRaw = String(aiResult?.triageRaw || '');
        result.ai.rag.results = Array.isArray(aiResult?.ragResults) ? aiResult.ragResults : [];
        result.ai.rag.resultsCount = result.ai.rag.results.length;
        result.ai.rag.searched = Boolean(result.ai.triage.needRag);
        result.reply.text = String(aiResult?.replyText || '').trim() || FALLBACK_REPLY_TEXT;
    } catch (error) {
        result.ai.error = String(error?.message || error);
        result.reply.text = FALLBACK_REPLY_TEXT;
    }

    return result;
}

module.exports = {
    FALLBACK_REPLY_TEXT,
    handleIncomingWebhookMessage
};
