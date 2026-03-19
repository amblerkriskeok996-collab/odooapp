const { expect } = require('chai');
const {
    QR_TTL_MS,
    createQrState,
    rememberQr,
    rememberFrontendQrImage,
    getQrPayload,
    clearQr,
} = require('../src/portalQr');

describe('portalQr', () => {
    it('caches QR payload as a data URL', () => {
        const state = createQrState();
        const payload = rememberQr(state, 'test-qr-value');

        expect(payload.qrDataUrl.startsWith('data:image/svg+xml')).to.equal(true);
        expect(payload.updatedAt).to.be.a('number');
        expect(payload.expiresAt - payload.updatedAt).to.equal(QR_TTL_MS);
    });

    it('returns null after QR is cleared', () => {
        const state = createQrState();
        rememberQr(state, 'test-qr-value');
        clearQr(state);

        expect(getQrPayload(state)).to.equal(null);
    });

    it('keeps returning the latest QR payload even after the local ttl passes', () => {
        const state = createQrState();
        rememberQr(state, 'test-qr-value');
        state.expiresAt = Date.now() - 1;

        const payload = getQrPayload(state);

        expect(payload).to.be.an('object');
        expect(payload.qrDataUrl.startsWith('data:image/svg+xml')).to.equal(true);
    });

    it('prefers the captured WhatsApp frontend QR image over local SVG rendering', () => {
        const state = createQrState();
        rememberQr(state, 'test-qr-value');
        rememberFrontendQrImage(state, 'data:image/png;base64,frontend');

        const payload = getQrPayload(state);

        expect(payload).to.be.an('object');
        expect(payload.qrDataUrl).to.equal('data:image/png;base64,frontend');
        expect(payload.source).to.equal('frontend');
    });
});
