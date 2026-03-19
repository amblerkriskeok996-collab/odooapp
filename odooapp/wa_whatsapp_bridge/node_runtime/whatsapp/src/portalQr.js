const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const QR_TTL_MS = 60 * 1000;

function createQrState() {
    return {
        qrText: '',
        frontendQrDataUrl: '',
        updatedAt: 0,
        expiresAt: 0,
    };
}

function buildQrDataUrl(qrText) {
    const qrcode = new QRCode(-1, QRErrorCorrectLevel.M);
    qrcode.addData(qrText);
    qrcode.make();

    const moduleCount = qrcode.getModuleCount();
    const cellSize = 8;
    const margin = 4;
    const totalSize = (moduleCount + margin * 2) * cellSize;
    const rects = [];

    for (let row = 0; row < moduleCount; row += 1) {
        for (let col = 0; col < moduleCount; col += 1) {
            if (!qrcode.isDark(row, col)) {
                continue;
            }
            const x = (col + margin) * cellSize;
            const y = (row + margin) * cellSize;
            rects.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}"/>`);
        }
    }

    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges">`,
        `<rect width="${totalSize}" height="${totalSize}" fill="#ffffff"/>`,
        `<g fill="#000000">${rects.join('')}</g>`,
        '</svg>',
    ].join('');

    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function rememberQr(state, qrText) {
    const updatedAt = Date.now();
    state.qrText = qrText;
    state.frontendQrDataUrl = '';
    state.updatedAt = updatedAt;
    state.expiresAt = updatedAt + QR_TTL_MS;
    return getQrPayload(state);
}

function rememberFrontendQrImage(state, qrDataUrl) {
    if (!qrDataUrl) {
        return null;
    }
    state.frontendQrDataUrl = qrDataUrl;
    return qrDataUrl;
}

function clearQr(state) {
    state.qrText = '';
    state.frontendQrDataUrl = '';
    state.updatedAt = 0;
    state.expiresAt = 0;
}

function getQrPayload(state) {
    if (!state.qrText || !state.updatedAt) {
        return null;
    }
    if (state.frontendQrDataUrl) {
        return {
            qrDataUrl: state.frontendQrDataUrl,
            updatedAt: state.updatedAt,
            expiresAt: state.expiresAt,
            source: 'frontend',
        };
    }
    return {
        qrDataUrl: buildQrDataUrl(state.qrText),
        updatedAt: state.updatedAt,
        expiresAt: state.expiresAt,
        source: 'rendered',
    };
}

module.exports = {
    QR_TTL_MS,
    buildQrDataUrl,
    clearQr,
    createQrState,
    getQrPayload,
    rememberFrontendQrImage,
    rememberQr,
};
