"""JSONL bridge for the bundled CPython/Docling runtime.

This file contains transport code only. Domain and application rules remain in TypeScript.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any

from docling.document_converter import DocumentConverter

PROTOCOL_VERSION = 1


def _block_payload(document_dict: dict[str, Any], markdown: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    cursor = 0
    candidates: list[dict[str, Any]] = []
    for key in ("texts", "tables", "pictures"):
        value = document_dict.get(key, [])
        if isinstance(value, list):
            candidates.extend(item for item in value if isinstance(item, dict))

    for index, item in enumerate(candidates):
        text = str(item.get("text") or item.get("orig") or "").strip()
        if not text:
            continue
        start = markdown.find(text, cursor)
        if start < 0:
            start = cursor
        end = min(len(markdown), start + len(text))
        cursor = end
        provenance = item.get("prov")
        first_provenance = provenance[0] if isinstance(provenance, list) and provenance else {}
        bbox = first_provenance.get("bbox") if isinstance(first_provenance, dict) else None
        block: dict[str, Any] = {
            "id": str(item.get("self_ref") or f"block-{index}"),
            "type": str(item.get("label") or "block"),
            "text": text,
            "markdownStart": start,
            "markdownEnd": end,
        }
        if isinstance(first_provenance, dict) and isinstance(first_provenance.get("page_no"), int):
            block["page"] = first_provenance["page_no"]
        if isinstance(bbox, dict) and all(name in bbox for name in ("l", "t", "r", "b")):
            block["boundingBox"] = {
                "left": bbox["l"],
                "top": bbox["t"],
                "right": bbox["r"],
                "bottom": bbox["b"],
            }
        blocks.append(block)
    return blocks


def convert(request: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    source = Path(request["inputPath"])
    if not source.is_file():
        raise FileNotFoundError(source)

    converter = DocumentConverter()
    conversion = converter.convert(source)
    document = conversion.document
    markdown = document.export_to_markdown().strip()
    if markdown:
        markdown += "\n"
    document_dict = document.export_to_dict()
    blocks = _block_payload(document_dict, markdown)
    confidence_values = [
        block.get("confidence") for block in blocks if isinstance(block.get("confidence"), (int, float))
    ]
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else None
    requires_ocr = not markdown.strip()
    warnings = []
    if requires_ocr:
        warnings.append(
            {
                "code": "empty_result",
                "messageKey": "errors.conversion.emptyResult",
                "recoverable": True,
            }
        )

    result: dict[str, Any] = {
        "status": "requires_ocr" if requires_ocr else "converted",
        "markdown": markdown,
        "contentHash": hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
        "blocks": blocks,
        "assets": [],
        "engine": "docling",
        "engineVersion": "2.111.0",
        "profile": request["profile"],
        "options": request.get("options", {}),
        "warnings": warnings,
        "quality": {"textCoverage": 0 if requires_ocr else 1},
        "metadata": {"durationMs": int((time.monotonic() - started) * 1000)},
        "rawStructuredResult": document_dict,
    }
    if confidence is not None:
        result["quality"]["confidence"] = confidence
    return result


def main() -> int:
    line = sys.stdin.readline()
    if not line:
        return 2
    request: dict[str, Any] = json.loads(line)
    request_id = request.get("requestId", "")
    try:
        if request.get("protocolVersion") != PROTOCOL_VERSION or request.get("command") != "convert":
            raise ValueError("unsupported_protocol")
        response = {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "ok": True,
            "result": convert(request),
        }
    except Exception as error:  # transport boundary normalizes sidecar failures
        response = {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "ok": False,
            "error": {
                "code": type(error).__name__,
                "messageKey": "errors.conversion.doclingFailed",
                "detail": str(error)[:500],
                "recoverable": True,
            },
        }
    sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
