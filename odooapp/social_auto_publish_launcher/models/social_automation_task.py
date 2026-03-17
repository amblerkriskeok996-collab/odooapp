import json

from odoo import fields, models


class SocialPublishAutomationTask(models.Model):
    _name = "social.publish.automation.task"
    _description = "Social Publish Automation Task"
    _order = "id desc"

    name = fields.Char(required=True)
    task_type = fields.Selection(
        [("login", "Login"), ("publish", "Publish"), ("cleanup", "Cleanup")],
        required=True,
        index=True,
    )
    status = fields.Selection(
        [
            ("pending", "Pending"),
            ("running", "Running"),
            ("qr_ready", "QR Ready"),
            ("success", "Success"),
            ("failed", "Failed"),
            ("cleaned", "Cleaned"),
        ],
        required=True,
        default="pending",
        index=True,
    )
    platform_key = fields.Char(index=True)
    platform_type = fields.Integer(index=True)
    account_id = fields.Many2one("social.publish.account", ondelete="set null", index=True)
    account_name = fields.Char(index=True)
    log_ids = fields.One2many("social.publish.automation.task.log", "task_id")
    payload_json = fields.Text()
    log_text = fields.Text()
    error_message = fields.Text()
    started_at = fields.Datetime(default=fields.Datetime.now)
    qr_emitted_at = fields.Datetime()
    browser_started_at = fields.Datetime()
    finished_at = fields.Datetime()
    cleanup_at = fields.Datetime()
    active = fields.Boolean(default=True, index=True)

    def append_log(self, message):
        for record in self:
            lines = [record.log_text] if record.log_text else []
            lines.append(message)
            record.log_text = "\n".join(lines)

    def add_event(self, event_code, message):
        log_model = self.env["social.publish.automation.task.log"].sudo()
        for record in self:
            log_model.create({
                "task_id": record.id,
                "event_code": event_code,
                "message": message,
            })
            record.append_log(message)

    def to_frontend_dict(self):
        self.ensure_one()
        payload_data = {}
        if self.payload_json:
            try:
                payload_data = json.loads(self.payload_json)
            except Exception:
                payload_data = {}
        return {
            "id": self.id,
            "name": self.name,
            "task_type": self.task_type,
            "status": self.status,
            "platform_key": self.platform_key,
            "platform_type": self.platform_type,
            "account_id": self.account_id.id if self.account_id else None,
            "account_name": self.account_name or "",
            "error_message": self.error_message or "",
            "log_text": self.log_text or "",
            "payload": payload_data,
            "started_at": fields.Datetime.to_string(self.started_at) if self.started_at else None,
            "qr_emitted_at": fields.Datetime.to_string(self.qr_emitted_at) if self.qr_emitted_at else None,
            "browser_started_at": fields.Datetime.to_string(self.browser_started_at) if self.browser_started_at else None,
            "finished_at": fields.Datetime.to_string(self.finished_at) if self.finished_at else None,
            "cleanup_at": fields.Datetime.to_string(self.cleanup_at) if self.cleanup_at else None,
            "logs": [log.to_frontend_dict() for log in self.log_ids],
        }
