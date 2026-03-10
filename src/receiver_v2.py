#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("GPT54_PORT", "8854"))
REPO = Path(os.environ.get("GPT54_REPO", os.getcwd())).resolve()
SAVE_ROOT = REPO / "docs" / "gpt54-responses"
TOKEN = os.environ.get("GPT54_TOKEN", "scholar-v4-rob")
ALLOWED_ORIGINS = {"https://chatgpt.com", "https://chat.openai.com"}
MAX_BODY_BYTES = 2 * 1024 * 1024
OPENCLAW_PATH = os.environ.get(
    "GPT54_OPENCLAW_PATH",
    "/home/yama/.nvm/versions/node/v22.22.0/bin/openclaw",
)


def sanitize_label(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())
    value = re.sub(r"-{2,}", "-", value).strip("._-")
    return value[:80] or "chatgpt"


def read_json_request(handler: BaseHTTPRequestHandler, max_bytes: int) -> dict:
    raw_len = handler.headers.get("Content-Length", "0")
    try:
        length = int(raw_len)
    except ValueError as exc:
        raise ValueError("invalid Content-Length") from exc
    if length <= 0:
        raise ValueError("empty request body")
    if length > max_bytes:
        raise OverflowError(f"request too large: {length} > {max_bytes}")
    raw = handler.rfile.read(length)
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid json: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ValueError("json body must be an object")
    return data


def unique_dir(base: Path) -> Path:
    candidate = base
    counter = 2
    while True:
        try:
            candidate.mkdir(parents=True, exist_ok=False)
            return candidate
        except FileExistsError:
            candidate = base.with_name(f"{base.name}-{counter}")
            counter += 1


def render_markdown(*, label: str, saved_at: str, captured_at: str, source_url: str, text: str) -> str:
    lines = [
        f"# {label}",
        "",
        f"- saved_at: {saved_at}",
        f"- captured_at: {captured_at or '(unknown)'}",
        f"- source_url: {source_url or '(unknown)'}",
        "",
        "---",
        "",
        text.rstrip(),
        "",
    ]
    return "\n".join(lines)


def render_meta(*, label: str, saved_at: str, captured_at: str, source_url: str, path: Path) -> dict:
    return {
        "label": label,
        "saved_at": saved_at,
        "captured_at": captured_at,
        "source_url": source_url,
        "response_path": str(path),
    }


def notify_rob(label: str, text_len: int, text_preview: str, save_path: str) -> None:
    """ロブ🦞にTelegram通知 + system event（失敗しても無視）"""
    import subprocess
    preview = text_preview[:80].replace('\n', ' ')
    msg = f"📥 GPT回答キャプチャ\n📝 {text_len}文字 | {label}\n💬 {preview}…\n📂 {save_path}"
    # Telegram通知（やまちゃん+ロブに見える）
    try:
        subprocess.Popen(
            [OPENCLAW_PATH, 'message', 'send', '--channel', 'telegram',
             '--target', '8596625967', '--message', msg],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass
    # system event（ロブのセッションに届く）
    try:
        subprocess.Popen(
            [OPENCLAW_PATH, 'system', 'event', '--text', msg, '--mode', 'now'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "GPT54ReceiverV2/2.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def _allow_origin(self) -> str:
        origin = self.headers.get("Origin", "")
        return origin if origin in ALLOWED_ORIGINS else "null"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self._allow_origin())
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Rob-Token")
        self.end_headers()
        self.wfile.write(body)

    def _check_origin(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            raise PermissionError(f"origin not allowed: {origin}")

    def _check_token(self) -> None:
        token = self.headers.get("X-Rob-Token", "")
        if token != TOKEN:
            raise PermissionError("invalid X-Rob-Token")

    def do_OPTIONS(self) -> None:
        try:
            self._check_origin()
        except PermissionError as exc:
            self._send_json(403, {"ok": False, "error": str(exc)})
            return
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", self._allow_origin())
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Rob-Token")
        self.end_headers()

    def do_POST(self) -> None:
        try:
            self._check_origin()
            self._check_token()
            if self.path != "/response":
                self._send_json(404, {"ok": False, "error": f"unknown path: {self.path}"})
                return
            self.handle_response_post()
        except PermissionError as exc:
            self._send_json(403, {"ok": False, "error": str(exc)})
        except OverflowError as exc:
            self._send_json(413, {"ok": False, "error": str(exc)})
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": f"internal error: {exc}"})

    def handle_response_post(self) -> None:
        body = read_json_request(self, MAX_BODY_BYTES)

        text = str(body.get("text", "")).strip()
        if not text:
            raise ValueError("text is required")

        label = sanitize_label(body.get("label", ""))
        source_url = str(body.get("source_url", "")).strip()
        captured_at = str(body.get("captured_at", "")).strip()

        now = datetime.now()
        saved_at = now.isoformat(timespec="seconds")
        dir_name = f"{now.strftime('%Y%m%d-%H%M%S')}-{label}"
        bundle_dir = unique_dir(SAVE_ROOT / dir_name)

        response_path = bundle_dir / "response.md"
        response_path.write_text(
            render_markdown(
                label=label,
                saved_at=saved_at,
                captured_at=captured_at,
                source_url=source_url,
                text=text,
            ),
            encoding="utf-8",
        )

        meta_path = bundle_dir / "meta.json"
        meta_path.write_text(
            json.dumps(
                render_meta(
                    label=label,
                    saved_at=saved_at,
                    captured_at=captured_at,
                    source_url=source_url,
                    path=response_path,
                ),
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        print(f"📥 saved: {response_path} ({len(text)}文字)", flush=True)
        notify_rob(label, len(text), text, str(bundle_dir))
        self._send_json(200, {"ok": True, "path": str(response_path)})


def main() -> None:
    SAVE_ROOT.mkdir(parents=True, exist_ok=True)
    with HTTPServer((HOST, PORT), Handler) as server:
        print(f"🦞 GPT54 Receiver v2 | {HOST}:{PORT} | save={SAVE_ROOT}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
