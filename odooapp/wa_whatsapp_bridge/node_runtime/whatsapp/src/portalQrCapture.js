const DEFAULT_QR_SELECTORS = [
    'img[alt*="QR"], img[data-testid="qrcode"]',
    'canvas[aria-label*="QR"], [data-testid="qrcode"] canvas',
    'div[aria-label*="QR"] canvas',
    'canvas',
];

const DEFAULT_CAPTURE_TIMEOUT_MS = 1200;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureFrontendQr(page, options = {}) {
    if (!page) {
        return null;
    }
    if (typeof page.isClosed === 'function' && page.isClosed()) {
        return null;
    }

    const selectors = options.selectors || DEFAULT_QR_SELECTORS;
    const attempts = options.attempts || 4;
    const delayMs = options.delayMs || 300;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        for (const selector of selectors) {
            let element = null;
            try {
                element = await page.waitForSelector(selector, {
                    visible: true,
                    timeout: 1000,
                });
            } catch (_error) {
                element = null;
            }

            if (!element) {
                continue;
            }

            try {
                const src = await page.evaluate((node) => node?.src || '', element);
                if (src && src.startsWith('data:image/')) {
                    return src;
                }
            } catch (_error) {
                // fall through to screenshot mode
            }

            try {
                const base64 = await element.screenshot({
                    encoding: 'base64',
                    type: 'png',
                });
                if (base64) {
                    return `data:image/png;base64,${base64}`;
                }
            } catch (_error) {
                // try next selector or retry
            }
        }

        if (attempt < attempts - 1) {
            await sleep(delayMs);
        }
    }

    return null;
}

async function captureFrontendQrWithTimeout(page, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_CAPTURE_TIMEOUT_MS;

    return Promise.race([
        captureFrontendQr(page, options),
        new Promise((resolve) => {
            setTimeout(() => resolve(null), timeoutMs);
        }),
    ]);
}

module.exports = {
    DEFAULT_CAPTURE_TIMEOUT_MS,
    DEFAULT_QR_SELECTORS,
    captureFrontendQr,
    captureFrontendQrWithTimeout,
};
