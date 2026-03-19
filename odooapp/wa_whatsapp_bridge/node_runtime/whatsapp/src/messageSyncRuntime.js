const { loadPgConfigFromEnvFile } = require('./messageSyncConfig');
const {
    createMessageSyncRepository,
    normalizeIncomingMessage,
} = require('./messageSyncPersistence');

async function createMessageSyncRuntime({ env = process.env, logger = console } = {}) {
    const { envPath, pg } = loadPgConfigFromEnvFile(env);
    const repository = createMessageSyncRepository(pg);
    await repository.initSchema();
    logger.log?.(`Message sync database ready via ${envPath}`);

    return {
        async persistMessage({ client, msg, chat, contact }) {
            const self = {
                jid: client?.info?.wid?._serialized || '',
                name: client?.info?.pushname || '',
                pushName: client?.info?.pushname || '',
            };
            const sessionName = client?.options?.authStrategy?.clientId || 'default';
            const record = normalizeIncomingMessage({
                msg,
                chat,
                contact,
                self,
                sessionName,
            });
            const result = await repository.insertMessage(record);
            logger.log?.(
                `Stored message ${record.messageId} session=${record.sessionName} direction=${record.direction} inserted=${result.inserted}`
            );
            return result;
        },

        async close() {
            await repository.close();
        },
    };
}

module.exports = {
    createMessageSyncRuntime,
};
