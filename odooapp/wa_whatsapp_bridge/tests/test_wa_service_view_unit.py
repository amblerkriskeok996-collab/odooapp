from pathlib import Path
import ast
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
VIEW_PATH = ROOT / 'views' / 'wa_service_views.xml'
MENU_PATH = ROOT / 'views' / 'menus.xml'
MANIFEST_PATH = ROOT / '__manifest__.py'

class TestWaServiceViewUnit(unittest.TestCase):
    def test_removed_webhook_ai_and_runtime_logs_tabs(self):
        root = ET.parse(VIEW_PATH).getroot()
        page_labels = [page.attrib.get('string', '') for page in root.findall('.//page')]
        self.assertNotIn('Webhook/AI', page_labels)
        self.assertNotIn('Runtime Logs', page_labels)

    def test_embedded_portal_client_action_is_registered(self):
        root = ET.parse(VIEW_PATH).getroot()
        tags = [field.text for field in root.findall(".//record[@model='ir.actions.client']/field[@name='tag']")]
        self.assertIn('wa_whatsapp_bridge.portal', tags)

    def test_form_view_exposes_odoo_embedded_portal_button(self):
        root = ET.parse(VIEW_PATH).getroot()
        button_names = [button.attrib.get('name', '') for button in root.findall('.//button')]
        self.assertIn('action_open_embedded_portal', button_names)

    def test_menu_points_to_embedded_portal_action(self):
        root = ET.parse(MENU_PATH).getroot()
        actions = [item.attrib.get('action', '') for item in root.findall('.//menuitem')]
        self.assertIn('action_wa_embedded_portal', actions)

    def test_portal_menu_is_ordered_before_chats_menu(self):
        root = ET.parse(MENU_PATH).getroot()
        sequences = {
            item.attrib.get('id'): int(item.attrib.get('sequence', '0') or 0)
            for item in root.findall('.//menuitem')
        }
        self.assertLess(
            sequences['menu_wa_whatsapp_portal'],
            sequences['menu_wa_whatsapp_chats']
        )

    def test_manifest_declares_backend_assets(self):
        manifest = ast.literal_eval(MANIFEST_PATH.read_text(encoding='utf-8'))
        backend_assets = manifest.get('assets', {}).get('web.assets_backend', [])
        self.assertIn('wa_whatsapp_bridge/static/src/js/wa_portal_action.js', backend_assets)
        self.assertIn('wa_whatsapp_bridge/static/src/xml/wa_portal_action.xml', backend_assets)
        self.assertIn('wa_whatsapp_bridge/static/src/scss/wa_portal_action.scss', backend_assets)

    def test_portal_template_uses_scrollable_root_wrapper(self):
        template_path = ROOT / 'static' / 'src' / 'xml' / 'wa_portal_action.xml'
        template_text = template_path.read_text(encoding='utf-8')
        self.assertIn('o_wa_portal_root', template_text)

    def test_form_view_exposes_remote_api_base_url_field(self):
        root = ET.parse(VIEW_PATH).getroot()
        field_names = [field.attrib.get('name', '') for field in root.findall('.//field')]
        self.assertIn('api_base_url', field_names)

    def test_portal_scss_caps_qr_size_and_enables_scroll(self):
        scss_path = ROOT / 'static' / 'src' / 'scss' / 'wa_portal_action.scss'
        scss_text = scss_path.read_text(encoding='utf-8')
        self.assertIn('overflow-y: auto', scss_text)
        self.assertIn('height: calc(100vh - 2rem)', scss_text)
        self.assertIn('max-height: 14rem', scss_text)

    def test_chat_workspace_scss_enables_page_and_panel_scroll(self):
        scss_path = ROOT / 'static' / 'src' / 'scss' / 'wa_chat_workspace.scss'
        scss_text = scss_path.read_text(encoding='utf-8')
        self.assertIn('height: calc(100vh - 2rem)', scss_text)
        self.assertIn('overflow-y: auto', scss_text)
        self.assertNotIn('overflow: hidden;', scss_text.split('.o_wa_chat_root {', 1)[1].split('}', 1)[0])

if __name__ == '__main__':
    unittest.main()
