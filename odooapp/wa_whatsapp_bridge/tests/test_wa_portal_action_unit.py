from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
JS_PATH = ROOT / "static" / "src" / "js" / "wa_portal_action.js"
XML_PATH = ROOT / "static" / "src" / "xml" / "wa_portal_action.xml"


class TestWaPortalActionUnit(unittest.TestCase):
    def test_portal_action_contains_ready_redirect_logic(self):
        js_text = JS_PATH.read_text(encoding="utf-8")
        self.assertIn('setTimeout(() => {', js_text)
        self.assertIn('clearTimeout(this.readyRedirectHandle)', js_text)
        self.assertIn('type: "ir.actions.client"', js_text)
        self.assertIn('tag: "wa_whatsapp_bridge.chat_workspace"', js_text)

    def test_portal_template_renders_ready_success_state(self):
        xml_text = XML_PATH.read_text(encoding="utf-8")
        self.assertIn('t-if="state.readySuccessVisible"', xml_text)
        self.assertIn("登录成功，正在进入聊天页面", xml_text)
        self.assertIn("o_wa_portal_success", xml_text)
        self.assertIn('text-success', xml_text)


if __name__ == "__main__":
    unittest.main()
