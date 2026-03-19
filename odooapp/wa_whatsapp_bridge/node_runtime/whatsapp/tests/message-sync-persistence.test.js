const { expect } = require('chai');

const {
    normalizeIncomingMessage,
    createInsertQuery,
} = require('../src/messageSyncPersistence');

describe('messageSyncPersistence', () => {
    it('normalizes inbound private messages for database storage', () => {
        const record = normalizeIncomingMessage({
            msg: {
                id: { _serialized: 'false_12345@c.us_MSG1' },
                fromMe: false,
                from: '12345@c.us',
                to: '8615215092966@c.us',
                body: 'hello',
                timestamp: 1773780593,
                author: '',
                _data: {
                    notifyName: 'Alice',
                    senderObj: { pushname: 'Alice P' },
                },
            },
            chat: { isGroup: false, name: '' },
            contact: { pushname: 'Alice', name: 'Alice Zhang', shortName: 'Alice' },
            self: { jid: '8615215092966@c.us', name: '+8615215092966' },
            sessionName: 'default',
        });

        expect(record.messageId).to.equal('false_12345@c.us_MSG1');
        expect(record.direction).to.equal('inbound');
        expect(record.chatType).to.equal('private');
        expect(record.chatJid).to.equal('12345@c.us');
        expect(record.senderJid).to.equal('12345@c.us');
        expect(record.senderPhone).to.equal('12345');
        expect(record.senderName).to.equal('Alice');
        expect(record.fromMe).to.equal(false);
        expect(record.sessionName).to.equal('default');
    });

    it('builds insert query with session scoped dedupe', () => {
        const query = createInsertQuery({
            sessionName: 'default',
            messageId: 'msg-1',
            direction: 'inbound',
            chatType: 'private',
            chatJid: '12345@c.us',
            senderJid: '12345@c.us',
            senderPhone: '12345',
            senderName: 'Alice',
            groupJid: null,
            groupName: null,
            messageTime: '2026-03-18T03:00:00.000Z',
            messageText: 'hello',
            fromMe: false,
            rawPayload: { body: 'hello' },
        });

        expect(query.text).to.include('INSERT INTO whatsapp_messages');
        expect(query.text).to.include('ON CONFLICT (session_name, message_id) DO NOTHING');
        expect(query.values[0]).to.equal('default');
        expect(query.values[1]).to.equal('msg-1');
    });
});
