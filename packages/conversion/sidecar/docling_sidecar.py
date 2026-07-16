"""JSONL bridge for the bundled CPython/Docling runtime.

This file contains transport code only. Domain and application rules remain in TypeScript.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

from docling.datamodel.base_models import InputFormat
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline

PROTOCOL_VERSION = 3

ProgressReporter = Callable[[str, float, int | None, int | None], None]
_progress_reporter: ProgressReporter | None = None


def _report_progress(
    stage: str,
    progress: float,
    completed_pages: int | None = None,
    total_pages: int | None = None,
) -> None:
    if _progress_reporter is not None:
        _progress_reporter(stage, progress, completed_pages, total_pages)


class _ProgressOutputQueue:
    """Observe completed pages while preserving Docling's original output queue."""

    def __init__(self, delegate: Any, total_pages: int) -> None:
        self._delegate = delegate
        self._total_pages = total_pages
        self._completed_page_numbers: set[int] = set()

    def get_batch(self, size: int, timeout: float | None = None) -> list[Any]:
        batch = self._delegate.get_batch(size, timeout)
        for item in batch:
            page_no = getattr(item, "page_no", None)
            if isinstance(page_no, int) and page_no > 0:
                self._completed_page_numbers.add(page_no)
        if batch:
            completed = min(len(self._completed_page_numbers), self._total_pages)
            fraction = completed / self._total_pages
            _report_progress(
                "processing_pages",
                0.1 + (0.8 * fraction),
                completed,
                self._total_pages,
            )
        return batch

    def close(self) -> None:
        self._delegate.close()

    @property
    def closed(self) -> bool:
        return bool(self._delegate.closed)


class ProgressPdfPipeline(StandardPdfPipeline):
    """Standard threaded PDF pipeline with non-invasive page completion events."""

    def __init__(self, pipeline_options: Any) -> None:
        self._progress_total_pages = 0
        super().__init__(pipeline_options)

    def _build_document(self, conv_res: Any) -> Any:
        self._progress_total_pages = len(self._get_expected_page_nos(conv_res))
        if self._progress_total_pages > 0:
            _report_progress(
                "processing_pages",
                0.1,
                0,
                self._progress_total_pages,
            )
        return super()._build_document(conv_res)

    def _create_run_ctx(self) -> Any:
        context = super()._create_run_ctx()
        if self._progress_total_pages > 0:
            context.output_queue = _ProgressOutputQueue(
                context.output_queue,
                self._progress_total_pages,
            )
        return context


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
            "readingOrder": index,
            "childrenRefs": [
                str(child.get("$ref"))
                for child in item.get("children", [])
                if isinstance(child, dict) and child.get("$ref")
            ],
        }
        parent = item.get("parent")
        if isinstance(parent, dict) and parent.get("$ref"):
            block["parentRef"] = str(parent["$ref"])
        charspan = first_provenance.get("charspan") if isinstance(first_provenance, dict) else None
        if (
            isinstance(charspan, list)
            and len(charspan) == 2
            and all(isinstance(value, int) and value >= 0 for value in charspan)
        ):
            block["sourceCharspan"] = charspan
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
    max_input_bytes = request.get("maxInputBytes")
    if isinstance(max_input_bytes, int) and source.stat().st_size > max_input_bytes:
        raise ValueError("input_size_limit_exceeded")

    _report_progress("loading_engine", 0.02)
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_cls=ProgressPdfPipeline)
        }
    )
    _report_progress("loading_engine", 0.07)
    options = request.get("options", {})
    max_pages = options.get("maxPages") if isinstance(options, dict) else None
    page_start = request.get("pageStart")
    page_end = request.get("pageEnd")
    page_range = None
    if isinstance(page_start, int) and isinstance(page_end, int):
        if page_start > page_end:
            raise ValueError("invalid_page_range")
        page_range = (page_start, page_end)
    if source.suffix.lower() != ".pdf":
        _report_progress("converting_document", 0.12)
    conversion = converter.convert(
        source,
        **({"max_num_pages": max_pages} if isinstance(max_pages, int) and max_pages > 0 else {}),
        **({"page_range": page_range} if page_range else {}),
    )
    _report_progress("serializing", 0.92)
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
        "documentStructure": {
            "body": document_dict.get("body", {}).get("children", [])
            if isinstance(document_dict.get("body"), dict)
            else [],
            "groups": document_dict.get("groups", [])
            if isinstance(document_dict.get("groups"), list)
            else [],
            "pageCount": len(document_dict.get("pages", {}))
            if isinstance(document_dict.get("pages"), dict)
            else 0,
        },
        "rawStructuredResult": document_dict,
    }
    if confidence is not None:
        result["quality"]["confidence"] = confidence
    _report_progress("serializing", 0.99)
    return result


def main() -> int:
    global _progress_reporter
    line = sys.stdin.readline()
    if not line:
        return 2
    request: dict[str, Any] = json.loads(line)
    request_id = request.get("requestId", "")

    def emit_progress(
        stage: str,
        progress: float,
        completed_pages: int | None,
        total_pages: int | None,
    ) -> None:
        event: dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "type": "progress",
            "stage": stage,
            "progress": max(0.0, min(1.0, progress)),
        }
        if completed_pages is not None:
            event["completedPages"] = completed_pages
        if total_pages is not None:
            event["totalPages"] = total_pages
        sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    _progress_reporter = emit_progress
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
    _progress_reporter = None
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
