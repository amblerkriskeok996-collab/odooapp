const fs = require('fs');
const path = require('path');

const DEFAULT_LISTENER_ENV_PATH = 'D:\\code\\programs\\msg_s\\Whatsapp\\.env';

function parseSslMode(value) {
    const mode = String(value || 'disable').toLowerCase();
    if (mode === 'require') {
        return { rejectUnauthorized: false };
    }
    return false;
}

function parseEnvText(text) {
    const values = {};
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) {
            continue;
        }
        const idx = line.indexOf('=');
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        values[key] = value;
    }
    return values;
}

function buildPgConfigFromEnvText(text) {
    const env = parseEnvText(text);
    return {
        host: env.PGHOST || '127.0.0.1',
        port: Number(env.PGPORT || 5432),
        database: env.PGDATABASE || 'postgres',
        user: env.PGUSER || 'postgres',
        password: env.PGPASSWORD || '',
        ssl: parseSslMode(env.PGSSLMODE),
    };
}

function resolveListenerEnvPath(env = process.env) {
    return path.resolve(env.MESSAGE_SYNC_ENV_PATH || DEFAULT_LISTENER_ENV_PATH);
}

function loadPgConfigFromEnvFile(env = process.env) {
    const envPath = resolveListenerEnvPath(env);
    const text = fs.readFileSync(envPath, 'utf8');
    return {
        envPath,
        pg: buildPgConfigFromEnvText(text),
    };
}

module.exports = {
    DEFAULT_LISTENER_ENV_PATH,
    parseEnvText,
    buildPgConfigFromEnvText,
    resolveListenerEnvPath,
    loadPgConfigFromEnvFile,
};
