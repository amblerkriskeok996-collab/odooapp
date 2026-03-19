import importlib.util
import sys
import types
import unittest
from unittest import mock
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "models" / "wa_service.py"

class _DummyFieldFactory:
    def __call__(self, *args, **kwargs):
        return None
    @staticmethod
    def now():
        return "now"

def _load_wa_service_module():
    module_name = "wa_service_unit_under_test"
    for name in (module_name, "odoo", "odoo.exceptions", "odoo.tools"):
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

    class _DummyFields:
        Char = staticmethod(lambda *args, **kwargs: None)
        Boolean = staticmethod(lambda *args, **kwargs: None)
        Selection = staticmethod(lambda *args, **kwargs: None)
        Integer = staticmethod(lambda *args, **kwargs: None)
        Text = staticmethod(lambda *args, **kwargs: None)
        Datetime = _DummyFieldFactory()

    odoo_module = types.ModuleType("odoo")
    odoo_module._ = lambda value: value
    odoo_module.api = _DummyApi()
    odoo_module.fields = _DummyFields()
    odoo_module.models = types.SimpleNamespace(Model=object)

    exceptions_module = types.ModuleType("odoo.exceptions")
    class UserError(Exception):
        pass
    exceptions_module.UserError = UserError

    tools_module = types.ModuleType("odoo.tools")
    tools_module.config = {}

    sys.modules["odoo"] = odoo_module
    sys.modules["odoo.exceptions"] = exceptions_module
    sys.modules["odoo.tools"] = tools_module

    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module

class _StubServiceRecord:
    def __init__(self, runtime_dir):
        self._runtime_dir_path = runtime_dir
        self.install_calls = []
    def ensure_one(self):
        return None
    def _runtime_dir(self):
        return self._runtime_dir_path
    def _run_npm_install(self, packages=None, no_save=False):
        self.install_calls.append({"packages": packages, "no_save": no_save})

class _StubInstallRecord:
    def __init__(self, module):
        self.module = module
        self.write_calls = []
    def ensure_one(self):
        return None
    def _runtime_dir(self):
        return self.module.Path("D:/fake/runtime")
    def _resolve_binaries(self):
        return "node", "npm"
    def _build_runtime_env(self):
        return {"TEST_ENV": "1"}
    def write(self, values):
        self.write_calls.append(values)

class _StubPortalRecord:
    def __init__(self, port=3000, record_id=7, name='Portal', api_base_url='http://10.168.2.103:3000/'):
        self.port = port
        self.id = record_id
        self.name = name
        self.api_base_url = api_base_url
    def ensure_one(self):
        return None
    def get_runtime_base_url(self):
        normalized = str(self.api_base_url or "").strip().rstrip("/")
        if normalized:
            return normalized
        return f"http://127.0.0.1:{self.port}"

class TestWaServiceRuntimeUnit(unittest.TestCase):
    def test_ensure_dependencies_installs_runtime_packages_after_fresh_install(self):
        module = _load_wa_service_module()
        runtime_dir = module.Path("D:/fake/runtime")
        record = _StubServiceRecord(runtime_dir)
        def _fake_exists(path_self):
            normalized = str(path_self).replace("\\", "/")
            if normalized.endswith("/node_modules"):
                return bool(record.install_calls)
            if normalized.endswith("/node_modules/dotenv"):
                return False
            return True
        with mock.patch.object(module.Path, "exists", autospec=True, side_effect=_fake_exists):
            module.WaServiceInstance._ensure_dependencies(record)
        self.assertEqual(record.install_calls, [{"packages": None, "no_save": False}, {"packages": ["dotenv"], "no_save": True}])

    def test_ensure_dependencies_installs_missing_runtime_packages_into_existing_node_modules(self):
        module = _load_wa_service_module()
        runtime_dir = module.Path("D:/fake/runtime")
        record = _StubServiceRecord(runtime_dir)
        def _fake_exists(path_self):
            normalized = str(path_self).replace("\\", "/")
            if normalized.endswith("/node_modules"):
                return True
            if normalized.endswith("/node_modules/dotenv"):
                return False
            return True
        with mock.patch.object(module.Path, "exists", autospec=True, side_effect=_fake_exists):
            module.WaServiceInstance._ensure_dependencies(record)
        self.assertEqual(record.install_calls, [{"packages": ["dotenv"], "no_save": True}])

    def test_ensure_dependencies_skips_install_when_runtime_packages_exist(self):
        module = _load_wa_service_module()
        runtime_dir = module.Path("D:/fake/runtime")
        record = _StubServiceRecord(runtime_dir)
        with mock.patch.object(module.Path, "exists", autospec=True, return_value=True):
            module.WaServiceInstance._ensure_dependencies(record)
        self.assertEqual(record.install_calls, [])

    def test_run_npm_install_uses_no_save_for_runtime_package_top_up(self):
        module = _load_wa_service_module()
        record = _StubInstallRecord(module)
        completed_process = types.SimpleNamespace(returncode=0, stderr="", stdout="")
        with mock.patch.object(module.subprocess, "run", return_value=completed_process) as subprocess_run:
            module.WaServiceInstance._run_npm_install(record, packages=["dotenv"], no_save=True)
        self.assertEqual(subprocess_run.call_args.args[0], ["npm", "install", "--no-save", "dotenv"])

    def test_get_runtime_base_url_prefers_remote_api_base_url(self):
        module = _load_wa_service_module()
        record = _StubPortalRecord(port=3141)
        self.assertEqual(module.WaServiceInstance.get_runtime_base_url(record), 'http://10.168.2.103:3000')

    def test_get_runtime_base_url_falls_back_to_port_when_remote_url_missing(self):
        module = _load_wa_service_module()
        record = _StubPortalRecord(port=3141, api_base_url='')
        self.assertEqual(module.WaServiceInstance.get_runtime_base_url(record), 'http://127.0.0.1:3141')

    def test_is_pid_running_returns_false_on_windows_systemerror(self):
        module = _load_wa_service_module()
        with mock.patch.object(module.os, "kill", side_effect=SystemError("winerror 87")):
            self.assertFalse(module.WaServiceInstance._is_pid_running(1504))

    def test_action_open_embedded_portal_returns_record_bound_client_action(self):
        module = _load_wa_service_module()
        record = _StubPortalRecord(port=3000, record_id=9, name='WA Main')
        result = module.WaServiceInstance.action_open_embedded_portal(record)
        self.assertEqual(result['type'], 'ir.actions.client')
        self.assertEqual(result['tag'], 'wa_whatsapp_bridge.portal')
        self.assertEqual(result['params']['instance_id'], 9)
        self.assertEqual(result['params']['instance_name'], 'WA Main')

    def test_action_open_portal_uses_remote_api_base_url(self):
        module = _load_wa_service_module()
        record = _StubPortalRecord(api_base_url='http://10.168.2.103:3000/')
        result = module.WaServiceInstance.action_open_portal(record)
        self.assertEqual(result['url'], 'http://10.168.2.103:3000')

if __name__ == "__main__":
    unittest.main()
