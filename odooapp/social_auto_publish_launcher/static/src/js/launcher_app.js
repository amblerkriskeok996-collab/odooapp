/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

const MENU_ITEMS = [
    { key: "dashboard", label: "首页", icon: "⌂" },
    { key: "accounts", label: "账号管理", icon: "◉" },
    { key: "materials", label: "素材管理", icon: "▣" },
    { key: "publish", label: "发布中心", icon: "⇪" },
    { key: "website", label: "网站", icon: "◎" },
    { key: "data", label: "数据", icon: "◌" },
];

const PLATFORM_OPTIONS = [
    { key: "kuaishou", label: "快手", tone: "green" },
    { key: "douyin", label: "抖音", tone: "red" },
    { key: "tencent", label: "视频号", tone: "orange" },
    { key: "xiaohongshu", label: "小红书", tone: "blue" },
    { key: "bilibili", label: "哔哩哔哩", tone: "blue" },
    { key: "toutiao", label: "今日头条", tone: "orange" },
    { key: "zhihu", label: "知乎", tone: "blue" },
    { key: "weibo", label: "微博", tone: "red" },
    { key: "sohu", label: "搜狐新闻", tone: "gold" },
    { key: "tencent_news", label: "腾讯新闻", tone: "green" },
];

const PLATFORM_TYPE_MAP = {
    xiaohongshu: 1,
    tencent: 2,
    douyin: 3,
    kuaishou: 4,
    bilibili: 5,
    toutiao: 6,
    zhihu: 7,
    weibo: 8,
    sohu: 9,
    tencent_news: 10,
};

const RECOMMENDED_TOPICS = [
    "游戏", "电影", "音乐", "美食", "旅行", "文化",
    "科技", "生活", "娱乐", "体育", "教育", "艺术",
    "健康", "时尚", "美妆", "摄影", "宠物", "汽车",
];

const NORMAL_STATUS = "正常";
const ABNORMAL_STATUS = "异常";

function createPublishTab(index = 1) {
    return {
        key: `tab_${index}`,
        label: `发布任务 ${index}`,
        publishMode: "video",
        files: [],
        selectedPlatforms: [],
        selectedAccounts: [],
        selectedTopics: [],
        title: "",
        productTitle: "",
        productLink: "",
        isDraft: false,
        scheduleEnabled: false,
        videosPerDay: 1,
        dailyTimes: ["10:00"],
        startDays: 0,
        publishStatus: null,
        publishing: false,
    };
}

function duplicateTab(tab, index) {
    return {
        ...structuredClone(tab),
        key: `tab_${index}`,
        label: `${tab.label} 副本`,
        publishStatus: null,
        publishing: false,
    };
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            const base64 = result.includes(",") ? result.split(",").pop() : result;
            resolve(base64 || "");
        };
        reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
        reader.readAsDataURL(file);
    });
}

function buildRoute(path) {
    return `${window.location.origin}${path}`;
}

function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

class Sidebar extends Component {
    static template = "social_auto_publish_launcher.Sidebar";
}

class HeaderBar extends Component {
    static template = "social_auto_publish_launcher.HeaderBar";
}

class DashboardPage extends Component {
    static template = "social_auto_publish_launcher.DashboardPage";
}

class AccountPage extends Component {
    static template = "social_auto_publish_launcher.AccountPage";
}

class MaterialPage extends Component {
    static template = "social_auto_publish_launcher.MaterialPage";
}

class PublishPage extends Component {
    static template = "social_auto_publish_launcher.PublishPage";
}

class PlaceholderPage extends Component {
    static template = "social_auto_publish_launcher.PlaceholderPage";
}

export class SocialAutoPublishLauncherApp extends Component {
    static template = "social_auto_publish_launcher.LauncherApp";
    static components = {
        Sidebar,
        HeaderBar,
        DashboardPage,
        AccountPage,
        MaterialPage,
        PublishPage,
        PlaceholderPage,
    };

    setup() {
        this.notification = useService("notification");
        this.menuItems = MENU_ITEMS;
        this.platformOptions = PLATFORM_OPTIONS;
        this.platformTabs = [{ name: "all", label: "全部" }, ...PLATFORM_OPTIONS.map((item) => ({ name: item.key, label: item.label }))];
        this.recommendedTopics = RECOMMENDED_TOPICS;
        this.state = useState({
            isCollapsed: false,
            currentPage: "dashboard",
            dashboardRefreshing: false,
            bootstrapLoading: true,
            accountTab: "all",
            accountSearch: "",
            accounts: [],
            accountForm: { id: null, name: "", platform_key: "kuaishou", platform: "快手", status: NORMAL_STATUS },
            loginStatus: "",
            loginError: "",
            qrCodeData: "",
            sseConnecting: false,
            currentLoginTaskId: null,
            currentLoginTask: null,
            materialSearch: "",
            isRefreshingMaterials: false,
            isUploadingMaterials: false,
            materials: [],
            materialFiles: [],
            materialUploadProgress: {},
            customFilename: "",
            previewMaterial: null,
            publishTabs: [createPublishTab(1)],
            activePublishTabKey: "tab_1",
            tempSelectedMaterials: [],
            tempSelectedAccounts: [],
            topicInput: "",
            batchPublishing: false,
            batchProgress: 0,
            batchResults: [],
            currentPublishingLabel: "",
            recentTasks: [],
            modals: {
                accountEditor: false,
                materialUpload: false,
                materialPreview: false,
                publishUploadOptions: false,
                publishLocalUpload: false,
                publishMaterialLibrary: false,
                publishAccountSelector: false,
                publishTopicSelector: false,
                publishBatchProgress: false,
            },
        });
        this.publishTabCounter = 2;
        onWillStart(async () => {
            await this.loadBootstrap();
        });
    }

    notify(message, type = "info") {
        this.notification.add(message, { type });
    }

    async loadBootstrap() {
        this.state.bootstrapLoading = true;
        try {
            const payload = await rpc("/social_auto_publish_launcher/bootstrap", {});
            if (!payload?.ok) {
                throw new Error("加载初始化数据失败");
            }
            this.state.accounts = (payload.accounts || []).map((account) => this.normalizeAccount(account));
            this.state.materials = (payload.materials || []).map((material) => this.normalizeMaterial(material));
            this.state.recentTasks = payload.recent_tasks || [];
        } catch (error) {
            this.notify(error.message || "加载初始化数据失败", "danger");
        } finally {
            this.state.bootstrapLoading = false;
        }
    }

    normalizeAccount(account) {
        const platformKey = account.platform_key || this.getPlatformKeyByLabel(account.platform) || "douyin";
        return {
            ...account,
            platform_key: platformKey,
            type: account.type || this.getPlatformTypeByKey(platformKey),
            platform: account.platform || this.getPlatformLabelByKey(platformKey),
            status: account.status || ABNORMAL_STATUS,
            filePath: account.filePath || "",
        };
    }

    normalizeMaterial(material) {
        return {
            ...material,
            filename: material.filename || material.file_name || material.name,
            fileType: material.fileType || ((material.mimeType || "").startsWith("image/") ? "image" : "video"),
            previewUrl: buildRoute(`/social_auto_publish_launcher/material/content/${material.id}`),
            downloadUrl: buildRoute(`/social_auto_publish_launcher/material/content/${material.id}?download=1`),
        };
    }

    closeLoginStream() {
        this.state.sseConnecting = false;
    }

    toggleSidebar() {
        this.state.isCollapsed = !this.state.isCollapsed;
    }

    selectPage(key) {
        this.state.currentPage = key;
    }

    closeModal(name) {
        if (name === "accountEditor") {
            this.closeLoginStream();
            this.state.qrCodeData = "";
            this.state.loginStatus = "";
            this.state.loginError = "";
            this.state.currentLoginTaskId = null;
            this.state.currentLoginTask = null;
        }
        this.state.modals[name] = false;
    }

    getCurrentPageLabel() {
        const item = this.menuItems.find((entry) => entry.key === this.state.currentPage);
        return item ? item.label : "首页";
    }

    getPlatformLabelByKey(key) {
        const item = this.platformOptions.find((entry) => entry.key === key);
        return item ? item.label : "";
    }

    getPlatformKeyByLabel(label) {
        const item = this.platformOptions.find((entry) => entry.label === label);
        return item ? item.key : "";
    }

    getPlatformTypeByKey(platformKey) {
        return PLATFORM_TYPE_MAP[platformKey] || 0;
    }

    getPlatformTone(platformLabel) {
        const item = this.platformOptions.find((entry) => entry.label === platformLabel);
        return item ? item.tone : "neutral";
    }

    getDashboardStats() {
        const accountTotal = this.state.accounts.length;
        const normalAccounts = this.state.accounts.filter((item) => item.status === NORMAL_STATUS).length;
        const abnormalAccounts = accountTotal - normalAccounts;
        const platformCounters = PLATFORM_OPTIONS.reduce((acc, item) => ({ ...acc, [item.key]: 0 }), {});
        for (const account of this.state.accounts) {
            if (platformCounters[account.platform_key] !== undefined) {
                platformCounters[account.platform_key] += 1;
            }
        }
        return {
            accountTotal,
            normalAccounts,
            abnormalAccounts,
            platformTotal: new Set(this.state.accounts.map((item) => item.platform_key)).size,
            taskTotal: this.state.publishTabs.length,
            materialTotal: this.state.materials.length,
            platformCounters,
        };
    }

    async refreshDashboardData() {
        this.state.dashboardRefreshing = true;
        await this.loadBootstrap();
        this.state.dashboardRefreshing = false;
        this.notify("已刷新真实数据", "success");
    }

    getAvatarText(name) {
        return (name || "?").trim().slice(0, 1).toUpperCase();
    }

    setAccountTab(tabName) {
        this.state.accountTab = tabName;
    }

    async refreshAccounts(platformType = null) {
        try {
            const payload = await rpc("/social_auto_publish_launcher/account/refresh", { platform_type: platformType });
            if (payload?.code !== 200) {
                throw new Error(payload?.msg || "刷新账号失败");
            }
            const refreshed = (payload.data || []).map((account) => this.normalizeAccount(account));
            if (platformType) {
                const platformKey = this.platformOptions.find((item) => this.getPlatformTypeByKey(item.key) === platformType)?.key;
                this.state.accounts = [
                    ...this.state.accounts.filter((item) => item.platform_key !== platformKey),
                    ...refreshed,
                ].sort((left, right) => right.id - left.id);
            } else {
                this.state.accounts = refreshed;
            }
            this.notify("账号状态已刷新", "success");
        } catch (error) {
            this.notify(error.message || "刷新账号失败", "danger");
        }
    }

    getFilteredAccounts() {
        const search = this.state.accountSearch.trim().toLowerCase();
        return this.state.accounts.filter((account) => {
            const tabMatch = this.state.accountTab === "all" || account.platform_key === this.state.accountTab;
            const searchMatch = !search || account.name.toLowerCase().includes(search) || account.platform.toLowerCase().includes(search);
            return tabMatch && searchMatch;
        });
    }

    getCurrentTabAbnormalAccounts() {
        return this.getFilteredAccounts().filter((account) => account.status === ABNORMAL_STATUS);
    }

    openAddAccount() {
        this.closeLoginStream();
        this.state.qrCodeData = "";
        this.state.loginStatus = "";
        this.state.loginError = "";
        this.state.currentLoginTaskId = null;
        this.state.currentLoginTask = null;
        this.state.accountForm = { id: null, name: "", platform_key: "kuaishou", platform: "快手", status: NORMAL_STATUS };
        this.state.modals.accountEditor = true;
    }

    editAccount(account) {
        this.closeLoginStream();
        this.state.qrCodeData = "";
        this.state.loginStatus = "";
        this.state.loginError = "";
        this.state.currentLoginTaskId = null;
        this.state.currentLoginTask = null;
        this.state.accountForm = {
            id: account.id,
            name: account.name,
            platform_key: account.platform_key,
            platform: account.platform,
            status: account.status,
        };
        this.state.modals.accountEditor = true;
    }

    async fetchTask(taskId) {
        if (!taskId) {
            return null;
        }
        const payload = await rpc("/social_auto_publish_launcher/task/get", { task_id: taskId });
        if (payload?.code !== 200) {
            throw new Error(payload?.msg || "加载任务状态失败");
        }
        this.state.currentLoginTask = payload.data;
        return payload.data;
    }

    async pollLoginTask(taskId) {
        const maxAttempts = 600;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const task = await this.fetchTask(taskId);
            const qrData = task?.payload?.qr_data || "";
            if (qrData) {
                this.state.qrCodeData = qrData.startsWith("data:image") ? qrData : `data:image/png;base64,${qrData}`;
            }
            if (task?.status === "success") {
                this.state.loginStatus = "200";
                this.state.loginError = "";
                this.closeLoginStream();
                this.notify("账号登录成功，正在同步数据", "success");
                await this.loadBootstrap();
                this.state.modals.accountEditor = false;
                this.state.qrCodeData = "";
                this.state.loginStatus = "";
                this.state.loginError = "";
                return;
            }
            if (task?.status === "failed") {
                this.state.loginStatus = "500";
                this.state.loginError = task.error_message || "二维码登录失败，请稍后重试";
                this.closeLoginStream();
                this.notify(this.state.loginError, "danger");
                return;
            }
            await sleep(1000);
        }
        this.closeLoginStream();
        this.state.loginError = "二维码登录超时，请重试";
        this.notify(this.state.loginError, "danger");
    }

    async startQrLogin() {
        const form = this.state.accountForm;
        if (!form.name.trim()) {
            this.notify("请输入账号名称", "warning");
            return;
        }
        this.closeLoginStream();
        this.state.sseConnecting = true;
        this.state.qrCodeData = "";
        this.state.loginStatus = "";
        this.state.loginError = "";
        this.state.currentLoginTaskId = null;
        this.state.currentLoginTask = null;
        const type = this.getPlatformTypeByKey(form.platform_key);
        const url = buildRoute(`/social_auto_publish_launcher/login?type=${type}&id=${encodeURIComponent(form.name.trim())}`);
        try {
            const response = await fetch(url, {
                method: "GET",
                credentials: "include",
                headers: { Accept: "application/json" },
            });
            if (!response.ok) {
                throw new Error("二维码登录任务创建失败");
            }
            const payload = await response.json();
            const taskId = payload?.data?.task_id;
            if (!taskId) {
                throw new Error(payload?.msg || "二维码登录任务创建失败");
            }
            this.state.currentLoginTaskId = taskId;
            await this.fetchTask(taskId);
            await this.pollLoginTask(taskId);
        } catch (error) {
            this.closeLoginStream();
            this.state.loginError = error.message || "二维码登录连接失败";
            this.notify(this.state.loginError, "danger");
        }
    }

    async saveAccount() {
        const form = this.state.accountForm;
        if (!form.name.trim()) {
            this.notify("请输入账号名称", "warning");
            return;
        }
        if (!form.id) {
            await this.startQrLogin();
            return;
        }
        try {
            const payload = await rpc("/social_auto_publish_launcher/account/save", {
                account: {
                    id: form.id,
                    name: form.name.trim(),
                    platform_key: form.platform_key,
                    type: this.getPlatformTypeByKey(form.platform_key),
                    status: form.status,
                },
            });
            if (payload?.code !== 200) {
                throw new Error(payload?.msg || "保存账号失败");
            }
            const updated = this.normalizeAccount(payload.data);
            const index = this.state.accounts.findIndex((item) => item.id === updated.id);
            if (index >= 0) {
                this.state.accounts.splice(index, 1, updated);
            }
            this.state.modals.accountEditor = false;
            this.notify("账号已更新", "success");
        } catch (error) {
            this.notify(error.message || "保存账号失败", "danger");
        }
    }

    async toggleAccountStatus(account) {
        await this.refreshAccounts(account.type);
    }

    downloadCookie(account) {
        window.open(buildRoute(`/social_auto_publish_launcher/account/download_cookie/${account.id}`), "_blank");
    }

    uploadCookie(account) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = async () => {
            const file = input.files && input.files[0];
            if (!file) {
                return;
            }
            if (!file.name.endsWith(".json")) {
                this.notify("请选择 JSON 格式的 Cookie 文件", "warning");
                return;
            }
            try {
                const content = await readFileAsBase64(file);
                const payload = await rpc("/social_auto_publish_launcher/account/upload_cookie", {
                    account_id: account.id,
                    filename: file.name,
                    content,
                });
                if (payload?.code !== 200) {
                    throw new Error(payload?.msg || "上传 Cookie 失败");
                }
                const updated = this.normalizeAccount(payload.data);
                const index = this.state.accounts.findIndex((item) => item.id === updated.id);
                if (index >= 0) {
                    this.state.accounts.splice(index, 1, updated);
                }
                this.notify(`${account.name} Cookie 上传成功`, "success");
            } catch (error) {
                this.notify(error.message || "上传 Cookie 失败", "danger");
            }
        };
        input.click();
    }

    async deleteAccount(accountId) {
        try {
            const payload = await rpc("/social_auto_publish_launcher/account/delete", { account_id: accountId });
            if (payload?.code !== 200) {
                throw new Error(payload?.msg || "删除账号失败");
            }
            this.state.accounts = this.state.accounts.filter((item) => item.id !== accountId);
            if (payload?.data?.task_id) {
                this.state.currentLoginTaskId = payload.data.task_id;
                await this.fetchTask(payload.data.task_id);
            }
            this.notify("账号已删除", "success");
        } catch (error) {
            this.notify(error.message || "删除账号失败", "danger");
        }
    }

    async deleteAbnormalAccounts() {
        const abnormalAccounts = this.getCurrentTabAbnormalAccounts();
        if (!abnormalAccounts.length) {
            this.notify("当前没有异常账号", "warning");
            return;
        }
        for (const account of abnormalAccounts) {
            await this.deleteAccount(account.id);
        }
    }

    getFilteredMaterials() {
        const search = this.state.materialSearch.trim().toLowerCase();
        return this.state.materials.filter((material) => !search || material.filename.toLowerCase().includes(search) || material.uuid.toLowerCase().includes(search));
    }

    async refreshMaterials() {
        this.state.isRefreshingMaterials = true;
        try {
            const payload = await rpc("/social_auto_publish_launcher/material/list", {});
            if (payload?.code !== 200) {
                throw new Error(payload?.msg || "刷新素材失败");
            }
            this.state.materials = (payload.data || []).map((material) => this.normalizeMaterial(material));
            this.notify("素材列表已刷新", "success");
        } catch (error) {
            this.notify(error.message || "刷新素材失败", "danger");
        } finally {
            this.state.isRefreshingMaterials = false;
        }
    }

    openMaterialUpload() {
        this.state.materialFiles = [];
        this.state.materialUploadProgress = {};
        this.state.customFilename = "";
        this.state.modals.materialUpload = true;
    }

    handleMaterialFiles(ev) {
        const files = Array.from(ev.target.files || []);
        this.state.materialFiles = files;
        const progress = {};
        for (const file of files) {
            progress[file.name] = { percentage: 0, speed: "等待上传" };
        }
        this.state.materialUploadProgress = progress;
    }

    async uploadFilesToMaterials(files, customFilename = "") {
        const payloadFiles = [];
        for (const file of files) {
            payloadFiles.push({
                file_name: file.name,
                display_name: files.length === 1 && customFilename.trim() ? customFilename.trim() : file.name,
                content: await readFileAsBase64(file),
            });
        }
        const payload = await rpc("/social_auto_publish_launcher/material/upload", { files: payloadFiles });
        if (payload?.code !== 200) {
            throw new Error(payload?.msg || "上传素材失败");
        }
        return (payload.data || []).map((material) => this.normalizeMaterial(material));
    }

    async submitMaterialUpload() {
        if (!this.state.materialFiles.length) {
            this.notify("请选择要上传的文件", "warning");
            return;
        }
        this.state.isUploadingMaterials = true;
        try {
            for (const file of this.state.materialFiles) {
                this.state.materialUploadProgress[file.name] = { percentage: 50, speed: "上传中" };
            }
            const created = await this.uploadFilesToMaterials(this.state.materialFiles, this.state.customFilename);
            for (const file of this.state.materialFiles) {
                this.state.materialUploadProgress[file.name] = { percentage: 100, speed: "完成" };
            }
            this.state.materials = [...created, ...this.state.materials];
            this.state.modals.materialUpload = false;
            this.notify("素材上传成功", "success");
        } catch (error) {
            this.notify(error.message || "素材上传失败", "danger");
        } finally {
            this.state.isUploadingMaterials = false;
        }
    }

    previewMaterial(material) {
        this.state.previewMaterial = material;
        this.state.modals.materialPreview = true;
    }

    isImageMaterial(material) {
        return Boolean(material) && material.fileType === "image";
    }

    getMaterialPreviewUrl(material) {
        return material ? material.previewUrl : "";
    }

    async deleteMaterial(materialId) {
        try {
            const payload = await rpc("/social_auto_publish_launcher/material/delete", { material_id: materialId });
            if (payload?.code !== 200) {
                throw new Error(payload?.msg || "删除素材失败");
            }
            this.state.materials = this.state.materials.filter((item) => item.id !== materialId);
            this.notify("素材已删除", "success");
        } catch (error) {
            this.notify(error.message || "删除素材失败", "danger");
        }
    }

    downloadMaterial(material) {
        window.open(material.downloadUrl, "_blank");
    }

    getActivePublishTab() {
        return this.state.publishTabs.find((tab) => tab.key === this.state.activePublishTabKey) || this.state.publishTabs[0];
    }

    setActivePublishTab(tabKey) {
        this.state.activePublishTabKey = tabKey;
    }

    addPublishTab() {
        const tab = createPublishTab(this.publishTabCounter++);
        this.state.publishTabs.push(tab);
        this.state.activePublishTabKey = tab.key;
    }

    duplicatePublishTab(tabKey) {
        const source = this.state.publishTabs.find((tab) => tab.key === tabKey);
        if (!source) {
            return;
        }
        const copy = duplicateTab(source, this.publishTabCounter++);
        this.state.publishTabs.push(copy);
        this.state.activePublishTabKey = copy.key;
    }

    removePublishTab(tabKey) {
        if (this.state.publishTabs.length <= 1) {
            return;
        }
        this.state.publishTabs = this.state.publishTabs.filter((tab) => tab.key !== tabKey);
        if (this.state.activePublishTabKey === tabKey) {
            this.state.activePublishTabKey = this.state.publishTabs[0].key;
        }
    }

    setPublishMode(mode) {
        const tab = this.getActivePublishTab();
        tab.publishMode = mode;
        tab.files = [];
    }

    showPublishUploadOptions() {
        this.state.modals.publishUploadOptions = true;
    }

    openPublishLocalUpload() {
        this.state.modals.publishUploadOptions = false;
        this.state.modals.publishLocalUpload = true;
    }

    openPublishMaterialLibrary() {
        this.state.tempSelectedMaterials = [];
        this.state.modals.publishUploadOptions = false;
        this.state.modals.publishMaterialLibrary = true;
    }

    async handlePublishFiles(ev) {
        const files = Array.from(ev.target.files || []);
        if (!files.length) {
            return;
        }
        try {
            const created = await this.uploadFilesToMaterials(files);
            const tab = this.getActivePublishTab();
            for (const material of created) {
                const expectedType = tab.publishMode === "image" ? "image" : "video";
                if (material.fileType !== expectedType) {
                    continue;
                }
                tab.files.push({
                    path: `material/${material.id}`,
                    materialId: material.id,
                    name: material.filename,
                    size: (material.filesize || 0) * 1024 * 1024,
                    type: material.fileType,
                    url: material.previewUrl,
                });
            }
            this.state.materials = [...created, ...this.state.materials];
            this.state.modals.publishLocalUpload = false;
            this.notify("文件已上传并加入发布任务", "success");
        } catch (error) {
            this.notify(error.message || "上传发布文件失败", "danger");
        } finally {
            ev.target.value = "";
        }
    }

    toggleMaterialSelection(materialId) {
        if (this.state.tempSelectedMaterials.includes(materialId)) {
            this.state.tempSelectedMaterials = this.state.tempSelectedMaterials.filter((item) => item !== materialId);
        } else {
            this.state.tempSelectedMaterials.push(materialId);
        }
    }

    confirmMaterialSelection() {
        const tab = this.getActivePublishTab();
        const expectedType = tab.publishMode === "image" ? "image" : "video";
        let addedCount = 0;
        for (const id of this.state.tempSelectedMaterials) {
            const material = this.state.materials.find((item) => item.id === id);
            if (!material || material.fileType !== expectedType) {
                continue;
            }
            if (!tab.files.some((file) => file.materialId === id)) {
                tab.files.push({
                    path: `material/${id}`,
                    materialId: id,
                    name: material.filename,
                    size: (material.filesize || 0) * 1024 * 1024,
                    type: material.fileType,
                    url: material.previewUrl,
                });
                addedCount += 1;
            }
        }
        this.state.modals.publishMaterialLibrary = false;
        this.notify(addedCount ? "素材已加入当前任务" : "未加入新素材，请检查类型或重复项", addedCount ? "success" : "warning");
    }

    removePublishFile(filePath) {
        const tab = this.getActivePublishTab();
        tab.files = tab.files.filter((file) => file.path !== filePath);
    }

    togglePlatform(platformKey) {
        const tab = this.getActivePublishTab();
        if (tab.selectedPlatforms.includes(platformKey)) {
            tab.selectedPlatforms = tab.selectedPlatforms.filter((item) => item !== platformKey);
        } else {
            tab.selectedPlatforms.push(platformKey);
        }
        this.filterSelectedAccountsByPlatforms(tab);
    }

    areAllPlatformsSelected() {
        const tab = this.getActivePublishTab();
        return tab.selectedPlatforms.length === this.platformOptions.length;
    }

    toggleAllPlatforms() {
        const tab = this.getActivePublishTab();
        tab.selectedPlatforms = this.areAllPlatformsSelected() ? [] : this.platformOptions.map((item) => item.key);
        this.filterSelectedAccountsByPlatforms(tab);
    }

    filterSelectedAccountsByPlatforms(tab) {
        tab.selectedAccounts = tab.selectedAccounts.filter((accountId) => {
            const account = this.state.accounts.find((item) => item.id === accountId);
            return account && tab.selectedPlatforms.includes(account.platform_key);
        });
    }

    includesPlatform(key) {
        return this.getActivePublishTab().selectedPlatforms.includes(key);
    }

    openAccountSelector() {
        const tab = this.getActivePublishTab();
        if (!tab.selectedPlatforms.length) {
            this.notify("请先选择平台", "warning");
            return;
        }
        this.state.tempSelectedAccounts = [...tab.selectedAccounts];
        this.state.modals.publishAccountSelector = true;
    }

    getSelectableAccounts() {
        const tab = this.getActivePublishTab();
        return this.state.accounts.filter((account) => tab.selectedPlatforms.includes(account.platform_key));
    }

    toggleTempAccount(accountId) {
        if (this.state.tempSelectedAccounts.includes(accountId)) {
            this.state.tempSelectedAccounts = this.state.tempSelectedAccounts.filter((item) => item !== accountId);
        } else {
            this.state.tempSelectedAccounts.push(accountId);
        }
    }

    confirmAccountSelection() {
        this.getActivePublishTab().selectedAccounts = [...this.state.tempSelectedAccounts];
        this.state.modals.publishAccountSelector = false;
        this.notify("账号选择已更新", "success");
    }

    removeSelectedAccount(accountId) {
        const tab = this.getActivePublishTab();
        tab.selectedAccounts = tab.selectedAccounts.filter((item) => item !== accountId);
    }

    getSelectedAccount(accountId) {
        return this.state.accounts.find((item) => item.id === accountId);
    }

    openTopicSelector() {
        this.state.topicInput = "";
        this.state.modals.publishTopicSelector = true;
    }

    addTopic(topic) {
        const value = (topic || this.state.topicInput).trim();
        if (!value) {
            this.notify("请输入话题内容", "warning");
            return;
        }
        const tab = this.getActivePublishTab();
        if (!tab.selectedTopics.includes(value)) {
            tab.selectedTopics.push(value);
            this.notify("话题添加成功", "success");
        } else {
            this.notify("话题已存在", "warning");
        }
        this.state.topicInput = "";
    }

    removeTopic(topic) {
        const tab = this.getActivePublishTab();
        tab.selectedTopics = tab.selectedTopics.filter((item) => item !== topic);
    }

    addDailyTime() {
        const tab = this.getActivePublishTab();
        tab.dailyTimes.push("18:00");
    }

    removeDailyTime(index) {
        const tab = this.getActivePublishTab();
        if (tab.dailyTimes.length <= 1) {
            return;
        }
        tab.dailyTimes.splice(index, 1);
    }

    formatFileSize(size) {
        return `${(size / 1024 / 1024).toFixed(2)} MB`;
    }

    getMaterialUploadSpeed(fileName) {
        return this.state.materialUploadProgress[fileName] ? this.state.materialUploadProgress[fileName].speed || "等待上传" : "等待上传";
    }

    getMaterialUploadPercentage(fileName) {
        return this.state.materialUploadProgress[fileName] ? this.state.materialUploadProgress[fileName].percentage || 0 : 0;
    }

    getSelectedAccountName(accountId) {
        const account = this.getSelectedAccount(accountId);
        return account ? account.name : `账号 ${accountId}`;
    }

    validatePublishTab(tab) {
        if (!tab.files.length) {
            throw new Error(`请先上传${tab.publishMode === "image" ? "图片" : "视频"}文件`);
        }
        if (!tab.title.trim()) {
            throw new Error("请输入标题");
        }
        if (!tab.selectedPlatforms.length) {
            throw new Error("请选择发布平台");
        }
        if (!tab.selectedAccounts.length) {
            throw new Error("请选择发布账号");
        }
    }

    async publishTab(tab) {
        this.validatePublishTab(tab);
        tab.publishing = true;
        tab.publishStatus = null;
        try {
            const materialIds = [...new Set(tab.files.map((file) => file.materialId).filter(Boolean))];
            for (const platformKey of tab.selectedPlatforms) {
                const accountIds = tab.selectedAccounts.filter((accountId) => {
                    const account = this.state.accounts.find((item) => item.id === accountId);
                    return account && account.platform_key === platformKey;
                });
                if (!accountIds.length) {
                    throw new Error(`请为 ${this.getPlatformLabelByKey(platformKey)} 至少选择一个账号`);
                }
                const payload = await rpc("/social_auto_publish_launcher/publish", {
                    payload: {
                        type: this.getPlatformTypeByKey(platformKey),
                        accountIds,
                        materialIds,
                        title: tab.title.trim(),
                        selectedTopics: [...tab.selectedTopics],
                        enableTimer: tab.scheduleEnabled,
                        videosPerDay: tab.scheduleEnabled ? tab.videosPerDay || 1 : 1,
                        dailyTimes: tab.scheduleEnabled ? [...tab.dailyTimes] : ["10:00"],
                        startDays: tab.scheduleEnabled ? Number(tab.startDays || 0) : 0,
                        category: 0,
                        publishMode: tab.publishMode,
                        productLink: platformKey === "douyin" ? tab.productLink.trim() : "",
                        productTitle: platformKey === "douyin" ? tab.productTitle.trim() : "",
                        isDraft: platformKey === "tencent" ? Boolean(tab.isDraft) : false,
                    },
                });
                if (payload?.code !== 200) {
                    throw new Error(payload?.msg || `${this.getPlatformLabelByKey(platformKey)} 发布失败`);
                }
            }
            tab.publishStatus = { type: "success", message: "发布任务已进入队列" };
            tab.files = [];
            tab.title = "";
            tab.selectedTopics = [];
            tab.selectedAccounts = [];
            tab.selectedPlatforms = [];
            tab.scheduleEnabled = false;
            tab.productLink = "";
            tab.productTitle = "";
            await this.loadBootstrap();
            this.notify(`${tab.label} 发布成功`, "success");
        } catch (error) {
            tab.publishStatus = { type: "error", message: `发布失败：${error.message || "请检查网络连接"}` };
            throw error;
        } finally {
            tab.publishing = false;
        }
    }

    async publishCurrentTab() {
        const tab = this.getActivePublishTab();
        try {
            await this.publishTab(tab);
        } catch (error) {
            this.notify(error.message || "发布失败", "danger");
        }
    }

    async batchPublish() {
        if (!this.state.publishTabs.length || this.state.batchPublishing) {
            return;
        }
        this.state.batchPublishing = true;
        this.state.batchProgress = 0;
        this.state.batchResults = [];
        this.state.currentPublishingLabel = "";
        this.state.modals.publishBatchProgress = true;
        for (let index = 0; index < this.state.publishTabs.length; index++) {
            const tab = this.state.publishTabs[index];
            this.state.currentPublishingLabel = tab.label;
            try {
                await this.publishTab(tab);
                this.state.batchResults.push({ label: tab.label, status: "success", message: "发布成功" });
            } catch (error) {
                this.state.batchResults.push({ label: tab.label, status: "error", message: error.message || "发布失败" });
            }
            this.state.batchProgress = Math.round(((index + 1) / this.state.publishTabs.length) * 100);
        }
        this.state.batchPublishing = false;
        this.notify("批量发布流程已执行完成", "success");
    }
}

registry.category("actions").add("social_auto_publish_launcher.main", SocialAutoPublishLauncherApp);
