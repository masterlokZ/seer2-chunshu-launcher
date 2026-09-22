#!/usr/bin/env python3
"""Fail-closed gate for renderer-sorted two-channel capture evidence.

This validator is intentionally read-only with respect to capture output.  It
does not infer a background from names, owner ids, or sorting-order quartiles.
An action may enable the foreground/underlay pair only when capture metadata
contains explicit renderer evidence and that evidence proves a strict order
separation.  Renderer stability and depth evidence are scoped to the classified
underlay, foreground renderers at/below its boundary, and the nearest foreground
renderer(s) above that boundary.  Unrelated transient foreground renderers do
not make the whole inventory unstable.  Any missing/ambiguous evidence inside
that safety scope still fails closed.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import struct
import sys
import math
from pathlib import Path
from typing import Any

try:
    from PIL import Image, ImageChops, ImageMath
except ImportError as error:  # pragma: no cover - environment failure path
    raise SystemExit("Pillow is required for the U-client dual-channel gate") from error


POLICY = "classified-background-underlay-v1"
ORDER_SCHEMA = "seer2-uclient-renderer-layer-evidence-v1"
REPORT_SCHEMA = "seer2-uclient-dual-channel-gate-v1"
OFFICIAL_FULL_SCHEMA = "seer2-uclient-action-specific-compensated-screen-v1"
OFFICIAL_FULL_COMPOSITOR = "action-specific-compensated-underlay-then-foreground-screen-v1"
sys.dont_write_bytecode = True


def _error(code: str, message: str, **extra: Any) -> dict[str, Any]:
    value: dict[str, Any] = {"code": code, "message": message}
    value.update(extra)
    return value


def _read_png_size(path: Path) -> tuple[int, int]:
    """Verify PNG signature/IHDR and canonical IEND at EOF."""
    with path.open("rb") as stream:
        header = stream.read(24)
        stream.seek(-12, 2)
        tail = stream.read(12)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("invalid PNG signature/header")
    if struct.unpack(">I", header[8:12])[0] != 13 or header[12:16] != b"IHDR":
        raise ValueError("first PNG chunk is not a canonical IHDR")
    width, height = struct.unpack(">II", header[16:24])
    if width <= 0 or height <= 0:
        raise ValueError("PNG dimensions are not positive")
    if tail != b"\x00\x00\x00\x00IEND\xaeB`\x82":
        raise ValueError("PNG does not end with a complete canonical IEND chunk")
    return width, height


def _foreground_occlusion_gate(action_root: Path) -> dict[str, Any]:
    """Run the repository's owner/action-independent foreground pixel gate."""
    gate_path = Path(__file__).with_name("Validate-UClientCaptureBackground.py")
    if not gate_path.is_file():
        return {"passed": False, "errors": [_error("foreground-gate-missing", f"foreground background gate is missing: {gate_path}")]}
    spec = importlib.util.spec_from_file_location("uclient_capture_background_gate", gate_path)
    if spec is None or spec.loader is None:
        return {"passed": False, "errors": [_error("foreground-gate-load", f"cannot load foreground background gate: {gate_path}")]}
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        return module.analyze_action(action_root, 24, 96, 245)
    except Exception as exc:  # the safety gate must turn analysis failures into denial
        return {"passed": False, "errors": [_error("foreground-gate-error", str(exc))]}


def _frames(action_root: Path, directory: str) -> tuple[list[Path], list[dict[str, Any]]]:
    root = action_root if directory in ("", ".") else action_root / directory
    if not root.is_dir():
        return [], [_error("channel-directory-missing", f"channel directory is missing: {root}")]
    values = sorted(root.glob("frame-*.png"))
    errors: list[dict[str, Any]] = []
    for index, frame in enumerate(values):
        expected = f"frame-{index:04d}.png"
        if frame.name != expected:
            errors.append(_error("channel-frame-sequence", f"expected {expected}, found {frame.name}", file=str(frame)))
        if frame.stat().st_size <= 0:
            errors.append(_error("channel-frame-empty", f"channel frame is empty: {frame}"))
    return values, errors


def _renderer_order_gate(raw: Any, official_full_equivalent: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    if not isinstance(raw, dict):
        return {}, [_error("renderer-order-evidence-missing", "rendererLayerEvidence object is missing")]
    if raw.get("schema") != ORDER_SCHEMA:
        errors.append(_error("renderer-order-schema", f"renderer evidence schema must be {ORDER_SCHEMA}"))
    inventory_stable = raw.get("inventoryStable") is True
    try:
        samples = int(raw.get("samples", 0))
    except (TypeError, ValueError):
        samples = 0
    if samples < 3:
        errors.append(_error("renderer-order-samples", "renderer order evidence requires at least three samples"))
    if raw.get("orderBasis") != "sorting-layer-value-then-render-queue-then-sorting-order-v1":
        errors.append(_error("renderer-order-basis", "renderer evidence must declare the canonical comparable order basis"))
    renderers = raw.get("renderers")
    if not isinstance(renderers, list) or not renderers:
        errors.append(_error("renderer-order-empty", "renderer evidence has no renderer records"))
        return {}, errors

    parsed: list[dict[str, Any]] = []
    for index, item in enumerate(renderers):
        if not isinstance(item, dict):
            # An untyped record cannot be proved outside the ordering boundary.
            errors.append(_error("renderer-record-invalid", f"renderer record {index} is not an object"))
            continue
        signature = str(item.get("signature", "")).strip()
        channel = str(item.get("channel", "")).strip().lower()
        numbers: dict[str, int] = {}
        for field in ("sortingLayerValue", "renderQueue", "sortingOrder"):
            value = item.get(field)
            if (not isinstance(value, bool) and isinstance(value, (int, float)) and
                    math.isfinite(float(value)) and int(value) == value):
                numbers[field] = int(value)
        def optional_count(field: str) -> int | None:
            value = item.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            if not math.isfinite(float(value)) or int(value) != value or int(value) < 0:
                return None
            return int(value)

        parsed.append({
            "index": index,
            "signature": signature,
            "channel": channel,
            "sortingLayerValue": numbers.get("sortingLayerValue"),
            "renderQueue": numbers.get("renderQueue"),
            "sortingOrder": numbers.get("sortingOrder"),
            "orderKey": ((numbers["sortingLayerValue"], numbers["renderQueue"], numbers["sortingOrder"])
                         if len(numbers) == 3 else None),
            "enabled": item.get("enabled"),
            "writesDepth": item.get("writesDepth"),
            "writesDepthDeclared": "writesDepth" in item,
            # New capture evidence may prove stability per renderer.  Legacy
            # evidence remains valid only when its aggregate inventoryStable flag
            # is true; a false aggregate cannot be silently reinterpreted.
            "observationSamples": optional_count("observationSamples"),
            "activeSamples": optional_count("activeSamples"),
            "orderStable": item.get("orderStable"),
            "depthStable": item.get("depthStable"),
        })

    backgrounds = [r for r in parsed if r["channel"] == "background"]
    foregrounds = [r for r in parsed if r["channel"] == "foreground"]
    unclassified = [r for r in parsed if r["channel"] not in {"background", "foreground"}]
    if not backgrounds:
        errors.append(_error("renderer-background-empty", "renderer evidence contains no background renderers"))
    valid_backgrounds = [r for r in backgrounds if r["orderKey"] is not None]
    maximum_background_key = max((r["orderKey"] for r in valid_backgrounds), default=None)

    def may_be_active(record: dict[str, Any]) -> bool:
        active_samples = record["activeSamples"]
        if active_samples is not None:
            return active_samples > 0
        # A stable legacy record that was disabled stayed disabled at every
        # sample.  With an unstable aggregate, one disabled snapshot is not proof.
        if inventory_stable and record["enabled"] is False:
            return False
        return True

    active_foregrounds = [r for r in foregrounds if may_be_active(r)]
    valid_foregrounds = [r for r in active_foregrounds if r["orderKey"] is not None]
    unknown_foregrounds = ([r for r in active_foregrounds if r["orderKey"] is None] +
                           [r for r in unclassified if may_be_active(r)])
    overlap_foregrounds: list[dict[str, Any]] = []
    boundary_foregrounds: list[dict[str, Any]] = []
    if maximum_background_key is not None:
        overlap_foregrounds = [
            r for r in valid_foregrounds if r["orderKey"] <= maximum_background_key
        ]
        above = [r for r in valid_foregrounds if r["orderKey"] > maximum_background_key]
        if above:
            minimum_above_key = min(r["orderKey"] for r in above)
            boundary_foregrounds = [r for r in above if r["orderKey"] == minimum_above_key]
    elif active_foregrounds:
        errors.append(_error(
            "renderer-order-boundary-unproven",
            "classified underlay renderers do not expose a complete ordering boundary",
        ))

    scoped: list[dict[str, Any]] = []
    scoped_ids: set[int] = set()
    for record in backgrounds + overlap_foregrounds + boundary_foregrounds + unknown_foregrounds:
        if record["index"] not in scoped_ids:
            scoped.append(record)
            scoped_ids.add(record["index"])

    signature_counts: dict[str, int] = {}
    for record in scoped:
        signature = record["signature"]
        if signature:
            signature_counts[signature] = signature_counts.get(signature, 0) + 1
    for signature, count in signature_counts.items():
        if count > 1:
            errors.append(_error(
                "renderer-signature-duplicate",
                f"renderer signature is duplicated inside the safety scope: {signature}",
            ))

    for record in scoped:
        label = record["signature"] or str(record["index"])
        if not record["signature"]:
            errors.append(_error("renderer-signature-missing", f"renderer record {label} has no signature"))
        if record["channel"] not in {"background", "foreground"}:
            errors.append(_error("renderer-channel-invalid", f"renderer {label} has channel {record['channel']!r}"))
        for field in ("sortingLayerValue", "renderQueue", "sortingOrder"):
            if record[field] is None:
                errors.append(_error("renderer-order-field-missing", f"renderer {label} has invalid {field}"))
        background_inactive = (
            record["channel"] == "background" and (
                record["activeSamples"] == 0 or (
                    record["activeSamples"] is None and inventory_stable and
                    record["enabled"] is not True)))
        if background_inactive:
            errors.append(_error("renderer-not-enabled", f"classified underlay renderer {label} was never active"))
        # Depth writes can make the split non-equivalent, but only renderers that
        # can touch the underlay/foreground boundary need this proof.
        writes_depth = record["writesDepth"]
        if writes_depth is True:
            # An observed depth-writing renderer is never waived by pixel
            # equivalence: the proof is intentionally limited to unknown depth.
            errors.append(_error("renderer-depth-write", f"renderer {label} explicitly writes depth"))
        elif writes_depth is False:
            pass
        elif not (record["writesDepthDeclared"] and writes_depth is None and
                  official_full_equivalent):
            errors.append(_error(
                "renderer-depth-write",
                f"renderer {label} does not prove writesDepth=false and has no complete official-full equivalence proof",
            ))
        if not inventory_stable:
            observation_samples = record["observationSamples"]
            if observation_samples is None or observation_samples < 3:
                errors.append(_error(
                    "renderer-scope-samples",
                    f"renderer {label} needs at least three scoped observations",
                ))
            if record["activeSamples"] is None:
                errors.append(_error(
                    "renderer-activity-scope-unproven",
                    f"renderer {label} does not prove its active sample count",
                ))
            if record["orderStable"] is not True:
                errors.append(_error(
                    "renderer-order-unstable",
                    f"renderer {label} does not prove stable ordering while observed",
                ))
            if record["depthStable"] is not True:
                errors.append(_error(
                    "renderer-depth-unstable",
                    f"renderer {label} does not prove stable depth state while observed",
                ))

    if not active_foregrounds:
        errors.append(_error("renderer-foreground-empty", "renderer evidence contains no active foreground renderers"))
    if overlap_foregrounds and maximum_background_key is not None:
        minimum_foreground_key = min(r["orderKey"] for r in overlap_foregrounds)
        errors.append(_error(
            "renderer-order-overlap",
            "one or more foreground renderers are at or below the classified underlay boundary",
            maximumBackgroundOrderKey=list(maximum_background_key),
            minimumOverlappingForegroundOrderKey=list(minimum_foreground_key),
        ))

    ordered_groups = sorted({
        (r["sortingLayerValue"], r["renderQueue"])
        for r in scoped if r["sortingLayerValue"] is not None
    }, key=lambda pair: (pair[0], -1 if pair[1] is None else pair[1]))
    scoped_null_depth_count = sum(
        1 for record in scoped
        if record["writesDepthDeclared"] and record["writesDepth"] is None)
    scoped_missing_depth_count = sum(
        1 for record in scoped if not record["writesDepthDeclared"])
    return {
        "rendererCount": len(parsed),
        "inventoryStable": inventory_stable,
        "scopePolicy": "underlay-overlap-and-nearest-boundary-v1",
        "scopedRendererCount": len(scoped),
        "backgroundRendererCount": len(backgrounds),
        "foregroundRendererCount": len(active_foregrounds),
        "boundaryForegroundRendererCount": len(boundary_foregrounds),
        "overlapRiskForegroundRendererCount": len(overlap_foregrounds) + len(unknown_foregrounds),
        "scopedNullDepthCount": scoped_null_depth_count,
        "scopedMissingDepthCount": scoped_missing_depth_count,
        "officialFullDepthSubstitutionApplied": official_full_equivalent and scoped_null_depth_count > 0,
        "sortingGroups": [{"sortingLayerValue": layer, "renderQueue": queue} for layer, queue in ordered_groups],
        "maximumBackgroundOrderKey": list(maximum_background_key) if maximum_background_key is not None else None,
        "minimumBoundaryForegroundOrderKey": (list(boundary_foregrounds[0]["orderKey"])
                                                if boundary_foregrounds else None),
        "backgroundSignatures": [r["signature"] for r in backgrounds],
        "boundaryForegroundSignatures": [r["signature"] for r in boundary_foregrounds],
        "overlapRiskForegroundSignatures": [r["signature"] for r in overlap_foregrounds + unknown_foregrounds],
    }, errors


def _active_windows_gate(split: dict[str, Any], duration: Any,
                         frame_count: Any, frame_rate: Any) -> list[dict[str, Any]]:
    """Validate the capture-owned renderer active clock independently.

    ``activeWindows`` is produced from the per-frame enabled state of the
    classified underlay renderers.  It is intentionally not derived from the
    foreground/background pixel windows: reusing those windows could resurrect
    a stale background when an authored renderer is disabled mid-action.
    """
    errors: list[dict[str, Any]] = []
    raw = split.get("activeWindows")
    if not isinstance(raw, list):
        return [_error("underlay-active-windows-missing", "layerSplit.activeWindows must be an array")]
    if not raw:
        return [_error(
            "underlay-active-windows-empty",
            "dual-channel capture is enabled but layerSplit.activeWindows is empty",
        )]
    try:
        end_limit = float(duration)
    except (TypeError, ValueError):
        end_limit = 0.0
    previous_end = 0.0
    previous_end_frame = -1
    valid_frame_count = frame_count if isinstance(frame_count, int) and frame_count > 0 else None
    valid_frame_rate = float(frame_rate) if isinstance(frame_rate, (int, float)) and not isinstance(frame_rate, bool) and frame_rate > 0 else None
    for index, window in enumerate(raw):
        if not isinstance(window, dict):
            errors.append(_error("underlay-active-window-invalid", f"active window {index} is not an object"))
            continue
        start = window.get("startSeconds")
        end = window.get("endSeconds")
        if (isinstance(start, bool) or not isinstance(start, (int, float)) or
                isinstance(end, bool) or not isinstance(end, (int, float)) or
                not math.isfinite(float(start)) or not math.isfinite(float(end))):
            errors.append(_error("underlay-active-window-time", f"active window {index} has invalid times"))
            continue
        start_value, end_value = float(start), float(end)
        if start_value < 0 or end_value <= start_value or end_value > end_limit + 1e-6:
            errors.append(_error("underlay-active-window-range", f"active window {index} is outside action duration"))
        if index and start_value < previous_end - 1e-6:
            errors.append(_error("underlay-active-window-overlap", "activeWindows must be sorted and non-overlapping"))
        previous_end = max(previous_end, end_value)
        start_frame = window.get("startFrame")
        end_frame = window.get("endFrame")
        if (isinstance(start_frame, bool) or not isinstance(start_frame, int) or
                isinstance(end_frame, bool) or not isinstance(end_frame, int)):
            errors.append(_error(
                "underlay-active-window-frame",
                f"active window {index} must declare integer startFrame/endFrame",
            ))
            continue
        if start_frame < 0 or end_frame < start_frame or (
                valid_frame_count is not None and end_frame >= valid_frame_count):
            errors.append(_error(
                "underlay-active-window-frame-range",
                f"active window {index} frame range {start_frame}..{end_frame} is invalid",
            ))
        if index and start_frame <= previous_end_frame:
            errors.append(_error(
                "underlay-active-window-frame-overlap",
                "activeWindows frame ranges must be sorted and non-overlapping",
            ))
        previous_end_frame = max(previous_end_frame, end_frame)
        if valid_frame_rate is not None:
            expected_start = start_frame / valid_frame_rate
            expected_end = min(end_limit, (end_frame + 1) / valid_frame_rate)
            tolerance = max(1e-6, 0.51 / valid_frame_rate)
            if (abs(start_value - expected_start) > tolerance or
                    abs(end_value - expected_end) > tolerance):
                errors.append(_error(
                    "underlay-active-window-clock-mismatch",
                    f"active window {index} frame and second clocks disagree",
                    expectedStartSeconds=expected_start,
                    expectedEndSeconds=expected_end,
                ))
    return errors


def _canonical_sha256(value: Any) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _black_flatten(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    black = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
    return Image.alpha_composite(black, rgba).convert("RGB")


def _transport_rgb(image: Image.Image) -> tuple[Image.Image, bool]:
    """Decode and verify the canonical black/opaque transport representation.

    Derived channels are written as transparent pure black or opaque RGB.  This
    makes the PNG's decoded RGB identical to the later FLV1 black-flattened RGB;
    accepting hidden colour or fractional alpha would make the evidence hash
    dependent on a decoder/compositor detail instead of the declared transport.
    """
    rgba = image.convert("RGBA")
    red, green, blue, alpha = rgba.split()
    visible = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    expected_alpha = visible.point(lambda value: 255 if value else 0)
    canonical = ImageChops.difference(alpha, expected_alpha).getbbox() is None
    return Image.merge("RGB", (red, green, blue)), canonical


def _pixel_sha256(image: Image.Image) -> str:
    width, height = image.size
    return hashlib.sha256(struct.pack(">II", width, height) + image.tobytes()).hexdigest()


def _difference_metrics(left: Image.Image, right: Image.Image) -> tuple[int, int]:
    """Return changed pixel count and maximum channel delta without Python pixel loops."""
    difference = ImageChops.difference(left.convert("RGB"), right.convert("RGB"))
    channels = difference.split()
    maximum_delta = max(channel.getextrema()[1] for channel in channels)
    changed = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    changed_pixels = sum(changed.histogram()[1:])
    return changed_pixels, maximum_delta


def _derive_exact_screen_channels(
        raw_underlay: Image.Image, official: Image.Image, active: bool,
        ) -> tuple[Image.Image, Image.Image, int, int]:
    """Derive the action/frame-bound pair consumed by the FLV1 SCREEN host.

    U' is component-wise min(raw underlay, official) while the authored underlay
    is active, otherwise black.  For each byte channel F' is the discrete inverse
    whose repository SCREEN integer formula equals official exactly.
    """
    raw_underlay = raw_underlay.convert("RGB")
    official = official.convert("RGB")
    if active:
        derived_underlay = ImageChops.darker(raw_underlay, official)
        clamped = ImageChops.subtract(raw_underlay, official)
        clamped_channels = sum(sum(channel.histogram()[1:]) for channel in clamped.split())
        clamp_mask_channels = clamped.split()
        clamp_mask = ImageChops.lighter(
            ImageChops.lighter(clamp_mask_channels[0], clamp_mask_channels[1]),
            clamp_mask_channels[2],
        )
        clamped_pixels = sum(clamp_mask.histogram()[1:])
    else:
        derived_underlay = Image.new("RGB", official.size, (0, 0, 0))
        clamped_pixels = 0
        clamped_channels = 0

    foreground_channels: list[Image.Image] = []
    for underlay_channel, official_channel in zip(
            derived_underlay.split(), official.split()):
        headroom = ImageMath.unsafe_eval("255-u", u=underlay_channel).convert("L")
        denominator = ImageChops.lighter(
            headroom, Image.new("L", headroom.size, 1))
        # The runtime uses O=255-floor((255-U)*(255-F)/255).  With q=255-F,
        # select the largest feasible q and therefore the minimum exact F:
        #   q=min(255, ceil(255*(256-O)/(255-U))-1).
        # ImageMath integer division truncates non-negative values.  Conversion
        # to L clamps upperExclusive>256 to the canonical F=0 endpoint.
        upper_exclusive = ImageMath.unsafe_eval(
            "(255*(256-o)+d-1)/d", o=official_channel, d=denominator,
        )
        foreground_channel = ImageMath.unsafe_eval(
            "256-x", x=upper_exclusive,
        ).convert("L")
        nonzero_headroom = headroom.point(lambda value: 255 if value else 0)
        foreground_channel = Image.composite(
            foreground_channel,
            Image.new("L", headroom.size, 0),
            nonzero_headroom,
        )
        foreground_channels.append(foreground_channel)
    derived_foreground = Image.merge("RGB", foreground_channels)
    return derived_foreground, derived_underlay, clamped_pixels, clamped_channels


def _official_full_equivalence_gate(
        action_root: Path, capture: dict[str, Any], split: dict[str, Any],
        foreground: list[Path], underlay: list[Path]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Re-derive and verify the action-specific compensated SCREEN pair.

    The audit roots and official-full pass are the independent inputs.  The gate
    never trusts the published derived channels: it recomputes U'/F' for every
    frame, compares the decoded transport RGB at zero tolerance, then proves the
    FLV1 black-flattened SCREEN result equals official-full exactly.  This proof
    may replace explicitly unknown scoped depth, never an observed depth write.
    """
    errors: list[dict[str, Any]] = []
    raw = capture.get("officialFullEquivalence")
    if not isinstance(raw, dict):
        return {
            "required": True,
            "passed": False,
            "schema": OFFICIAL_FULL_SCHEMA,
            "verifiedFrameCount": 0,
            "mismatchedFrameCount": 0,
        }, [_error(
            "official-full-equivalence-missing",
            "every enabled dual-channel action requires exact officialFullEquivalence metadata",
        )]

    if raw.get("schema") != OFFICIAL_FULL_SCHEMA:
        errors.append(_error(
            "official-full-equivalence-schema",
            f"officialFullEquivalence.schema must be {OFFICIAL_FULL_SCHEMA}",
        ))
    if raw.get("compositor") != OFFICIAL_FULL_COMPOSITOR:
        errors.append(_error(
            "official-full-compositor",
            f"officialFullEquivalence.compositor must be {OFFICIAL_FULL_COMPOSITOR}",
        ))
    if (raw.get("foregroundDirectory") != "." or
            raw.get("underlayDirectory") != "underlay" or
            raw.get("rawForegroundDirectory") != "foreground-raw" or
            raw.get("rawUnderlayDirectory") != "underlay-raw" or
            raw.get("officialFullDirectory") != "official-full"):
        errors.append(_error(
            "official-full-directories",
            "exact proof must bind derived '.', 'underlay', raw audit roots and 'official-full'",
        ))
    if raw.get("underlaySemantics") != "action-specific-compensated-underlay":
        errors.append(_error(
            "official-full-underlay-semantics",
            "underlay must be declared action-specific-compensated-underlay",
        ))
    if raw.get("screenInverse") != "minimum-foreground-byte-v1":
        errors.append(_error(
            "official-full-screen-inverse",
            "exact proof must declare the canonical minimum-foreground-byte-v1 inverse",
        ))
    if raw.get("rawProvenance") != "single-authored-renderer-snapshot-three-pass-v1":
        errors.append(_error(
            "official-full-raw-provenance",
            "raw audit roots must come from one authored renderer snapshot",
        ))
    if raw.get("capturePassOrder") != [
            "official-full", "foreground-raw", "underlay-raw"]:
        errors.append(_error(
            "official-full-capture-pass-order",
            "capturePassOrder must preserve official-full, foreground-raw, underlay-raw",
        ))
    if raw.get("hostBlendMode") != "screen" or raw.get("channelOrder") != ["underlay", "foreground"]:
        errors.append(_error(
            "official-full-host-composition",
            "official-full proof must declare SCREEN with underlay before foreground",
        ))
    if raw.get("transport") != "flv1-black-flattened-rgb":
        errors.append(_error(
            "official-full-alpha-transport",
            "exact proof must preserve the existing FLV1 black-flattened RGB transport",
        ))
    if raw.get("complete") is not True:
        errors.append(_error(
            "official-full-equivalence-incomplete",
            "official-full proof does not explicitly declare complete=true",
        ))

    frame_count = capture.get("frameCount")
    if not isinstance(frame_count, int) or frame_count <= 0:
        frame_count = 0
    if raw.get("frameCount") != frame_count:
        errors.append(_error(
            "official-full-frame-count-metadata",
            f"official-full frameCount={raw.get('frameCount')} does not match capture={frame_count}",
        ))
    if (raw.get("verifiedFrameCount") != frame_count or
            raw.get("mismatchedFrameCount") != 0 or
            raw.get("exactMismatchPixelCount") != 0 or
            raw.get("maximumChannelDelta") != 0):
        errors.append(_error(
            "official-full-verification-summary",
            "exact metadata must prove every frame verified with zero mismatch pixels/delta",
        ))
    if (isinstance(raw.get("clampedPixelCount"), bool) or
            not isinstance(raw.get("clampedPixelCount"), int) or
            raw.get("clampedPixelCount", -1) < 0 or
            isinstance(raw.get("clampedChannelCount"), bool) or
            not isinstance(raw.get("clampedChannelCount"), int) or
            raw.get("clampedChannelCount", -1) < 0):
        errors.append(_error(
            "official-full-clamp-summary",
            "exact metadata must declare non-negative clamped pixel/channel totals",
        ))
    if raw.get("unexpectedRendererCount") != 0:
        errors.append(_error(
            "official-full-unexpected-renderer",
            "official-full proof observed renderer(s) outside the single authored snapshot",
        ))

    split_windows = split.get("activeWindows")
    proof_windows = raw.get("activeWindows")
    expected_windows_hash = _canonical_sha256(split_windows)
    if proof_windows != split_windows:
        errors.append(_error(
            "official-full-active-windows-mismatch",
            "official-full activeWindows are not identical to layerSplit.activeWindows",
        ))
    if str(raw.get("activeWindowsSha256", "")).lower() != expected_windows_hash:
        errors.append(_error(
            "official-full-active-windows-hash",
            "official-full activeWindowsSha256 does not match the canonical split clock",
            expected=expected_windows_hash,
        ))

    active_frames: set[int] = set()
    if isinstance(split_windows, list):
        for window in split_windows:
            if not isinstance(window, dict):
                continue
            start, end = window.get("startFrame"), window.get("endFrame")
            if (isinstance(start, int) and not isinstance(start, bool) and
                    isinstance(end, int) and not isinstance(end, bool) and 0 <= start <= end):
                active_frames.update(range(start, end + 1))

    raw_foreground, raw_foreground_errors = _frames(action_root, "foreground-raw")
    raw_underlay, raw_underlay_errors = _frames(action_root, "underlay-raw")
    official, official_errors = _frames(action_root, "official-full")
    errors.extend(raw_foreground_errors)
    errors.extend(raw_underlay_errors)
    errors.extend(official_errors)
    channel_sets = {
        "foreground-raw": raw_foreground,
        "underlay-raw": raw_underlay,
        "official-full": official,
    }
    for label, frames in channel_sets.items():
        if len(frames) != frame_count:
            errors.append(_error(
                "official-full-frame-count",
                f"{label} files={len(frames)} do not match capture frameCount={frame_count}",
                directory=label,
            ))
    sequences = [foreground, underlay, raw_foreground, raw_underlay, official]
    if any([path.name for path in frames] != [path.name for path in foreground]
           for frames in sequences[1:]):
        errors.append(_error(
            "official-full-frame-sequence",
            "derived, raw audit and official-full frame sequences are not aligned",
        ))

    raw_frames = raw.get("frames")
    frame_records: dict[int, dict[str, Any]] = {}
    if not isinstance(raw_frames, list):
        errors.append(_error(
            "official-full-frame-evidence-missing",
            "officialFullEquivalence.frames must be an array",
        ))
    else:
        for position, record in enumerate(raw_frames):
            if not isinstance(record, dict):
                errors.append(_error(
                    "official-full-frame-record-invalid",
                    f"official-full frame record {position} is not an object",
                ))
                continue
            index = record.get("frameIndex")
            if isinstance(index, bool) or not isinstance(index, int) or index < 0:
                errors.append(_error(
                    "official-full-frame-index",
                    f"official-full frame record {position} has an invalid frameIndex",
                ))
                continue
            if index in frame_records:
                errors.append(_error(
                    "official-full-frame-duplicate",
                    f"official-full frameIndex is duplicated: {index}",
                ))
                continue
            frame_records[index] = record
        if sorted(frame_records) != list(range(frame_count)):
            errors.append(_error(
                "official-full-frame-record-sequence",
                "official-full frame records are not a complete zero-based sequence",
            ))

    expected_size = (capture.get("width"), capture.get("height"))
    size_valid = all(isinstance(value, int) and value > 0 for value in expected_size)
    verified_frames = 0
    mismatched_frames = 0
    total_clamped_pixels = 0
    total_clamped_channels = 0
    total_mismatched_pixels = 0
    maximum_channel_delta = 0
    comparable_count = min(
        len(foreground), len(underlay), len(raw_foreground), len(raw_underlay),
        len(official), frame_count,
    )
    for index in range(comparable_count):
        record = frame_records.get(index)
        if record is None:
            continue
        expected_name = f"frame-{index:04d}.png"
        if record.get("fileName") != expected_name:
            errors.append(_error(
                "official-full-frame-name",
                f"official-full frame {index} does not bind fileName={expected_name}",
            ))
        expected_active = index in active_frames
        if record.get("activeUnderlay") is not expected_active:
            errors.append(_error(
                "official-full-frame-active-window",
                f"official-full frame {index} has the wrong activeUnderlay state",
            ))

        paths = {
            "derivedForegroundSha256": foreground[index],
            "derivedUnderlaySha256": underlay[index],
            "rawForegroundSha256": raw_foreground[index],
            "rawUnderlaySha256": raw_underlay[index],
            "officialFullSha256": official[index],
        }
        for field, path in paths.items():
            try:
                png_size = _read_png_size(path)
            except (OSError, ValueError) as exc:
                errors.append(_error(
                    "official-full-png-invalid",
                    f"exact frame {index} {field} is not a complete canonical PNG: {exc}",
                    field=field,
                ))
                continue
            if size_valid and png_size != expected_size:
                errors.append(_error(
                    "official-full-png-dimensions",
                    f"exact frame {index} {field} is {png_size[0]}x{png_size[1]}, expected {expected_size}",
                    field=field,
                ))
            actual_hash = _file_sha256(path)
            if str(record.get(field, "")).lower() != actual_hash:
                errors.append(_error(
                    "official-full-file-hash",
                    f"official-full frame {index} {field} does not match {path.name}",
                    field=field,
                    expected=actual_hash,
                ))

        try:
            with Image.open(foreground[index]) as source:
                derived_foreground_rgb, foreground_canonical = _transport_rgb(source)
            with Image.open(underlay[index]) as source:
                derived_underlay_rgb, underlay_canonical = _transport_rgb(source)
            with Image.open(raw_foreground[index]) as source:
                raw_foreground_rgb = _black_flatten(source)
            with Image.open(raw_underlay[index]) as source:
                raw_underlay_rgb = _black_flatten(source)
            with Image.open(official[index]) as source:
                official_rgb = _black_flatten(source)
        except (OSError, ValueError) as exc:
            errors.append(_error(
                "official-full-pixel-read-failed",
                f"official-full frame {index} could not be decoded: {exc}",
            ))
            continue
        if not foreground_canonical:
            errors.append(_error(
                "official-full-derived-transport",
                f"derived foreground frame {index} is not transparent-black/opaque-RGB canonical transport",
                channel="foreground",
            ))
        if not underlay_canonical:
            errors.append(_error(
                "official-full-derived-transport",
                f"derived underlay frame {index} is not transparent-black/opaque-RGB canonical transport",
                channel="underlay",
            ))
        decoded = [derived_foreground_rgb, derived_underlay_rgb,
                   raw_foreground_rgb, raw_underlay_rgb, official_rgb]
        sizes = {image.size for image in decoded}
        if len(sizes) != 1 or (size_valid and derived_foreground_rgb.size != expected_size):
            errors.append(_error(
                "official-full-png-dimensions",
                f"official-full frame {index} channel dimensions do not match {expected_size}",
                sizes=[list(value) for value in sorted(sizes)],
            ))
            continue

        expected_foreground, expected_underlay, clamped_pixels, clamped_channels = (
            _derive_exact_screen_channels(raw_underlay_rgb, official_rgb, expected_active)
        )
        total_clamped_pixels += clamped_pixels
        total_clamped_channels += clamped_channels
        foreground_mismatch, foreground_delta = _difference_metrics(
            derived_foreground_rgb, expected_foreground)
        underlay_mismatch, underlay_delta = _difference_metrics(
            derived_underlay_rgb, expected_underlay)
        if foreground_mismatch:
            errors.append(_error(
                "official-full-derived-foreground-mismatch",
                f"derived foreground frame {index} does not match raw+official reconstruction",
                mismatchedPixels=foreground_mismatch,
                maximumChannelDelta=foreground_delta,
            ))
        if underlay_mismatch:
            errors.append(_error(
                "official-full-derived-underlay-mismatch",
                f"derived underlay frame {index} does not match raw+official reconstruction",
                mismatchedPixels=underlay_mismatch,
                maximumChannelDelta=underlay_delta,
            ))

        composite = ImageChops.screen(derived_underlay_rgb, derived_foreground_rgb)
        composite_hash = _pixel_sha256(composite)
        official_rgb_hash = _pixel_sha256(official_rgb)
        rgb_hashes = {
            "derivedForegroundRgbSha256": _pixel_sha256(derived_foreground_rgb),
            "derivedUnderlayRgbSha256": _pixel_sha256(derived_underlay_rgb),
            "rawForegroundRgbSha256": _pixel_sha256(raw_foreground_rgb),
            "rawUnderlayRgbSha256": _pixel_sha256(raw_underlay_rgb),
            "compositeRgbSha256": composite_hash,
            "officialFullRgbSha256": official_rgb_hash,
        }
        for field, expected_hash in rgb_hashes.items():
            if str(record.get(field, "")).lower() != expected_hash:
                errors.append(_error(
                    "official-full-rgb-hash",
                    f"exact frame {index} {field} is stale or invalid",
                    field=field,
                    expected=expected_hash,
                ))

        mismatched_pixels, maximum_delta = _difference_metrics(composite, official_rgb)
        total_mismatched_pixels += mismatched_pixels
        maximum_channel_delta = max(maximum_channel_delta, maximum_delta)
        if mismatched_pixels:
            mismatched_frames += 1
            errors.append(_error(
                "official-full-composite-mismatch",
                f"exact derived frame {index} differs from official SCREEN result",
                mismatchedPixels=mismatched_pixels,
                maximumChannelDelta=maximum_delta,
            ))
        if (record.get("clampedPixelCount") != clamped_pixels or
                record.get("clampedChannelCount") != clamped_channels):
            errors.append(_error(
                "official-full-frame-clamp-summary",
                f"exact frame {index} clamp summary does not match decoded raw pixels",
                expectedPixels=clamped_pixels,
                expectedChannels=clamped_channels,
            ))
        if record.get("mismatchedPixelCount") != mismatched_pixels or record.get("maximumChannelDelta") != maximum_delta:
            errors.append(_error(
                "official-full-frame-summary",
                f"official-full frame {index} mismatch summary does not match decoded pixels",
            ))
        verified_frames += 1

    if (raw.get("clampedPixelCount") != total_clamped_pixels or
            raw.get("clampedChannelCount") != total_clamped_channels):
        errors.append(_error(
            "official-full-clamp-summary",
            "exact metadata clamp totals do not match independently decoded frames",
            expectedPixels=total_clamped_pixels,
            expectedChannels=total_clamped_channels,
        ))
    if (raw.get("exactMismatchPixelCount") != total_mismatched_pixels or
            raw.get("maximumChannelDelta") != maximum_channel_delta or
            raw.get("mismatchedFrameCount") != mismatched_frames):
        errors.append(_error(
            "official-full-exact-mismatch-summary",
            "exact mismatch totals do not match independently recomposed frames",
            expectedPixels=total_mismatched_pixels,
            expectedFrames=mismatched_frames,
            expectedMaximumChannelDelta=maximum_channel_delta,
        ))

    return {
        "required": True,
        "passed": not errors,
        "schema": OFFICIAL_FULL_SCHEMA,
        "compositor": OFFICIAL_FULL_COMPOSITOR,
        "frameCount": frame_count,
        "verifiedFrameCount": verified_frames,
        "mismatchedFrameCount": mismatched_frames,
        "exactMismatchPixelCount": total_mismatched_pixels,
        "maximumChannelDelta": maximum_channel_delta,
        "clampedPixelCount": total_clamped_pixels,
        "clampedChannelCount": total_clamped_channels,
        "derivedForegroundFrameCount": len(foreground),
        "derivedUnderlayFrameCount": len(underlay),
        "rawForegroundFrameCount": len(raw_foreground),
        "rawUnderlayFrameCount": len(raw_underlay),
        "officialFullFrameCount": len(official),
        "activeWindowsSha256": expected_windows_hash,
    }, errors


def _underlay_signal_gate(underlay: list[Path], split: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Prove that the declared underlay channel contains captured pixels.

    File length and byte inequality are not pixel evidence: a complete sequence
    of transparent PNGs satisfies both checks while contributing no background
    at runtime.  Active renderer windows are the capture-owned clock, so visible
    underlay pixels must occur inside those windows and every declared window
    must contain at least one visible frame.
    """
    errors: list[dict[str, Any]] = []
    raw_windows = split.get("activeWindows")
    windows: list[tuple[int, int]] = []
    if isinstance(raw_windows, list):
        for window in raw_windows:
            if not isinstance(window, dict):
                continue
            start = window.get("startFrame")
            end = window.get("endFrame")
            if (isinstance(start, int) and not isinstance(start, bool) and
                    isinstance(end, int) and not isinstance(end, bool) and
                    0 <= start <= end):
                windows.append((start, end))

    visible_frames: list[int] = []
    unreadable: list[str] = []
    for index, frame in enumerate(underlay):
        try:
            with Image.open(frame) as image:
                alpha_extrema = image.convert("RGBA").getchannel("A").getextrema()
        except (OSError, ValueError) as exc:
            unreadable.append(f"{frame.name}: {exc}")
            continue
        if alpha_extrema[1] > 8:
            visible_frames.append(index)

    if unreadable:
        errors.append(_error(
            "underlay-pixel-read-failed",
            "one or more underlay frames could not be decoded for alpha evidence",
            files=unreadable,
        ))
    if underlay and not visible_frames:
        errors.append(_error(
            "underlay-pixel-signal-missing",
            "every underlay frame is fully transparent; dual-channel output has no captured background pixels",
        ))
    if windows:
        visible_set = set(visible_frames)
        for window_index, (start, end) in enumerate(windows):
            if not any(index in visible_set for index in range(start, end + 1)):
                errors.append(_error(
                    "underlay-active-window-pixels-missing",
                    f"active window {window_index} ({start}..{end}) contains no visible underlay frame",
                ))
        outside = [
            index for index in visible_frames
            if not any(start <= index <= end for start, end in windows)
        ]
        if outside:
            errors.append(_error(
                "underlay-pixels-outside-active-window",
                "visible underlay pixels occur outside the capture-owned activeWindows clock",
                firstFrame=outside[0],
                count=len(outside),
            ))
    return {
        "visibleFrameCount": len(visible_frames),
        "firstVisibleFrame": visible_frames[0] if visible_frames else None,
        "lastVisibleFrame": visible_frames[-1] if visible_frames else None,
        "activeWindowCount": len(windows),
    }, errors


def _derive_renderer_layer_evidence(capture: dict[str, Any], action: str, analysis: dict[str, Any]) -> dict[str, Any]:
    """Adapt timeline-layer-analysis output into the gate's explicit evidence shape.

    The graph sidecar contains sorting layer/order but not material queue or
    depth-write state.  Those fields intentionally remain unknown; the gate
    reports the resulting blocker instead of treating a guessed default as
    proof of a safe compositor split.
    """
    token_signatures: dict[str, str] = {}
    for value in capture.get("backgroundRendererSignatures", []):
        signature = str(value).strip()
        token = signature.split("|", 1)[0].strip().lower()
        if token and not token.startswith("subset:"):
            token_signatures[token] = signature
    rows = []
    for row in analysis.get("renderers", []):
        transform = str(row.get("transform", ""))
        prefix = action.lower() + "/"
        if not bool(row.get("enabled", True)) or not transform.lower().startswith(prefix):
            continue
        relative = transform[len(prefix):].lower()
        channel = "background" if relative in token_signatures else "foreground"
        rows.append({
            # Transform paths can legitimately host multiple renderers; retain
            # the graph object id for a unique diagnostic identity while
            # preserving the capture signature for classified backgrounds.
            "signature": token_signatures.get(relative, f"{transform}#{row.get('id', '')}"),
            "channel": channel,
            "sortingLayerValue": row.get("layer"),
            "renderQueue": None,
            "sortingOrder": row.get("order"),
            "enabled": True,
            "writesDepth": None,
        })
    return {
        "schema": ORDER_SCHEMA,
        # A graph sidecar cannot prove renderer inventory stability; only the
        # capture plugin's renderer probe may assert it.  Keep this explicitly
        # false so deriving a shape from incomplete evidence always fails closed.
        "inventoryStable": analysis.get("inventoryStable") is True,
        "samples": int(analysis.get("sampleCount", 0) or 0),
        "orderBasis": "sorting-layer-value-then-render-queue-then-sorting-order-v1",
        "renderers": rows,
        "source": str(analysis.get("file", "")),
    }


def validate_action(action_root: Path, expected_owner: int | None = None, analysis: dict[str, Any] | None = None) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    capture_path = action_root / "capture.json"
    if not capture_path.is_file():
        return {"action": action_root.name, "passed": False, "errors": [_error("capture-metadata-missing", f"capture metadata is missing: {capture_path}")]}
    try:
        capture = json.loads(capture_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"action": action_root.name, "passed": False, "errors": [_error("capture-metadata-invalid", str(exc))]}
    # Owner/action ids are diagnostic metadata only; a missing owner id must not
    # alter classification or make the gate owner-specific.
    split = capture.get("layerSplit")
    if not isinstance(split, dict):
        errors.append(_error("layer-split-metadata-missing", "layerSplit metadata is missing"))
        split = {}
    split_enabled = split.get("enabled") is True
    # Split capture is intentionally per-action.  A disabled action is a valid
    # single-channel capture and must not be rejected merely because it has no
    # underlay directory or renderer-order proof.
    expected_underlay_directory = "underlay" if split_enabled else ""
    expected_raw_foreground_directory = "foreground-raw" if split_enabled else ""
    expected_raw_underlay_directory = "underlay-raw" if split_enabled else ""
    # Disabled (legacy single-channel) captures may omit optional raw-channel
    # directory fields entirely.  Treat an omitted field as the canonical empty
    # value instead of rejecting an otherwise valid capture under the strict gate.
    declared_raw_foreground_directory = split.get("rawForegroundDirectory", "")
    declared_raw_underlay_directory = split.get("rawUnderlayDirectory", "")
    if (split.get("policy") != POLICY or split.get("foregroundDirectory") != "." or
            split.get("underlayDirectory") != expected_underlay_directory or
            declared_raw_foreground_directory != expected_raw_foreground_directory or
            declared_raw_underlay_directory != expected_raw_underlay_directory):
        errors.append(_error(
            "layer-split-policy",
            "layerSplit policy/directories do not bind the declared derived/raw channel roots",
            expected={
                "policy": POLICY,
                "foregroundDirectory": ".",
                "underlayDirectory": expected_underlay_directory,
                "rawForegroundDirectory": expected_raw_foreground_directory,
                "rawUnderlayDirectory": expected_raw_underlay_directory,
            }))
    state = split.get("rendererState")
    if split_enabled and (not isinstance(state, dict) or state.get("restored") is not True):
        errors.append(_error("renderer-state-restore-unproven", "layerSplit.rendererState does not prove restored=true"))
    elif split_enabled:
        try:
            snapshot_count = int(state.get("snapshotCount", 0))
            mismatch_count = int(state.get("mismatchCount", -1))
        except (TypeError, ValueError):
            snapshot_count, mismatch_count = 0, -1
        if snapshot_count <= 0 or mismatch_count != 0:
            errors.append(_error("renderer-state-restore-mismatch", f"renderer state proof requires snapshotCount>0 and mismatchCount=0, found {snapshot_count}/{mismatch_count}"))
    if split_enabled and capture.get("backgroundSuppressionAmbiguous") is not False:
        errors.append(_error("background-suppression-ambiguous", "capture does not explicitly prove backgroundSuppressionAmbiguous=false"))
    # An ordinary single-channel action is intentionally allowed to omit the
    # optional underlay clock.  Once dual-channel is enabled, absence or
    # malformed activeWindows is a hard denial.
    if split_enabled:
        errors.extend(_active_windows_gate(
            split,
            capture.get("durationSeconds"),
            capture.get("frameCount"),
            capture.get("frameRate"),
        ))
    foreground, foreground_errors = _frames(action_root, ".")
    if split_enabled:
        underlay, underlay_errors = _frames(action_root, "underlay")
        raw_foreground, raw_foreground_errors = _frames(action_root, "foreground-raw")
        raw_underlay, raw_underlay_errors = _frames(action_root, "underlay-raw")
    else:
        underlay_root = action_root / "underlay"
        underlay = sorted(underlay_root.glob("frame-*.png")) if underlay_root.is_dir() else []
        raw_foreground = []
        raw_underlay = []
        underlay_errors = []
        raw_foreground_errors = []
        raw_underlay_errors = []
        unexpected_split_artifacts = [
            directory for directory in (
                "underlay", "foreground-raw", "underlay-raw", "official-full")
            if (action_root / directory).is_dir() and
            any((action_root / directory).glob("frame-*.png"))
        ]
        if underlay or unexpected_split_artifacts or capture.get("officialFullEquivalence") is not None:
            underlay_errors.append(_error(
                "disabled-underlay-present",
                "a single-channel action contains dual-channel proof artifacts",
                directories=unexpected_split_artifacts))
    errors.extend(foreground_errors)
    errors.extend(underlay_errors)
    errors.extend(raw_foreground_errors)
    errors.extend(raw_underlay_errors)
    frame_count = capture.get("frameCount")
    if not isinstance(frame_count, int) or frame_count <= 0:
        errors.append(_error("frame-count-invalid", "capture.frameCount must be a positive integer"))
    elif len(foreground) != frame_count or (split_enabled and len(underlay) != frame_count):
        errors.append(_error("channel-frame-count", f"foreground/underlay frame counts must equal metadata frameCount={frame_count}", foreground=len(foreground), underlay=len(underlay)))
    elif split_enabled and [p.name for p in foreground] != [p.name for p in underlay]:
        errors.append(_error("channel-frame-misaligned", "foreground and underlay frame names are not aligned"))
    distinct_pairs = 0
    if len(foreground) == len(underlay) and foreground:
        for foreground_frame, underlay_frame in zip(foreground, underlay):
            foreground_hash = hashlib.sha256(foreground_frame.read_bytes()).digest()
            underlay_hash = hashlib.sha256(underlay_frame.read_bytes()).digest()
            if foreground_hash != underlay_hash:
                distinct_pairs += 1
        if distinct_pairs == 0:
            errors.append(_error("channels-byte-identical", "every underlay frame is byte-identical to its foreground frame"))
    underlay_signal, underlay_signal_errors = _underlay_signal_gate(raw_underlay, split) if split_enabled else ({"visibleFrameCount": 0, "firstVisibleFrame": None, "lastVisibleFrame": None, "activeWindowCount": 0}, [])
    errors.extend(underlay_signal_errors)
    expected_size = (capture.get("width"), capture.get("height"))
    if all(isinstance(v, int) and v > 0 for v in expected_size):
        channels = [("foreground", foreground)] + ([ ("underlay", underlay) ] if split_enabled else [])
        for channel, frames in channels:
            for frame in frames:
                try:
                    size = _read_png_size(frame)
                except (OSError, ValueError) as exc:
                    errors.append(_error("channel-png-invalid", f"{channel} frame {frame.name}: {exc}"))
                    continue
                if size != expected_size:
                    errors.append(_error("channel-png-dimensions", f"{channel} frame {frame.name} is {size[0]}x{size[1]}, expected {expected_size[0]}x{expected_size[1]}"))
    renderer_evidence = capture.get("rendererLayerEvidence")
    if renderer_evidence is None and analysis is not None:
        renderer_evidence = _derive_renderer_layer_evidence(capture, action_root.name, analysis)
    official_full_summary = {
        "required": False,
        "passed": True,
        "schema": OFFICIAL_FULL_SCHEMA,
        "verifiedFrameCount": 0,
        "mismatchedFrameCount": 0,
    }
    if split_enabled:
        # Every enabled split must carry the same independent exact proof.  It is
        # not merely a waiver for writesDepth=null: requiring it unconditionally
        # prevents a nominally known depth flag from bypassing five-channel
        # provenance and compositor equivalence.
        official_full_summary, official_full_errors = _official_full_equivalence_gate(
            action_root, capture, split, foreground, underlay)
        errors.extend(official_full_errors)
        official_full_equivalent = official_full_summary.get("passed") is True
        order_summary, order_errors = _renderer_order_gate(
            renderer_evidence, official_full_equivalent)
        errors.extend(order_errors)
    else:
        order_summary = {}
    try:
        declared_underlay_count = int(split.get("underlayFrameCount"))
    except (TypeError, ValueError):
        declared_underlay_count = -1
    if declared_underlay_count != len(underlay):
        errors.append(_error("underlay-metadata-count", f"layerSplit.underlayFrameCount={declared_underlay_count} does not match files={len(underlay)}"))
    declared_signatures = {str(value).strip() for value in split.get("underlayRendererSignatures", []) if str(value).strip()}
    capture_signatures = {str(value).strip() for value in capture.get("backgroundRendererSignatures", []) if str(value).strip()}
    evidence_signatures = set(order_summary.get("backgroundSignatures", []))
    if split_enabled and not declared_signatures:
        errors.append(_error("underlay-renderer-signatures-missing", "layerSplit.underlayRendererSignatures is empty"))
    if split_enabled and declared_signatures != capture_signatures:
        errors.append(_error("underlay-renderer-signatures-capture-mismatch", "underlay renderer signatures do not match capture.backgroundRendererSignatures", declared=sorted(declared_signatures), capture=sorted(capture_signatures)))
    elif split_enabled and evidence_signatures and declared_signatures != evidence_signatures:
        errors.append(_error("underlay-renderer-signatures-mismatch", "underlay renderer signatures do not match renderer order evidence", declared=sorted(declared_signatures), evidence=sorted(evidence_signatures)))
    foreground_gate = _foreground_occlusion_gate(
        action_root / "foreground-raw" if split_enabled else action_root)
    if foreground_gate.get("passed") is not True:
        for foreground_error in foreground_gate.get("errors", []):
            errors.append(_error(
                "foreground-occlusion-evidence",
                f"foreground channel failed full-frame/static background gate [{foreground_error.get('code', 'unknown')}]: {foreground_error.get('message', '')}",
                upstreamCode=foreground_error.get("code"),
            ))
    return {
        "action": action_root.name,
        "ownerId": capture.get("ownerId"),
        "enabled": split.get("enabled") is True,
        "passed": not errors,
        "errors": errors,
        "frameCount": frame_count,
        "foregroundFrameCount": len(foreground),
        "underlayFrameCount": len(underlay),
        "distinctChannelFramePairs": distinct_pairs,
        "underlaySignal": underlay_signal,
        "foregroundOcclusionGate": foreground_gate,
        "rendererOrder": order_summary,
        "officialFullEquivalence": official_full_summary,
    }


def validate_root(root: Path, expected_owner: int | None = None, analysis: dict[str, Any] | None = None) -> dict[str, Any]:
    actions = sorted((p for p in root.iterdir() if p.is_dir() and (p / "capture.json").is_file()), key=lambda p: p.name)
    if not actions:
        return {"schema": REPORT_SCHEMA, "captureRoot": str(root), "passed": False, "errors": [_error("actions-missing", f"no action capture directories found: {root}")], "actions": []}
    results = [validate_action(action, expected_owner, analysis) for action in actions]
    errors = [dict(error, action=result["action"]) for result in results for error in result["errors"]]
    return {
        "schema": REPORT_SCHEMA,
        "captureRoot": str(root),
        "policy": POLICY,
        "passed": not errors,
        "safeToEnableDualChannel": not errors,
        "errors": errors,
        "actions": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture_root", type=Path)
    parser.add_argument("--owner-id", type=int)
    parser.add_argument("--analysis", type=Path, help="timeline-layer-analysis JSON sidecar")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.capture_root.resolve()
    if not root.is_dir():
        parser.error(f"capture root is missing: {root}")
    analysis = None
    if args.analysis:
        analysis_path = args.analysis.resolve()
        if not analysis_path.is_file():
            parser.error(f"renderer analysis sidecar is missing: {analysis_path}")
        try:
            analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            parser.error(f"renderer analysis sidecar is invalid: {exc}")
    report = validate_root(root, args.owner_id, analysis)
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
