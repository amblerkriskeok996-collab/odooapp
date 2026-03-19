'use strict';

function isRecoverablePageError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message) return false;

    return (
        message.includes('session closed')
        || message.includes('page has been closed')
        || message.includes('target closed')
        || message.includes('session not found')
    );
}

async function runWithSingleRecovery(openAction, recoveryAction) {
    try {
        return await openAction();
    } catch (error) {
        if (!isRecoverablePageError(error)) {
            throw error;
        }

        await recoveryAction(error);
        return openAction();
    }
}

module.exports = {
    isRecoverablePageError,
    runWithSingleRecovery
};
