#!/usr/bin/env python3
"""Reject opaque, edge-connected or static full-frame capture backgrounds.

The detector is intentionally independent of owner ids and action names.  It
discovers action directories from capture metadata/frame files, or accepts an
explicit list of action directory names.  Analysis runs on a bounded RGBA grid
so a full five-action capture can be gated without decoding every source pixel
into Python objects.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections import deque
from pathlib import Path
from typing import Any, Iterable

try:
    from PIL import Image
except ImportError as error:  # pragma: no cover - environment failure path
    raise SystemExit("Pillow is required for the U-client capture background gate") from error


SCHEMA = "seer2-uclient-capture-background-gate-v2"
# The final AVM2/FLV1 wrapper uses BlendMode.SCREEN, which intentionally
# flattens transparent pixels to pure black.  Treat a nearly-black edge as
# compositing-safe instead of flagging it as a background rectangle.  Colored
# (including dark blue/brown) edges still fail the boundary checks below.
SCREEN_SAFE_RGB = 8
SCREEN_SAFE_EDGE_FRACTION = 0.90
# A legitimate flash/beam can touch all four edges but has strong spatial
# variation.  A backdrop rectangle is comparatively flat along the border;
# this bound keeps transient high-frequency effects out of the background gate.
MAX_RECTANGULAR_EDGE_VARIANCE = 900.0


def uniformly_sample(items: list[Path], limit: int) -> list[Path]:
    if limit <= 0 or len(items) <= limit:
        return items
    indexes = {
        int(round(index * (len(items) - 1) / (limit - 1)))
        for index in range(limit)
    }
    return [items[index] for index in sorted(indexes)]


def discover_actions(root: Path, explicit: Iterable[str]) -> list[str]:
    requested = [str(item).strip() for item in explicit if str(item).strip()]
    if requested:
        return list(dict.fromkeys(requested))
    result: list[str] = []
    for candidate in sorted(root.iterdir(), key=lambda item: item.name.casefold()):
        if not candidate.is_dir():
            continue
        if (candidate / "capture.json").is_file() or any(candidate.glob("frame-*.png")):
            result.append(candidate.name)
    return result


def edge_indexes(width: int, height: int, band: int) -> list[int]:
    return [
        y * width + x
        for y in range(height)
        for x in range(width)
        if x < band or x >= width - band or y < band or y >= height - band
    ]


def boundary_connected_fraction(mask: list[bool], width: int, height: int) -> float:
    queue: deque[int] = deque()
    seen = bytearray(width * height)

    def seed(index: int) -> None:
        if mask[index] and not seen[index]:
            seen[index] = 1
            queue.append(index)

    for x in range(width):
        seed(x)
        seed((height - 1) * width + x)
    for y in range(1, height - 1):
        seed(y * width)
        seed(y * width + width - 1)

    connected = 0
    while queue:
        index = queue.popleft()
        connected += 1
        x = index % width
        y = index // width
        if x > 0:
            seed(index - 1)
        if x + 1 < width:
            seed(index + 1)
        if y > 0:
            seed(index - width)
        if y + 1 < height:
            seed(index + width)
    return connected / float(width * height)


def largest_internal_component(mask: list[bool], pixels: list[tuple[int, ...]],
                               width: int, height: int, edge_band: int) -> dict[str, float]:
    """Return the largest component that is wholly away from the capture edge.

    This catches a scene board/oval/grid rendered inside transparent margins.  A
    component touching the edge is intentionally excluded because it is covered
    by the existing boundary gate.  Connected-component geometry is combined
    with colour statistics later to distinguish a low-frequency backdrop from a
    moving beam or a handful of particles.
    """
    seen = bytearray(width * height)
    best: dict[str, float] = {
        "areaFraction": 0.0,
        "bboxFillFraction": 0.0,
        "bboxWidthFraction": 0.0,
        "bboxHeightFraction": 0.0,
        "bboxMarginFraction": 1.0,
        "bboxCenterXFraction": 0.5,
        "bboxCenterYFraction": 0.5,
        "colorVariance": 0.0,
        "meanLuminance": 0.0,
    }
    total = width * height

    for start, active in enumerate(mask):
        if not active or seen[start]:
            continue
        queue: deque[int] = deque([start])
        seen[start] = 1
        points: list[int] = []
        touches_edge_band = False
        while queue:
            index = queue.popleft()
            points.append(index)
            x = index % width
            y = index // width
            if x < edge_band or x >= width - edge_band or y < edge_band or y >= height - edge_band:
                touches_edge_band = True
            neighbors = []
            if x > 0:
                neighbors.append(index - 1)
            if x + 1 < width:
                neighbors.append(index + 1)
            if y > 0:
                neighbors.append(index - width)
            if y + 1 < height:
                neighbors.append(index + width)
            for neighbor in neighbors:
                if mask[neighbor] and not seen[neighbor]:
                    seen[neighbor] = 1
                    queue.append(neighbor)
        if touches_edge_band:
            continue
        area = len(points)
        min_x = min(index % width for index in points)
        max_x = max(index % width for index in points)
        min_y = min(index // width for index in points)
        max_y = max(index // width for index in points)
        bbox_area = (max_x - min_x + 1) * (max_y - min_y + 1)
        rgb = [pixels[index][:3] for index in points]
        means = [sum(pixel[channel] for pixel in rgb) / area for channel in range(3)]
        variance = sum(
            sum((pixel[channel] - means[channel]) ** 2 for channel in range(3))
            for pixel in rgb
        ) / (area * 3.0)
        luminance = sum((0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]) for pixel in rgb) / area
        candidate = {
            "areaFraction": area / float(total),
            "bboxFillFraction": area / float(bbox_area),
            "bboxWidthFraction": (max_x - min_x + 1) / float(width),
            "bboxHeightFraction": (max_y - min_y + 1) / float(height),
            "bboxMarginFraction": min(min_x, width - 1 - max_x, min_y, height - 1 - max_y) / float(min(width, height)),
            "bboxCenterXFraction": ((min_x + max_x + 1) * 0.5) / float(width),
            "bboxCenterYFraction": ((min_y + max_y + 1) * 0.5) / float(height),
            "colorVariance": variance,
            "meanLuminance": luminance,
        }
        if candidate["areaFraction"] > best["areaFraction"]:
            best = candidate
    return best


def analyze_frame(path: Path, grid_width: int, opaque_alpha: int) -> dict[str, Any]:
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        source_width, source_height = rgba.size
        grid_height = max(16, int(round(grid_width * source_height / source_width)))
        sampled = rgba.resize((grid_width, grid_height), Image.Resampling.BOX)
        if hasattr(sampled, "get_flattened_data"):
            pixels = list(sampled.get_flattened_data())
        else:  # Pillow < 12
            pixels = list(sampled.getdata())

    alpha = [pixel[3] for pixel in pixels]
    opaque_mask = [value >= opaque_alpha for value in alpha]
    visible_mask = [value > 8 for value in alpha]
    band = max(1, int(round(min(grid_width, grid_height) * 0.035)))
    edge = edge_indexes(grid_width, grid_height, band)
    edge_opaque = sum(1 for index in edge if opaque_mask[index]) / float(len(edge))
    edge_visible = sum(1 for index in edge if visible_mask[index]) / float(len(edge))
    opaque_fraction = sum(opaque_mask) / float(len(opaque_mask))
    visible_fraction = sum(visible_mask) / float(len(visible_mask))
    transparent_fraction = sum(value <= 8 for value in alpha) / float(len(alpha))
    connected_fraction = boundary_connected_fraction(opaque_mask, grid_width, grid_height)
    connected_visible_fraction = boundary_connected_fraction(visible_mask, grid_width, grid_height)
    internal = largest_internal_component(visible_mask, pixels, grid_width, grid_height, band)
    edge_rgb = [pixels[index][:3] for index in edge]
    means = [sum(pixel[channel] for pixel in edge_rgb) / len(edge_rgb) for channel in range(3)]
    screen_safe_edge_fraction = sum(
        1 for pixel in edge_rgb if max(pixel) <= SCREEN_SAFE_RGB
    ) / float(len(edge_rgb))
    variance = sum(
        sum((pixel[channel] - means[channel]) ** 2 for channel in range(3))
        for pixel in edge_rgb
    ) / (len(edge_rgb) * 3.0)

    return {
        "file": path.name,
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "gridWidth": grid_width,
        "gridHeight": grid_height,
        "alphaOpaqueFraction": round(opaque_fraction, 6),
        "alphaVisibleFraction": round(visible_fraction, 6),
        "alphaTransparentFraction": round(transparent_fraction, 6),
        "edgeOpaqueFraction": round(edge_opaque, 6),
        "edgeVisibleFraction": round(edge_visible, 6),
        "boundaryConnectedOpaqueFraction": round(connected_fraction, 6),
        "boundaryConnectedVisibleFraction": round(connected_visible_fraction, 6),
        "internalLargestAreaFraction": round(internal["areaFraction"], 6),
        "internalLargestBboxFillFraction": round(internal["bboxFillFraction"], 6),
        "internalLargestBboxWidthFraction": round(internal["bboxWidthFraction"], 6),
        "internalLargestBboxHeightFraction": round(internal["bboxHeightFraction"], 6),
        "internalLargestBboxMarginFraction": round(internal["bboxMarginFraction"], 6),
        "internalLargestBboxCenterXFraction": round(internal["bboxCenterXFraction"], 6),
        "internalLargestBboxCenterYFraction": round(internal["bboxCenterYFraction"], 6),
        "internalLargestColorVariance": round(internal["colorVariance"], 3),
        "internalLargestMeanLuminance": round(internal["meanLuminance"], 3),
        "screenSafeEdgeFraction": round(screen_safe_edge_fraction, 6),
        "edgeRgbVariance": round(variance, 3),
        "_pixels": pixels,
        "_edge": edge,
    }


def temporal_edge_metrics(frames: list[dict[str, Any]]) -> dict[str, float]:
    if len(frames) < 2:
        return {"stableFraction": 0.0, "meanNormalizedDelta": 1.0}
    stable = 0
    total = 0
    delta_sum = 0
    for previous, current in zip(frames, frames[1:]):
        for index in current["_edge"]:
            left = previous["_pixels"][index]
            right = current["_pixels"][index]
            rgb_delta = abs(left[0] - right[0]) + abs(left[1] - right[1]) + abs(left[2] - right[2])
            alpha_delta = abs(left[3] - right[3])
            delta_sum += rgb_delta / 765.0
            stable += int(rgb_delta <= 24 and alpha_delta <= 8)
            total += 1
    return {
        "stableFraction": round(stable / float(total), 6),
        "meanNormalizedDelta": round(delta_sum / float(total), 6),
    }


def analyze_action(action_root: Path, sample_limit: int, grid_width: int,
                   opaque_alpha: int) -> dict[str, Any]:
    frames = sorted(action_root.glob("frame-*.png"), key=lambda item: item.name)
    errors: list[dict[str, Any]] = []
    if not frames:
        return {
            "action": action_root.name,
            "passed": False,
            "frameCount": 0,
            "sampleCount": 0,
            "errors": [{"code": "frames-missing", "message": "No frame-*.png files were found."}],
        }

    selected = uniformly_sample(frames, sample_limit)
    analyzed = [analyze_frame(path, grid_width, opaque_alpha) for path in selected]
    temporal = temporal_edge_metrics(analyzed)
    persistent_candidates = [
        item for item in analyzed
        if item["alphaOpaqueFraction"] >= 0.97
        and item["edgeOpaqueFraction"] >= 0.95
        and item["boundaryConnectedOpaqueFraction"] >= 0.88
        and item["screenSafeEdgeFraction"] < SCREEN_SAFE_EDGE_FRACTION
    ]
    persistent_ratio = len(persistent_candidates) / float(len(analyzed))
    translucent_boundary_candidates = [
        item for item in analyzed
        if item["alphaVisibleFraction"] >= 0.70
        and item["edgeVisibleFraction"] >= 0.95
        and item["boundaryConnectedVisibleFraction"] >= 0.65
        and item["edgeRgbVariance"] <= MAX_RECTANGULAR_EDGE_VARIANCE
        and (
            item["alphaOpaqueFraction"] >= 0.75
            or item["edgeOpaqueFraction"] >= 0.50
            or item["edgeRgbVariance"] <= 32.0
        )
        and item["screenSafeEdgeFraction"] < SCREEN_SAFE_EDGE_FRACTION
    ]
    translucent_boundary_ratio = len(translucent_boundary_candidates) / float(len(analyzed))
    internal_candidates = [
        item for item in analyzed
        if item["internalLargestAreaFraction"] >= 0.16
        and item["internalLargestBboxFillFraction"] >= 0.48
        and item["internalLargestBboxWidthFraction"] >= 0.42
        and item["internalLargestBboxHeightFraction"] >= 0.30
        and item["internalLargestBboxMarginFraction"] >= 0.035
        and item["internalLargestColorVariance"] <= 2200.0
        and item["internalLargestMeanLuminance"] <= 175.0
    ]
    internal_ratio = len(internal_candidates) / float(len(analyzed))
    internal_temporal_stable = 0.0
    if len(internal_candidates) >= 2:
        internal_values = [
            (item["internalLargestAreaFraction"], item["internalLargestBboxFillFraction"],
             item["internalLargestMeanLuminance"], item["internalLargestBboxCenterXFraction"],
             item["internalLargestBboxCenterYFraction"])
            for item in analyzed
        ]
        transitions = 0
        stable_transitions = 0
        for previous, current in zip(internal_values, internal_values[1:]):
            transitions += 1
            area_delta = abs(previous[0] - current[0])
            fill_delta = abs(previous[1] - current[1])
            luminance_delta = abs(previous[2] - current[2]) / 255.0
            center_delta = abs(previous[3] - current[3]) + abs(previous[4] - current[4])
            if (area_delta <= 0.035 and fill_delta <= 0.10 and
                    luminance_delta <= 0.08 and center_delta <= 0.06):
                stable_transitions += 1
        internal_temporal_stable = stable_transitions / float(transitions)
    internal_static = internal_ratio >= 0.50 and internal_temporal_stable >= 0.72
    unusable_alpha_ratio = sum(
        item["alphaOpaqueFraction"] >= 0.97
        and item["screenSafeEdgeFraction"] < SCREEN_SAFE_EDGE_FRACTION
        for item in analyzed
    ) / float(len(analyzed))
    static_fullscreen = (
        len(analyzed) >= 3
        and persistent_ratio >= 0.50
        and temporal["stableFraction"] >= 0.72
        and temporal["meanNormalizedDelta"] <= 0.08
    )

    if unusable_alpha_ratio >= 0.80:
        errors.append({
            "code": "alpha-channel-opaque",
            "message": "The capture is effectively opaque across the sampled sequence; transparent composition cannot be verified.",
            "sampleRatio": round(unusable_alpha_ratio, 6),
        })
    if persistent_ratio >= 0.25:
        errors.append({
            "code": "boundary-connected-full-frame",
            "message": "A large opaque component repeatedly reaches the capture boundary and can render as a rectangular background.",
            "sampleRatio": round(persistent_ratio, 6),
        })
    if len(translucent_boundary_candidates) >= 3 and translucent_boundary_ratio >= 0.50:
        errors.append({
            "code": "visible-boundary-full-frame",
            "message": "A persistent opaque or translucent component covers the capture boundary and can render as a rectangular background.",
            "sampleRatio": round(translucent_boundary_ratio, 6),
            "sampleCount": len(translucent_boundary_candidates),
        })
    if len(internal_candidates) >= 3 and internal_static:
        errors.append({
            "code": "static-internal-background",
            "message": "A large low-frequency opaque or translucent component persists inside transparent margins while the action advances.",
            "sampleRatio": round(internal_ratio, 6),
            "temporalStableFraction": round(internal_temporal_stable, 6),
        })
    if static_fullscreen:
        errors.append({
            "code": "static-fullscreen-background",
            "message": "The opaque full-frame edge remains temporally stable while the action advances.",
            "edgeStableFraction": temporal["stableFraction"],
            "edgeMeanNormalizedDelta": temporal["meanNormalizedDelta"],
        })

    public_frames = []
    for item in analyzed:
        public_frames.append({key: value for key, value in item.items() if not key.startswith("_")})
    return {
        "action": action_root.name,
        "passed": not errors,
        "frameCount": len(frames),
        "sampleCount": len(analyzed),
        "persistentBoundaryBackgroundSampleRatio": round(persistent_ratio, 6),
        "persistentVisibleBoundaryBackgroundSampleRatio": round(translucent_boundary_ratio, 6),
        "persistentInternalBackgroundSampleRatio": round(internal_ratio, 6),
        "internalBackgroundTemporalStableFraction": round(internal_temporal_stable, 6),
        "staticInternalBackground": internal_static,
        "unusableAlphaSampleRatio": round(unusable_alpha_ratio, 6),
        "temporalEdge": temporal,
        "staticFullscreenBackground": static_fullscreen,
        "errors": errors,
        "frames": public_frames,
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.part-", dir=str(path.parent), text=True
    )
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-root", type=Path, required=True)
    parser.add_argument("--action", action="append", default=[], help="Action directory name; repeat as needed.")
    parser.add_argument("--minimum-actions", type=int, default=0)
    parser.add_argument("--sample-limit", type=int, default=24)
    parser.add_argument("--grid-width", type=int, default=96)
    parser.add_argument("--opaque-alpha", type=int, default=245)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.capture_root.resolve()
    if not root.is_dir():
        raise SystemExit(f"Capture root does not exist: {root}")
    if args.sample_limit < 3 or args.grid_width < 32 or not 1 <= args.opaque_alpha <= 255:
        raise SystemExit("Invalid background gate sampling parameters")
    actions = discover_actions(root, args.action)
    global_errors: list[dict[str, Any]] = []
    if len(actions) < args.minimum_actions:
        global_errors.append({
            "code": "action-count-incomplete",
            "message": f"Discovered {len(actions)} actions; required at least {args.minimum_actions}.",
        })
    reports = []
    for action in actions:
        action_root = root / action
        if not action_root.is_dir():
            reports.append({
                "action": action,
                "passed": False,
                "frameCount": 0,
                "sampleCount": 0,
                "errors": [{"code": "action-directory-missing", "message": str(action_root)}],
            })
        else:
            reports.append(analyze_action(action_root, args.sample_limit, args.grid_width, args.opaque_alpha))
    if not actions:
        global_errors.append({"code": "actions-missing", "message": "No capture action directories were discovered."})

    passed = not global_errors and all(report["passed"] for report in reports)
    result = {
        "schema": SCHEMA,
        "captureRoot": str(root),
        "passed": passed,
        "policy": {
            "ownerIndependent": True,
            "actionNameIndependent": True,
            "minimumActions": args.minimum_actions,
            "sampleLimitPerAction": args.sample_limit,
            "gridWidth": args.grid_width,
            "opaqueAlphaThreshold": args.opaque_alpha,
            "screenSafeRgbThreshold": SCREEN_SAFE_RGB,
            "screenSafeEdgeFraction": SCREEN_SAFE_EDGE_FRACTION,
            "rejectOpaqueAlphaSampleRatio": 0.80,
            "rejectPersistentBoundaryBackgroundSampleRatio": 0.25,
            "rejectPersistentVisibleBoundaryBackgroundSampleRatio": 0.50,
            "minimumPersistentVisibleBoundarySamples": 3,
            "rejectPersistentInternalBackgroundSampleRatio": 0.50,
            "minimumPersistentInternalBackgroundSamples": 3,
            "internalLargestAreaFraction": 0.16,
            "internalLargestBboxFillFraction": 0.48,
            "internalLargestBboxWidthFraction": 0.42,
            "internalLargestBboxHeightFraction": 0.30,
            "internalLargestBboxMarginFraction": 0.035,
            "internalLargestColorVariance": 2200.0,
            "internalLargestMeanLuminance": 175.0,
            "internalTemporalStableFraction": 0.72,
            "maxRectangularEdgeVariance": MAX_RECTANGULAR_EDGE_VARIANCE,
            "staticEdgeStableFraction": 0.72,
            "staticEdgeMeanNormalizedDelta": 0.08,
        },
        "errors": global_errors,
        "actions": reports,
    }
    output = args.output or (root / "capture-background-gate-report.json")
    write_json_atomic(output.resolve(), result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if passed else 2


if __name__ == "__main__":
    sys.exit(main())
