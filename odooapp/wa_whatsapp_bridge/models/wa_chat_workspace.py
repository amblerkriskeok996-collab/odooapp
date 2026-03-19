from __future__ import annotations

import json
from contextlib import closing
from datetime import datetime
from pathlib import Path
from urllib import error, request as urlrequest

import psycopg2

from odoo import _, api, models
from odoo.exceptions import UserError


DEFAULT_LISTENER_ENV_PATH = Path(r"D:\code\programs\msg_s\Whatsapp\.env")


class WaChatWorkspace(models.AbstractModel):
    _name = "wa.chat.workspace"
    _description = "WhatsApp Chat Workspace"

    @staticmethod
    def _parse_env_text(text: str) -> dict[str, str]:
        values: dict[str, str] = {}
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
        return values

    @staticmethod
    def _serialize_timestamp(value):
        if isinstance(value, datetime):
            return value.isoformat()
        return value or ""

    @staticmethod
    def _jid_local_part(value):
        if not value:
            return ""
        return value.split("@", 1)[0]

    @classmethod
    def _private_chat_name(
        cls,
        chat_jid,
        contact_name,
        contact_phone,
        latest_sender_name,
        latest_sender_phone,
    ):
        return (
            contact_name
            or contact_phone
            or cls._jid_local_part(chat_jid)
            or latest_sender_name
            or latest_sender_phone
            or chat_jid
            or "-"
        )

    @staticmethod
    def _is_visible_chat(chat_jid, chat_type):
        if not chat_jid:
            return False
        if chat_type == "private" and chat_jid == "status@broadcast":
            return False
        return True

    @staticmethod
    def _chat_name_from_values(chat_type, group_name, sender_name, sender_phone, chat_jid):
        if chat_type == "group" and group_name:
            return group_name
        return sender_name or sender_phone or chat_jid or "-"

    @api.model
    def _listener_env_path(self) -> Path:
        param_value = self.env["ir.config_parameter"].sudo().get_param(
            "wa_whatsapp_bridge.listener_env_path"
        )
        return Path(param_value) if param_value else DEFAULT_LISTENER_ENV_PATH

    @api.model
    def _message_db_config(self) -> dict[str, object]:
        env_path = self._listener_env_path()
        if not env_path.exists():
            raise UserError(_("Listener env file not found: %s") % env_path)

        values = self._parse_env_text(env_path.read_text(encoding="utf-8"))
        return {
            "host": values.get("PGHOST") or "127.0.0.1",
            "port": int(values.get("PGPORT") or 5432),
            "dbname": values.get("PGDATABASE") or "postgres",
            "user": values.get("PGUSER") or "postgres",
            "password": values.get("PGPASSWORD") or "",
        }

    @api.model
    def _connect_message_db(self):
        return psycopg2.connect(**self._message_db_config())

    @api.model
    def _get_listener_status(self):
        try:
            service = self.env["wa.service.instance"].resolve_embedded_portal_instance()
            base_url = str(service.get_runtime_base_url() or "").strip().rstrip("/")
            if not base_url:
                return {"status": "unavailable", "detail": _("WhatsApp listener base URL is empty.")}
            req = urlrequest.Request(f"{base_url}/api/session/status", headers={"Accept": "application/json"}, method="GET")
            with urlrequest.urlopen(req, timeout=10) as response:
                payload = json.loads((response.read().decode("utf-8") or "{}"))
        except Exception as exc:
            return {"status": "unavailable", "detail": str(exc)}

        data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else {}
        return {
            "status": str(data.get("status") or "unknown"),
            "detail": str(data.get("detail") or ""),
        }

    @api.model
    def _fetch_chat_rows(self, limit=80):
        sql = """
            WITH latest AS (
                SELECT DISTINCT ON (chat_jid)
                    chat_jid,
                    chat_type,
                    sender_name,
                    sender_phone,
                    group_name,
                    COALESCE(message_text, '') AS last_message_text,
                    message_time AS last_message_time,
                    from_me
                FROM whatsapp_messages
                ORDER BY chat_jid, message_time DESC, id DESC
            ),
            contact_hint AS (
                SELECT DISTINCT ON (chat_jid)
                    chat_jid,
                    sender_name AS contact_name,
                    sender_phone AS contact_phone
                FROM whatsapp_messages
                WHERE NOT from_me
                ORDER BY chat_jid, message_time DESC, id DESC
            )
            SELECT
                latest.chat_jid,
                latest.chat_type,
                latest.sender_name,
                latest.sender_phone,
                latest.group_name,
                latest.last_message_text,
                latest.last_message_time,
                latest.from_me,
                contact_hint.contact_name,
                contact_hint.contact_phone
            FROM latest
            LEFT JOIN contact_hint
                ON contact_hint.chat_jid = latest.chat_jid
            ORDER BY last_message_time DESC
            LIMIT %s
        """
        with closing(self._connect_message_db()) as conn, closing(conn.cursor()) as cursor:
            cursor.execute(sql, [limit])
            rows = cursor.fetchall()

        chats = []
        for row in rows:
            (
                chat_jid,
                chat_type,
                sender_name,
                sender_phone,
                group_name,
                last_message_text,
                last_message_time,
                from_me,
                contact_name,
                contact_phone,
            ) = row
            if not self._is_visible_chat(chat_jid, chat_type):
                continue
            if chat_type == "private":
                chat_name = self._private_chat_name(
                    chat_jid=chat_jid,
                    contact_name=contact_name or "",
                    contact_phone=contact_phone or "",
                    latest_sender_name=sender_name or "",
                    latest_sender_phone=sender_phone or "",
                )
            else:
                chat_name = self._chat_name_from_values(
                    chat_type, group_name, sender_name, sender_phone, chat_jid
                )
            chats.append(
                {
                    "chat_jid": chat_jid,
                    "chat_type": chat_type,
                    "chat_name": chat_name,
                    "sender_name": sender_name or "",
                    "sender_phone": sender_phone or "",
                    "group_name": group_name or "",
                    "last_message_text": last_message_text or "",
                    "last_message_time": self._serialize_timestamp(last_message_time),
                    "from_me": bool(from_me),
                    "unread_count": 0,
                }
            )
        return chats

    @api.model
    def _fetch_message_rows(self, chat_jid, limit=200):
        sql = """
            SELECT
                id,
                message_id,
                direction,
                chat_type,
                chat_jid,
                sender_jid,
                sender_phone,
                sender_name,
                group_name,
                COALESCE(message_text, '') AS message_text,
                message_time,
                from_me
            FROM whatsapp_messages
            WHERE chat_jid = %s
            ORDER BY message_time ASC, id ASC
            LIMIT %s
        """
        with closing(self._connect_message_db()) as conn, closing(conn.cursor()) as cursor:
            cursor.execute(sql, [chat_jid, limit])
            rows = cursor.fetchall()

        messages = []
        for row in rows:
            (
                row_id,
                message_id,
                direction,
                chat_type,
                chat_jid_value,
                sender_jid,
                sender_phone,
                sender_name,
                group_name,
                message_text,
                message_time,
                from_me,
            ) = row
            messages.append(
                {
                    "id": row_id,
                    "message_id": message_id,
                    "direction": direction,
                    "chat_type": chat_type,
                    "chat_jid": chat_jid_value,
                    "sender_jid": sender_jid,
                    "sender_phone": sender_phone or "",
                    "sender_name": sender_name or "",
                    "group_name": group_name or "",
                    "message_text": message_text or "",
                    "message_time": self._serialize_timestamp(message_time),
                    "from_me": bool(from_me),
                }
            )
        return messages

    @api.model
    def get_chat_messages(self, chat_jid, limit=200):
        listener_status = self._get_listener_status()
        if listener_status.get("status") != "ready":
            return {
                "chat_jid": "",
                "messages": [],
                "portal_state": listener_status.get("status", "unknown"),
                "portal_detail": listener_status.get("detail", ""),
            }
        if not chat_jid:
            return {"chat_jid": "", "messages": []}
        return {
            "chat_jid": chat_jid,
            "messages": self._fetch_message_rows(chat_jid=chat_jid, limit=limit),
            "portal_state": listener_status.get("status", "unknown"),
            "portal_detail": listener_status.get("detail", ""),
        }

    @api.model
    def get_workspace_bootstrap(self, chat_jid=None):
        listener_status = self._get_listener_status()
        if listener_status.get("status") != "ready":
            return {
                "portal_state": listener_status.get("status", "unknown"),
                "portal_detail": listener_status.get("detail", ""),
                "chats": [],
                "selected_chat_jid": "",
                "selected_chat": None,
                "messages": [],
            }
        chats = self._fetch_chat_rows()
        selected_chat_jid = chat_jid or (chats[0]["chat_jid"] if chats else "")
        selected_chat = next((chat for chat in chats if chat["chat_jid"] == selected_chat_jid), None)
        return {
            "portal_state": listener_status.get("status", "unknown"),
            "portal_detail": listener_status.get("detail", ""),
            "chats": chats,
            "selected_chat_jid": selected_chat_jid,
            "selected_chat": selected_chat,
            "messages": self._fetch_message_rows(selected_chat_jid) if selected_chat_jid else [],
        }
