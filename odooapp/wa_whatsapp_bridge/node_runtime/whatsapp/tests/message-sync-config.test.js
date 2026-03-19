const { expect } = require('chai');

const {
    parseEnvText,
    buildPgConfigFromEnvText,
} = require('../src/messageSyncConfig');

describe('messageSyncConfig', () => {
    it('parses dotenv style text', () => {
        const parsed = parseEnvText(`
PGHOST=10.168.2.103
PGPORT=5432
PGDATABASE=sakana
PGUSER=sakana
PGPASSWORD=123456
PGSSLMODE=disable
`);

        expect(parsed).to.deep.equal({
            PGHOST: '10.168.2.103',
            PGPORT: '5432',
            PGDATABASE: 'sakana',
            PGUSER: 'sakana',
            PGPASSWORD: '123456',
            PGSSLMODE: 'disable',
        });
    });

    it('builds pg config from env text', () => {
        const config = buildPgConfigFromEnvText(`
PGHOST=10.168.2.103
PGPORT=5432
PGDATABASE=sakana
PGUSER=sakana
PGPASSWORD=123456
PGSSLMODE=disable
`);

        expect(config).to.deep.equal({
            host: '10.168.2.103',
            port: 5432,
            database: 'sakana',
            user: 'sakana',
            password: '123456',
            ssl: false,
        });
    });
});
