import importlib.util
import sys
import types
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "controllers" / "main.py"


def _load_controller_module():
    module_name = "wa_portal_controller_unit_under_test"
    for name in (module_name, "odoo", "odoo.http"):
        sys.modules.pop(name, None)

    class _DummyController:
        pass

    def _route(*args, **kwargs):
        def _wrap(func):
            return func
        return _wrap

    odoo_module = types.ModuleType("odoo")
    http_module = types.ModuleType("odoo.http")
    http_module.Controller = _DummyController
    http_module.route = _route
    http_module.request = types.SimpleNamespace(env=None)
    odoo_module.http = http_module

    sys.modules["odoo"] = odoo_module
    sys.modules["odoo.http"] = http_module

    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class TestWaPortalControllerUnit(unittest.TestCase):
    def test_normalize_remote_status_maps_listener_payload(self):
        module = _load_controller_module()
        payload = {
            "ok": True,
            "data": {
                "status": "qr_required",
                "detail": "Scan from phone",
                "waState": "OPENING",
                "account": {"wid": "86123@c.us", "pushName": "Alice"},
                "rebindInProgress": True,
            },
        }

        result = module.normalize_remote_status(payload)

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["portalState"], "qr_required")
        self.assertEqual(result["data"]["detail"], "Scan from phone")
        self.assertEqual(result["data"]["waState"], "OPENING")
        self.assertEqual(result["data"]["account"]["wid"], "86123@c.us")
        self.assertTrue(result["data"]["accountSwitchInProgress"])

    def test_normalize_remote_qr_builds_qr_data_url(self):
        module = _load_controller_module()
        payload = {
            "ok": True,
            "data": {
                "available": True,
                "qr": "HELLO-QR",
            },
        }

        result = module.normalize_remote_qr(payload)

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["qrText"], "HELLO-QR")
        self.assertTrue(result["data"]["qrDataUrl"].startswith("data:image/svg+xml;base64,"))

    def test_normalize_remote_action_accepts_rebind_response(self):
        module = _load_controller_module()
        payload = {"ok": True, "data": {"accepted": True}}

        result = module.normalize_remote_action(payload)

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["accepted"], True)


if __name__ == "__main__":
    unittest.main()
