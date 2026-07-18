# Conversion, structure, and asset rules

Load this rule for file/web conversion, normalized Markdown, structure
detection, Docling, OCR, chunking, SourceSpans, or managed assets.

## Routing by content type

- Rendered web pages use Defuddle as the primary extractor.
- PDF, DOCX, PPTX, XLSX, EPUB, OpenDocument formats, and images requiring OCR
  use the packaged Docling sidecar.
- TXT, Markdown, CSV, JSON, XML, RSS, Atom, IPYNB, and simple local HTML use
  native TypeScript converters in `@app/conversion`.
- YouTube uses `youtubei.js` for metadata and transcripts when available.
- ZIP/container input is extracted with byte, entry-count, depth, compression,
  and path-traversal limits; each entry returns to the conversion router.

`@app/conversion` receives authorized inputs and returns structured results. It
does not access the database; desktop services persist through `@app/db`.

## Normalized result

Every ingested textual source becomes normalized Markdown. The dialect supports
GFM, inline HTML when Markdown cannot preserve table structure, LaTeX formulas,
and relative managed-asset references.

Record engine and version, options/profile, hashes, warnings, extracted
metadata, and quality/confidence when available. Complex results preserve block
order, page, bounding box, source char span, stable block reference, and mapping
to normalized Markdown offsets. Preserve useful raw `DoclingDocument` data as a
derived asset.

Never claim success for empty, corrupted, or low-coverage output. Produce a
recoverable warning/status such as `requires_ocr`. Password-protected, corrupt,
DRM-protected, ambiguous, or limit-exceeding input fails explicitly; do not
circumvent protection or produce a silent partial hierarchy.

## Docling boundary

- Docling runs in its packaged CPython sidecar, offline by default, over
  versioned JSONL on stdin/stdout; it exposes no network port.
- Requests, progress events, and responses are Zod-validated and correlated by
  request ID. The current protocol version is `3`.
- The desktop/controlled worker owns start, timeout, cancellation, cleanup,
  crash recovery, and shutdown.
- Runtime never uses system Python or installs packages. Temporary files live
  under controlled application storage and are removed after success, failure,
  or cancellation.
- PDF progress reflects pages completed by Docling's pipeline. Do not split a
  document into unrelated conversions merely to manufacture progress.
- OCR may run automatically on pages without usable searchable text. Advanced
  OCR, handwriting, or VLM processing requires a separate explicit path.

## Structure detection

- EPUB order/hierarchy follows nav.xhtml or NCX, then semantic HTML/spine
  fallbacks. Resolve href/fragment safely and never fetch remote resources.
- PDF order/hierarchy prioritizes outline and page labels, then printed table of
  contents and canonical-Markdown headings supported by Docling page/layout
  evidence.
- Detection evidence and confidence remain explainable and reviewable. Conflicts,
  overlaps, empty ranges, or invalid ordering block materialization until fixed.
- Calibration corpora may stay local and ignored. Convert generalizable cases
  into small deterministic fixtures for normal tests.

## Chunks and provenance

- Chunks are always produced from the current normalized source document, never
  from a summary.
- Chunk boundaries prefer Markdown structure and size constraints while
  preserving deterministic order.
- Every chunk links to its source item, document revision, and SourceSpan.
  SourceSpans preserve Markdown offsets and, when available, page, block ID,
  bounding box, and structured selector back to the original.
- Reprocessing is idempotent. Do not replace chunks that support reviewed
  artifacts; use document revisions and generation history.

## Assets

- Original and derived files use stable IDs and SHA-256 metadata. Optional
  external upload copies use hash-based paths and preserve original filename,
  MIME type, size, storage base, relative path, and role in the database.
- Deduplicate identical content where safe, reject path traversal, and detect
  missing external copies so the user can repair, recopy, or unlink them.
- Large-file copying and hashing use streaming where practical; avoid holding
  original bytes, full Markdown, and full structured JSON in memory together.
