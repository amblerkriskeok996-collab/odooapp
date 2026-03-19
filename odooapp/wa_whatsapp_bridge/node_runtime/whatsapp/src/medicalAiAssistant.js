const fetch = require('node-fetch');

const DEFAULT_RAG_TOP_K = 10;
const DEFAULT_TIMEOUT_MS = 30000;

const FALLBACK_DISEASE_KEYWORDS = [
    '病', '疾病', '症状', '诊断', '治疗', '手术', '术后', '康复',
    '医院', '医生', '住院', '检查', '化疗', '放疗', '移植',
    '癌', '瘤', '心脏', '脑', '肝', '肺', '肾', '胃', '骨',
    '费用', '价格', '多少钱', '预算'
];

function normalizeBaseUrl(raw) {
    return String(raw || '').trim().replace(/\/+$/, '');
}

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return ['true', '1', 'yes', 'y', '是', '需要'].includes(normalized);
}

function extractJsonObject(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return {};

    const directJson = tryParseJson(text);
    if (directJson) return directJson;

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        const parsedFence = tryParseJson(fenced[1]);
        if (parsedFence) return parsedFence;
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const sliced = text.slice(start, end + 1);
        const parsedSlice = tryParseJson(sliced);
        if (parsedSlice) return parsedSlice;
    }

    return {};
}

function tryParseJson(raw) {
    try {
        return JSON.parse(raw);
    } catch (error) {
        return null;
    }
}

function normalizeKeywords(value) {
    if (!Array.isArray(value)) return [];
    const uniq = new Set();
    for (const keyword of value) {
        const cleaned = String(keyword || '').trim();
        if (!cleaned) continue;
        uniq.add(cleaned);
    }
    return Array.from(uniq).slice(0, 3);
}

function normalizeTriageResult(raw, messageText = '') {
    const input = raw && typeof raw === 'object' ? raw : {};
    const message = String(messageText || '');
    const fallbackDisease = FALLBACK_DISEASE_KEYWORDS.some((keyword) => message.includes(keyword));
    const isDiseaseConsultation = toBoolean(input.is_disease_consultation) || fallbackDisease;
    const keywords = normalizeKeywords(input.keywords);
    const needRagByOutput = toBoolean(input.need_rag);
    const needRag = needRagByOutput || (isDiseaseConsultation && keywords.length > 0);

    return {
        isDiseaseConsultation,
        needRag,
        keywords,
        reason: String(input.reason || '').trim() || 'No reason returned by model.'
    };
}

function buildTriageMessages(messageText) {
    return [
        {
            role: 'system',
            content: [
                '你是海外医疗客服系统里的“意图分诊器”。',
                '任务：判断用户是否在咨询疾病/治疗相关问题，是否需要调用RAG费用检索，并给出检索关键词。',
                '必须仅输出 JSON，不要输出任何额外文本。',
                'JSON字段固定为：',
                '{',
                '  "is_disease_consultation": boolean,',
                '  "need_rag": boolean,',
                '  "keywords": string[],',
                '  "reason": string',
                '}',
                '规则：',
                '1) 用户提到疾病、症状、治疗方案、手术、检查、住院、费用/价格/预算时，is_disease_consultation=true。',
                '2) 用户涉及治疗费用、手术费用、住院费用、诊疗项目费用，need_rag=true。',
                '3) keywords用于DRG检索，只保留1-3个最关键中文医学关键词，避免长句。',
                '4) 如果用户不是医疗咨询，keywords返回空数组，need_rag=false。'
            ].join('\n')
        },
        {
            role: 'user',
            content: messageText
        }
    ];
}

function buildRagContextText(ragResults) {
    if (!Array.isArray(ragResults) || ragResults.length === 0) {
        return '未检索到可用DRG费用结果。';
    }

    const lines = [];
    for (const result of ragResults) {
        lines.push(`关键词: ${result.keyword}`);
        if (!Array.isArray(result.items) || result.items.length === 0) {
            lines.push('- 无匹配结果');
            continue;
        }
        for (const item of result.items) {
            lines.push(
                `- 排名${item.rank} | ${item.drg_name} | 起步费用: ${item.start_cost_cny ?? '未知'} | 封顶费用: ${item.cap_cost_cny ?? '未知'} | score: ${item.score ?? 'N/A'}`
            );
        }
    }
    return lines.join('\n');
}

function buildReplyMessages({ messageText, triage, ragContextText }) {
    return [
        {
            role: 'system',
            content: [
                '你是海外医疗客服助手，负责在 WhatsApp 回复潜在患者。',
                '回复目标：专业、清晰、友好，不夸大，不做确定性诊断。',
                '要求：',
                '1) 先回应用户核心问题。',
                '2) 若有RAG费用数据，明确是“DRG检索估算区间（人民币）”，并提示最终以医院评估为准。',
                '3) 若缺乏关键信息，补充1-2个必要追问（例如病种、治疗方式、国家/医院偏好、是否已有检查报告）。',
                '4) 若非疾病咨询，引导用户说明医疗需求，不要硬给价格。',
                '5) 输出纯文本，控制在220字以内。'
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `用户原话: ${messageText}`,
                `分诊结果: is_disease_consultation=${triage.isDiseaseConsultation}, need_rag=${triage.needRag}, keywords=${triage.keywords.join(',') || '(none)'}`,
                `分诊理由: ${triage.reason}`,
                'RAG结果:',
                ragContextText
            ].join('\n')
        }
    ];
}

function resolveChatCompletionsUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) {
        throw new Error('AI base URL is empty.');
    }
    if (/\/v1\/chat\/completions$/i.test(normalized)) {
        return normalized;
    }
    if (/\/v1$/i.test(normalized)) {
        return `${normalized}/chat/completions`;
    }
    return `${normalized}/v1/chat/completions`;
}

async function callChatCompletions({ baseUrl, apiKey, model, messages, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!apiKey) {
        throw new Error('AI API key is missing.');
    }
    if (!model) {
        throw new Error('AI model is missing.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const url = resolveChatCompletionsUrl(baseUrl);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.2
            }),
            signal: controller.signal
        });

        const raw = await response.text();
        if (!response.ok) {
            throw new Error(`AI API ${response.status} ${response.statusText}: ${raw.slice(0, 600)}`);
        }

        const parsed = tryParseJson(raw);
        const content = parsed?.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error('AI API response missing choices[0].message.content');
        }
        return String(content);
    } finally {
        clearTimeout(timeout);
    }
}

function resolveRagSearchUrl(ragBaseUrl) {
    const normalized = normalizeBaseUrl(ragBaseUrl);
    if (!normalized) return '';
    return /\/search$/i.test(normalized) ? normalized : `${normalized}/search`;
}

async function searchRagByKeywords({ ragBaseUrl, keywords, topK = DEFAULT_RAG_TOP_K }) {
    const searchUrl = resolveRagSearchUrl(ragBaseUrl);
    if (!searchUrl || !Array.isArray(keywords) || keywords.length === 0) {
        return [];
    }

    const results = [];
    for (const keyword of keywords) {
        const url = `${searchUrl}?keyword=${encodeURIComponent(keyword)}&top_k=${topK}`;
        try {
            const response = await fetch(url);
            const text = await response.text();
            if (!response.ok) {
                results.push({ keyword, items: [], error: `RAG API ${response.status}: ${text.slice(0, 200)}` });
                continue;
            }
            const parsed = tryParseJson(text) || {};
            results.push({
                keyword,
                items: Array.isArray(parsed.items) ? parsed.items : []
            });
        } catch (error) {
            results.push({ keyword, items: [], error: error.message });
        }
    }
    return results;
}

async function generateMedicalReply({ messageText, aiConfig, ragConfig }) {
    const triageRaw = await callChatCompletions({
        baseUrl: aiConfig.baseUrl,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        messages: buildTriageMessages(messageText),
        timeoutMs: aiConfig.timeoutMs
    });

    const triage = normalizeTriageResult(extractJsonObject(triageRaw), messageText);
    const ragResults = triage.needRag
        ? await searchRagByKeywords({
            ragBaseUrl: ragConfig.baseUrl,
            keywords: triage.keywords,
            topK: ragConfig.topK
        })
        : [];
    const ragContextText = buildRagContextText(ragResults);

    const replyText = await callChatCompletions({
        baseUrl: aiConfig.baseUrl,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        messages: buildReplyMessages({ messageText, triage, ragContextText }),
        timeoutMs: aiConfig.timeoutMs
    });

    return {
        triage,
        triageRaw,
        ragResults,
        ragContextText,
        replyText: replyText.trim()
    };
}

module.exports = {
    extractJsonObject,
    normalizeTriageResult,
    buildRagContextText,
    generateMedicalReply
};
