const { Client, Location, Poll, List, Buttons, LocalAuth } = require('./index');
const fetch = require('node-fetch');
const fs = require('fs');
const http = require('http');
const path = require('path');
const dotenv = require('dotenv');
const { buildIncomingWebhookPayload } = require('./src/webhookPayload');
const { handleIncomingWebhookMessage } = require('./src/webhookWorkflow');
const { createMessageSyncRuntime } = require('./src/messageSyncRuntime');
const { WhatsWebURL } = require('./src/util/Constants');
const {
    createPortalState,
    transitionPortalState,
    buildLoginAction
} = require('./src/accountPortalState');
const {
    getSessionCleanupTargets,
    buildPortalPuppeteerOptions,
    shouldDisableLibraryUserAgent
} = require('./src/whatsappPortalConfig');
const { runWithSingleRecovery } = require('./src/portalLoginRecovery');
const InterfaceController = require('./src/util/InterfaceController');
const { LoadUtils } = require('./src/util/Injected/Utils');
const {
    createQrState,
    rememberQr,
    rememberFrontendQrImage,
    clearQr,
    getQrPayload,
} = require('./src/portalQr');
const { captureFrontendQrWithTimeout } = require('./src/portalQrCapture');

dotenv.config();

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error?.message || error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

const SERVER_PORT = Number(process.env.SERVER_PORT || 3000);
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || `http://127.0.0.1:${SERVER_PORT}/webhook/whatsapp-workflow`;
const AUTO_SEND_WEBHOOK_REPLY = process.env.AUTO_SEND_WEBHOOK_REPLY !== 'false';
const AI_BASE_URL = process.env.AI_BASE_URL || process.env.url || '';
const AI_API_KEY = process.env.AI_API_KEY || process.env.api_key || '';
const AI_MODEL = process.env.AI_MODEL || process.env.model || '';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);
const RAG_API_URL = process.env.RAG_API_URL || 'http://127.0.0.1:18080';
const RAG_TOP_K = Number(process.env.RAG_TOP_K || 10);
const PORTAL_INDEX_FILE = path.join(__dirname, 'public', 'account-portal.html');
const PORTAL_HOME_FILE = path.join(__dirname, 'public', 'account-home.html');
const SESSION_CLEANUP_TARGETS = getSessionCleanupTargets(__dirname);
const messageSyncRuntimePromise = createMessageSyncRuntime({ logger: console }).catch((error) => {
    console.warn('Message sync runtime disabled:', error.message);
    return null;
});

let portalState = createPortalState();
let accountSwitchInProgress = false;
let pageErrorHandlersAttached = false;
let loginRecoveryPromise = null;
let readyRecoveryInterval = null;
let readyRecoveryInProgress = false;
const qrState = createQrState();

function setPortalState(eventName, detail = '') {
    portalState = transitionPortalState(portalState, eventName, detail);
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPortalState(expectedStates, timeoutMs = 45000, pollIntervalMs = 500) {
    const states = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (states.includes(portalState.status)) {
            return portalState.status;
        }
        await wait(pollIntervalMs);
    }

    throw new Error(`Timed out waiting for portal state (${states.join(',')})`);
}

async function sendToN8n(data) {
    try {
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        const bodyText = await response.text();
        console.log('Webhook forward status:', response.status, bodyText);
    } catch (error) {
        console.error('Failed to forward incoming message:', error.message);
    }
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (error) {
                reject(new Error(`Invalid JSON body: ${error.message}`));
            }
        });
        req.on('error', (error) => reject(error));
    });
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

async function sendHtmlFile(res, filePath) {
    try {
        const html = await fs.promises.readFile(filePath, 'utf8');
        sendHtml(res, 200, html);
    } catch (error) {
        sendHtml(res, 500, `<h1>Failed to load page</h1><pre>${error.message}</pre>`);
    }
}

async function getPortalStatusPayload() {
    let waState = '';
    if (client?.info && typeof client.getState === 'function') {
        try {
            waState = await client.getState();
        } catch (error) {
            waState = '';
        }
    }

    return {
        portalState: portalState.status,
        detail: portalState.detail,
        updatedAt: portalState.updatedAt,
        waState,
        accountSwitchInProgress,
        loginAction: buildLoginAction(portalState),
        account: client?.info
            ? {
                wid: client.info.wid?._serialized || '',
                pushName: client.info.pushname || '',
                platform: client.info.platform || ''
            }
            : null
    };
}

async function openWhatsappHomePage() {
    if (!client?.pupPage) {
        throw new Error('WhatsApp page is not ready');
    }

    if (typeof client.pupPage.isClosed === 'function' && client.pupPage.isClosed()) {
        throw new Error('Session closed: current WhatsApp page is already closed');
    }

    await client.pupPage.bringToFront();
    const currentUrl = client.pupPage.url() || '';
    if (!currentUrl.startsWith(WhatsWebURL)) {
        await client.pupPage.goto(WhatsWebURL, {
            waitUntil: 'domcontentloaded',
            timeout: 0
        });
    }

    return client.pupPage.url() || WhatsWebURL;
}

async function refreshFrontendQrImage() {
    const frontendQrDataUrl = await captureFrontendQrWithTimeout(client?.pupPage, {
        timeoutMs: 1200,
    });
    if (frontendQrDataUrl) {
        rememberFrontendQrImage(qrState, frontendQrDataUrl);
    }
    return frontendQrDataUrl;
}

async function refreshFrontendQrImageSafely() {
    try {
        return await refreshFrontendQrImage();
    } catch (error) {
        console.warn('frontend qr capture failed:', error.message);
        return null;
    }
}

function stopReadyRecoveryMonitor() {
    if (readyRecoveryInterval) {
        clearInterval(readyRecoveryInterval);
        readyRecoveryInterval = null;
    }
}

async function recoverReadyState(trigger = 'unknown') {
    if (readyRecoveryInProgress || portalState.status === 'ready' || !client?.pupPage) {
        return false;
    }

    readyRecoveryInProgress = true;
    try {
        const pageSnapshot = await client.pupPage.evaluate(() => ({
            hasStore: typeof window.Store !== 'undefined',
            hasWWebJS: typeof window.WWebJS !== 'undefined',
            appState: window.AuthStore?.AppState?.state || '',
            hasSynced: Boolean(window.AuthStore?.AppState?.hasSynced),
            info: window.Store?.Conn?.serialize
                ? {
                    ...window.Store.Conn.serialize(),
                    wid: window.Store.User?.getMaybeMePnUser?.() || window.Store.User?.getMaybeMeLidUser?.() || null,
                }
                : null,
        }));

        if (!pageSnapshot.hasStore || !pageSnapshot.hasSynced || pageSnapshot.appState !== 'CONNECTED') {
            return false;
        }

        if (!pageSnapshot.hasWWebJS) {
            await client.pupPage.evaluate(LoadUtils);
        }

        if (!client.info && pageSnapshot.info) {
            client.info = pageSnapshot.info;
        }
        if (!client.interface) {
            client.interface = new InterfaceController(client);
        }

        await client.attachEventListeners();

        console.log(`READY (recovered:${trigger})`);
        clearQr(qrState);
        setPortalState('ready');
        stopReadyRecoveryMonitor();
        return true;
    } catch (error) {
        console.warn(`ready recovery skipped (${trigger}):`, error.message);
        return false;
    } finally {
        readyRecoveryInProgress = false;
    }
}

function startReadyRecoveryMonitor(trigger = 'authenticated') {
    stopReadyRecoveryMonitor();
    let attempts = 0;
    readyRecoveryInterval = setInterval(async () => {
        attempts += 1;
        if (portalState.status === 'ready' || attempts > 12) {
            stopReadyRecoveryMonitor();
            return;
        }
        await recoverReadyState(`${trigger}:${attempts}`);
    }, 5000);
}

async function recoverClientForLogin() {
    if (loginRecoveryPromise) {
        return loginRecoveryPromise;
    }

    loginRecoveryPromise = (async () => {
        setPortalState('reinitializing', 'recovering_closed_page');
        pageErrorHandlersAttached = false;

        try {
            await client.destroy();
        } catch (destroyError) {
            console.warn('destroy failed before login recovery:', destroyError.message);
        }

        setPortalState('initializing');
        client.initialize();

        const state = await waitForPortalState(
            ['ready', 'qr_required', 'auth_failure', 'disconnected'],
            45000,
            500
        );

        if (state !== 'ready') {
            throw new Error('Account expired, please login again');
        }
    })().finally(() => {
        loginRecoveryPromise = null;
    });

    return loginRecoveryPromise;
}

async function switchWhatsappAccount() {
    if (accountSwitchInProgress) {
        throw new Error('Switching account is already in progress');
    }

    accountSwitchInProgress = true;
    setPortalState('switching_account');
    clearQr(qrState);
    try {
        try {
            await client.logout();
        } catch (logoutError) {
            console.warn('logout failed before switching account:', logoutError.message);
            try {
                await client.destroy();
            } catch (destroyError) {
                console.warn('destroy failed before switching account:', destroyError.message);
            }
        }

        const cleanupErrors = [];
        for (const cleanupPath of SESSION_CLEANUP_TARGETS) {
            try {
                await fs.promises.rm(cleanupPath, {
                    recursive: true,
                    force: true,
                    maxRetries: 4,
                    retryDelay: 250
                });
            } catch (cleanupError) {
                cleanupErrors.push(`${cleanupPath}: ${cleanupError.message}`);
            }
        }
        if (cleanupErrors.length > 0) {
            throw new Error(`Failed to clear login files: ${cleanupErrors.join(' | ')}`);
        }

        setPortalState('reinitializing');
        pageErrorHandlersAttached = false;
        await client.initialize();
    } finally {
        accountSwitchInProgress = false;
    }
}

async function sendWhatsappMessage(to, message) {
    await client.sendMessage(to, message);
    return { sent: true, to };
}

async function persistWhatsappMessage(msg) {
    const runtime = await messageSyncRuntimePromise;
    if (!runtime) {
        return;
    }

    try {
        const [chat, contact] = await Promise.all([
            typeof msg.getChat === 'function' ? msg.getChat().catch(() => null) : null,
            typeof msg.getContact === 'function' ? msg.getContact().catch(() => null) : null,
        ]);

        await runtime.persistMessage({
            client,
            msg,
            chat,
            contact,
        });
    } catch (error) {
        console.warn('Failed to persist WhatsApp message to sync database:', error.message);
    }
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    try {
        if (req.method === 'GET' && pathname === '/') {
            await sendHtmlFile(res, PORTAL_INDEX_FILE);
            return;
        }

        if (req.method === 'GET' && pathname === '/account-home') {
            await sendHtmlFile(res, PORTAL_HOME_FILE);
            return;
        }

        if (req.method === 'GET' && pathname === '/api/account/status') {
            sendJson(res, 200, {
                success: true,
                data: await getPortalStatusPayload()
            });
            return;
        }

        if (req.method === 'GET' && pathname === '/api/account/qr') {
            if (portalState.status === 'qr_required') {
                await refreshFrontendQrImageSafely();
            }
            const payload = getQrPayload(qrState);
            if (!payload) {
                sendJson(res, 404, {
                    success: false,
                    error: 'QR code is not available yet'
                });
                return;
            }
            sendJson(res, 200, {
                success: true,
                data: payload
            });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/account/login') {
            const action = buildLoginAction(portalState);
            if (!action.allowed) {
                sendJson(res, 401, {
                    success: false,
                    error: action.message,
                    data: await getPortalStatusPayload()
                });
                return;
            }

            let openedUrl = '';
            try {
                openedUrl = await runWithSingleRecovery(
                    () => openWhatsappHomePage(),
                    async () => recoverClientForLogin()
                );
            } catch (error) {
                if (String(error?.message || '').toLowerCase().includes('account expired')) {
                    sendJson(res, 401, {
                        success: false,
                        error: 'Account expired, please login again',
                        data: await getPortalStatusPayload()
                    });
                    return;
                }
                throw error;
            }

            sendJson(res, 200, {
                success: true,
                message: 'Opened WhatsApp home in whatsapp-web session',
                openedUrl,
                redirectPath: '/account-home',
                data: await getPortalStatusPayload()
            });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/account/switch-account') {
            if (accountSwitchInProgress) {
                sendJson(res, 409, {
                    success: false,
                    error: 'Switching account is already in progress',
                    data: await getPortalStatusPayload()
                });
                return;
            }

            await switchWhatsappAccount();
            sendJson(res, 200, {
                success: true,
                message: 'Login data cleared. Please scan QR code to login again.',
                data: await getPortalStatusPayload()
            });
            return;
        }

        if (req.method === 'POST' && pathname === '/webhook/reply') {
            const data = await readJsonBody(req);
            if (!data.to || !data.message) {
                sendJson(res, 400, { success: false, error: 'Missing to or message in request body' });
                return;
            }
            await sendWhatsappMessage(data.to, data.message);
            sendJson(res, 200, { success: true, message: 'WhatsApp message sent' });
            return;
        }

        if (req.method === 'POST' && pathname === '/webhook/whatsapp-workflow') {
            const data = await readJsonBody(req);
            const workflowResult = await handleIncomingWebhookMessage({
                incomingPayload: data,
                aiConfig: {
                    baseUrl: AI_BASE_URL,
                    apiKey: AI_API_KEY,
                    model: AI_MODEL,
                    timeoutMs: AI_TIMEOUT_MS
                },
                ragConfig: {
                    baseUrl: RAG_API_URL,
                    topK: RAG_TOP_K
                }
            });

            const callerAllowsAutoSend = data.autoSendReply !== false;
            const shouldSendReply = Boolean(
                AUTO_SEND_WEBHOOK_REPLY
                && callerAllowsAutoSend
                && workflowResult.decision.shouldReply
                && workflowResult.reply.to
                && workflowResult.reply.text
            );

            if (shouldSendReply) {
                try {
                    workflowResult.delivery = await sendWhatsappMessage(workflowResult.reply.to, workflowResult.reply.text);
                } catch (error) {
                    workflowResult.success = false;
                    workflowResult.delivery = { sent: false, error: error.message };
                }
            } else {
                workflowResult.delivery = {
                    sent: false,
                    reason: 'reply_disabled_or_not_needed'
                };
            }

            sendJson(res, workflowResult.success ? 200 : 502, workflowResult);
            return;
        }

        sendJson(res, 404, { success: false, error: 'Not Found' });
    } catch (error) {
        sendJson(res, 500, { success: false, error: error.message });
    }
});

server.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`HTTP server started on port ${SERVER_PORT}`);
    console.log(`Portal route: http://localhost:${SERVER_PORT}/`);
    console.log(`Webhook route: http://localhost:${SERVER_PORT}/webhook/whatsapp-workflow`);
    console.log(`Reply route: http://localhost:${SERVER_PORT}/webhook/reply`);
    console.log(`Forward route for incoming WhatsApp events: ${N8N_WEBHOOK_URL}`);
});

const clientOptions = {
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'none'
    },
    puppeteer: buildPortalPuppeteerOptions(process.env, {
        // args: ['--proxy-server=proxy-server-that-requires-authentication.example.com']
    })
};

if (shouldDisableLibraryUserAgent(process.env)) {
    clientOptions.userAgent = false;
}

const client = new Client(clientOptions);

console.log(`Portal client config: systemChrome=${clientOptions.puppeteer.channel === 'chrome'} disableLibraryUA=${clientOptions.userAgent === false} webCache=${clientOptions.webVersionCache.type}`);

// client initialize does not finish at ready now.
setPortalState('initializing');
client.initialize();

client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
    setPortalState('initializing', `${percent}% ${message}`);
});

client.on('qr', async (qr) => {
    // NOTE: This event will not be fired if a session is specified.
    console.log('QR RECEIVED', qr);
    setPortalState('qr');
    try {
        rememberQr(qrState, qr);
    } catch (error) {
        qrState.qrText = qr;
        qrState.frontendQrDataUrl = '';
        qrState.updatedAt = Date.now();
        qrState.expiresAt = qrState.updatedAt + (60 * 1000);
        console.warn('qr cache fallback activated:', error.message);
    }
    refreshFrontendQrImageSafely();
});

client.on('code', (code) => {
    console.log('Pairing code:',code);
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED');
    setPortalState('authenticated');
    startReadyRecoveryMonitor('authenticated');
});

client.on('auth_failure', msg => {
    // Fired if session restore was unsuccessful
    console.error('AUTHENTICATION FAILURE', msg);
    setPortalState('auth_failure', String(msg || ''));
});

client.on('ready', async () => {
    console.log('READY');
    stopReadyRecoveryMonitor();
    clearQr(qrState);
    setPortalState('ready');
    const debugWWebVersion = await client.getWWebVersion();
    console.log(`WWebVersion = ${debugWWebVersion}`);

    if (!pageErrorHandlersAttached) {
        client.pupPage.on('pageerror', function(err) {
            console.log('Page error: ' + err.toString());
        });
        client.pupPage.on('error', function(err) {
            console.log('Page error: ' + err.toString());
        });
        pageErrorHandlersAttached = true;
    }
    
});

client.on('message', async msg => {
    console.log('MESSAGE RECEIVED', msg);
    await persistWhatsappMessage(msg);

    const selfWid = client.info?.wid?._serialized || msg.to || '';
    const messageData = buildIncomingWebhookPayload(msg, selfWid);

    if (msg.hasQuotedMsg) {
        try {
            const quotedMsg = await msg.getQuotedMessage();
            messageData.quotedMessage = {
                body: quotedMsg.body || '',
                author: quotedMsg.author || quotedMsg.from || ''
            };
        } catch (error) {
            console.warn('Failed to load quoted message:', error.message);
        }
    }

    await sendToN8n(messageData);
    if (msg.body === '!ping reply') {
        // Send a new message as a reply to the current one
        msg.reply('pong');

    } else if (msg.body === '!ping') {
        // Send a new message to the same chat
        client.sendMessage(msg.from, 'pong');

    } else if (msg.body.startsWith('!sendto ')) {
        // Direct send a new message to specific id
        let number = msg.body.split(' ')[1];
        let messageIndex = msg.body.indexOf(number) + number.length;
        let message = msg.body.slice(messageIndex, msg.body.length);
        number = number.includes('@c.us') ? number : `${number}@c.us`;
        let chat = await msg.getChat();
        chat.sendSeen();
        client.sendMessage(number, message);

    } else if (msg.body.startsWith('!subject ')) {
        // Change the group subject
        let chat = await msg.getChat();
        if (chat.isGroup) {
            let newSubject = msg.body.slice(9);
            chat.setSubject(newSubject);
        } else {
            msg.reply('This command can only be used in a group!');
        }
    } else if (msg.body.startsWith('!echo ')) {
        // Replies with the same message
        msg.reply(msg.body.slice(6));
    } else if (msg.body.startsWith('!preview ')) {
        const text = msg.body.slice(9);
        msg.reply(text, null, { linkPreview: true });
    } else if (msg.body.startsWith('!desc ')) {
        // Change the group description
        let chat = await msg.getChat();
        if (chat.isGroup) {
            let newDescription = msg.body.slice(6);
            chat.setDescription(newDescription);
        } else {
            msg.reply('This command can only be used in a group!');
        }
    } else if (msg.body === '!leave') {
        // Leave the group
        let chat = await msg.getChat();
        if (chat.isGroup) {
            chat.leave();
        } else {
            msg.reply('This command can only be used in a group!');
        }
    } else if (msg.body.startsWith('!join ')) {
        const inviteCode = msg.body.split(' ')[1];
        try {
            await client.acceptInvite(inviteCode);
            msg.reply('Joined the group!');
        } catch (e) {
            msg.reply('That invite code seems to be invalid.');
        }
    } else if (msg.body.startsWith('!addmembers')) {
        const group = await msg.getChat();
        const result = await group.addParticipants(['number1@c.us', 'number2@c.us', 'number3@c.us']);
        /**
         * The example of the {@link result} output:
         *
         * {
         *   'number1@c.us': {
         *     code: 200,
         *     message: 'The participant was added successfully',
         *     isInviteV4Sent: false
         *   },
         *   'number2@c.us': {
         *     code: 403,
         *     message: 'The participant can be added by sending private invitation only',
         *     isInviteV4Sent: true
         *   },
         *   'number3@c.us': {
         *     code: 404,
         *     message: 'The phone number is not registered on WhatsApp',
         *     isInviteV4Sent: false
         *   }
         * }
         *
         * For more usage examples:
         * @see https://github.com/pedroslopez/whatsapp-web.js/pull/2344#usage-example1
         */
        console.log(result);
    } else if (msg.body === '!creategroup') {
        const partitipantsToAdd = ['number1@c.us', 'number2@c.us', 'number3@c.us'];
        const result = await client.createGroup('Group Title', partitipantsToAdd);
        /**
         * The example of the {@link result} output:
         * {
         *   title: 'Group Title',
         *   gid: {
         *     server: 'g.us',
         *     user: '1111111111',
         *     _serialized: '1111111111@g.us'
         *   },
         *   participants: {
         *     'botNumber@c.us': {
         *       statusCode: 200,
         *       message: 'The participant was added successfully',
         *       isGroupCreator: true,
         *       isInviteV4Sent: false
         *     },
         *     'number1@c.us': {
         *       statusCode: 200,
         *       message: 'The participant was added successfully',
         *       isGroupCreator: false,
         *       isInviteV4Sent: false
         *     },
         *     'number2@c.us': {
         *       statusCode: 403,
         *       message: 'The participant can be added by sending private invitation only',
         *       isGroupCreator: false,
         *       isInviteV4Sent: true
         *     },
         *     'number3@c.us': {
         *       statusCode: 404,
         *       message: 'The phone number is not registered on WhatsApp',
         *       isGroupCreator: false,
         *       isInviteV4Sent: false
         *     }
         *   }
         * }
         *
         * For more usage examples:
         * @see https://github.com/pedroslopez/whatsapp-web.js/pull/2344#usage-example2
         */
        console.log(result);
    } else if (msg.body === '!groupinfo') {
        let chat = await msg.getChat();
        if (chat.isGroup) {
            msg.reply(`
                *Group Details*
                Name: ${chat.name}
                Description: ${chat.description}
                Created At: ${chat.createdAt.toString()}
                Created By: ${chat.owner.user}
                Participant count: ${chat.participants.length}
            `);
        } else {
            msg.reply('This command can only be used in a group!');
        }
    } else if (msg.body === '!chats') {
        const chats = await client.getChats();
        client.sendMessage(msg.from, `The bot has ${chats.length} chats open.`);
    } else if (msg.body === '!info') {
        let info = client.info;
        client.sendMessage(msg.from, `
            *Connection info*
            User name: ${info.pushname}
            My number: ${info.wid.user}
            Platform: ${info.platform}
        `);
    } else if (msg.body === '!mediainfo' && msg.hasMedia) {
        const attachmentData = await msg.downloadMedia();
        msg.reply(`
            *Media info*
            MimeType: ${attachmentData.mimetype}
            Filename: ${attachmentData.filename}
            Data (length): ${attachmentData.data.length}
        `);
    } else if (msg.body === '!quoteinfo' && msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();

        quotedMsg.reply(`
            ID: ${quotedMsg.id._serialized}
            Type: ${quotedMsg.type}
            Author: ${quotedMsg.author || quotedMsg.from}
            Timestamp: ${quotedMsg.timestamp}
            Has Media? ${quotedMsg.hasMedia}
        `);
    } else if (msg.body === '!resendmedia' && msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.hasMedia) {
            const attachmentData = await quotedMsg.downloadMedia();
            client.sendMessage(msg.from, attachmentData, { caption: 'Here\'s your requested media.' });
        }
        if (quotedMsg.hasMedia && quotedMsg.type === 'audio') {
            const audio = await quotedMsg.downloadMedia();
            await client.sendMessage(msg.from, audio, { sendAudioAsVoice: true });
        }
    } else if (msg.body === '!isviewonce' && msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.hasMedia) {
            const media = await quotedMsg.downloadMedia();
            await client.sendMessage(msg.from, media, { isViewOnce: true });
        }
    } else if (msg.body === '!location') {
        // only latitude and longitude
        await msg.reply(new Location(37.422, -122.084));
        // location with name only
        await msg.reply(new Location(37.422, -122.084, { name: 'Googleplex' }));
        // location with address only
        await msg.reply(new Location(37.422, -122.084, { address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA' }));
        // location with name, address and url
        await msg.reply(new Location(37.422, -122.084, { name: 'Googleplex', address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA', url: 'https://google.com' }));
    } else if (msg.location) {
        msg.reply(msg.location);
    } else if (msg.body.startsWith('!status ')) {
        const newStatus = msg.body.split(' ')[1];
        await client.setStatus(newStatus);
        msg.reply(`Status was updated to *${newStatus}*`);
    } else if (msg.body === '!mentionUsers') {
        const chat = await msg.getChat();
        const userNumber = 'XXXXXXXXXX';
        /**
         * To mention one user you can pass user's ID to 'mentions' property as is,
         * without wrapping it in Array, and a user's phone number to the message body:
         */
        await chat.sendMessage(`Hi @${userNumber}`, {
            mentions: userNumber + '@c.us'
        });
        // To mention a list of users:
        await chat.sendMessage(`Hi @${userNumber}, @${userNumber}`, {
            mentions: [userNumber + '@c.us', userNumber + '@c.us']
        });
    } else if (msg.body === '!mentionGroups') {
        const chat = await msg.getChat();
        const groupId = 'YYYYYYYYYY@g.us';
        /**
         * Sends clickable group mentions, the same as user mentions.
         * When the mentions are clicked, it opens a chat with the mentioned group.
         * The 'groupMentions.subject' can be custom
         * 
         * @note The user that does not participate in the mentioned group,
         * will not be able to click on that mentioned group, the same if the group does not exist
         *
         * To mention one group:
         */
        await chat.sendMessage(`Check the last message here: @${groupId}`, {
            groupMentions: { subject: 'GroupSubject', id: groupId }
        });
        // To mention a list of groups:
        await chat.sendMessage(`Check the last message in these groups: @${groupId}, @${groupId}`, {
            groupMentions: [
                { subject: 'FirstGroup', id: groupId },
                { subject: 'SecondGroup', id: groupId }
            ]
        });
    } else if (msg.body === '!getGroupMentions') {
        // To get group mentions from a message:
        const groupId = 'ZZZZZZZZZZ@g.us';
        const msg = await client.sendMessage('chatId', `Check the last message here: @${groupId}`, {
            groupMentions: { subject: 'GroupSubject', id: groupId }
        });
        /** {@link groupMentions} is an array of `GroupChat` */
        const groupMentions = await msg.getGroupMentions();
        console.log(groupMentions);
    } else if (msg.body === '!delete') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.fromMe) {
                quotedMsg.delete(true);
            } else {
                msg.reply('I can only delete my own messages');
            }
        }
    } else if (msg.body === '!pin') {
        const chat = await msg.getChat();
        await chat.pin();
    } else if (msg.body === '!archive') {
        const chat = await msg.getChat();
        await chat.archive();
    } else if (msg.body === '!mute') {
        const chat = await msg.getChat();
        // mute the chat for 20 seconds
        const unmuteDate = new Date();
        unmuteDate.setSeconds(unmuteDate.getSeconds() + 20);
        await chat.mute(unmuteDate);
    } else if (msg.body === '!typing') {
        const chat = await msg.getChat();
        // simulates typing in the chat
        chat.sendStateTyping();
    } else if (msg.body === '!recording') {
        const chat = await msg.getChat();
        // simulates recording audio in the chat
        chat.sendStateRecording();
    } else if (msg.body === '!clearstate') {
        const chat = await msg.getChat();
        // stops typing or recording in the chat
        chat.clearState();
    } else if (msg.body === '!jumpto') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            client.interface.openChatWindowAt(quotedMsg.id._serialized);
        }
    } else if (msg.body === '!buttons') {
        let button = new Buttons('Button body', [{ body: 'bt1' }, { body: 'bt2' }, { body: 'bt3' }], 'title', 'footer');
        client.sendMessage(msg.from, button);
    } else if (msg.body === '!list') {
        let sections = [
            { title: 'sectionTitle', rows: [{ title: 'ListItem1', description: 'desc' }, { title: 'ListItem2' }] }
        ];
        let list = new List('List body', 'btnText', sections, 'Title', 'footer');
        client.sendMessage(msg.from, list);
    } else if (msg.body === '!reaction') {
        await msg.react('ðŸ‘');
    } else if (msg.body === '!sendpoll') {
        /** By default the poll is created as a single choice poll: */
        await msg.reply(new Poll('Winter or Summer?', ['Winter', 'Summer']));
        /** If you want to provide a multiple choice poll, add allowMultipleAnswers as true: */
        await msg.reply(new Poll('Cats or Dogs?', ['Cats', 'Dogs'], { allowMultipleAnswers: true }));
        /**
         * You can provide a custom message secret, it can be used as a poll ID:
         * @note It has to be a unique vector with a length of 32
         */
        await msg.reply(
            new Poll('Cats or Dogs?', ['Cats', 'Dogs'], {
                messageSecret: [
                    1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
                ]
            })
        );
    } else if (msg.body === '!vote') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.type === 'poll_creation') {
                await quotedMsg.vote(msg.body.replace('!vote', ''));
            } else {
                msg.reply('Can only be used on poll messages');
            }
        }
    } else if (msg.body === '!edit') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.fromMe) {
                await quotedMsg.edit(msg.body.replace('!edit', ''));
            } else {
                msg.reply('I can only edit my own messages');
            }
        }
    } else if (msg.body === '!updatelabels') {
        const chat = await msg.getChat();
        await chat.changeLabels([0, 1]);
    } else if (msg.body === '!addlabels') {
        const chat = await msg.getChat();
        let labels = (await chat.getLabels()).map((l) => l.id);
        labels.push('0');
        labels.push('1');
        await chat.changeLabels(labels);
    } else if (msg.body === '!removelabels') {
        const chat = await msg.getChat();
        await chat.changeLabels([]);
    } else if (msg.body === '!approverequest') {
        /**
         * Presented an example for membership request approvals, the same examples are for the request rejections.
         * To approve the membership request from a specific user:
         */
        await client.approveGroupMembershipRequests(msg.from, { requesterIds: 'number@c.us' });
        /** The same for execution on group object (no need to provide the group ID): */
        const group = await msg.getChat();
        await group.approveGroupMembershipRequests({ requesterIds: 'number@c.us' });
        /** To approve several membership requests: */
        const approval = await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: ['number1@c.us', 'number2@c.us']
        });
        /**
         * The example of the {@link approval} output:
         * [
         *   {
         *     requesterId: 'number1@c.us',
         *     message: 'Rejected successfully'
         *   },
         *   {
         *     requesterId: 'number2@c.us',
         *     error: 404,
         *     message: 'ParticipantRequestNotFoundError'
         *   }
         * ]
         *
         */
        console.log(approval);
        /** To approve all the existing membership requests (simply don't provide any user IDs): */
        await client.approveGroupMembershipRequests(msg.from);
        /** To change the sleep value to 300 ms: */
        await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: ['number1@c.us', 'number2@c.us'],
            sleep: 300
        });
        /** To change the sleep value to random value between 100 and 300 ms: */
        await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: ['number1@c.us', 'number2@c.us'],
            sleep: [100, 300]
        });
        /** To explicitly disable the sleep: */
        await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: ['number1@c.us', 'number2@c.us'],
            sleep: null
        });
    } else if (msg.body === '!pinmsg') {
        /**
         * Pins a message in a chat, a method takes a number in seconds for the message to be pinned.
         * WhatsApp default values for duration to pass to the method are:
         * 1. 86400 for 24 hours
         * 2. 604800 for 7 days
         * 3. 2592000 for 30 days
         * You can pass your own value:
         */
        const result = await msg.pin(60); // Will pin a message for 1 minute
        console.log(result); // True if the operation completed successfully, false otherwise
    } else if (msg.body === '!howManyConnections') {
        /**
         * Get user device count by ID
         * Each WaWeb Connection counts as one device, and the phone (if exists) counts as one
         * So for a non-enterprise user with one WaWeb connection it should return "2"
         */
        let deviceCount = await client.getContactDeviceCount(msg.from);
        await msg.reply(`You have *${deviceCount}* devices connected`);
    } else if (msg.body === '!syncHistory') {
        const isSynced = await client.syncHistory(msg.from);
        // Or through the Chat object:
        // const chat = await client.getChatById(msg.from);
        // const isSynced = await chat.syncHistory();
        
        await msg.reply(isSynced ? 'Historical chat is syncing..' : 'There is no historical chat to sync.');
    } else if (msg.body === '!statuses') {
        const statuses = await client.getBroadcasts();
        console.log(statuses);
        const chat = await statuses[0]?.getChat(); // Get user chat of a first status
        console.log(chat);
    } else if (msg.body === '!sendMediaHD' && msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.hasMedia) {
            const media = await quotedMsg.downloadMedia();
            await client.sendMessage(msg.from, media, { sendMediaAsHd: true });
        }
    } else if (msg.body === '!parseVCard') {
        const vCard =
            'BEGIN:VCARD\n' +
            'VERSION:3.0\n' +
            'FN:John Doe\n' +
            'ORG:Microsoft;\n' +
            'EMAIL;type=INTERNET:john.doe@gmail.com\n' +
            'URL:www.johndoe.com\n' +
            'TEL;type=CELL;type=VOICE;waid=18006427676:+1 (800) 642 7676\n' +
            'END:VCARD';
        const vCardExtended =
            'BEGIN:VCARD\n' +
            'VERSION:3.0\n' +
            'FN:John Doe\n' +
            'ORG:Microsoft;\n' +
            'item1.TEL:+1 (800) 642 7676\n' +
            'item1.X-ABLabel:USA Customer Service\n' +
            'item2.TEL:+55 11 4706 0900\n' +
            'item2.X-ABLabel:Brazil Customer Service\n' +
            'PHOTO;BASE64:here you can paste a binary data of a contact photo in Base64 encoding\n' +
            'END:VCARD';
        const userId = 'XXXXXXXXXX@c.us';
        await client.sendMessage(userId, vCard);
        await client.sendMessage(userId, vCardExtended);
    } else if (msg.body === '!changeSync') {
        // NOTE: this action will take effect after you restart the client.
        const backgroundSync = await client.setBackgroundSync(true);
        console.log(backgroundSync);
    } else if (msg.body === '!postStatus') {
        await client.sendMessage('status@broadcast', 'Hello there!');
        // send with a different style
        await client.sendMessage('status@broadcast', 'Hello again! Looks different?', {
            fontStyle: 1,
            backgroundColor: '#0b3296'
        });
    }
});

client.on('message_create', async (msg) => {
    // Fired on all message creations, including your own
    if (msg.fromMe) {
        await persistWhatsappMessage(msg);
        // do stuff here
    }

    // Unpins a message
    if (msg.fromMe && msg.body.startsWith('!unpin')) {
        const pinnedMsg = await msg.getQuotedMessage();
        if (pinnedMsg) {
            // Will unpin a message
            const result = await pinnedMsg.unpin();
            console.log(result); // True if the operation completed successfully, false otherwise
        }
    }
});

client.on('message_ciphertext', (msg) => {
    // Receiving new incoming messages that have been encrypted
    // msg.type === 'ciphertext'
    msg.body = 'Waiting for this message. Check your phone.';
    
    // do stuff here
});

client.on('message_revoke_everyone', async (after, before) => {
    // Fired whenever a message is deleted by anyone (including you)
    console.log(after); // message after it was deleted.
    if (before) {
        console.log(before); // message before it was deleted.
    }
});

client.on('message_revoke_me', async (msg) => {
    // Fired whenever a message is only deleted in your own view.
    console.log(msg.body); // message before it was deleted.
});

client.on('message_ack', (msg, ack) => {
    /*
        == ACK VALUES ==
        ACK_ERROR: -1
        ACK_PENDING: 0
        ACK_SERVER: 1
        ACK_DEVICE: 2
        ACK_READ: 3
        ACK_PLAYED: 4
    */

    if (ack == 3) {
        // The message was read
    }
});

client.on('group_join', (notification) => {
    // User has joined or been added to the group.
    console.log('join', notification);
    notification.reply('User joined.');
});

client.on('group_leave', (notification) => {
    // User has left or been kicked from the group.
    console.log('leave', notification);
    notification.reply('User left.');
});

client.on('group_update', (notification) => {
    // Group picture, subject or description has been updated.
    console.log('update', notification);
});

client.on('change_state', state => {
    console.log('CHANGE STATE', state);
    if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
        setPortalState('qr', state);
    }
});

// Change to false if you don't want to reject incoming calls
let rejectCalls = true;

client.on('call', async (call) => {
    console.log('Call received, rejecting. GOTO Line 261 to disable', call);
    if (rejectCalls) await call.reject();
    await client.sendMessage(call.from, `[${call.fromMe ? 'Outgoing' : 'Incoming'}] Phone call from ${call.from}, type ${call.isGroup ? 'group' : ''} ${call.isVideo ? 'video' : 'audio'} call. ${rejectCalls ? 'This call was automatically rejected by the script.' : ''}`);
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    setPortalState('disconnected', String(reason || ''));
    pageErrorHandlersAttached = false;
});

client.on('contact_changed', async (message, oldId, newId, isContact) => {
    /** The time the event occurred. */
    const eventTime = (new Date(message.timestamp * 1000)).toLocaleString();

    console.log(
        `The contact ${oldId.slice(0, -5)}` +
        `${!isContact ? ' that participates in group ' +
            `${(await client.getChatById(message.to ?? message.from)).name} ` : ' '}` +
        `changed their phone number\nat ${eventTime}.\n` +
        `Their new phone number is ${newId.slice(0, -5)}.\n`);

    /**
     * Information about the @param {message}:
     * 
     * 1. If a notification was emitted due to a group participant changing their phone number:
     * @param {message.author} is a participant's id before the change.
     * @param {message.recipients[0]} is a participant's id after the change (a new one).
     * 
     * 1.1 If the contact who changed their number WAS in the current user's contact list at the time of the change:
     * @param {message.to} is a group chat id the event was emitted in.
     * @param {message.from} is a current user's id that got an notification message in the group.
     * Also the @param {message.fromMe} is TRUE.
     * 
     * 1.2 Otherwise:
     * @param {message.from} is a group chat id the event was emitted in.
     * @param {message.to} is @type {undefined}.
     * Also @param {message.fromMe} is FALSE.
     * 
     * 2. If a notification was emitted due to a contact changing their phone number:
     * @param {message.templateParams} is an array of two user's ids:
     * the old (before the change) and a new one, stored in alphabetical order.
     * @param {message.from} is a current user's id that has a chat with a user,
     * whos phone number was changed.
     * @param {message.to} is a user's id (after the change), the current user has a chat with.
     */
});

client.on('group_admin_changed', (notification) => {
    if (notification.type === 'promote') {
        /** 
          * Emitted when a current user is promoted to an admin.
          * {@link notification.author} is a user who performs the action of promoting/demoting the current user.
          */
        console.log(`You were promoted by ${notification.author}`);
    } else if (notification.type === 'demote')
        /** Emitted when a current user is demoted to a regular user. */
        console.log(`You were demoted by ${notification.author}`);
});

client.on('group_membership_request', async (notification) => {
    /**
     * The example of the {@link notification} output:
     * {
     *     id: {
     *         fromMe: false,
     *         remote: 'groupId@g.us',
     *         id: '123123123132132132',
     *         participant: 'number@c.us',
     *         _serialized: 'false_groupId@g.us_123123123132132132_number@c.us'
     *     },
     *     body: '',
     *     type: 'created_membership_requests',
     *     timestamp: 1694456538,
     *     chatId: 'groupId@g.us',
     *     author: 'number@c.us',
     *     recipientIds: []
     * }
     *
     */
    console.log(notification);
    /** You can approve or reject the newly appeared membership request: */
    await client.approveGroupMembershipRequestss(notification.chatId, notification.author);
    await client.rejectGroupMembershipRequests(notification.chatId, notification.author);
});

client.on('message_reaction', async (reaction) => {
    console.log('REACTION RECEIVED', reaction);
});

client.on('vote_update', (vote) => {
    /** The vote that was affected: */
    console.log(vote);
});



