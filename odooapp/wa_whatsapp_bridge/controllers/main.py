from __future__ import annotations

import base64
import json
from io import BytesIO
from urllib import error, request as urlrequest

from odoo import http
from odoo.http import request


def build_qr_data_url(qr_text):
    if not qr_text:
        return ""
    import qrcode
    import qrcode.image.svg

    buffer = BytesIO()
    image = qrcode.make(qr_text, image_factory=qrcode.image.svg.SvgImage)
    image.save(buffer)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def normalize_remote_status(payload):
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else {}
    account = data.get("account") if isinstance(data.get("account"), dict) else {}
    status = str(data.get("status") or data.get("portalState") or "unknown")
    detail = str(data.get("detail") or "")
    wa_state = str(data.get("waState") or "")
    return {
        "success": bool(payload.get("ok", payload.get("success", True))),
        "data": {
            "portalState": status,
            "detail": detail,
            "waState": wa_state,
            "accountSwitchInProgress": bool(data.get("rebindInProgress") or data.get("accountSwitchInProgress")),
            "account": {
                "wid": str(account.get("wid") or ""),
                "pushName": str(account.get("pushName") or ""),
                "platform": str(account.get("platform") or ""),
            },
            "loginAction": {
                "allowed": status == "ready",
                "message": detail,
            },
        },
    }


def normalize_remote_qr(payload):
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else {}
    qr_text = str(data.get("qr") or "").strip() if data.get("available") else ""
    return {
        "success": bool(payload.get("ok", payload.get("success", True))),
        "data": {
            "qrText": qr_text,
            "qrDataUrl": build_qr_data_url(qr_text) if qr_text else "",
        },
    }


def normalize_remote_action(payload):
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else {}
    return {
        "success": bool(payload.get("ok", payload.get("success", True))),
        "data": {
            "accepted": bool(data.get("accepted", True)),
        },
    }


class WaPortalController(http.Controller):
    def _resolve_instance(self, instance_id=None):
        service_model = request.env["wa.service.instance"]
        return service_model.resolve_embedded_portal_instance(instance_id=instance_id)

    @staticmethod
    def _proxy(instance, path, method="GET", payload=None):
        url = f"{instance.get_runtime_base_url()}{path}"
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urlrequest.Request(url, data=data, headers=headers, method=method)
        try:
            with urlrequest.urlopen(req, timeout=15) as response:
                body = response.read().decode("utf-8") or "{}"
                return json.loads(body)
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8") if exc.fp else ""
            try:
                return json.loads(body or "{}")
            except json.JSONDecodeError:
                return {"success": False, "error": body or str(exc)}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    @http.route("/wa_whatsapp_bridge/portal/resolve", type="jsonrpc", auth="user")
    def resolve_instance(self, instance_id=None):
        instance = self._resolve_instance(instance_id=instance_id)
        return {
            "success": True,
            "data": {
                "instanceId": instance.id,
                "name": instance.name,
                "port": instance.port,
                "apiBaseUrl": instance.get_runtime_base_url(),
            },
        }

    @http.route("/wa_whatsapp_bridge/portal/status", type="jsonrpc", auth="user")
    def portal_status(self, instance_id=None):
        instance = self._resolve_instance(instance_id=instance_id)
        return normalize_remote_status(self._proxy(instance, "/api/session/status"))

    @http.route("/wa_whatsapp_bridge/portal/qr", type="jsonrpc", auth="user")
    def portal_qr(self, instance_id=None):
        instance = self._resolve_instance(instance_id=instance_id)
        return normalize_remote_qr(self._proxy(instance, "/api/session/qr"))

    @http.route("/wa_whatsapp_bridge/portal/login", type="jsonrpc", auth="user")
    def portal_login(self, instance_id=None):
        instance = self._resolve_instance(instance_id=instance_id)
        self._proxy(instance, "/api/session/rebind", method="POST", payload={})
        return normalize_remote_status(self._proxy(instance, "/api/session/status"))

    @http.route("/wa_whatsapp_bridge/portal/switch_account", type="jsonrpc", auth="user")
    def portal_switch_account(self, instance_id=None):
        instance = self._resolve_instance(instance_id=instance_id)
        return normalize_remote_action(self._proxy(instance, "/api/session/rebind", method="POST", payload={}))


class WaChatWorkspaceController(http.Controller):
    @http.route("/wa_whatsapp_bridge/chat/bootstrap", type="jsonrpc", auth="user")
    def chat_bootstrap(self, chat_jid=None):
        workspace = request.env["wa.chat.workspace"]
        return {
            "success": True,
            "data": workspace.get_workspace_bootstrap(chat_jid=chat_jid),
        }

    @http.route("/wa_whatsapp_bridge/chat/messages", type="jsonrpc", auth="user")
    def chat_messages(self, chat_jid, limit=200):
        workspace = request.env["wa.chat.workspace"]
        return {
            "success": True,
            "data": workspace.get_chat_messages(chat_jid=chat_jid, limit=limit),
        }
