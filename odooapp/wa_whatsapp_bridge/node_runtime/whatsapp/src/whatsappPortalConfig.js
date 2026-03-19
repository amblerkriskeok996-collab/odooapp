'use strict';

const path = require('path');

function getSessionCleanupTargets(projectRoot) {
    return [
        path.resolve(projectRoot, '.wwebjs_auth'),
        path.resolve(projectRoot, '.wwebjs_cache')
    ];
}

function buildPortalPuppeteerOptions(env, baseOptions = {}) {
    const options = {
        ...baseOptions,
        headless: false
    };

    if (String(env.WA_USE_SYSTEM_CHROME || '').toLowerCase() !== 'false') {
        options.channel = 'chrome';
    } else {
        delete options.channel;
    }

    return options;
}

function shouldDisableLibraryUserAgent(env) {
    return String(env.WA_USE_LIBRARY_DEFAULT_UA || '').toLowerCase() !== 'true';
}

module.exports = {
    getSessionCleanupTargets,
    buildPortalPuppeteerOptions,
    shouldDisableLibraryUserAgent
};
