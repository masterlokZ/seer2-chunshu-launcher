import argparse
import json
from pathlib import Path
from typing import Any

import UnityPy


ACTIONS = ("appear", "attack", "cp", "hidemove", "sa")


def number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def vector3(value: Any, default: float) -> dict[str, float]:
    source = value if isinstance(value, dict) else {}
    return {axis: number(source.get(axis), default) for axis in ("x", "y", "z")}


def curve(value: Any) -> list[dict[str, Any]]:
    source = value if isinstance(value, dict) else {}
    result: list[dict[str, Any]] = []
    for key in source.get("m_Curve") or []:
        if not isinstance(key, dict):
            continue
        result.append({
            "time": number(key.get("time")),
            "value": number(key.get("value")),
            "inSlope": number(key.get("inSlope")),
            "outSlope": number(key.get("outSlope")),
            "weightedMode": int(key.get("weightedMode") or 0),
            "inWeight": number(key.get("inWeight")),
            "outWeight": number(key.get("outWeight")),
        })
    return result


def transform_template(value: Any) -> dict[str, Any] | None:
    template = value if isinstance(value, dict) else {}
    required = {"applyPosition", "applyRotation", "applyScale", "position", "eulerAngles", "localScale"}
    if not required.issubset(template):
        return None
    return {
        "isFlipped": bool(template.get("isFlipped")),
        "applyPosition": bool(template.get("applyPosition")),
        "applyRotation": bool(template.get("applyRotation")),
        "applyScale": bool(template.get("applyScale")),
        "positionIsWorld": bool(template.get("positionIsWorld")),
        "rotationIsWorld": bool(template.get("rotationIsWorld")),
        "position": vector3(template.get("position"), 0.0),
        "eulerAngles": vector3(template.get("eulerAngles"), 0.0),
        "localScale": vector3(template.get("localScale"), 1.0),
    }


def overlaps(clips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, left in enumerate(clips):
        for right in clips[index + 1:]:
            start = max(number(left.get("start")), number(right.get("start")))
            end = min(number(left.get("end")), number(right.get("end")))
            if end <= start:
                continue
            result.append({
                "leftAssetPathId": int(left["assetPathId"]),
                "rightAssetPathId": int(right["assetPathId"]),
                "start": start,
                "end": end,
                "duration": end - start,
            })
    return result


def framing_samples(tracks: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for label, moment in (("start", 0.0), ("middle", duration / 2.0), ("end", duration)):
        active: list[dict[str, Any]] = []
        for track in tracks:
            for clip in track.get("clips") or []:
                if number(clip.get("start")) <= moment <= number(clip.get("end")):
                    active.append({
                        "role": str(track.get("role") or ""),
                        "bindingPath": str(track.get("bindingPath") or ""),
                        "assetPathId": int(clip.get("assetPathId") or 0),
                        "transform": clip.get("transform"),
                    })
        result.append({"label": label, "time": moment, "activeTransforms": active})
    return result


def pointer_id(value: Any) -> int:
    if isinstance(value, dict):
        # UnityPy may wrap PPtrs in a ``component``/``transform`` field.
        # Accept both the raw pointer and the wrapped form so the classifier
        # remains compatible with old and new typetree shapes.
        nested = value.get("component") or value.get("transform") or value.get("gameObject")
        if isinstance(nested, dict) and not (value.get("m_PathID") or value.get("pathId")):
            value = nested
        return int(value.get("m_PathID") or value.get("pathId") or 0)
    return int(getattr(value, "path_id", 0) or 0)


def component_ids(value: Any) -> list[int]:
    """Return component PPtrs from a GameObject's m_Component array."""
    if not isinstance(value, list):
        return []
    result: list[int] = []
    for item in value:
        path_id = pointer_id(item)
        if path_id:
            result.append(path_id)
    return result


def renderer_type(obj: Any) -> str:
    value = getattr(obj, "type", "")
    return str(getattr(value, "name", value) or "")


def renderer_layer_metadata(root_reader: Any, action: str) -> dict[str, Any]:
    """Classify prefab renderers around the official pet sorting plane.

    This is deliberately metadata-only: no renderer/Flash composition is changed
    here.  The official battle Spine renderer uses sortingOrder 0 (right) or 1
    (left).  Negative orders are therefore a safe background channel and orders
    greater than 1 are a safe foreground channel.  Orders 0/1 and non-default
    sorting layers remain explicitly ``pet-plane``/``unclassified`` so a future
    adapter cannot silently put an authored effect in the wrong pass.
    """
    objects = list(root_reader.assetsfile.objects.values())
    by_id = {int(obj.path_id): obj for obj in objects}
    trees: dict[int, dict[str, Any]] = {}

    def tree_for(path_id: int) -> dict[str, Any]:
        if not path_id or path_id not in by_id:
            return {}
        if path_id not in trees:
            try:
                value = by_id[path_id].read_typetree()
                trees[path_id] = value if isinstance(value, dict) else {}
            except Exception:
                trees[path_id] = {}
        return trees[path_id]

    game_objects: dict[int, dict[str, Any]] = {}
    transforms: dict[int, dict[str, Any]] = {}
    transform_for_go: dict[int, int] = {}
    for obj in objects:
        object_id = int(obj.path_id)
        tree = tree_for(object_id)
        kind = renderer_type(obj)
        if kind == "GameObject":
            game_objects[object_id] = {
                "name": str(tree.get("m_Name") or ""),
                "components": component_ids(tree.get("m_Component")),
            }
        elif kind == "Transform":
            game_object_id = pointer_id(tree.get("m_GameObject"))
            father_id = pointer_id(tree.get("m_Father"))
            transforms[object_id] = {"gameObject": game_object_id, "father": father_id}
            if game_object_id:
                transform_for_go[game_object_id] = object_id

    root_id = int(root_reader.path_id)
    # Prefab container roots are normally GameObjects; tolerate a container
    # pointing at a component by walking back to its owning GameObject.
    if root_id not in game_objects:
        root_tree = tree_for(root_id)
        root_id = pointer_id(root_tree.get("m_GameObject")) or root_id
    root_transform = transform_for_go.get(root_id, 0)

    def under_root(transform_id: int) -> bool:
        seen: set[int] = set()
        current = transform_id
        while current and current not in seen:
            if current == root_transform:
                return True
            seen.add(current)
            current = int(transforms.get(current, {}).get("father") or 0)
        return False

    def transform_path(transform_id: int) -> str:
        names: list[str] = []
        seen: set[int] = set()
        current = transform_id
        while current and current not in seen:
            seen.add(current)
            info = transforms.get(current, {})
            go_id = int(info.get("gameObject") or 0)
            names.append(str(game_objects.get(go_id, {}).get("name") or "<unnamed>"))
            current = int(info.get("father") or 0)
        return "/".join(reversed(names))

    def classify(layer_id: Any, layer_index: Any, order: Any) -> str:
        if layer_id is None and layer_index is None:
            return "unclassified"
        if int(layer_id or 0) != 0 or int(layer_index or 0) != 0:
            return "unclassified"
        if order is None:
            return "unclassified"
        order_number = int(order)
        if order_number < 0:
            return "background"
        if order_number <= 1:
            return "pet-plane"
        return "foreground"

    renderers: list[dict[str, Any]] = []
    for obj in objects:
        kind = renderer_type(obj)
        if not kind.endswith("Renderer"):
            continue
        tree = tree_for(int(obj.path_id))
        game_object_id = pointer_id(tree.get("m_GameObject"))
        transform_id = transform_for_go.get(game_object_id, 0)
        if root_transform and not under_root(transform_id):
            continue
        layer_id = tree.get("m_SortingLayerID")
        layer_index = tree.get("m_SortingLayer")
        order = tree.get("m_SortingOrder")
        try:
            layer_id = int(layer_id) if layer_id is not None else None
        except (TypeError, ValueError):
            layer_id = None
        try:
            layer_index = int(layer_index) if layer_index is not None else None
        except (TypeError, ValueError):
            layer_index = None
        try:
            order = int(order) if order is not None else None
        except (TypeError, ValueError):
            order = None
        classification = classify(layer_id, layer_index, order)
        renderers.append({
            "pathId": int(obj.path_id),
            "type": kind,
            "gameObject": str(game_objects.get(game_object_id, {}).get("name") or ""),
            "transformPath": transform_path(transform_id),
            "sortingLayerId": layer_id,
            "sortingLayer": layer_index,
            "sortingOrder": order,
            "initiallyEnabled": bool(tree.get("m_Enabled", True)),
            "classification": classification,
        })

    counts = {key: sum(1 for item in renderers if item["classification"] == key)
              for key in ("background", "pet-plane", "foreground", "unclassified")}
    channels = {key: [item["pathId"] for item in renderers if item["classification"] == key]
                for key in counts}
    return {
        "schemaVersion": 1,
        "policy": "official-pet-sorting-plane-v1",
        "action": action,
        "petSortingOrders": {"right": 0, "left": 1},
        "rendererCount": len(renderers),
        "classificationCounts": counts,
        "capturePlan": {
            "backgroundRendererPathIds": channels["background"],
            "foregroundRendererPathIds": channels["foreground"],
            "petPlaneRendererPathIds": channels["pet-plane"],
            "unclassifiedRendererPathIds": channels["unclassified"],
            "requiresPetPlanePass": counts["pet-plane"] > 0,
            "requiresUnclassifiedFallback": counts["unclassified"] > 0,
            "safeBackgroundForegroundSplit": counts["pet-plane"] == 0 and counts["unclassified"] == 0,
        },
        "renderers": sorted(renderers, key=lambda item: (item["sortingOrder"] is None,
                                                            item["sortingOrder"] if item["sortingOrder"] is not None else 0,
                                                            item["pathId"])),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True, type=int)
    parser.add_argument("--index", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.owner <= 0:
        raise ValueError("owner must be a positive integer")
    index = json.loads(args.index.read_text(encoding="utf-8"))
    indexed_owner = int(index.get("ownerId") or 0)
    if indexed_owner and indexed_owner != args.owner:
        raise ValueError("bundle index owner does not match --owner")
    timeline_assets = {
        str(asset.get("action") or "").lower(): asset
        for asset in index.get("assets", [])
        if "/Timelines/" in str(asset.get("assetPath") or "")
    }
    effect_assets = {
        str(asset.get("action") or "").lower(): asset
        for asset in index.get("assets", [])
        if "/Effects/" in str(asset.get("assetPath") or "")
    }
    if set(timeline_assets) != set(ACTIONS) or set(effect_assets) != set(ACTIONS):
        raise ValueError("owner does not expose the complete five-action Timeline/Effect family")
    expected_prefixes = (
        f"assets/skilltimeline/timelines/{args.owner}/",
        f"assets/skilltimeline/effects/{args.owner}/",
        f"assets/skilltimeline/videos/{args.owner}/",
    )
    if any(not str(asset.get("assetPath") or "").replace("\\", "/").lower().startswith(expected_prefixes)
           for asset in index.get("assets", [])):
        raise ValueError("bundle index contains an asset owned by another identity")

    environments: dict[str, Any] = {}
    result: dict[str, Any] = {
        "_metadata": {
            "schemaVersion": 1,
            "policy": "official-unity-playable-signal-clock-v1",
            "ownerId": args.owner,
            "hitSignalPolicy": "final-official-signal-marker-v1",
        }
    }
    for action in ACTIONS:
        evidence = timeline_assets[action]
        bundle_file = str((evidence.get("bundle") or {}).get("file") or "")
        if not bundle_file or not Path(bundle_file).is_file():
            raise FileNotFoundError(f"timeline bundle is missing for {action}: {bundle_file}")
        if bundle_file not in environments:
            environments[bundle_file] = UnityPy.load(bundle_file)
        environment = environments[bundle_file]
        wanted = str(evidence.get("assetPath") or "").replace("\\", "/").lower()
        roots = []
        for container_path, reader in environment.container.items():
            if str(container_path).replace("\\", "/").lower() != wanted:
                continue
            # Unity bundles may publish several objects (for example
            # ``Recorded`` sub-assets) under the same container path.  The
            # Timeline root is the sole object whose serialized name is the
            # requested action.
            try:
                candidate = reader.read_typetree()
            except Exception:
                candidate = {}
            if isinstance(candidate, dict) and str(candidate.get("m_Name") or "").lower() == action:
                roots.append(reader)
        if len(roots) != 1:
            raise RuntimeError(f"expected one exact TimelineAsset container for {action}, got {len(roots)}")
        root_reader = roots[0]
        # UnityPy 1.25 exposes the serialized owner as ``assetsfile`` on a
        # container PPtr.  Keep the traversal anchored to that exact file so
        # PathIDs from dependency bundles can never be mistaken for tracks in
        # this TimelineAsset.
        objects = list(root_reader.assetsfile.objects.values())
        by_id = {int(obj.path_id): obj for obj in objects}
        trees: dict[int, dict[str, Any]] = {}

        def tree_for(path_id: int) -> dict[str, Any]:
            if not path_id or path_id not in by_id:
                return {}
            if path_id not in trees:
                try:
                    value = by_id[path_id].read_typetree()
                    trees[path_id] = value if isinstance(value, dict) else {}
                except Exception:
                    trees[path_id] = {}
            return trees[path_id]

        root_tree = tree_for(int(root_reader.path_id))
        if str(root_tree.get("m_Name") or "").lower() != action:
            raise RuntimeError(f"Timeline root identity mismatch for {action}")
        pending = [pointer_id(value) for value in root_tree.get("m_Tracks") or []]
        seen: set[int] = set()
        clips: list[dict[str, Any]] = []
        video_clips: list[dict[str, Any]] = []
        markers: list[dict[str, Any]] = []
        transform_tracks: list[dict[str, Any]] = []
        maximum = float(root_tree.get("m_FixedDuration") or 0.0)
        while pending:
            track_id = pending.pop(0)
            if not track_id or track_id in seen:
                continue
            seen.add(track_id)
            track_tree = tree_for(track_id)
            pending.extend(pointer_id(value) for value in track_tree.get("m_Children") or [])
            track_name = str(track_tree.get("m_Name") or "")
            binding_path = str(track_tree.get("bindingPath") or "")
            transform_clips: list[dict[str, Any]] = []
            for clip in track_tree.get("m_Clips") or []:
                start = float(clip.get("m_Start") or 0.0)
                duration = float(clip.get("m_Duration") or 0.0)
                end = start + duration
                maximum = max(maximum, end)
                clip_record = {"track": track_name, "start": start, "duration": duration, "end": end}
                clips.append(clip_record)
                if track_name.strip().lower() == "video track":
                    video_clips.append(clip_record)
                asset_path_id = pointer_id(clip.get("m_Asset"))
                asset_tree = tree_for(asset_path_id)
                template = transform_template(asset_tree.get("template"))
                if template is not None:
                    blend_in = number(clip.get("m_BlendInDuration"), -1.0)
                    blend_out = number(clip.get("m_BlendOutDuration"), -1.0)
                    ease_in = number(clip.get("m_EaseInDuration"))
                    ease_out = number(clip.get("m_EaseOutDuration"))
                    transform_clips.append({
                        "assetPathId": asset_path_id,
                        "start": start,
                        "duration": duration,
                        "end": end,
                        "clipIn": number(clip.get("m_ClipIn")),
                        "timeScale": number(clip.get("m_TimeScale"), 1.0),
                        "weight": {
                            "easeInSeconds": ease_in,
                            "easeOutSeconds": ease_out,
                            "blendInSeconds": blend_in,
                            "blendOutSeconds": blend_out,
                            "effectiveInSeconds": blend_in if blend_in >= 0 else ease_in,
                            "effectiveOutSeconds": blend_out if blend_out >= 0 else ease_out,
                            "mixInCurve": curve(clip.get("m_MixInCurve")),
                            "mixOutCurve": curve(clip.get("m_MixOutCurve")),
                        },
                        "transform": template,
                    })
            if transform_clips:
                role = "lookAt" if binding_path.lower().endswith("/lookat") else (
                    "target" if binding_path.lower().endswith("/follow") else track_name)
                transform_tracks.append({
                    "track": track_name,
                    "role": role,
                    "bindingPath": binding_path,
                    "muted": bool(track_tree.get("m_Muted")),
                    "clips": transform_clips,
                    "overlaps": overlaps(transform_clips),
                })
            marker_refs = (track_tree.get("m_Markers") or {}).get("m_Objects") or []
            for marker_ref in marker_refs:
                marker_tree = tree_for(pointer_id(marker_ref))
                if "m_Time" not in marker_tree:
                    continue
                moment = float(marker_tree.get("m_Time") or 0.0)
                maximum = max(maximum, moment)
                markers.append({"track": track_name, "time": moment})

        signals = sorted(
            (marker for marker in markers if "signal" in marker["track"].lower()),
            key=lambda marker: marker["time"],
        )
        if action == "appear":
            if signals:
                raise RuntimeError("appear Timeline unexpectedly contains a battle signal")
        elif not signals:
            raise RuntimeError(f"expected at least one official Signal marker for {action}")
        if not maximum > 0:
            raise RuntimeError(f"Timeline duration is invalid for {action}")
        if len(video_clips) > 1:
            raise RuntimeError(f"expected at most one official Video Track clip for {action}")
        video_window = None
        if video_clips:
            video_clip = video_clips[0]
            start = number(video_clip.get("start"))
            duration = number(video_clip.get("duration"))
            end = number(video_clip.get("end"))
            if start < 0 or duration <= 0 or end <= start or end > maximum + 0.05:
                raise RuntimeError(f"official Video Track window is invalid for {action}")
            video_window = {
                "source": "official Video Track",
                "startSeconds": start,
                "endSeconds": end,
                "durationSeconds": duration,
            }
        effect_evidence = effect_assets[action]
        effect_bundle_file = str((effect_evidence.get("bundle") or {}).get("file") or "")
        if not effect_bundle_file or not Path(effect_bundle_file).is_file():
            raise FileNotFoundError(f"effect bundle is missing for {action}: {effect_bundle_file}")
        if effect_bundle_file not in environments:
            environments[effect_bundle_file] = UnityPy.load(effect_bundle_file)
        effect_environment = environments[effect_bundle_file]
        wanted_effect = str(effect_evidence.get("assetPath") or "").replace("\\", "/").lower()
        effect_roots = []
        for container_path, reader in effect_environment.container.items():
            if str(container_path).replace("\\", "/").lower() != wanted_effect:
                continue
            try:
                candidate = reader.read_typetree()
            except Exception:
                candidate = {}
            if isinstance(candidate, dict) and str(candidate.get("m_Name") or "").lower() == action:
                effect_roots.append(reader)
        if len(effect_roots) != 1:
            raise RuntimeError(f"expected one exact Effect prefab container for {action}, got {len(effect_roots)}")
        layer_metadata = renderer_layer_metadata(effect_roots[0], action)
        result[action] = {"rootPathId": int(root_reader.path_id), "computedDuration": maximum,
                          "clips": clips, "markers": markers, "signalMarkers": signals,
                          "videoWindow": video_window,
                          "transformMetadata": {
                              "schemaVersion": 1,
                              "clock": "official-timeline-seconds",
                              "coordinateSpace": "unity-transform-override",
                              "cameraBakedIntoOverlay": True,
                              "composition": {"x": 0, "y": 0, "scaleX": 1, "scaleY": 1,
                                              "rotationDegrees": 0},
                              "framingSamples": framing_samples(transform_tracks, maximum),
                              "tracks": transform_tracks,
                          },
                          "layerMetadata": layer_metadata,
                          # Some authored ultimates contain an earlier cue and a
                          # later battle-resolution signal.  Resolution uses the
                          # final official Signal marker, never a duration ratio.
                          "hitSignal": signals[-1] if signals else None}

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ownerId": args.owner, "output": str(args.output), "actions": list(ACTIONS),
                      "hitSeconds": {action: (result[action]["hitSignal"]["time"]
                                                if action != "appear" else None)
                                     for action in ACTIONS}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
