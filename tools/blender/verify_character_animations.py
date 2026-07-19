"""Verify the exported Riftbound pilot rigs, GLB animation clips, and atlases."""

from __future__ import annotations

import json
import os
import sys

import bpy


EXPECTED = {"Idle", "Run", "Jump", "Fire", "Shield", "Dash", "Hit", "Defeat"}


def clear_imported_data():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    for image in list(bpy.data.images):
        if image.name != "Render Result":
            bpy.data.images.remove(image)


def verify_character(asset_dir, character):
    clear_imported_data()
    glb_path = os.path.join(asset_dir, f"{character}.glb")
    atlas_path = os.path.join(asset_dir, f"{character}-spritesheet.png")
    manifest_path = os.path.join(asset_dir, f"{character}-animations.json")

    bpy.ops.import_scene.gltf(filepath=glb_path)
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"{character}: expected one armature, found {len(armatures)}")

    action_names = {action.name.split(".")[0] for action in bpy.data.actions}
    missing_actions = EXPECTED - action_names
    if missing_actions:
        raise RuntimeError(f"{character}: GLB is missing actions {sorted(missing_actions)}; found {sorted(action_names)}")

    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    if set(manifest["clips"]) != {name.lower() for name in EXPECTED}:
        raise RuntimeError(f"{character}: animation manifest does not match the expected clips")
    if manifest["frameWidth"] != 256 or manifest["frameHeight"] != 256 or manifest["columns"] != 8:
        raise RuntimeError(f"{character}: unexpected atlas layout {manifest}")

    atlas = bpy.data.images.load(atlas_path, check_existing=False)
    if tuple(atlas.size) != (2048, 2048):
        raise RuntimeError(f"{character}: expected a 2048x2048 atlas, found {tuple(atlas.size)}")
    print(f"{character}: rig + {len(EXPECTED)} GLB clips + 64 atlas frames verified")


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    asset_dir = os.path.abspath(argv[0] if argv else "public/assets/characters")
    verify_character(asset_dir, "astra")
    verify_character(asset_dir, "vanta")
    print("Riftbound character animation validation passed")


if __name__ == "__main__":
    main()
