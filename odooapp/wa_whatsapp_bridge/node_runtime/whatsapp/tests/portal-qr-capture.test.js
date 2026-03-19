const { expect } = require('chai');
const {
    captureFrontendQr,
    captureFrontendQrWithTimeout,
} = require('../src/portalQrCapture');

describe('portalQrCapture', () => {
    it('returns the original img data url when WhatsApp Web exposes one', async () => {
        const page = {
            isClosed: () => false,
            waitForSelector: async (selector) => {
                if (selector === 'img[alt*="QR"], img[data-testid="qrcode"]') {
                    return { kind: 'img' };
                }
                return null;
            },
            evaluate: async (_fn, element) => {
                if (element.kind === 'img') {
                    return 'data:image/png;base64,frontend';
                }
                return '';
            },
        };

        const payload = await captureFrontendQr(page, {
            selectors: ['img[alt*="QR"], img[data-testid="qrcode"]'],
            attempts: 1,
        });

        expect(payload).to.equal('data:image/png;base64,frontend');
    });

    it('falls back to an element screenshot when only a canvas is available', async () => {
        const element = {
            screenshot: async () => 'ZmFrZV9wbmc=',
        };
        const page = {
            isClosed: () => false,
            waitForSelector: async (selector) => {
                if (selector === 'canvas') {
                    return element;
                }
                return null;
            },
            evaluate: async () => '',
        };

        const payload = await captureFrontendQr(page, {
            selectors: ['canvas'],
            attempts: 1,
        });

        expect(payload).to.equal('data:image/png;base64,ZmFrZV9wbmc=');
    });

    it('returns null quickly when frontend capture stalls', async () => {
        const page = {
            isClosed: () => false,
            waitForSelector: async () => new Promise(() => {}),
        };

        const startedAt = Date.now();
        const payload = await captureFrontendQrWithTimeout(page, {
            selectors: ['canvas'],
            attempts: 1,
            timeoutMs: 50,
        });

        expect(payload).to.equal(null);
        expect(Date.now() - startedAt).to.be.lessThan(500);
    });
});
