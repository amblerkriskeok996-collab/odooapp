/** @odoo-module */

import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

class WaPortalAction extends Component {
    static template = "wa_whatsapp_bridge.WaPortalAction";

    setup() {
        this.action = useService("action");
        this.notification = useService("notification");
        const actionParams = this.props.action?.params || {};
        this.state = useState({
            initialized: false,
            loading: true,
            instanceId: actionParams.instance_id || null,
            instanceName: actionParams.instance_name || "WhatsApp Portal",
            error: "",
            qrError: "",
            qrDataUrl: "",
            portalState: "initializing",
            detail: "初始化中",
            waState: "-",
            accountSwitchInProgress: false,
            account: null,
            loginAction: { allowed: false, message: "" },
            readySuccessVisible: false,
        });
        this.pollHandle = null;
        this.readyRedirectHandle = null;

        onMounted(async () => {
            await this.bootstrap();
            this.pollHandle = setInterval(() => {
                this.refreshStatus();
            }, 4000);
        });

        onWillUnmount(() => {
            if (this.pollHandle) {
                clearInterval(this.pollHandle);
            }
            this.clearReadyRedirect();
        });
    }

    get isReady() {
        return this.state.portalState === "ready";
    }

    get accountWid() {
        return this.state.account?.wid || "-";
    }

    get accountPlatform() {
        return this.state.account?.platform || "-";
    }

    get loginActionMessage() {
        return this.state.loginAction?.message || "-";
    }

    get switchStateLabel() {
        return this.state.accountSwitchInProgress ? "处理中" : "空闲";
    }

    get loginDisabled() {
        return this.state.accountSwitchInProgress || this.state.loading;
    }

    get statusClass() {
        if (this.state.portalState === "ready") {
            return "text-bg-success";
        }
        if (["switching_account", "reinitializing", "initializing", "authenticated"].includes(this.state.portalState)) {
            return "text-bg-warning";
        }
        if (this.state.portalState === "qr_required") {
            return "text-bg-info";
        }
        if (["auth_failure", "disconnected"].includes(this.state.portalState)) {
            return "text-bg-danger";
        }
        return "text-bg-secondary";
    }

    get stateLabel() {
        const labels = {
            ready: "已连接",
            authenticated: "已认证",
            qr_required: "待扫码",
            auth_failure: "已失效",
            disconnected: "已断开",
            switching_account: "切换中",
            reinitializing: "重连中",
            initializing: "启动中",
        };
        return labels[this.state.portalState] || (this.state.portalState || "unknown").toUpperCase();
    }

    clearReadyRedirect() {
        if (this.readyRedirectHandle) {
            clearTimeout(this.readyRedirectHandle);
            this.readyRedirectHandle = null;
        }
    }

    scheduleReadyRedirect() {
        if (this.readyRedirectHandle) {
            return;
        }
        this.state.readySuccessVisible = true;
        this.readyRedirectHandle = setTimeout(() => {
            this.readyRedirectHandle = null;
            this.action.doAction({
                type: "ir.actions.client",
                tag: "wa_whatsapp_bridge.chat_workspace",
                name: "WhatsApp Chats",
            });
        }, 1500);
    }

    resetReadySuccess() {
        this.clearReadyRedirect();
        this.state.readySuccessVisible = false;
    }

    async bootstrap() {
        this.state.loading = true;
        this.state.error = "";
        try {
            if (!this.state.instanceId) {
                const resolved = await rpc("/wa_whatsapp_bridge/portal/resolve", {});
                this.state.instanceId = resolved?.data?.instanceId || null;
                this.state.instanceName = resolved?.data?.name || this.state.instanceName;
            }
            await this.refreshStatus();
            this.state.initialized = true;
        } catch (error) {
            this.state.error = error.message || "加载 WhatsApp 页面失败";
        } finally {
            this.state.loading = false;
        }
    }

    applyStatus(payload) {
        const data = payload?.data || {};
        const previousPortalState = this.state.portalState;
        this.state.portalState = data.portalState || "unknown";
        this.state.detail = data.detail || "-";
        this.state.waState = data.waState || "-";
        this.state.accountSwitchInProgress = Boolean(data.accountSwitchInProgress);
        this.state.account = data.account || null;
        this.state.loginAction = data.loginAction || { allowed: false, message: "" };

        if (this.state.portalState !== "ready") {
            this.resetReadySuccess();
        }
        if (this.state.portalState !== "qr_required") {
            this.state.qrDataUrl = "";
            this.state.qrError = "";
        }
        if (previousPortalState !== "ready" && this.state.portalState === "ready") {
            this.scheduleReadyRedirect();
        }
    }

    async refreshStatus() {
        try {
            const payload = await rpc("/wa_whatsapp_bridge/portal/status", {
                instance_id: this.state.instanceId,
            });
            if (!payload?.success) {
                throw new Error(payload?.error || "加载状态失败");
            }
            this.state.error = "";
            this.applyStatus(payload);
            if (this.state.portalState === "qr_required") {
                await this.refreshQr();
            }
        } catch (error) {
            this.state.error = error.message || "加载状态失败";
        }
    }

    async refreshQr() {
        try {
            const payload = await rpc("/wa_whatsapp_bridge/portal/qr", {
                instance_id: this.state.instanceId,
            });
            if (!payload?.success) {
                throw new Error(payload?.error || "二维码暂时不可用");
            }
            this.state.qrDataUrl = payload?.data?.qrDataUrl || "";
            this.state.qrError = "";
        } catch (error) {
            this.state.qrError = error.message || "二维码暂时不可用";
        }
    }

    async login() {
        try {
            const payload = await rpc("/wa_whatsapp_bridge/portal/login", {
                instance_id: this.state.instanceId,
            });
            if (!payload?.success) {
                throw new Error(payload?.error || "账号已失效，请重新登录");
            }
            this.applyStatus(payload);
            await this.refreshStatus();
        } catch (error) {
            this.state.error = error.message || "账号已失效，请重新登录";
        }
    }

    async switchAccount() {
        try {
            const payload = await rpc("/wa_whatsapp_bridge/portal/switch_account", {
                instance_id: this.state.instanceId,
            });
            if (!payload?.success) {
                throw new Error(payload?.error || "清理登录信息失败");
            }
            this.notification.add("已清理登录信息，请重新扫码登录。", { type: "success" });
            this.applyStatus(payload);
            await this.refreshStatus();
        } catch (error) {
            this.state.error = error.message || "清理登录信息失败";
        }
    }
}

registry.category("actions").add("wa_whatsapp_bridge.portal", WaPortalAction);
