#!/usr/bin/env python3
"""Derive per-action backdrop windows from a U-client capture.

The detector deliberately knows nothing about owner ids or action names.  The
capture metadata is the first gate: an action can have a backdrop only when
``authoredViewport.enabled`` or ``authoredFullscreen.enabled`` is true.  The
second gate is per-frame RGBA evidence, so a viewport/fullscreen flag does not
turn a whole action into a black rectangle.  The result is an aggregate JSON
file with continuous ``backgroundWindows`` ranges (frame and seconds).

This is a read-only analysis tool.  It does not edit SWF/AS3 sources or the
capture metadata files.  Pillow is the only dependency.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError as error:  # pragma: no cover - environment/setup failure
    raise SystemExit("Pillow is required for backdrop-window derivation") from error


SCHEMA = "seer2-uclient-backdrop-windows-v2"
POLICY = "authored-viewport-fullscreen-pixel-evidence-v2"
ALPHA_VISIBLE = 8
ALPHA_OPAQUE = 245


def _fraction(histogram: list[int], first: int) -> float:
    total = sum(histogram)
    return sum(histogram[first:]) / float(total) if total else 0.0


def _alpha_fraction(alpha: Image.Image, box: tuple[int, int, int, int], first: int) -> float:
    return _fraction(alpha.crop(box).histogram(), first)


def _edge_boxes(box: tuple[int, int, int, int], band: int) -> tuple[tuple[int, int, int, int], ...]:
    left, top, right, bottom = box
    band = max(1, min(band, right - left, bottom - top))
    return (
        (left, top, right, min(bottom, top + band)),
        (left, max(top, bottom - band), right, bottom),
        (left, min(bottom, top + band), min(right, left + band), max(top, bottom - band)),
        (max(left, right - band), min(bottom, top + band), right, max(top, bottom - band)),
    )


def _frame_evidence(path: Path, mode: str, viewport: dict[str, Any] | None) -> dict[str, Any]:
    with Image.open(path) as source:
        image = source.convert("RGBA")
    width, height = image.size
    alpha = image.getchannel("A")
    stage = (0, 0, width, height)
    band = max(2, round(min(width, height) * 0.0125))
    stage_visible = _alpha_fraction(alpha, stage, ALPHA_VISIBLE)
    stage_opaque = _alpha_fraction(alpha, stage, ALPHA_OPAQUE)
    stage_edges = _edge_boxes(stage, band)
    edge_visible = sum(_alpha_fraction(alpha, item, ALPHA_VISIBLE) for item in stage_edges) / len(stage_edges)
    edge_opaque = sum(_alpha_fraction(alpha, item, ALPHA_OPAQUE) for item in stage_edges) / len(stage_edges)

    viewport_fill = 0.0
    viewport_boundary = 0.0
    viewport_horizontal = 0.0
    viewport_vertical = 0.0
    viewport_box: tuple[int, int, int, int] | None = None
    if mode == "viewport" and viewport:
        x = max(0, min(width - 1, int(viewport.get("x", 0))))
        y = max(0, min(height - 1, int(viewport.get("y", 0))))
        right = max(x + 1, min(width, x + max(1, int(viewport.get("width", width)))))
        bottom = max(y + 1, min(height, y + max(1, int(viewport.get("height", height)))))
        viewport_box = (x, y, right, bottom)
        viewport_fill = _alpha_fraction(alpha, viewport_box, ALPHA_VISIBLE)
        local_band = max(2, round(min(right - x, bottom - y) * 0.016))
        edges = _edge_boxes(viewport_box, local_band)
        values = [_alpha_fraction(alpha, item, ALPHA_VISIBLE) for item in edges]
        viewport_horizontal = (values[0] + values[1]) / 2.0
        viewport_vertical = (values[2] + values[3]) / 2.0
        # A board can intentionally have transparent side gutters.  Use the
        # fill and horizontal boundary independently instead of requiring all
        # four edges, which would reject valid starfield/letterbox backdrops.
        viewport_boundary = max(viewport_horizontal, viewport_vertical)

    if mode == "viewport":
        # The authored board itself is the strongest signal.  The horizontal
        # boundary fallback catches a board entering from an edge before its
        # interior is filled.  A couple of particles cannot pass either gate.
        active = viewport_fill >= 0.42 or viewport_boundary >= 0.34
        score = max(viewport_fill, viewport_boundary)
    elif mode == "fullscreen":
        active = stage_visible >= 0.58 or edge_visible >= 0.34
        score = max(stage_visible, edge_visible)
    else:
        active = False
        score = 0.0

    return {
        "file": path.name,
        "active": bool(active),
        "score": round(score, 6),
        "visibleFraction": round(stage_visible, 6),
        "opaqueFraction": round(stage_opaque, 6),
        "edgeVisibleFraction": round(edge_visible, 6),
        "edgeOpaqueFraction": round(edge_opaque, 6),
        "viewportVisibleFraction": round(viewport_fill, 6),
        "viewportBoundaryVisibleFraction": round(viewport_boundary, 6),
        "viewportHorizontalBoundaryFraction": round(viewport_horizontal, 6),
        "viewportVerticalBoundaryFraction": round(viewport_vertical, 6),
    }


def _close_gaps(values: list[bool], maximum_gap: int) -> list[bool]:
    result = values[:]
    index = 0
    while index < len(result):
        if result[index]:
            index += 1
            continue
        end = index
        while end < len(result) and not result[end]:
            end += 1
        if index > 0 and end < len(result) and end - index <= maximum_gap:
            result[index:end] = [True] * (end - index)
        index = end
    return result


def _remove_short_runs(values: list[bool], minimum_run: int) -> list[bool]:
    result = values[:]
    index = 0
    while index < len(result):
        if not result[index]:
            index += 1
            continue
        end = index
        while end < len(result) and result[end]:
            end += 1
        if end - index < minimum_run:
            result[index:end] = [False] * (end - index)
        index = end
    return result


def _windows(active: list[bool], frame_rate: float, duration: float) -> list[dict[str, int | float]]:
    result: list[dict[str, int | float]] = []
    index = 0
    while index < len(active):
        if not active[index]:
            index += 1
            continue
        end = index
        while end + 1 < len(active) and active[end + 1]:
            end += 1
        result.append({
            "startFrame": index,
            "endFrame": end,
            "startSeconds": round(index / frame_rate, 6),
            "endSeconds": round(min(duration, (end + 1) / frame_rate), 6),
        })
        index = end + 1
    return result


def _enabled_mode(capture: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    fullscreen = capture.get("authoredFullscreen")
    viewport = capture.get("authoredViewport")
    fullscreen_enabled = isinstance(fullscreen, dict) and fullscreen.get("enabled") is True
    viewport_enabled = isinstance(viewport, dict) and viewport.get("enabled") is True
    if fullscreen_enabled and viewport_enabled:
        raise ValueError("capture enables both authoredViewport and authoredFullscreen")
    if fullscreen_enabled:
        return "fullscreen", fullscreen
    if viewport_enabled:
        return "viewport", viewport
    return "none", None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _validate_capture_identity(action_root: Path, capture: dict[str, Any], frames: list[Path]) -> None:
    if str(capture.get("action", "")) != action_root.name:
        raise ValueError(f"capture action/directory mismatch: {action_root}")
    owner_id = capture.get("ownerId")
    if not isinstance(owner_id, int) or isinstance(owner_id, bool) or owner_id <= 0:
        raise ValueError(f"capture ownerId is invalid: {action_root}")
    frame_count = capture.get("frameCount")
    if not isinstance(frame_count, int) or isinstance(frame_count, bool) or frame_count != len(frames):
        raise ValueError(f"capture frame count is invalid: {action_root}")
    if not frames:
        raise ValueError(f"capture has no frames: {action_root}")
    with Image.open(frames[0]) as first:
        width, height = first.size
    viewport = capture.get("authoredViewport")
    if isinstance(viewport, dict) and viewport.get("enabled") is True:
        try:
            x, y = int(viewport["x"]), int(viewport["y"])
            viewport_width, viewport_height = int(viewport["width"]), int(viewport["height"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"authored viewport geometry is incomplete: {action_root}") from error
        if (x < 0 or y < 0 or viewport_width < 1 or viewport_height < 1 or
                x + viewport_width > width or y + viewport_height > height):
            raise ValueError(f"authored viewport geometry is outside the capture: {action_root}")


def analyze_action(action_root: Path) -> dict[str, Any]:
    capture_path = action_root / "capture.json"
    try:
        capture = json.loads(capture_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        capture = {}
    frames = sorted(action_root.glob("frame-*.png"), key=lambda item: item.name)
    _validate_capture_identity(action_root, capture, frames)
    mode, authored = _enabled_mode(capture)
    expected_count = capture.get("frameCount")
    frame_rate = float(capture.get("frameRate", 30.0) or 30.0)
    duration = float(capture.get("durationSeconds", len(frames) / frame_rate if frame_rate else 0.0) or 0.0)

    evidence = [_frame_evidence(path, mode, authored) for path in frames]
    active = [bool(item["active"]) for item in evidence]
    # Do not manufacture a backdrop for actions without authored evidence.
    if mode == "none":
        active = [False] * len(frames)
    else:
        active = _close_gaps(active, max(1, round(frame_rate * 0.10)))
        active = _remove_short_runs(active, max(2, round(frame_rate * 0.12)))
    windows = _windows(active, frame_rate, duration)
    if mode != "none" and not windows:
        raise ValueError(f"authored background produced no evidence window: {action_root}")

    max_score = max((item["score"] for item in evidence), default=0.0)
    return {
        "action": str(capture.get("action", action_root.name)),
        "actionDirectory": action_root.name,
        "ownerId": int(capture["ownerId"]),
        "captureJsonSha256": _sha256(capture_path),
        "backgroundMode": mode,
        "authoredBackgroundEnabled": mode != "none",
        "requiresOpaqueBackdrop": mode != "none",
        "backgroundWindows": windows,
        "frameRate": frame_rate,
        "frameCount": len(frames),
        "captureFrameCount": expected_count,
        "durationSeconds": duration,
        "maxEvidenceScore": round(max_score, 6),
        "evidenceThresholds": {
            "alphaVisible": ALPHA_VISIBLE,
            "viewportFill": 0.42,
            "viewportBoundary": 0.34,
            "fullscreenVisible": 0.58,
            "fullscreenEdge": 0.34,
            "gapSeconds": 0.10,
            "minimumWindowSeconds": 0.12,
        },
        "evidence": evidence,
    }


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.part-", dir=str(path.parent), text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.capture_root.resolve()
    if not root.is_dir():
        raise SystemExit(f"Capture root does not exist: {root}")
    actions = [item for item in sorted(root.iterdir(), key=lambda item: item.name.casefold())
               if item.is_dir() and (item / "capture.json").is_file()]
    reports = [analyze_action(item) for item in actions]
    if not reports:
        raise SystemExit("Capture root has no action captures")
    owner_ids = {int(item["ownerId"]) for item in reports}
    action_names = [str(item["action"]) for item in reports]
    if len(owner_ids) != 1 or len(action_names) != len(set(action_names)):
        raise SystemExit("Capture actions do not have one owner and a unique action set")
    capture_evidence = {
        "ownerId": next(iter(owner_ids)),
        "actions": [{key: item[key] for key in (
            "action", "actionDirectory", "captureJsonSha256", "frameRate",
            "frameCount", "durationSeconds")} for item in reports],
    }
    capture_evidence["fingerprintSha256"] = hashlib.sha256(
        json.dumps(capture_evidence, ensure_ascii=False, separators=(",", ":"),
                   sort_keys=True).encode("utf-8")).hexdigest().upper()
    result = {
        "schema": SCHEMA,
        "policy": POLICY,
        "ownerIndependent": True,
        "actionNameIndependent": True,
        "captureRoot": str(root),
        "captureEvidence": capture_evidence,
        "actions": reports,
    }
    output = args.output.resolve() if args.output else (root / "backdrop-windows.json")
    _write_json_atomic(output, result)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
