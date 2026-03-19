import unittest
from pathlib import Path


MODULE_ROOT = Path(__file__).resolve().parents[1]
JS_PATH = MODULE_ROOT / "static" / "src" / "js" / "wa_portal_action.js"
XML_PATH = MODULE_ROOT / "static" / "src" / "xml" / "wa_portal_action.xml"


class TestWaPortalFrontendUnit(unittest.TestCase):
    def test_portal_action_redirects_to_chat_workspace_when_ready(self):
        source = JS_PATH.read_text(encoding="utf-8")

        self.assertIn('useService("action")', source)
        self.assertIn('tag: "wa_whatsapp_bridge.chat_workspace"', source)
        self.assertIn('type: "ir.actions.client"', source)
        self.assertIn("scheduleReadyRedirect", source)

    def test_portal_template_contains_success_state_copy(self):
        template = XML_PATH.read_text(encoding="utf-8")

        self.assertIn("登录成功，正在进入聊天页面", template)
        self.assertIn("o_wa_portal_success", template)


if __name__ == "__main__":
    unittest.main()
