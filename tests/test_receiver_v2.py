"""Integration tests for receiver_v2.py."""
from __future__ import annotations

import importlib.util
import io
import itertools
import json
import types
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "src" / "receiver_v2.py"
MODULE_COUNTER = itertools.count()


def load_receiver_module():
    name = f"receiver_v2_test_{next(MODULE_COUNTER)}"
    spec = importlib.util.spec_from_file_location(name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def invoke_request(
    module,
    *,
    method: str = "POST",
    path: str = "/response",
    body: bytes = b"",
    origin: str | None = "https://chatgpt.com",
    token: str | None = "scholar-v4-rob",
    content_type: str | None = "application/json",
):
    handler = object.__new__(module.Handler)
    headers = {"Content-Length": str(len(body))}
    if origin is not None:
        headers["Origin"] = origin
    if token is not None:
        headers["X-Rob-Token"] = token
    if content_type is not None:
        headers["Content-Type"] = content_type

    handler.headers = headers
    handler.path = path
    handler.command = method
    handler.request_version = "HTTP/1.1"
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler.response_status = None
    handler.response_headers = []

    def send_response(self, code, message=None):
        self.response_status = code

    def send_header(self, key, value):
        self.response_headers.append((key, value))

    def end_headers(self):
        return None

    handler.send_response = types.MethodType(send_response, handler)
    handler.send_header = types.MethodType(send_header, handler)
    handler.end_headers = types.MethodType(end_headers, handler)

    if method == "OPTIONS":
        module.Handler.do_OPTIONS(handler)
    else:
        module.Handler.do_POST(handler)

    return handler.response_status, handler.wfile.getvalue(), dict(handler.response_headers)


@pytest.fixture
def receiver_app(monkeypatch, tmp_path):
    module = load_receiver_module()
    save_root = tmp_path / "gpt54-responses"
    save_root.mkdir()
    notifications = []

    monkeypatch.setattr(module, "SAVE_ROOT", save_root)
    monkeypatch.setattr(
        module,
        "notify_rob",
        lambda label, text_len: notifications.append((label, text_len)),
    )
    yield module, save_root, notifications


def test_import_executes_module_code():
    module = load_receiver_module()
    assert module.Handler.server_version == "GPT54ReceiverV2/2.1"
    assert module.MAX_BODY_BYTES == 2 * 1024 * 1024


def test_openclaw_path_can_be_configured_with_env(monkeypatch):
    monkeypatch.setenv("GPT54_OPENCLAW_PATH", "/tmp/custom-openclaw")
    module = load_receiver_module()
    assert module.OPENCLAW_PATH == "/tmp/custom-openclaw"


def test_saves_ten_json_payloads_and_notifies_once_per_request(receiver_app):
    module, save_root, notifications = receiver_app

    for i in range(10):
        payload = {
            "text": f"message {i}",
            "label": f"chat-{i}",
            "source_url": f"https://chatgpt.com/c/{i}",
            "captured_at": f"2026-03-10T12:00:{i:02d}+09:00",
        }
        status, body, _ = invoke_request(module, body=json.dumps(payload).encode("utf-8"))
        assert status == 200
        assert json.loads(body)["ok"] is True

    bundles = sorted(path for path in save_root.iterdir() if path.is_dir())
    assert len(bundles) == 10
    assert len(notifications) == 10

    saved_labels = {
        json.loads((bundle / "meta.json").read_text(encoding="utf-8"))["label"]
        for bundle in bundles
    }
    assert saved_labels == {f"chat-{i}" for i in range(10)}


def test_empty_body_returns_400(receiver_app):
    module, _, notifications = receiver_app
    status, body, _ = invoke_request(module, body=b"")

    assert status == 400
    assert json.loads(body)["error"] == "empty request body"
    assert notifications == []


def test_invalid_json_returns_400(receiver_app):
    module, _, notifications = receiver_app
    status, body, _ = invoke_request(module, body=b"{")

    assert status == 400
    assert "invalid json" in json.loads(body)["error"]
    assert notifications == []


def test_empty_text_returns_400(receiver_app):
    module, _, notifications = receiver_app
    payload = {
        "text": "   ",
        "label": "empty",
        "source_url": "https://chatgpt.com/c/empty",
        "captured_at": "2026-03-10T12:34:56+09:00",
    }
    status, body, _ = invoke_request(module, body=json.dumps(payload).encode("utf-8"))

    assert status == 400
    assert json.loads(body)["error"] == "text is required"
    assert notifications == []


def test_same_second_requests_use_unique_directories(receiver_app, monkeypatch):
    module, save_root, notifications = receiver_app
    fixed_now = datetime(2026, 3, 10, 12, 34, 56)

    class FrozenDateTime:
        @classmethod
        def now(cls):
            return fixed_now

    monkeypatch.setattr(module, "datetime", FrozenDateTime)

    first = {
        "text": "first response",
        "label": "dup",
        "source_url": "https://chatgpt.com/c/dup",
        "captured_at": "2026-03-10T12:34:56+09:00",
    }
    second = {
        "text": "second response",
        "label": "dup",
        "source_url": "https://chatgpt.com/c/dup",
        "captured_at": "2026-03-10T12:34:57+09:00",
    }

    for payload in (first, second):
        status, body, _ = invoke_request(module, body=json.dumps(payload).encode("utf-8"))
        assert status == 200
        assert json.loads(body)["ok"] is True

    bundle_names = sorted(path.name for path in save_root.iterdir() if path.is_dir())
    assert bundle_names == ["20260310-123456-dup", "20260310-123456-dup-2"]
    assert "first response" in (save_root / "20260310-123456-dup" / "response.md").read_text(encoding="utf-8")
    assert "second response" in (save_root / "20260310-123456-dup-2" / "response.md").read_text(encoding="utf-8")
    assert notifications == [("dup", len("first response")), ("dup", len("second response"))]


def test_disallowed_origin_returns_403_with_null_cors_origin(receiver_app):
    module, _, notifications = receiver_app
    payload = {
        "text": "blocked",
        "label": "bad-origin",
        "source_url": "https://chatgpt.com/c/bad-origin",
        "captured_at": "2026-03-10T12:34:56+09:00",
    }
    status, body, headers = invoke_request(
        module,
        body=json.dumps(payload).encode("utf-8"),
        origin="https://evil.example",
    )

    assert status == 403
    assert "origin not allowed" in json.loads(body)["error"]
    assert headers["Access-Control-Allow-Origin"] == "null"
    assert notifications == []
