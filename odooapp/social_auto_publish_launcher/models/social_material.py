import base64
import hashlib
import mimetypes
import uuid

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class SocialPublishMaterial(models.Model):
    _name = "social.publish.material"
    _description = "Social Publish Material"
    _order = "id desc"

    name = fields.Char(required=True, index=True)
    uuid = fields.Char(required=True, copy=False, index=True, default=lambda self: str(uuid.uuid4()))
    file_name = fields.Char(required=True)
    file_ext = fields.Char()
    mime_type = fields.Char()
    file_size_mb = fields.Float(digits=(16, 2))
    file_size_bytes = fields.Integer()
    upload_time = fields.Datetime(default=fields.Datetime.now, required=True)
    binary_content = fields.Binary(attachment=False, required=True)
    checksum = fields.Char(index=True)
    active = fields.Boolean(default=True)

    @api.model_create_multi
    def create(self, vals_list):
        normalized_list = []
        for vals in vals_list:
            next_vals = dict(vals)
            self._normalize_vals(next_vals)
            normalized_list.append(next_vals)
        return super().create(normalized_list)

    def write(self, vals):
        next_vals = dict(vals)
        self._normalize_vals(next_vals)
        return super().write(next_vals)

    @classmethod
    def build_vals(cls, file_name, binary_content_b64, display_name=None):
        raw_bytes = base64.b64decode(binary_content_b64 or b"")
        mime_type, _encoding = mimetypes.guess_type(file_name or "")
        return {
            "name": display_name or file_name,
            "file_name": file_name,
            "file_ext": (file_name.rsplit(".", 1)[-1].lower() if "." in (file_name or "") else ""),
            "mime_type": mime_type or "application/octet-stream",
            "file_size_bytes": len(raw_bytes),
            "file_size_mb": round(len(raw_bytes) / (1024 * 1024), 2),
            "binary_content": binary_content_b64,
            "checksum": hashlib.sha256(raw_bytes).hexdigest(),
        }

    def _normalize_vals(self, vals):
        if "file_name" in vals and "name" not in vals:
            vals["name"] = vals["file_name"]
        if "binary_content" in vals and "checksum" not in vals:
            raw_bytes = base64.b64decode(vals["binary_content"] or b"")
            vals["checksum"] = hashlib.sha256(raw_bytes).hexdigest() if raw_bytes else False
            vals["file_size_bytes"] = len(raw_bytes)
            vals["file_size_mb"] = round(len(raw_bytes) / (1024 * 1024), 2)
        if "file_name" in vals and "file_ext" not in vals:
            vals["file_ext"] = (vals["file_name"].rsplit(".", 1)[-1].lower() if "." in (vals["file_name"] or "") else "")
        if "file_name" in vals and "mime_type" not in vals:
            mime_type, _encoding = mimetypes.guess_type(vals["file_name"] or "")
            vals["mime_type"] = mime_type or "application/octet-stream"

    @api.constrains("uuid")
    def _check_uuid_unique(self):
        for record in self:
            if self.search_count([("id", "!=", record.id), ("uuid", "=", record.uuid)]):
                raise ValidationError("Material UUID must be unique.")

    @api.constrains("file_size_bytes", "file_size_mb")
    def _check_size_non_negative(self):
        for record in self:
            if record.file_size_bytes and record.file_size_bytes < 0:
                raise ValidationError("file_size_bytes must be >= 0")
            if record.file_size_mb and record.file_size_mb < 0:
                raise ValidationError("file_size_mb must be >= 0")

    def to_frontend_dict(self):
        self.ensure_one()
        return {
            "id": self.id,
            "uuid": self.uuid,
            "filename": self.name,
            "filesize": self.file_size_mb,
            "upload_time": fields.Datetime.to_string(self.upload_time),
            "fileType": "image" if (self.mime_type or "").startswith("image/") else "video",
            "mimeType": self.mime_type,
            "file_name": self.file_name,
        }
