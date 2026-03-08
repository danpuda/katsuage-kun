#!/usr/bin/env python3
"""GPT54-Scholar receiver v5

ChatGPT Web から本文と添付ファイル参照を受け取り、
Git 管理下の docs/gpt54-responses/ に保存するローカルHTTPサーバー。

Endpoints:
- POST /response : 本文保存。bundle_id を返す
- POST /file     : 添付ファイル実体 or 参照メタデータ保存
- OPTIONS        : CORS preflight

使い方:
    python3 gpt54_receiver_v5.py

環境変数で上書き可能:
    GPT54_REPO=/path/to/repo
    GPT54_TOKEN=scholar-v4-rob
    GPT54_PORT=8854
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
import re
import os
import re
import subprocess
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, List, Tuple

HOST = '127.0.0.1'
PORT = int(os.environ.get('GPT54_PORT', '8854'))
REPO = Path(os.environ.get('GPT54_REPO', '/home/yama/fx-backtest-v2')).resolve()
SAVE_ROOT = REPO / 'docs' / 'gpt54-responses'
NOTIFY_FILE = Path('/tmp/gpt54-latest')
TOKEN = os.environ.get('GPT54_TOKEN', 'scholar-v4-rob')
ALLOWED_ORIGINS = {'https://chatgpt.com', 'https://chat.openai.com'}
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_FILE_BYTES = 25 * 1024 * 1024
INDEX_FILE = SAVE_ROOT / '.bundle-index.json'


INJECT_QUEUE_DIR = Path('/tmp/gpt54-inject-queue')
INJECT_QUEUE_DIR.mkdir(parents=True, exist_ok=True)
MAX_INJECT_BYTES = 512 * 1024
INJECT_LEASE_SECONDS = 120

SAVE_ROOT.mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return datetime.now().isoformat(timespec='seconds')


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sanitize_label(label: str) -> str:
    label = re.sub(r'\s+', ' ', label or '').strip()
    label = re.sub(r'[\\/:*?"<>|]+', '_', label)
    label = re.sub(r'[^0-9A-Za-z._\-\u3040-\u30ff\u3400-\u9fff ]+', '_', label)
    label = label.strip(' ._')
    return (label or 'response')[:60]


def sanitize_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]+', '_', name or '').strip()
    name = name.replace('\x00', '_')
    name = re.sub(r'\s+', ' ', name)
    name = name.strip(' .') or 'attachment.bin'
    return name[:120]


def load_index() -> Dict[str, str]:
    if not INDEX_FILE.exists():
        return {}
    try:
        return json.loads(INDEX_FILE.read_text(encoding='utf-8'))
    except Exception:
        return {}


def save_index(index: Dict[str, str]) -> None:
    INDEX_FILE.write_text(json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True), encoding='utf-8')


def read_json_request(handler: BaseHTTPRequestHandler, max_bytes: int) -> Dict[str, Any]:
    length_header = handler.headers.get('Content-Length', '0')
    try:
        length = int(length_header)
    except ValueError as exc:
        raise ValueError(f'invalid Content-Length: {length_header}') from exc

    if length <= 0:
        raise ValueError('empty body')
    if length > max_bytes:
        raise OverflowError(f'payload too large: {length} > {max_bytes}')

    body = handler.rfile.read(length)
    if len(body) != length:
        raise ValueError('incomplete request body')
    try:
        data = json.loads(body.decode('utf-8'))
    except json.JSONDecodeError as exc:
        raise ValueError(f'invalid json: {exc}') from exc
    if not isinstance(data, dict):
        raise ValueError('json must be an object')
    return data


def append_attachment_record(meta: Dict[str, Any], record: Dict[str, Any]) -> None:
    items = meta.setdefault('saved_attachments', [])
    record_key = (record.get('name'), record.get('sha256'), record.get('raw_href'), record.get('resolved_href'))
    for existing in items:
        existing_key = (existing.get('name'), existing.get('sha256'), existing.get('raw_href'), existing.get('resolved_href'))
        if existing_key == record_key:
            existing.update(record)
            return
    items.append(record)


def load_meta(bundle_dir: Path) -> Dict[str, Any]:
    meta_path = bundle_dir / 'meta.json'
    if not meta_path.exists():
        return {}
    return json.loads(meta_path.read_text(encoding='utf-8'))


def save_meta(bundle_dir: Path, meta: Dict[str, Any]) -> None:
    (bundle_dir / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2, sort_keys=True), encoding='utf-8')



def write_json_file(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding='utf-8')

def read_json_file(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))

def sanitize_inject_id(inject_id: str) -> str:
    return re.sub(r'[^0-9A-Za-z._-]+', '_', inject_id or '').strip('._-')[:120] or 'inject'

def build_inject_id(text: str) -> str:
    ts = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    short_sha = sha256_hex(text.encode('utf-8'))[:12]
    return f'inject-{ts}-{short_sha}'

def inject_path_for(inject_id: str) -> Path:
    return INJECT_QUEUE_DIR / f'{sanitize_inject_id(inject_id)}.json'

def list_inject_files():
    return sorted(INJECT_QUEUE_DIR.glob('inject-*.json'))

def queue_inject_prompt(text: str, chat_url: str):
    inject_id = build_inject_id(text)
    item = {
        'inject_id': inject_id, 'text': text, 'chat_url': chat_url,
        'status': 'pending', 'created_at': now_iso(),
        'leased_at': '', 'lease_until_epoch': 0, 'acked_at': '',
    }
    write_json_file(inject_path_for(inject_id), item)
    return item

def claim_next_inject():
    now_epoch = int(time.time())
    for path in list_inject_files():
        try:
            item = read_json_file(path)
        except Exception:
            continue
        status = str(item.get('status', 'pending'))
        lease_until_epoch = int(item.get('lease_until_epoch', 0) or 0)
        if status == 'acked':
            try: path.unlink()
            except FileNotFoundError: pass
            continue
        if status == 'leased' and lease_until_epoch > now_epoch:
            continue
        item['status'] = 'leased'
        item['leased_at'] = now_iso()
        item['lease_until_epoch'] = now_epoch + INJECT_LEASE_SECONDS
        write_json_file(path, item)
        return item
    return None

def ack_inject_prompt(inject_id: str) -> bool:
    path = inject_path_for(inject_id)
    if not path.exists():
        return False
    item = read_json_file(path)
    item['status'] = 'acked'
    item['acked_at'] = now_iso()
    item['lease_until_epoch'] = 0
    write_json_file(path, item)
    try: path.unlink()
    except FileNotFoundError: pass
    return True

def git_commit(paths: List[Path], message: str) -> Tuple[bool, str]:
    rel_paths = [str(p.relative_to(REPO)) if p.is_absolute() else str(p) for p in paths]

    add_proc = subprocess.run(
        ['git', 'add', '--'] + rel_paths,
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if add_proc.returncode != 0:
        return False, f'git add failed: {add_proc.stderr.strip() or add_proc.stdout.strip()}'

    diff_proc = subprocess.run(
        ['git', 'diff', '--cached', '--quiet', '--exit-code', '--'] + rel_paths,
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if diff_proc.returncode == 0:
        return True, 'no changes'
    if diff_proc.returncode != 1:
        return False, f'git diff failed: {diff_proc.stderr.strip() or diff_proc.stdout.strip()}'

    commit_proc = subprocess.run(
        ['git', 'commit', '-m', message],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if commit_proc.returncode != 0:
        return False, f'git commit failed: {commit_proc.stderr.strip() or commit_proc.stdout.strip()}'
    return True, commit_proc.stdout.strip() or 'committed'


class Handler(BaseHTTPRequestHandler):
    server_version = 'GPT54Receiver/5.0'

    def _origin_for_response(self) -> str:
        origin = self.headers.get('Origin', '')
        return origin if origin in ALLOWED_ORIGINS else 'https://chatgpt.com'

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', self._origin_for_response())
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Rob-Token')
        self.end_headers()
        self.wfile.write(body)

    def _reject_if_forbidden(self) -> Tuple[bool, Dict[str, Any] | None]:
        origin = self.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            return True, {'ok': False, 'error': f'origin not allowed: {origin}'}
        token = self.headers.get('X-Rob-Token', '')
        if token != TOKEN:
            return True, {'ok': False, 'error': 'invalid X-Rob-Token'}
        return False, None

    def do_OPTIONS(self) -> None:
        origin = self.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            self._send_json(403, {'ok': False, 'error': f'origin not allowed: {origin}'})
            return
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', self._origin_for_response())
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Rob-Token')
        self.end_headers()


    def do_GET(self) -> None:
        blocked, payload = self._reject_if_forbidden()
        if blocked:
            self._send_json(401 if payload and payload.get('error') == 'invalid X-Rob-Token' else 403, payload or {'ok': False})
            return
        try:
            if self.path == '/inject/next':
                self.handle_inject_next_get()
            else:
                self._send_json(404, {'ok': False, 'error': f'unknown path: {self.path}'})
        except Exception as exc:
            self._send_json(500, {'ok': False, 'error': f'internal error: {exc}'})

    def do_POST(self) -> None:
        blocked, payload = self._reject_if_forbidden()
        if blocked:
            self._send_json(401 if payload and payload.get('error') == 'invalid X-Rob-Token' else 403, payload or {'ok': False})
            return

        try:
            if self.path == '/response':
                self.handle_response_post()
            elif self.path == '/file':
                self.handle_file_post()
            elif self.path == '/inject':
                self.handle_inject_post()
            elif self.path == '/inject/ack':
                self.handle_inject_ack_post()
            else:
                self._send_json(404, {'ok': False, 'error': f'unknown path: {self.path}'})
        except OverflowError as exc:
            self._send_json(413, {'ok': False, 'error': str(exc)})
        except ValueError as exc:
            self._send_json(400, {'ok': False, 'error': str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._send_json(500, {'ok': False, 'error': f'internal error: {exc}'})

    def handle_response_post(self) -> None:
        body = read_json_request(self, MAX_BODY_BYTES)

        text = str(body.get('text', ''))
        if not text.strip():
            raise ValueError('text is required')

        text_bytes = text.encode('utf-8')
        text_sha = sha256_hex(text_bytes)
        expected_sha = str(body.get('text_sha256', '')).strip()
        if expected_sha and expected_sha != text_sha:
            raise ValueError('text_sha256 mismatch')

        label = sanitize_label(str(body.get('label', 'response')))
        source_url = str(body.get('source_url', '')).strip()
        attachments_discovered = body.get('attachments_discovered', [])
        if not isinstance(attachments_discovered, list):
            raise ValueError('attachments_discovered must be a list')

        client_fingerprint = str(body.get('client_fingerprint', '')).strip()
        bundle_index = load_index()
        bundle_id = bundle_index.get(client_fingerprint, '') if client_fingerprint else ''
        deduped = False

        if bundle_id:
            bundle_dir = SAVE_ROOT / bundle_id
            deduped = bundle_dir.exists()
        else:
            ts = datetime.now().strftime('%Y%m%d-%H%M%S')
            short_sha = text_sha[:12]
            bundle_id = f'{ts}-{label}-{short_sha}'
            bundle_dir = SAVE_ROOT / bundle_id
            counter = 1
            while bundle_dir.exists():
                counter += 1
                bundle_id = f'{ts}-{label}-{short_sha}-{counter}'
                bundle_dir = SAVE_ROOT / bundle_id

        bundle_dir.mkdir(parents=True, exist_ok=True)
        attachments_dir = bundle_dir / 'attachments'
        attachments_dir.mkdir(exist_ok=True)

        response_path = bundle_dir / 'response.md'
        meta_path = bundle_dir / 'meta.json'

        if not deduped or not response_path.exists():
            lines = [
                f'# GPT-5.4 Response: {label}',
                '',
                f'- saved_at: {now_iso()}',
                f'- source_url: {source_url or "(unknown)"}',
                f'- text_sha256: `{text_sha}`',
                f'- attachments_discovered: {len(attachments_discovered)}',
                '',
                '---',
                '',
                text.rstrip(),
                ''
            ]
            response_path.write_text('\n'.join(lines), encoding='utf-8')

        meta = load_meta(bundle_dir) if meta_path.exists() else {}
        meta.update({
            'bundle_id': bundle_id,
            'label': label,
            'saved_at': meta.get('saved_at', now_iso()),
            'last_seen_at': now_iso(),
            'source_url': source_url,
            'text_sha256': text_sha,
            'client_fingerprint': client_fingerprint,
            'attachments_discovered': attachments_discovered,
        })
        save_meta(bundle_dir, meta)

        # v7.5: sandbox_files — Canvas/sandboxファイル内容を保存
        sandbox_files = body.get('sandbox_files', [])
        if isinstance(sandbox_files, list):
            for sf in sandbox_files:
                sf_name = sanitize_filename(str(sf.get('name', 'artifact.txt')))
                sf_content = str(sf.get('content', ''))
                sf_path_hint = str(sf.get('sandbox_path', ''))
                if not sf_content:
                    continue

                sf_file_path = attachments_dir / sf_name
                sf_counter = 2
                while sf_file_path.exists():
                    stem = Path(sf_name).stem
                    suffix = Path(sf_name).suffix
                    sf_file_path = attachments_dir / f'{stem}-{sf_counter}{suffix}'
                    sf_counter += 1

                sf_file_path.write_text(sf_content, encoding='utf-8')
                sf_record = {
                    'name': sf_name,
                    'kind': 'canvas-artifact',
                    'sandbox_path': sf_path_hint,
                    'reference_only': False,
                    'path': str(sf_file_path.relative_to(REPO)),
                    'size': len(sf_content.encode('utf-8')),
                    'sha256': sha256_hex(sf_content.encode('utf-8')),
                    'saved_at': now_iso(),
                }
                append_attachment_record(meta, sf_record)
                print(
                    f'📄 {datetime.now().strftime("%H:%M:%S")} canvas artifact saved: {bundle_id}/{sf_name} '
                    f'({len(sf_content)} chars)',
                    flush=True,
                )
            if sandbox_files:
                save_meta(bundle_dir, meta)

        if client_fingerprint and client_fingerprint not in bundle_index:
            bundle_index[client_fingerprint] = bundle_id
            save_index(bundle_index)

        ok, detail = git_commit(
            [response_path, meta_path, attachments_dir, INDEX_FILE],
            f'📥 GPT-5.4 auto: {bundle_id}'
        )
        if not ok:
            raise RuntimeError(detail)

        print(
            f'📥 {datetime.now().strftime("%H:%M:%S")} response saved: {bundle_id} '
            f'({len(text)} chars, attachments={len(attachments_discovered)}, deduped={deduped})',
            flush=True,
        )
        NOTIFY_FILE.write_text(f'{response_path}\n{now_iso()}\n', encoding='utf-8')

        # ロブ🦞にagent turn通知（Telegram経由）— 同じlabelは5分に1回に制限
        sf_count = len([sf for sf in sandbox_files if sf.get('content')]) if isinstance(sandbox_files, list) else 0
        _now_epoch = int(time.time())
        _last_notify = getattr(self.__class__, '_notify_history', {})
        _last_time = _last_notify.get(label, 0)
        if _now_epoch - _last_time >= 300:  # 5分throttle
            _sf_info = f' / 📄Canvas: {sf_count}ファイル' if sf_count > 0 else ''
            _notify_msg = (
                f'📥 😎スーパーメガネから返答が来た。以下を実行しろ:\n'
                f'1. cat {response_path} で中身を読め\n'
                f'2. コードが含まれてたら該当ファイルに配置しろ\n'
                f'3. テストがあれば実行しろ\n'
                f'4. 結果をやまちゃん🗻にTelegramで報告しろ\n'
                f'bundle: {bundle_id} / {len(text)}文字 / label: {label}{_sf_info}'
            )
            try:
                subprocess.Popen(
                    ['openclaw', 'agent',
                     '--agent', 'main',
                     '--deliver',
                     '--channel', 'telegram',
                     '--message', _notify_msg],
                    cwd=str(REPO),
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                _last_notify[label] = _now_epoch
                self.__class__._notify_history = _last_notify
                print(f'🔔 agent turn起動: {label}', flush=True)
            except Exception as _e:
                print(f'⚠️ agent turn起動失敗: {_e}', flush=True)
        else:
            print(f'⏭ 通知throttle: {label} (残{300-(_now_epoch-_last_time)}秒)', flush=True)

        self._send_json(200, {
            'ok': True,
            'bundle_id': bundle_id,
            'bundle_dir': str(bundle_dir),
            'deduped': deduped,
            'git': detail,
        })

    def handle_file_post(self) -> None:
        body = read_json_request(self, MAX_FILE_BYTES * 2)

        bundle_id = str(body.get('bundle_id', '')).strip()
        if not bundle_id:
            raise ValueError('bundle_id is required')

        bundle_dir = SAVE_ROOT / bundle_id
        if not bundle_dir.exists():
            self._send_json(404, {'ok': False, 'error': f'bundle not found: {bundle_id}'})
            return

        attachments_dir = bundle_dir / 'attachments'
        attachments_dir.mkdir(exist_ok=True)
        meta = load_meta(bundle_dir)

        name = sanitize_filename(str(body.get('name', 'attachment.bin')))
        kind = str(body.get('kind', 'url'))
        raw_href = str(body.get('raw_href', ''))
        resolved_href = str(body.get('resolved_href', ''))
        text = str(body.get('text', ''))
        download_attr = str(body.get('download_attr', ''))
        reference_only = bool(body.get('reference_only', False))
        note = str(body.get('note', ''))
        mime_type = str(body.get('mime_type', 'application/octet-stream'))
        declared_size = int(body.get('size', 0) or 0)
        declared_sha = str(body.get('sha256', '')).strip()
        content_b64 = str(body.get('content_base64', ''))

        record: Dict[str, Any] = {
            'name': name,
            'kind': kind,
            'raw_href': raw_href,
            'resolved_href': resolved_href,
            'text': text,
            'download_attr': download_attr,
            'reference_only': reference_only,
            'note': note,
            'mime_type': mime_type,
            'saved_at': now_iso(),
        }

        touched_paths: List[Path] = [bundle_dir / 'meta.json']

        if reference_only:
            append_attachment_record(meta, record)
            save_meta(bundle_dir, meta)
            ok, detail = git_commit(touched_paths, f'📎 GPT-5.4 attachment ref: {bundle_id}/{name}')
            if not ok:
                raise RuntimeError(detail)
            print(f'📎 {datetime.now().strftime("%H:%M:%S")} attachment ref saved: {bundle_id}/{name}', flush=True)
            self._send_json(200, {'ok': True, 'bundle_id': bundle_id, 'reference_only': True, 'git': detail})
            return

        if not content_b64:
            raise ValueError('content_base64 is required unless reference_only=true')

        try:
            binary = base64.b64decode(content_b64, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError('invalid content_base64') from exc

        if len(binary) > MAX_FILE_BYTES:
            raise OverflowError(f'file too large: {len(binary)} > {MAX_FILE_BYTES}')
        if declared_size and declared_size != len(binary):
            raise ValueError('size mismatch')

        actual_sha = sha256_hex(binary)
        if declared_sha and declared_sha != actual_sha:
            raise ValueError('sha256 mismatch')

        file_path = attachments_dir / name
        if file_path.exists() and sha256_hex(file_path.read_bytes()) != actual_sha:
            stem = file_path.stem
            suffix = file_path.suffix
            counter = 2
            while True:
                candidate = attachments_dir / f'{stem}-{counter}{suffix}'
                if not candidate.exists():
                    file_path = candidate
                    break
                counter += 1

        file_path.write_bytes(binary)
        record.update({
            'reference_only': False,
            'path': str(file_path.relative_to(REPO)),
            'size': len(binary),
            'sha256': actual_sha,
        })
        append_attachment_record(meta, record)
        save_meta(bundle_dir, meta)

        touched_paths.extend([file_path])
        ok, detail = git_commit(touched_paths, f'📎 GPT-5.4 attachment: {bundle_id}/{file_path.name}')
        if not ok:
            raise RuntimeError(detail)

        print(
            f'📎 {datetime.now().strftime("%H:%M:%S")} attachment saved: {bundle_id}/{file_path.name} '
            f'({len(binary)} bytes)',
            flush=True,
        )
        self._send_json(200, {
            'ok': True,
            'bundle_id': bundle_id,
            'path': str(file_path),
            'sha256': actual_sha,
            'git': detail,
        })


    def handle_inject_post(self) -> None:
        body = read_json_request(self, MAX_INJECT_BYTES)
        text = str(body.get('text', ''))
        if not text.strip():
            raise ValueError('text is required')
        chat_url = str(body.get('chat_url', '')).strip()
        item = queue_inject_prompt(text=text, chat_url=chat_url)
        print(f'📝 {datetime.now().strftime("%H:%M:%S")} inject queued: {item["inject_id"]} ({len(text)} chars)', flush=True)
        self._send_json(200, {'ok': True, 'inject_id': item['inject_id'], 'pending': True, 'chat_url': chat_url})

    def handle_inject_next_get(self) -> None:
        item = claim_next_inject()
        if not item:
            self._send_json(200, {'ok': True, 'pending': False})
            return
        self._send_json(200, {
            'ok': True, 'pending': True,
            'inject_id': item['inject_id'], 'text': item['text'],
            'chat_url': item.get('chat_url', ''),
            'created_at': item.get('created_at', ''),
            'leased_at': item.get('leased_at', ''),
        })

    def handle_inject_ack_post(self) -> None:
        body = read_json_request(self, 64 * 1024)
        inject_id = str(body.get('inject_id', '')).strip()
        if not inject_id:
            raise ValueError('inject_id is required')
        if not ack_inject_prompt(inject_id):
            self._send_json(404, {'ok': False, 'error': f'inject not found: {inject_id}'})
            return
        print(f'✅ {datetime.now().strftime("%H:%M:%S")} inject acked: {inject_id}', flush=True)
        self._send_json(200, {'ok': True, 'inject_id': inject_id, 'acked': True})

    def log_message(self, fmt: str, *args: Any) -> None:
        # 標準ログは抑制。必要なイベントは自前で print する。
        return


if __name__ == '__main__':
    if not (REPO / '.git').exists():
        print(f'ERROR: git repo not found: {REPO}', file=sys.stderr)
        sys.exit(2)

    print(f'🦞 GPT54 Receiver v5 | {HOST}:{PORT} | repo={REPO} | save={SAVE_ROOT}', flush=True)
    HTTPServer((HOST, PORT), Handler).serve_forever()
