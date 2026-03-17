import logging
from pathlib import Path

from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)

SOURCE_PROJECT_DIR = Path(__file__).resolve().parents[3] / "social-auto-upload"
RUNTIME_COOKIE_PREFIX = "odoo_runtime_cookie_"

PLATFORM_SELECTION = [
    ("xiaohongshu", "小红书"),
    ("tencent", "视频号"),
    ("douyin", "抖音"),
    ("kuaishou", "快手"),
    ("bilibili", "哔哩哔哩"),
    ("toutiao", "今日头条"),
    ("zhihu", "知乎"),
    ("weibo", "微博"),
    ("sohu", "搜狐新闻"),
    ("tencent_news", "腾讯新闻"),
]


PLATFORM_TYPE_MAP = {
    "xiaohongshu": 1,
    "tencent": 2,
    "douyin": 3,
    "kuaishou": 4,
    "bilibili": 5,
    "toutiao": 6,
    "zhihu": 7,
    "weibo": 8,
    "sohu": 9,
    "tencent_news": 10,
}


TYPE_PLATFORM_MAP = {value: key for key, value in PLATFORM_TYPE_MAP.items()}


class SocialPublishAccount(models.Model):
    _name = "social.publish.account"
    _description = "Social Publish Account"
    _order = "id desc"

    name = fields.Char(required=True, index=True)
    platform_key = fields.Selection(PLATFORM_SELECTION, required=True, default="douyin", index=True)
    platform_type = fields.Integer(required=True, index=True, default=3)
    platform_label = fields.Char(compute="_compute_platform_label", store=True, readonly=True)
    status = fields.Selection(
        [("normal", "正常"), ("abnormal", "异常")],
        required=True,
        default="abnormal",
    )
    cookie_filename = fields.Char(index=True)
    cookie_json = fields.Text()
    last_validated_at = fields.Datetime()
    last_login_task_id = fields.Many2one("social.publish.automation.task", readonly=True)
    last_publish_task_id = fields.Many2one("social.publish.automation.task", readonly=True)
    last_login_error = fields.Text()
    note = fields.Text()
    active = fields.Boolean(default=True, index=True)

    @api.depends("platform_key")
    def _compute_platform_label(self):
        label_map = dict(PLATFORM_SELECTION)
        for record in self:
            record.platform_label = label_map.get(record.platform_key, "")

    @api.model_create_multi
    def create(self, vals_list):
        normalized_list = []
        for vals in vals_list:
            next_vals = dict(vals)
            self._normalize_platform_vals(next_vals)
            normalized_list.append(next_vals)
        return super().create(normalized_list)

    def write(self, vals):
        next_vals = dict(vals)
        self._normalize_platform_vals(next_vals)
        return super().write(next_vals)

    @classmethod
    def platform_key_from_type(cls, platform_type):
        return TYPE_PLATFORM_MAP.get(int(platform_type or 0), "")

    @classmethod
    def platform_type_from_key(cls, platform_key):
        return PLATFORM_TYPE_MAP.get(platform_key, 0)

    @classmethod
    def platform_label_from_key(cls, platform_key):
        return dict(PLATFORM_SELECTION).get(platform_key, "")

    @classmethod
    def platform_label_from_type(cls, platform_type):
        return cls.platform_label_from_key(cls.platform_key_from_type(platform_type))

    def _normalize_platform_vals(self, vals):
        if "platform_type" in vals and "platform_key" not in vals:
            vals["platform_key"] = self.platform_key_from_type(vals["platform_type"]) or "douyin"
        if "platform_key" in vals and "platform_type" not in vals:
            vals["platform_type"] = self.platform_type_from_key(vals["platform_key"])

    @api.constrains("platform_type", "platform_key")
    def _check_platform_mapping(self):
        for record in self:
            expected_key = self.platform_key_from_type(record.platform_type)
            if not expected_key:
                raise ValidationError("Unsupported platform_type value.")
            if expected_key != record.platform_key:
                raise ValidationError("platform_type and platform_key are inconsistent.")

    @api.constrains("name", "platform_type")
    def _check_name_platform_unique(self):
        for record in self:
            domain = [("id", "!=", record.id), ("name", "=", record.name), ("platform_type", "=", record.platform_type)]
            if self.search_count(domain):
                raise ValidationError("Duplicate account name for the same platform is not allowed.")

    @api.constrains("cookie_filename")
    def _check_cookie_filename(self):
        for record in self:
            if record.cookie_filename and not record.cookie_filename.endswith(".json"):
                raise ValidationError("cookie_filename must end with .json")

    @classmethod
    def create_from_login_result(cls, env, *, platform_type, user_name, cookie_filename, cookie_json):
        platform_key = cls.platform_key_from_type(platform_type)
        vals = {
            "name": user_name,
            "platform_key": platform_key,
            "platform_type": int(platform_type),
            "cookie_filename": cookie_filename,
            "cookie_json": cookie_json,
            "status": "normal",
            "last_login_error": False,
            "last_validated_at": fields.Datetime.now(),
        }
        account_model = env["social.publish.account"].sudo()
        record = account_model.search(
            [("name", "=", user_name), ("platform_type", "=", int(platform_type))],
            limit=1,
        )
        if record:
            record.write(vals)
        else:
            record = account_model.create(vals)
        return record

    def unlink(self):
        runtime_paths = []
        cookies_dir = SOURCE_PROJECT_DIR / "cookiesFile"
        for record in self:
            runtime_path = cookies_dir / f"{RUNTIME_COOKIE_PREFIX}{record.id}.json"
            runtime_paths.append(runtime_path)
        result = super().unlink()
        for runtime_path in runtime_paths:
            try:
                if runtime_path.exists():
                    runtime_path.unlink()
            except OSError as error:
                _logger.warning("Failed to cleanup runtime cookie %s: %s", runtime_path, error)
        return result

    def to_frontend_dict(self):
        self.ensure_one()
        return {
            "id": self.id,
            "type": self.platform_type,
            "platform_key": self.platform_key,
            "platform": self.platform_label,
            "name": self.name,
            "status": "正常" if self.status == "normal" else "异常",
            "filePath": self.cookie_filename or "",
            "lastValidatedAt": self.last_validated_at.isoformat() if self.last_validated_at else None,
            "lastLoginTaskId": self.last_login_task_id.id if self.last_login_task_id else None,
            "lastPublishTaskId": self.last_publish_task_id.id if self.last_publish_task_id else None,
            "lastLoginError": self.last_login_error or "",
        }
