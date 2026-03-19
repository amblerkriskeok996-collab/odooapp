import importlib.util
import sys
import types
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "models" / "wa_chat_workspace.py"


def _load_workspace_module():
    module_name = "wa_chat_workspace_unit_under_test"
    for name in (
        module_name,
        "odoo",
        "odoo.exceptions",
    ):
        sys.modules.pop(name, None)

    def _decorator(*args, **kwargs):
        def _wrap(func):
            return func

        return _wrap

    class _DummyApi:
        depends = staticmethod(_decorator)

        @staticmethod
        def model(func):
            return func

    odoo_module = types.ModuleType("odoo")
    odoo_module._ = lambda value: value
    odoo_module.api = _DummyApi()
    odoo_module.models = types.SimpleNamespace(AbstractModel=object)

    exceptions_module = types.ModuleType("odoo.exceptions")

    class UserError(Exception):
        pass

    exceptions_module.UserError = UserError

    sys.modules["odoo"] = odoo_module
    sys.modules["odoo.exceptions"] = exceptions_module

    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class TestWaChatWorkspaceUnit(unittest.TestCase):
    def test_parse_env_text_reads_key_values_and_skips_comments(self):
        module = _load_workspace_module()
        text = "# comment\nPGHOST=10.0.0.8\nPGPORT=5432\n\nPGDATABASE=sakana\n"
        parsed = module.WaChatWorkspace._parse_env_text(text)
        self.assertEqual(
            parsed,
            {"PGHOST": "10.0.0.8", "PGPORT": "5432", "PGDATABASE": "sakana"},
        )

    def test_chat_name_prefers_group_name_for_group_chats(self):
        module = _load_workspace_module()
        name = module.WaChatWorkspace._chat_name_from_values(
            "group", "Project Group", "Alice", "13800000000", "1203630@g.us"
        )
        self.assertEqual(name, "Project Group")

    def test_chat_name_falls_back_to_sender_or_chat_jid_for_private_chats(self):
        module = _load_workspace_module()
        name = module.WaChatWorkspace._chat_name_from_values(
            "private", "", "", "13800000000", "13800000000@c.us"
        )
        self.assertEqual(name, "13800000000")

    def test_private_chat_name_does_not_use_self_name_for_outbound_latest_message(self):
        module = _load_workspace_module()
        name = module.WaChatWorkspace._private_chat_name(
            chat_jid="135704491339834@lid",
            contact_name="",
            contact_phone="",
            latest_sender_name="oisuku",
            latest_sender_phone="8615215092966",
        )
        self.assertEqual(name, "135704491339834")

    def test_chat_visibility_filters_status_broadcast_stream(self):
        module = _load_workspace_module()
        self.assertFalse(module.WaChatWorkspace._is_visible_chat("status@broadcast", "private"))
        self.assertTrue(module.WaChatWorkspace._is_visible_chat("135704491339834@lid", "private"))

    def test_workspace_bootstrap_returns_empty_data_when_listener_not_ready(self):
        module = _load_workspace_module()

        class _StubWorkspace:
            def _get_listener_status(self):
                return {"status": "qr_required", "detail": "Scan to login"}

            def _fetch_chat_rows(self, limit=80):
                raise AssertionError("chat rows should not be fetched before listener is ready")

            def _fetch_message_rows(self, chat_jid, limit=200):
                raise AssertionError("message rows should not be fetched before listener is ready")

        payload = module.WaChatWorkspace.get_workspace_bootstrap(_StubWorkspace())

        self.assertEqual(payload["portal_state"], "qr_required")
        self.assertEqual(payload["portal_detail"], "Scan to login")
        self.assertEqual(payload["chats"], [])
        self.assertEqual(payload["messages"], [])
        self.assertEqual(payload["selected_chat_jid"], "")
        self.assertIsNone(payload["selected_chat"])

    def test_workspace_bootstrap_loads_messages_only_when_listener_ready(self):
        module = _load_workspace_module()

        class _StubWorkspace:
            def _get_listener_status(self):
                return {"status": "ready", "detail": "Connected"}

            def _fetch_chat_rows(self, limit=80):
                return [
                    {
                        "chat_jid": "86123@c.us",
                        "chat_name": "Alice",
                        "chat_type": "private",
                        "last_message_text": "hi",
                        "last_message_time": "2026-03-19T10:00:00",
                        "from_me": False,
                        "sender_name": "Alice",
                        "sender_phone": "86123",
                        "group_name": "",
                        "unread_count": 0,
                    }
                ]

            def _fetch_message_rows(self, chat_jid, limit=200):
                return [{"id": 1, "chat_jid": chat_jid, "message_text": "hi", "from_me": False}]

        payload = module.WaChatWorkspace.get_workspace_bootstrap(_StubWorkspace())

        self.assertEqual(payload["portal_state"], "ready")
        self.assertEqual(len(payload["chats"]), 1)
        self.assertEqual(payload["selected_chat_jid"], "86123@c.us")
        self.assertEqual(payload["messages"][0]["chat_jid"], "86123@c.us")


if __name__ == "__main__":
    unittest.main()
