"""Build and render the two Riftbound Arena pilot characters.

Run with:
  blender --background --python tools/blender/create_characters.py -- public/assets/characters
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Vector


def material(name: str, color: tuple[float, float, float, float], metallic=0.35, roughness=0.28, emission=None):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = emission
        bsdf.inputs["Emission Strength"].default_value = 5.0
    return mat


def cube(name, loc, scale, mat, bevel=0.09, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = obj.modifiers.new("Edge bevel", "BEVEL")
    modifier.width = bevel
    modifier.segments = 3
    obj.data.materials.append(mat)
    return obj


def uv_sphere(name, loc, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return obj


def cylinder(name, loc, radius, depth, mat, rotation=(0, 0, 0), vertices=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new("Edge bevel", "BEVEL")
    bevel.width = 0.055
    bevel.segments = 3
    return obj


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.materials, bpy.data.curves, bpy.data.meshes, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def build_pilot(callsign: str, accent_rgb: tuple[float, float, float], variant: str):
    dark = material(f"{callsign}_graphite", (0.018, 0.027, 0.052, 1), 0.7, 0.2)
    armor = material(f"{callsign}_armor", (0.105, 0.135, 0.19, 1), 0.72, 0.18)
    accent = material(f"{callsign}_accent", (*accent_rgb, 1), 0.35, 0.18)
    glow = material(f"{callsign}_glow", (*accent_rgb, 1), 0.1, 0.16, (*accent_rgb, 1))
    white = material(f"{callsign}_ceramic", (0.62, 0.70, 0.78, 1), 0.55, 0.17)

    root = bpy.data.objects.new(callsign, None)
    bpy.context.collection.objects.link(root)

    # Athletic armored silhouette with a compact reactor spine.
    parts = []
    parts.append(cube("Torso", (0, 0, 2.65), (0.58, 0.36, 0.72), armor, 0.15))
    parts.append(cube("Chest_plate", (0.05, -0.34, 2.78), (0.48, 0.08, 0.42), white, 0.1))
    parts.append(uv_sphere("Reactor", (0.08, -0.44, 2.78), (0.18, 0.07, 0.18), glow))
    parts.append(cube("Waist", (0, 0, 1.96), (0.40, 0.30, 0.20), dark, 0.08))

    # Helmet and luminous face slit.
    parts.append(uv_sphere("Helmet", (0, 0, 3.72), (0.50, 0.43, 0.52), armor))
    parts.append(cube("Brow", (0.07, -0.37, 3.80), (0.36, 0.08, 0.16), dark, 0.07))
    parts.append(cube("Visor", (0.08, -0.445, 3.75), (0.30, 0.025, 0.065), glow, 0.035))
    parts.append(cube("Jaw", (0.08, -0.35, 3.48), (0.30, 0.12, 0.13), white, 0.06))
    fin_height = 0.34 if variant == "astra" else 0.22
    parts.append(cube("Crown_fin", (-0.12, 0.02, 4.23), (0.10, 0.20, fin_height), accent, 0.05, (0, 0.24, 0)))

    # Grounded stride: back leg planted, front leg flexed.
    parts.append(cube("Rear_thigh", (-0.28, 0.08, 1.45), (0.25, 0.27, 0.54), armor, 0.12, (0, -0.05, -0.05)))
    parts.append(cube("Rear_shin", (-0.40, 0.08, 0.62), (0.22, 0.24, 0.55), dark, 0.10, (0, 0.12, -0.03)))
    parts.append(cube("Rear_boot", (-0.18, -0.04, 0.10), (0.42, 0.34, 0.16), white, 0.09))
    parts.append(cube("Front_thigh", (0.38, -0.03, 1.42), (0.27, 0.29, 0.53), white, 0.12, (0, -0.18, 0.02)))
    parts.append(cube("Front_shin", (0.58, -0.05, 0.66), (0.23, 0.25, 0.52), armor, 0.10, (0, 0.25, 0.02)))
    parts.append(cube("Front_boot", (0.84, -0.12, 0.13), (0.44, 0.35, 0.17), accent, 0.09))
    parts.append(cube("Knee_glow", (0.48, -0.32, 1.08), (0.14, 0.04, 0.11), glow, 0.04))

    # Rear shield arm, projecting a readable shield-ring mount.
    parts.append(uv_sphere("Rear_shoulder", (-0.62, 0.04, 2.95), (0.34, 0.38, 0.34), white))
    parts.append(cube("Rear_arm", (-0.72, 0.03, 2.35), (0.22, 0.24, 0.44), armor, 0.10, (0.15, 0, -0.05)))
    parts.append(cylinder("Shield_emitter", (-0.78, -0.23, 2.12), 0.30, 0.16, accent, (math.radians(90), 0, 0), 32))
    parts.append(cylinder("Shield_core", (-0.78, -0.33, 2.12), 0.13, 0.07, glow, (math.radians(90), 0, 0), 32))

    # Forward cannon arm; clear horizontal read at small sprite sizes.
    parts.append(uv_sphere("Cannon_shoulder", (0.64, -0.03, 3.02), (0.36, 0.40, 0.36), accent))
    parts.append(cube("Cannon_upper", (0.88, -0.04, 2.64), (0.37, 0.27, 0.24), armor, 0.10, (0, 0, -0.12)))
    parts.append(cylinder("Blaster", (1.45, -0.04, 2.55), 0.30, 0.88, dark, (0, math.radians(90), 0), 32))
    parts.append(cylinder("Blaster_shroud", (1.72, -0.04, 2.55), 0.37, 0.20, white, (0, math.radians(90), 0), 32))
    parts.append(cylinder("Muzzle_glow", (1.84, -0.04, 2.55), 0.20, 0.08, glow, (0, math.radians(90), 0), 32))

    # Small asymmetric silhouette cues distinguish the pilots beyond color.
    if variant == "astra":
        parts.append(cube("Antenna", (-0.34, 0.00, 4.28), (0.035, 0.035, 0.30), accent, 0.02, (0, -0.2, -0.1)))
    else:
        parts.append(cube("Shoulder_blade", (-0.74, 0.02, 3.28), (0.11, 0.20, 0.42), accent, 0.05, (0, -0.2, -0.2)))

    for obj in parts:
        obj.parent = root

    return root


def setup_world():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = True
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = bpy.data.worlds.new("Riftbound World") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.006, 0.009, 0.022, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.28

    bpy.ops.object.light_add(type="AREA", location=(2.5, -5.0, 7.2))
    key = bpy.context.object
    key.name = "Key_Light"
    key.data.energy = 1050
    key.data.shape = "DISK"
    key.data.size = 4.0
    key.data.color = (0.55, 0.76, 1.0)
    look_at(key, (0.2, 0, 2.2))

    bpy.ops.object.light_add(type="AREA", location=(-4.0, 2.0, 4.8))
    rim = bpy.context.object
    rim.name = "Rim_Light"
    rim.data.energy = 900
    rim.data.size = 3.0
    rim.data.color = (0.80, 0.16, 1.0)
    look_at(rim, (0, 0, 2.4))

    bpy.ops.object.camera_add(location=(7.4, -14.5, 5.6))
    camera = bpy.context.object
    camera.name = "Pilot_Render_Camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 5.6
    look_at(camera, (0.25, 0, 2.15))
    scene.camera = camera


def render_character(output_dir: str, callsign: str, color, variant):
    clear_scene()
    setup_world()
    root = build_pilot(callsign, color, variant)
    bpy.context.view_layer.objects.active = root
    root.select_set(True)

    png_path = os.path.join(output_dir, f"{callsign.lower()}.png")
    blend_path = os.path.join(output_dir, f"{callsign.lower()}.blend")
    glb_path = os.path.join(output_dir, f"{callsign.lower()}.glb")
    bpy.context.scene.render.filepath = png_path
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    bpy.ops.render.render(write_still=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB", export_apply=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    output_dir = os.path.abspath(argv[0] if argv else "public/assets/characters")
    os.makedirs(output_dir, exist_ok=True)
    render_character(output_dir, "Astra", (0.00, 0.86, 1.00), "astra")
    render_character(output_dir, "Vanta", (1.00, 0.12, 0.62), "vanta")
    print(f"Rendered Riftbound pilots to {output_dir}")


if __name__ == "__main__":
    main()
