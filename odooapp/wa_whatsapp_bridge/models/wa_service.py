from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import config


RUNTIME_NODE_PACKAGES = ("dotenv",)
DEFAULT_REMOTE_API_BASE_URL = "http://10.168.2.103:3000"


class WaServiceInstance(models.Model):
    _name = "wa.service.instance"
    _description = "WhatsApp Auto Reply Service"
    _order = "id desc"

    name = fields.Char(required=True, default="WhatsApp Auto Reply")
    active = fields.Boolean(default=True)
    state = fields.Selection(
        [("stopped", "Stopped"), ("running", "Running"), ("error", "Error")],
        default="stopped",
        readonly=True,
    )
    port = fields.Integer(default=3000, required=True)
    api_base_url = fields.Char(
        default=DEFAULT_REMOTE_API_BASE_URL,
        help="Remote WhatsApp listener control API base URL.",
    )
    n8n_webhook_url = fields.Char(
        default="http://127.0.0.1:3000/webhook/whatsapp-workflow",
        help="Incoming WhatsApp messages will be forwarded to this webhook URL.",
    )
    auto_send_webhook_reply = fields.Boolean(default=True)

    ai_base_url = fields.Char(string="AI Base URL")
    ai_api_key = fields.Char(string="AI API Key")
    ai_model = fields.Char(string="AI Model")
    ai_timeout_ms = fields.Integer(default=30000)
    rag_api_url = fields.Char(default="http://127.0.0.1:18080")
    rag_top_k = fields.Integer(default=10)

    wa_use_system_chrome = fields.Boolean(default=True)
    wa_use_library_default_ua = fields.Boolean(default=False)

    node_binary = fields.Char(default="node")
    npm_binary = fields.Char(default="npm")
    extra_env_json = fields.Text(
        string="Extra ENV JSON",
        help='Optional extra environment variables, e.g. {"FOO":"bar"}',
    )

    runtime_path = fields.Char(compute="_compute_runtime_path", readonly=True)
    pid = fields.Integer(readonly=True)
    log_file = fields.Char(readonly=True)
    started_at = fields.Datetime(readonly=True)
    last_error = fields.Text(readonly=True)
    log_tail = fields.Text(compute="_compute_log_tail", readonly=True)

    @api.depends()
    def _compute_runtime_path(self):
        runtime = self._runtime_dir()
        for rec in self:
            rec.runtime_path = str(runtime)

    @api.depends("log_file")
    def _compute_log_tail(self):
        for rec in self:
            rec.log_tail = rec._read_log_tail_text()

    @api.model
    def _module_root(self) -> Path:
        return Path(__file__).resolve().parents[1]

    @api.model
    def _runtime_dir(self) -> Path:
        runtime = self._module_root() / "node_runtime" / "whatsapp"
        if not runtime.exists():
            raise UserError(
                _(
                    "WhatsApp runtime directory does not exist: %s. "
                    "Please confirm module files were copied correctly."
                )
                % runtime
            )
        return runtime

    @api.model
    def _service_data_dir(self) -> Path:
        data_dir = config.get("data_dir")
        if data_dir:
            root = Path(data_dir)
        else:
            root = self._module_root() / ".wa_runtime"
        target = root / "wa_whatsapp_bridge"
        target.mkdir(parents=True, exist_ok=True)
        return target

    def _pid_file_path(self) -> Path:
        self.ensure_one()
        return self._service_data_dir() / f"service_{self.id}.pid"

    def _log_file_path(self) -> Path:
        self.ensure_one()
        return self._service_data_dir() / f"service_{self.id}.log"

    @staticmethod
    def _is_pid_running(pid: int) -> bool:
        if not pid:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return False
        except SystemError:
            return False
        return True

    def _resolve_binaries(self) -> tuple[str, str]:
        self.ensure_one()
        node = shutil.which(self.node_binary or "node")
        npm = shutil.which(self.npm_binary or "npm")
        if not node:
            raise UserError(_("Node.js binary not found. Current value: %s") % (self.node_binary or "node"))
        if not npm:
            raise UserError(_("NPM binary not found. Current value: %s") % (self.npm_binary or "npm"))
        return node, npm

    def _build_runtime_env(self) -> dict[str, str]:
        self.ensure_one()
        env = os.environ.copy()
        env["SERVER_PORT"] = str(self.port)
        env["N8N_WEBHOOK_URL"] = self.n8n_webhook_url or f"http://127.0.0.1:{self.port}/webhook/whatsapp-workflow"
        env["AUTO_SEND_WEBHOOK_REPLY"] = "true" if self.auto_send_webhook_reply else "false"
        env["AI_BASE_URL"] = self.ai_base_url or ""
        env["AI_API_KEY"] = self.ai_api_key or ""
        env["AI_MODEL"] = self.ai_model or ""
        env["AI_TIMEOUT_MS"] = str(self.ai_timeout_ms or 30000)
        env["RAG_API_URL"] = self.rag_api_url or ""
        env["RAG_TOP_K"] = str(self.rag_top_k or 10)
        env["WA_USE_SYSTEM_CHROME"] = "true" if self.wa_use_system_chrome else "false"
        env["WA_USE_LIBRARY_DEFAULT_UA"] = "true" if self.wa_use_library_default_ua else "false"
        env["PUPPETEER_SKIP_DOWNLOAD"] = env.get("PUPPETEER_SKIP_DOWNLOAD", "1")

        if self.extra_env_json:
            try:
                extra = json.loads(self.extra_env_json)
            except json.JSONDecodeError as exc:
                raise UserError(_("Extra ENV JSON is invalid: %s") % exc) from exc
            if not isinstance(extra, dict):
                raise UserError(_("Extra ENV JSON must be a JSON object"))
            for key, value in extra.items():
                env[str(key)] = "" if value is None else str(value)
        return env

    def _read_pid_from_file(self) -> int:
        self.ensure_one()
        pid_file = self._pid_file_path()
        if not pid_file.exists():
            return 0
        try:
            return int(pid_file.read_text(encoding="utf-8").strip() or 0)
        except (ValueError, OSError):
            return 0

    def _write_pid_file(self, pid: int) -> None:
        self.ensure_one()
        self._pid_file_path().write_text(str(pid), encoding="utf-8")

    def _unlink_pid_file(self) -> None:
        self.ensure_one()
        pid_file = self._pid_file_path()
        if pid_file.exists():
            pid_file.unlink(missing_ok=True)

    def _read_log_tail_text(self, max_bytes: int = 12000) -> str:
        self.ensure_one()
        log_path = Path(self.log_file) if self.log_file else self._log_file_path()
        if not log_path.exists():
            return ""
        with log_path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            seek_pos = max(0, size - max_bytes)
            fh.seek(seek_pos, os.SEEK_SET)
            data = fh.read()
        return data.decode("utf-8", errors="ignore")

    def _ensure_dependencies(self) -> None:
        self.ensure_one()
        runtime = self._runtime_dir()
        node_modules = runtime / "node_modules"
        if not node_modules.exists():
            self._run_npm_install()
        missing_packages = WaServiceInstance._get_missing_runtime_packages(node_modules)
        if missing_packages:
            self._run_npm_install(packages=missing_packages, no_save=True)

    @staticmethod
    def _get_missing_runtime_packages(node_modules: Path) -> list[str]:
        missing_packages = []
        for package_name in RUNTIME_NODE_PACKAGES:
            package_path = node_modules.joinpath(*package_name.split("/"))
            if not package_path.exists():
                missing_packages.append(package_name)
        return missing_packages

    def _run_npm_install(self, packages: list[str] | tuple[str, ...] | None = None, no_save: bool = False) -> None:
        self.ensure_one()
        runtime = self._runtime_dir()
        _, npm_bin = self._resolve_binaries()
        env = self._build_runtime_env()
        cmd = [npm_bin, "install"]
        if packages:
            if no_save:
                cmd.append("--no-save")
            cmd.extend(packages)
        else:
            cmd.append("--omit=dev")
        result = subprocess.run(
            cmd,
            cwd=str(runtime),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            self.write({"state": "error", "last_error": err[-4000:]})
            raise UserError(_("npm install failed:\n%s") % (err[-1500:] if err else "unknown error"))

    def _sync_state(self) -> None:
        for rec in self:
            pid = rec.pid or rec._read_pid_from_file()
            running = rec._is_pid_running(pid)
            vals = {"pid": pid if running else 0}
            if running:
                vals["state"] = "running"
            else:
                vals["state"] = "error" if rec.last_error else "stopped"
                if not rec.last_error:
                    vals["started_at"] = False
            rec.write(vals)

    def get_runtime_base_url(self):
        self.ensure_one()
        remote_url = str(self.api_base_url or "").strip().rstrip("/")
        if remote_url:
            return remote_url
        return f"http://127.0.0.1:{self.port}"

    @api.model
    def resolve_embedded_portal_instance(self, instance_id=None):
        if instance_id:
            record = self.browse(instance_id).exists()
            if not record:
                raise UserError(_("WhatsApp service instance not found."))
            return record

        active_records = self.search([('active', '=', True)], order='id desc', limit=2)
        if len(active_records) == 1:
            return active_records
        if active_records:
            return active_records[0]
        fallback = self.search([], order='id desc', limit=1)
        if fallback:
            return fallback
        raise UserError(_("No WhatsApp service instance is configured yet."))

    def action_open_embedded_portal(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.client',
            'name': _('WhatsApp Portal'),
            'tag': 'wa_whatsapp_bridge.portal',
            'params': {
                'instance_id': self.id,
                'instance_name': self.name,
            },
        }

    def action_refresh_status(self):
        self._sync_state()
        return True

    def action_install_dependencies(self):
        self.ensure_one()
        self._run_npm_install()
        self.write({"last_error": False})
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "type": "success",
                "title": _("Dependencies Installed"),
                "message": _("Node dependencies are ready."),
                "sticky": False,
            },
        }

    def action_start_service(self):
        self.ensure_one()
        self._sync_state()
        if self.state == "running":
            raise UserError(_("Service is already running (PID %s).") % self.pid)

        runtime = self._runtime_dir()
        node_bin, _npm_bin = self._resolve_binaries()
        self._ensure_dependencies()
        env = self._build_runtime_env()

        log_path = self._log_file_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_handle = log_path.open("ab", buffering=0)

        creation_flags = 0
        if os.name == "nt":
            creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

        process = subprocess.Popen(
            [node_bin, "example.js"],
            cwd=str(runtime),
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
        )
        log_handle.close()
        self._write_pid_file(process.pid)

        time.sleep(2)
        if process.poll() is not None:
            err_tail = self._read_log_tail_text()
            self._unlink_pid_file()
            self.write(
                {
                    "pid": 0,
                    "state": "error",
                    "log_file": str(log_path),
                    "last_error": (err_tail or _("Node process exited immediately."))[-4000:],
                    "started_at": False,
                }
            )
            raise UserError(_("Service failed to start. Check log tail in the form."))

        self.write(
            {
                "pid": process.pid,
                "state": "running",
                "log_file": str(log_path),
                "started_at": fields.Datetime.now(),
                "last_error": False,
            }
        )
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "type": "success",
                "title": _("Service Started"),
                "message": _("WhatsApp runtime started on port %s.") % self.port,
                "sticky": False,
            },
        }

    def action_stop_service(self):
        self.ensure_one()
        self._sync_state()
        pid = self.pid or self._read_pid_from_file()
        if not pid or not self._is_pid_running(pid):
            self._unlink_pid_file()
            self.write({"pid": 0, "state": "stopped", "started_at": False})
            return True

        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False,
                capture_output=True,
                text=True,
            )
        else:
            os.kill(pid, 15)

        self._unlink_pid_file()
        self.write({"pid": 0, "state": "stopped", "started_at": False})
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "type": "success",
                "title": _("Service Stopped"),
                "message": _("WhatsApp runtime was stopped."),
                "sticky": False,
            },
        }

    def action_open_portal(self):
        self.ensure_one()
        return {
            "type": "ir.actions.act_url",
            "name": _("WhatsApp Portal"),
            "url": self.get_runtime_base_url(),
            "target": "new",
        }
