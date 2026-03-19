/** @odoo-module **/

import { Component, onMounted, useState } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { registry } from "@web/core/registry";

class WaChatWorkspace extends Component {
    static template = "wa_whatsapp_bridge.WaChatWorkspace";

    setup() {
        this.state = useState({
            loading: true,
            error: "",
            portalState: "unknown",
            portalDetail: "",
            chats: [],
            messages: [],
            selectedChatJid: "",
            selectedChat: null,
        });

        onMounted(async () => {
            await this.loadWorkspace();
        });
    }

    get hasChats() {
        return this.state.chats.length > 0;
    }

    get isReady() {
        return this.state.portalState === "ready";
    }

    get chatTitle() {
        return this.state.selectedChat?.chat_name || "WhatsApp";
    }

    get chatMeta() {
        if (!this.state.selectedChat) {
            return "";
        }
        return this.state.selectedChat.chat_type === "group" ? "群聊" : "单聊";
    }

    formatMessageTime(value) {
        if (!value) {
            return "";
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return value;
        }
        return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }

    async loadWorkspace(chatJid = null) {
        this.state.loading = true;
        this.state.error = "";
        try {
            const payload = await rpc("/wa_whatsapp_bridge/chat/bootstrap", {
                chat_jid: chatJid,
            });
            if (!payload?.success) {
                throw new Error(payload?.error || "加载聊天工作台失败");
            }
            this.applyWorkspacePayload(payload.data || {});
        } catch (error) {
            this.state.error = error.message || "加载聊天工作台失败";
        } finally {
            this.state.loading = false;
        }
    }

    applyWorkspacePayload(data) {
        this.state.portalState = data.portal_state || "unknown";
        this.state.portalDetail = data.portal_detail || "";
        this.state.chats = data.chats || [];
        this.state.messages = data.messages || [];
        this.state.selectedChatJid = data.selected_chat_jid || "";
        this.state.selectedChat = data.selected_chat || null;
    }

    async openChat(chat) {
        if (!chat?.chat_jid || chat.chat_jid === this.state.selectedChatJid || !this.isReady) {
            return;
        }
        this.state.loading = true;
        this.state.error = "";
        try {
            const payload = await rpc("/wa_whatsapp_bridge/chat/messages", {
                chat_jid: chat.chat_jid,
                limit: 200,
            });
            if (!payload?.success) {
                throw new Error(payload?.error || "加载消息失败");
            }
            this.state.selectedChatJid = chat.chat_jid;
            this.state.selectedChat = chat;
            this.state.messages = payload?.data?.messages || [];
            this.state.portalState = payload?.data?.portal_state || this.state.portalState;
            this.state.portalDetail = payload?.data?.portal_detail || this.state.portalDetail;
        } catch (error) {
            this.state.error = error.message || "加载消息失败";
        } finally {
            this.state.loading = false;
        }
    }
}

registry.category("actions").add("wa_whatsapp_bridge.chat_workspace", WaChatWorkspace);
