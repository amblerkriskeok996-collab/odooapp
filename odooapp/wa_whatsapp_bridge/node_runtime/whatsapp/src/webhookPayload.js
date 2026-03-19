function extractPhoneFromJid(jid) {
    const raw = String(jid || '').trim();
    const match = raw.match(/^(\d+)@/);
    return match ? match[1] : '';
}

function normalizeUnixTimestamp(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
    }
    return Math.floor(Date.now() / 1000);
}

function normalizeQuotedMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const body = String(raw.body || '').trim();
    const author = String(raw.author || '').trim();
    if (!body && !author) return null;
    return { body, author };
}

function buildIncomingWebhookPayload(msg, selfWid) {
    const source = msg && typeof msg === 'object' ? msg : {};
    const from = String(source.from || '').trim();
    const to = String(source.to || selfWid || '').trim();
    const body = String(source.body || '').trim();
    const type = String(source.type || 'chat').trim() || 'chat';
    const timestamp = normalizeUnixTimestamp(source.timestamp);
    const author = String(source.author || from).trim();
    const isGroup = typeof source.isGroup === 'boolean'
        ? source.isGroup
        : String(from).endsWith('@g.us');
    const fromMe = Boolean(source.fromMe);
    const pushName = source?._data?.notifyName || source?._data?.senderObj?.pushname || '';
    const quotedMessage = normalizeQuotedMessage(source.quotedMessage);
    const messageId = source?.id?._serialized || '';
    const sentAtIso = new Date(timestamp * 1000).toISOString();

    const payload = {
        event: 'whatsapp.incoming_message',
        source: 'whatsapp-web.js',
        workflow: 'whatsapp-medical-ai-webhook',
        messageId,
        requestId: messageId || `incoming_${timestamp}_${Math.random().toString(36).slice(2, 10)}`,
        chatId: from,
        from,
        to,
        body,
        text: body,
        message: body,
        question: body,
        type,
        timestamp,
        author,
        isGroup,
        hasMedia: Boolean(source.hasMedia),
        fromMe,
        pushName,
        userJid: from,
        userPhone: extractPhoneFromJid(from),
        receiverJid: to,
        receiverPhone: extractPhoneFromJid(to),
        sentAt: {
            unix: timestamp,
            iso: sentAtIso
        },
        senderAccount: {
            jid: from,
            phone: extractPhoneFromJid(from),
            pushName,
            authorJid: author
        },
        recipientAccount: {
            jid: to,
            phone: extractPhoneFromJid(to)
        },
        messageContent: {
            text: body,
            type,
            hasMedia: Boolean(source.hasMedia)
        },
        relay: {
            receivedAtUnix: Math.floor(Date.now() / 1000),
            receivedAtIso: new Date().toISOString()
        }
    };

    if (quotedMessage) {
        payload.quotedMessage = quotedMessage;
    }

    return payload;
}

module.exports = {
    extractPhoneFromJid,
    buildIncomingWebhookPayload
};
