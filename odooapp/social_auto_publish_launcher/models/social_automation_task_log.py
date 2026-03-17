from odoo import fields, models


class SocialPublishAutomationTaskLog(models.Model):
    _name = "social.publish.automation.task.log"
    _description = "Social Publish Automation Task Log"
    _order = "id asc"

    task_id = fields.Many2one(
        "social.publish.automation.task",
        required=True,
        ondelete="cascade",
        index=True,
    )
    event_code = fields.Char(required=True, index=True)
    message = fields.Text(required=True)
    created_at = fields.Datetime(default=fields.Datetime.now, required=True, index=True)

    def to_frontend_dict(self):
        self.ensure_one()
        return {
            "id": self.id,
            "event_code": self.event_code,
            "message": self.message,
            "created_at": fields.Datetime.to_string(self.created_at),
        }
