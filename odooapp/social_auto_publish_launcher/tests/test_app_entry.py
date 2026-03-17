from odoo.tests import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestSocialAutoPublishLauncherAppEntry(TransactionCase):
    def test_standalone_app_entry_exists(self):
        module = self.env["ir.module.module"].search(
            [("name", "=", "social_auto_publish_launcher")],
            limit=1,
        )

        self.assertTrue(module)
        self.assertTrue(module.application)
        self.assertIn("base", module.dependencies_id.mapped("name"))
        self.assertIn("web", module.dependencies_id.mapped("name"))

        root_menu = self.env.ref("social_auto_publish_launcher.menu_social_auto_publish_root")
        child_menu = self.env.ref("social_auto_publish_launcher.menu_social_auto_publish_center")
        action = self.env.ref("social_auto_publish_launcher.action_social_auto_publish_launcher_client")

        self.assertFalse(root_menu.parent_id)
        self.assertEqual(
            root_menu.web_icon,
            "social_auto_publish_launcher,static/description/icon.png",
        )
        self.assertEqual(root_menu.name, "自媒体自动化运营系统")
        self.assertEqual(child_menu.parent_id, root_menu)
        self.assertEqual(child_menu.name, "发布中心")
        self.assertEqual(child_menu.action._name, "ir.actions.client")
        self.assertEqual(child_menu.action.id, action.id)
        self.assertEqual(action.name, "发布中心")
        self.assertEqual(action.type, "ir.actions.client")
        self.assertEqual(action.tag, "social_auto_publish_launcher.main")
        self.assertEqual(action.target, "current")
