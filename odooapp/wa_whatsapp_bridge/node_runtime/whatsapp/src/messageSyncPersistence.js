function extractPhoneFromJid(jid) {
    const raw = String(jid || '').trim();
    const match = raw.match(/^(\d+)@/);
    return match ? match[1] : '';
}

function pickName(...values) {
    for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized) {
            return normalized;
        }
    }
    return '';
}

function normalizeUnixTimestamp(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
    }
    return Math.floor(Date.now() / 1000);
}

function resolveChatType(msg, chat) {
    if (typeof chat?.isGroup === 'boolean') {
        return chat.isGroup ? 'group' : 'private';
    }
    if (String(msg?.from || '').endsWith('@g.us')) {
        return 'group';
    }
    return 'private';
}

function resolveChatJid(msg, chatType) {
    if (chatType === 'group') {
        return String(msg.from || '').trim();
    }
    const outboundTarget = String(msg.to || '').trim();
    const inboundSource = String(msg.from || '').trim();
    return msg.fromMe ? outboundTarget : inboundSource;
}

function resolveSenderJid(msg, chatType, self) {
    if (chatType === 'group') {
        return String(msg.author || msg.from || '').trim();
    }
    if (msg.fromMe) {
        return String(self?.jid || msg.from || '').trim();
    }
    return String(msg.from || '').trim();
}

function resolveSenderName({ msg, contact, chatType, self }) {
    if (msg.fromMe) {
        return pickName(self?.name, self?.pushName);
    }
    if (chatType === 'group') {
        return pickName(
            msg?._data?.notifyName,
            contact?.pushname,
            contact?.name,
            contact?.shortName
        );
    }
    return pickName(
        contact?.pushname,
        msg?._data?.notifyName,
        contact?.name,
        chatType === 'private' ? msg?._data?.senderObj?.pushname : '',
        chatType === 'private' ? msg?.notifyName : ''
    );
}

function normalizeIncomingMessage({ msg, chat = null, contact = null, self = null, sessionName = 'default' }) {
    const source = msg && typeof msg === 'object' ? msg : {};
    const timestamp = normalizeUnixTimestamp(source.timestamp);
    const chatType = resolveChatType(source, chat);
    const chatJid = resolveChatJid(source, chatType);
    const senderJid = resolveSenderJid(source, chatType, self);
    const fromMe = Boolean(source.fromMe);

    return {
        sessionName: String(sessionName || 'default').trim() || 'default',
        messageId: String(source?.id?._serialized || '').trim(),
        direction: fromMe ? 'outbound' : 'inbound',
        chatType,
        chatJid,
        senderJid,
        senderPhone: extractPhoneFromJid(senderJid) || null,
        senderName: resolveSenderName({ msg: source, contact, chatType, self }) || null,
        groupJid: chatType === 'group' ? chatJid : null,
        groupName: chatType === 'group' ? pickName(chat?.name) || null : null,
        messageTime: new Date(timestamp * 1000).toISOString(),
        messageText: String(source.body || '').trim(),
        fromMe,
        rawPayload: source,
    };
}

function createSchemaSql() {
    return `
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_name TEXT NOT NULL DEFAULT 'default',
    message_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    chat_type TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    sender_phone TEXT,
    sender_name TEXT,
    group_jid TEXT,
    group_name TEXT,
    message_time TIMESTAMPTZ NOT NULL,
    message_text TEXT,
    from_me BOOLEAN NOT NULL,
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE whatsapp_messages
    ADD COLUMN IF NOT EXISTS session_name TEXT;

UPDATE whatsapp_messages
SET session_name = 'default'
WHERE session_name IS NULL OR BTRIM(session_name) = '';

ALTER TABLE whatsapp_messages
    ALTER COLUMN session_name SET DEFAULT 'default';

ALTER TABLE whatsapp_messages
    ALTER COLUMN session_name SET NOT NULL;

ALTER TABLE whatsapp_messages
    DROP CONSTRAINT IF EXISTS whatsapp_messages_message_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_session_name_message_id_key
    ON whatsapp_messages (session_name, message_id);
`.trim();
}

function createInsertQuery(record) {
    return {
        text: `
INSERT INTO whatsapp_messages (
    session_name,
    message_id,
    direction,
    chat_type,
    chat_jid,
    sender_jid,
    sender_phone,
    sender_name,
    group_jid,
    group_name,
    message_time,
    message_text,
    from_me,
    raw_payload
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
)
ON CONFLICT (session_name, message_id) DO NOTHING
`.trim(),
        values: [
            record.sessionName,
            record.messageId,
            record.direction,
            record.chatType,
            record.chatJid,
            record.senderJid,
            record.senderPhone,
            record.senderName,
            record.groupJid,
            record.groupName,
            record.messageTime,
            record.messageText,
            record.fromMe,
            record.rawPayload,
        ],
    };
}

function createMessageSyncRepository(pgConfig) {
    const { Pool } = require('pg');
    const pool = new Pool(pgConfig);

    return {
        async initSchema() {
            await pool.query(createSchemaSql());
        },

        async insertMessage(record) {
            const result = await pool.query(createInsertQuery(record));
            return {
                inserted: result.rowCount > 0,
            };
        },

        async close() {
            await pool.end();
        },
    };
}

module.exports = {
    extractPhoneFromJid,
    normalizeIncomingMessage,
    createSchemaSql,
    createInsertQuery,
    createMessageSyncRepository,
};
