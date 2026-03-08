from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

def read_config(path: str | Path) -> dict[str, Any]:
    """JSON設定ファイルを読み込んで辞書として返す。"""
    config_path = Path(path)

    try:
        with config_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError as e:
        raise FileNotFoundError(f"設定ファイルが見つかりません: {config_path}") from e

    if not isinstance(data, dict):
        raise ValueError("設定ファイルのルート要素はJSONオブジェクトである必要があります。")

    return data

def save_result(data: dict[str, str], output: str | Path) -> None:
    """結果をJSONファイルとして保存する。"""
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    logger.info("saved to %s", output_path)

def process(config_path: str | Path, output_path: str | Path) -> None:
    """設定を読み込み、値を大文字化して保存する。"""
    config = read_config(config_path)
    result: dict[str, str] = {}

    for key, value in config.items():
        if not isinstance(value, str):
            raise ValueError(
                f"キー '{key}' の値は文字列である必要があります "
                f"(got {type(value).__name__})"
            )
        result[str(key)] = value.upper()

    save_result(result, output_path)

def main() -> int:
    parser = argparse.ArgumentParser(description="設定ファイルを処理する")
    parser.add_argument("config", nargs="?", default="config.json", help="入力JSONパス")
    parser.add_argument("output", nargs="?", default="output.json", help="出力JSONパス")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    try:
        process(args.config, args.output)
    except (FileNotFoundError, json.JSONDecodeError, ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    return 0

if __name__ == "__main__":
    raise SystemExit(main())

