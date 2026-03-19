'use strict';

function createPortalState(now = Date.now()) {
    return {
        status: 'initializing',
        detail: '',
        updatedAt: now
    };
}

function transitionPortalState(currentState, eventName, detail = '', now = Date.now()) {
    const state = currentState ? { ...currentState } : createPortalState(now);
    state.updatedAt = now;

    if (eventName === 'qr') {
        state.status = 'qr_required';
        state.detail = String(detail || '');
        return state;
    }

    if (eventName === 'authenticated') {
        state.status = 'authenticated';
        state.detail = String(detail || '');
        return state;
    }

    if (eventName === 'ready') {
        state.status = 'ready';
        state.detail = String(detail || '');
        return state;
    }

    if (eventName === 'auth_failure') {
        state.status = 'auth_failure';
        state.detail = String(detail || '');
        return state;
    }

    if (eventName === 'disconnected') {
        state.status = 'disconnected';
        state.detail = String(detail || '');
        return state;
    }

    if (eventName === 'switching_account') {
        state.status = 'switching_account';
        state.detail = String(detail || '');
        return state;
    }

    if (eventName === 'reinitializing') {
        state.status = 'reinitializing';
        state.detail = String(detail || '');
        return state;
    }

    if (eventName === 'initializing') {
        state.status = 'initializing';
        state.detail = String(detail || '');
        return state;
    }

    state.detail = String(detail || state.detail || '');
    return state;
}

function isPortalReady(state) {
    return Boolean(state && state.status === 'ready');
}

function buildLoginAction(state) {
    if (isPortalReady(state)) {
        return {
            allowed: true,
            message: 'Account is ready'
        };
    }

    const status = state?.status || '';
    if (status === 'switching_account' || status === 'reinitializing') {
        return {
            allowed: false,
            message: 'Switching account, please wait'
        };
    }

    if (status === 'qr_required' || status === 'auth_failure' || status === 'disconnected') {
        return {
            allowed: false,
            message: 'Account expired, please login again'
        };
    }

    return {
        allowed: false,
        message: 'Client is not ready yet'
    };
}

module.exports = {
    createPortalState,
    transitionPortalState,
    isPortalReady,
    buildLoginAction
};
