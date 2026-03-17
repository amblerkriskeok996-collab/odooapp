from pathlib import Path

from odoo.tests import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestSocialAutoPublishAutomationModels(TransactionCase):
    def test_automation_task_can_store_logs(self):
        task = self.env["social.publish.automation.task"].create({
            "name": "login demo",
            "task_type": "login",
            "status": "pending",
            "platform_key": "douyin",
            "platform_type": 3,
            "account_name": "demo",
        })

        task.add_event("started", "worker started")
        task.add_event("qr_emitted", "qr ready")

        self.assertEqual(task.log_ids.mapped("event_code"), ["started", "qr_emitted"])
        self.assertIn("worker started", task.log_text)

    def test_account_unlink_cleans_runtime_cookie_file(self):
        account = self.env["social.publish.account"].create({
            "name": "cleanup-demo",
            "platform_key": "douyin",
            "platform_type": 3,
            "status": "normal",
            "cookie_json": "{}",
        })

        runtime_path = Path("D:/code/programs/social-auto-upload/cookiesFile") / f"odoo_runtime_cookie_{account.id}.json"
        runtime_path.parent.mkdir(parents=True, exist_ok=True)
        runtime_path.write_text("{}", encoding="utf-8")

        self.assertTrue(runtime_path.exists())
        account.unlink()
        self.assertFalse(runtime_path.exists())
