import asyncio
import base64
import json
import logging
import queue
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from odoo import SUPERUSER_ID, api, fields, http
from odoo.http import request
from odoo.modules.registry import Registry


_logger = logging.getLogger(__name__)

SOURCE_PROJECT_DIR = Path(__file__).resolve().parents[3] / "social-auto-upload"
RUNTIME_COOKIE_PREFIX = "odoo_runtime_cookie_"
RUNTIME_MATERIAL_PREFIX = "odoo_runtime_material_"


def _ensure_source_path():
    source_dir = str(SOURCE_PROJECT_DIR)
    if source_dir not in sys.path:
        sys.path.insert(0, source_dir)


def _load_source_modules():
    _ensure_source_path()
    import myUtils.auth as auth_module
    import myUtils.login as login_module
    import myUtils.postVideo as post_video_module

    return auth_module, login_module, post_video_module


class _DummyCursor:
    def execute(self, *args, **kwargs):
        return self

    def fetchone(self):
        return None

    def fetchall(self):
        return []


class _DummyConnection:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self):
        return _DummyCursor()

    def commit(self):
        return None


@contextmanager
def _patched_sqlite_connect(login_module):
    original_connect = login_module.sqlite3.connect
    login_module.sqlite3.connect = lambda *args, **kwargs: _DummyConnection()
    try:
        yield
    finally:
        login_module.sqlite3.connect = original_connect


def _cookies_dir():
    return SOURCE_PROJECT_DIR / "cookiesFile"


def _materials_dir():
    return SOURCE_PROJECT_DIR / "videoFile"


def _list_new_files(before, directory):
    after = set(directory.glob("*.json"))
    return sorted(after - before, key=lambda item: item.stat().st_mtime, reverse=True)


def _run_coroutine(coro):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(coro)
    finally:
        loop.close()


def _runtime_cookie_name(account_id):
    return f"{RUNTIME_COOKIE_PREFIX}{account_id}.json"


def _cleanup_runtime_cookie_for_account(account_id):
    runtime_path = _cookies_dir() / _runtime_cookie_name(account_id)
    _cleanup_paths([runtime_path])


def _write_runtime_cookie(account):
    cookies_dir = _cookies_dir()
    cookies_dir.mkdir(parents=True, exist_ok=True)
    runtime_name = _runtime_cookie_name(account.id)
    runtime_path = cookies_dir / runtime_name
    runtime_path.write_text(account.cookie_json or "{}", encoding="utf-8")
    return runtime_name, runtime_path


def _write_runtime_material(material):
    materials_dir = _materials_dir()
    materials_dir.mkdir(parents=True, exist_ok=True)
    runtime_file_name = f"{RUNTIME_MATERIAL_PREFIX}{material.uuid}_{material.file_name}"
    runtime_path = materials_dir / runtime_file_name
    runtime_path.write_bytes(base64.b64decode(material.binary_content or b""))
    return runtime_file_name, runtime_path


def _cleanup_paths(paths):
    for path in paths:
        try:
            candidate = Path(path)
            if candidate.exists():
                candidate.unlink()
        except OSError:
            continue


def _platform_runner(login_module, platform_type):
    runners = {
        1: login_module.xiaohongshu_cookie_gen,
        2: login_module.get_tencent_cookie,
        3: login_module.douyin_cookie_gen,
        4: login_module.get_ks_cookie,
        5: login_module.bilibili_cookie_gen,
        6: login_module.toutiao_cookie_gen,
        7: login_module.zhihu_cookie_gen,
        8: login_module.weibo_cookie_gen,
        9: login_module.sohu_cookie_gen,
        10: login_module.tencent_news_cookie_gen,
    }
    return runners.get(int(platform_type or 0))


@contextmanager
def _db_env(db_name):
    registry = Registry(db_name)
    with registry.cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        try:
            yield env
            cr.commit()
        except Exception:
            cr.rollback()
            raise


def _task_write(db_name, task_id, values=None, event_code=None, message=None):
    values = values or {}
    with _db_env(db_name) as env:
        task = env["social.publish.automation.task"].sudo().browse(task_id)
        if not task.exists():
            return
        if values:
            task.write(values)
        if event_code and message:
            task.add_event(event_code, message)


def _create_task(db_name, vals, event_code=None, message=None):
    with _db_env(db_name) as env:
        task = env["social.publish.automation.task"].sudo().create(vals)
        if event_code and message:
            task.add_event(event_code, message)
        return task.id
    return 0


def _create_account_from_generated_cookie(db_name, platform_type, user_name, generated_file, task_id=None):
    cookie_json = generated_file.read_text(encoding="utf-8")
    with _db_env(db_name) as env:
        account = env["social.publish.account"].create_from_login_result(
            env,
            platform_type=platform_type,
            user_name=user_name,
            cookie_filename=generated_file.name,
            cookie_json=cookie_json,
        )
        values = {"last_login_task_id": task_id, "last_login_error": False} if task_id else {"last_login_error": False}
        account.sudo().write(values)
        return account.id
    return None


def _task_event_payload(task_id, event, **extra):
    payload = {"task_id": task_id, "event": event}
    payload.update(extra)
    return payload


def _login_worker(db_name, platform_type, user_name, output_queue, task_id):
    _task_write(
        db_name,
        task_id,
        values={"status": "running", "started_at": fields.Datetime.now()},
        event_code="started",
        message=f"login worker started for platform_type={platform_type}, user={user_name}",
    )
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="ignore")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="ignore")
        _ensure_source_path()
        _auth_module, login_module, _post_video_module = _load_source_modules()
        cookies_dir = _cookies_dir()
        cookies_dir.mkdir(parents=True, exist_ok=True)
        before = set(cookies_dir.glob("*.json"))
        runner = _platform_runner(login_module, platform_type)
        if not runner:
            raise RuntimeError(f"unsupported platform_type {platform_type}")

        _task_write(
            db_name,
            task_id,
            values={"browser_started_at": fields.Datetime.now()},
            event_code="playwright_started",
            message="playwright browser automation launched",
        )
        output_queue.put(_task_event_payload(task_id, "playwright_started", message="playwright browser automation launched"))

        class _InterceptQueue:
            def __init__(self):
                self.final_status = None

            def put(self, message):
                if message in {"200", "500"}:
                    self.final_status = message
                    return
                _task_write(
                    db_name,
                    task_id,
                    values={
                        "status": "qr_ready",
                        "qr_emitted_at": fields.Datetime.now(),
                        "payload_json": json.dumps({"qr_data": message}, ensure_ascii=False),
                    },
                    event_code="qr_emitted",
                    message="qr code emitted to frontend",
                )
                output_queue.put(_task_event_payload(task_id, "qr", data=message))

        intercept_queue = _InterceptQueue()
        with _patched_sqlite_connect(login_module):
            _run_coroutine(runner(user_name, intercept_queue))

        if intercept_queue.final_status != "200":
            raise RuntimeError("login automation finished without success")

        new_files = _list_new_files(before, cookies_dir)
        if not new_files:
            raise RuntimeError("no generated cookie file found")

        generated_file = new_files[0]
        try:
            account_id = _create_account_from_generated_cookie(db_name, platform_type, user_name, generated_file, task_id=task_id)
            _task_write(
                db_name,
                task_id,
                values={"status": "success", "finished_at": fields.Datetime.now()},
                event_code="success",
                message=f"cookie persisted to pg for account_id={account_id}",
            )
        finally:
            _cleanup_paths([generated_file])

        output_queue.put(_task_event_payload(task_id, "final", code="200", status="success"))
    except Exception as error:
        _logger.exception("login worker failed")
        _task_write(
            db_name,
            task_id,
            values={"status": "failed", "finished_at": fields.Datetime.now(), "error_message": str(error)},
            event_code="failed",
            message=str(error),
        )
        output_queue.put(_task_event_payload(task_id, "final", code="500", status="failed", error=str(error)))


def _sse_stream(status_queue):
    while True:
        if not status_queue.empty():
            message = status_queue.get()
            yield f"data: {json.dumps(message, ensure_ascii=False)}\n\n"
            if message.get("event") == "final":
                break
        else:
            time.sleep(0.1)


class SocialAutoPublishLauncherController(http.Controller):
    @http.route("/social_auto_publish_launcher/bootstrap", type="jsonrpc", auth="user", methods=["POST"])
    def bootstrap(self):
        env = request.env
        accounts = env["social.publish.account"].sudo().search([])
        materials = env["social.publish.material"].sudo().search([])
        tasks = env["social.publish.automation.task"].sudo().search([], limit=10)
        return {
            "ok": True,
            "user": env.user.name,
            "accounts": [account.to_frontend_dict() for account in accounts],
            "materials": [material.to_frontend_dict() for material in materials],
            "recent_tasks": [task.to_frontend_dict() for task in tasks],
        }

    @http.route("/social_auto_publish_launcher/task/list", type="jsonrpc", auth="user", methods=["POST"])
    def task_list(self, limit=20):
        tasks = request.env["social.publish.automation.task"].sudo().search([], limit=int(limit or 20))
        return {"code": 200, "msg": "success", "data": [task.to_frontend_dict() for task in tasks]}

    @http.route("/social_auto_publish_launcher/task/get", type="jsonrpc", auth="user", methods=["POST"])
    def task_get(self, task_id=None):
        task = request.env["social.publish.automation.task"].sudo().browse(int(task_id or 0))
        if not task.exists():
            return {"code": 404, "msg": "task not found", "data": None}
        return {"code": 200, "msg": "success", "data": task.to_frontend_dict()}

    @http.route("/social_auto_publish_launcher/account/list", type="jsonrpc", auth="user", methods=["POST"])
    def account_list(self):
        accounts = request.env["social.publish.account"].sudo().search([])
        return {"code": 200, "msg": "success", "data": [account.to_frontend_dict() for account in accounts]}

    @http.route("/social_auto_publish_launcher/account/save", type="jsonrpc", auth="user", methods=["POST"])
    def account_save(self, account=None):
        account = account or {}
        account_model = request.env["social.publish.account"].sudo()
        vals = {
            "name": account.get("name"),
            "platform_key": account.get("platform_key") or account_model.platform_key_from_type(account.get("type")) or "douyin",
            "status": "normal" if account.get("status") in ("正常", "normal") else "abnormal",
            "note": account.get("note"),
        }
        if account.get("id"):
            record = account_model.browse(int(account["id"]))
            record.write(vals)
        else:
            record = account_model.create(vals)
        return {"code": 200, "msg": "success", "data": record.to_frontend_dict()}

    @http.route("/social_auto_publish_launcher/account/delete", type="jsonrpc", auth="user", methods=["POST"])
    def account_delete(self, account_id=None):
        account = request.env["social.publish.account"].sudo().browse(int(account_id or 0))
        if not account.exists():
            return {"code": 404, "msg": "account not found", "data": None}
        task_id = _create_task(
            request.db,
            {
                "name": f"cleanup account {account.name}",
                "task_type": "cleanup",
                "status": "running",
                "platform_key": account.platform_key,
                "platform_type": account.platform_type,
                "account_name": account.name,
            },
            event_code="started",
            message=f"cleanup started for account_id={account.id}",
        )
        _cleanup_runtime_cookie_for_account(account.id)
        _task_write(request.db, task_id, event_code="cleaned", message="runtime cookie cleaned if existed")
        account.unlink()
        _task_write(
            request.db,
            task_id,
            values={"status": "success", "finished_at": fields.Datetime.now(), "cleanup_at": fields.Datetime.now()},
            event_code="success",
            message="account removed from pg",
        )
        return {"code": 200, "msg": "success", "data": {"task_id": task_id}}

    @http.route("/social_auto_publish_launcher/account/refresh", type="jsonrpc", auth="user", methods=["POST"])
    def account_refresh(self, platform_type=None):
        auth_module, _login_module, _post_video_module = _load_source_modules()
        account_model = request.env["social.publish.account"].sudo()
        domain = []
        if platform_type:
            domain.append(("platform_type", "=", int(platform_type)))
        accounts = account_model.search(domain)
        for account in accounts:
            runtime_name, runtime_path = _write_runtime_cookie(account)
            try:
                is_valid = asyncio.run(auth_module.check_cookie(account.platform_type, runtime_name))
            except Exception:
                is_valid = False
            finally:
                _cleanup_paths([runtime_path])
            account.write({
                "status": "normal" if is_valid else "abnormal",
                "last_validated_at": fields.Datetime.now(),
            })
        return {"code": 200, "msg": "success", "data": [account.to_frontend_dict() for account in accounts]}

    @http.route("/social_auto_publish_launcher/account/upload_cookie", type="jsonrpc", auth="user", methods=["POST"])
    def account_upload_cookie(self, account_id=None, filename=None, content=None):
        account = request.env["social.publish.account"].sudo().browse(int(account_id or 0))
        if not account.exists():
            return {"code": 404, "msg": "account not found", "data": None}
        account.write({
            "cookie_filename": filename or account.cookie_filename or f"account_{account.id}.json",
            "cookie_json": base64.b64decode(content or b"").decode("utf-8"),
            "status": "normal",
            "last_login_error": False,
            "last_validated_at": fields.Datetime.now(),
        })
        return {"code": 200, "msg": "success", "data": account.to_frontend_dict()}

    @http.route("/social_auto_publish_launcher/account/download_cookie/<int:account_id>", type="http", auth="user", methods=["GET"])
    def account_download_cookie(self, account_id):
        account = request.env["social.publish.account"].sudo().browse(account_id)
        filename = account.cookie_filename or f"account_{account.id}.json"
        return request.make_response(
            (account.cookie_json or "{}").encode("utf-8"),
            headers=[
                ("Content-Type", "application/json"),
                ("Content-Disposition", f'attachment; filename="{filename}"'),
            ],
        )

    @http.route("/social_auto_publish_launcher/material/list", type="jsonrpc", auth="user", methods=["POST"])
    def material_list(self):
        materials = request.env["social.publish.material"].sudo().search([])
        return {"code": 200, "msg": "success", "data": [material.to_frontend_dict() for material in materials]}

    @http.route("/social_auto_publish_launcher/material/upload", type="jsonrpc", auth="user", methods=["POST"])
    def material_upload(self, files=None, filename=None):
        files = files or []
        material_model = request.env["social.publish.material"].sudo()
        created = []
        for item in files:
            file_name = item.get("file_name") or item.get("name") or filename
            display_name = item.get("display_name") or filename or file_name
            vals = material_model.build_vals(file_name, item.get("content"), display_name=display_name)
            created.append(material_model.create(vals).to_frontend_dict())
        return {"code": 200, "msg": "success", "data": created}

    @http.route("/social_auto_publish_launcher/material/delete", type="jsonrpc", auth="user", methods=["POST"])
    def material_delete(self, material_id=None):
        request.env["social.publish.material"].sudo().browse(int(material_id or 0)).unlink()
        return {"code": 200, "msg": "success", "data": None}

    @http.route("/social_auto_publish_launcher/material/content/<int:material_id>", type="http", auth="user", methods=["GET"])
    def material_content(self, material_id):
        material = request.env["social.publish.material"].sudo().browse(material_id)
        binary = base64.b64decode(material.binary_content or b"")
        disposition = request.httprequest.args.get("download")
        headers = [("Content-Type", material.mime_type or "application/octet-stream")]
        if disposition:
            headers.append(("Content-Disposition", f'attachment; filename="{material.file_name}"'))
        return request.make_response(binary, headers=headers)

    @http.route("/social_auto_publish_launcher/login", type="http", auth="user", methods=["GET"])
    def login(self, type=None, id=None):
        platform_type = int(type or 0)
        user_name = (id or "").strip()
        task_id = _create_task(
            request.db,
            {
                "name": f"login {user_name or 'unknown'}",
                "task_type": "login",
                "status": "pending",
                "platform_type": platform_type,
                "platform_key": request.env["social.publish.account"].platform_key_from_type(platform_type),
                "account_name": user_name,
            },
            event_code="started",
            message="login request received",
        )
        status_queue = queue.Queue()
        status_queue.put(_task_event_payload(task_id, "task_created", status="pending"))
        thread = threading.Thread(
            target=_login_worker,
            args=(request.db, platform_type, user_name, status_queue, task_id),
            daemon=True,
        )
        thread.start()
        response = request.make_response(
            json.dumps({"code": 200, "msg": "success", "data": {"task_id": task_id}}, ensure_ascii=False).encode("utf-8"),
            headers=[("Content-Type", "application/json; charset=utf-8")],
        )
        return response

    @http.route("/social_auto_publish_launcher/publish", type="jsonrpc", auth="user", methods=["POST"])
    def publish(self, payload=None):
        payload = payload or {}
        _auth_module, _login_module, post_video_module = _load_source_modules()
        account_model = request.env["social.publish.account"].sudo()
        material_model = request.env["social.publish.material"].sudo()

        account_ids = [int(account_id) for account_id in payload.get("accountIds", [])]
        material_ids = [int(material_id) for material_id in payload.get("materialIds", [])]
        accounts = account_model.browse(account_ids)
        materials = material_model.browse(material_ids)
        platform_type = int(payload.get("type") or 0)
        platform_key = account_model.platform_key_from_type(platform_type)
        title = payload.get("title") or ""

        task_id = _create_task(
            request.db,
            {
                "name": f"publish {title or 'untitled'}",
                "task_type": "publish",
                "status": "running",
                "platform_key": platform_key,
                "platform_type": platform_type,
                "account_name": ", ".join(accounts.mapped("name")),
                "payload_json": json.dumps(payload, ensure_ascii=False),
            },
            event_code="started",
            message=f"publish started for platform_type={platform_type}",
        )

        temp_paths = []
        runtime_cookie_names = []
        runtime_material_names = []
        try:
            for account in accounts:
                runtime_name, runtime_path = _write_runtime_cookie(account)
                runtime_cookie_names.append(runtime_name)
                temp_paths.append(runtime_path)
            for material in materials:
                runtime_name, runtime_path = _write_runtime_material(material)
                runtime_material_names.append(runtime_name)
                temp_paths.append(runtime_path)

            tags = payload.get("tags") or payload.get("selectedTopics") or []
            enable_timer = bool(payload.get("enableTimer"))
            videos_per_day = int(payload.get("videosPerDay") or 1)
            daily_times = payload.get("dailyTimes") or []
            start_days = int(payload.get("startDays") or 0)
            publish_mode = payload.get("publishMode") or "video"
            category = payload.get("category")
            is_draft = bool(payload.get("isDraft"))
            product_link = payload.get("productLink") or ""
            product_title = payload.get("productTitle") or ""

            _task_write(request.db, task_id, event_code="platform_called", message=f"platform uploader called for platform_type={platform_type}")

            if platform_type == 1:
                post_video_module.post_video_xhs(title, runtime_material_names, tags, runtime_cookie_names, category, enable_timer, videos_per_day, daily_times, start_days)
            elif platform_type == 2:
                post_video_module.post_video_tencent(title, runtime_material_names, tags, runtime_cookie_names, category, enable_timer, videos_per_day, daily_times, start_days, is_draft)
            elif platform_type == 3:
                post_video_module.post_video_DouYin(title, runtime_material_names, tags, runtime_cookie_names, category, enable_timer, videos_per_day, daily_times, start_days, "", product_link, product_title)
            elif platform_type == 4:
                post_video_module.post_video_ks(title, runtime_material_names, tags, runtime_cookie_names, category, enable_timer, videos_per_day, daily_times, start_days)
            elif platform_type == 5:
                post_video_module.post_video_bilibili(title, runtime_material_names, tags, runtime_cookie_names, category or 21, enable_timer, videos_per_day, daily_times, start_days)
            elif platform_type == 8:
                post_video_module.post_video_weibo(title, runtime_material_names, tags, runtime_cookie_names, category, enable_timer, videos_per_day, daily_times, start_days, publish_mode)
            else:
                post_video_module.post_video_placeholder(
                    account_model.platform_label_from_type(platform_type) or "未知平台",
                    title,
                    runtime_material_names,
                    tags,
                    runtime_cookie_names,
                    enable_timer,
                    videos_per_day,
                    daily_times,
                    start_days,
                )

            accounts.write({"last_publish_task_id": task_id})
            _task_write(
                request.db,
                task_id,
                values={"status": "success", "finished_at": fields.Datetime.now()},
                event_code="success",
                message="publish automation finished successfully",
            )
            return {"code": 200, "msg": "success", "data": {"task_id": task_id}}
        except Exception as error:
            _logger.exception("publish failed")
            accounts.write({"last_publish_task_id": task_id})
            _task_write(
                request.db,
                task_id,
                values={"status": "failed", "finished_at": fields.Datetime.now(), "error_message": str(error)},
                event_code="failed",
                message=str(error),
            )
            return {"code": 500, "msg": f"发布失败: {error}", "data": {"task_id": task_id}}
        finally:
            _cleanup_paths(temp_paths)
            _task_write(
                request.db,
                task_id,
                values={"cleanup_at": fields.Datetime.now()},
                event_code="cleaned",
                message="runtime temp files cleaned",
            )
