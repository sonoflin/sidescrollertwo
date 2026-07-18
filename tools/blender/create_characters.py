"""Build the hero-art-inspired Riftbound Arena pilots.

Design reference: public/og.png

Outputs for each pilot:
  - an editable Blender scene
  - a game-ready GLB model
  - a transparent 1024px action-pose render

Run with:
  blender --background --python tools/blender/create_characters.py -- public/assets/characters
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Vector


def make_material(name, color, metallic=0.55, roughness=0.22, emission=None, emission_strength=0.0, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color[:3], alpha)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color[:3], 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission[:3], 1)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.surface_render_method = "DITHERED"
    return mat


def finish_object(obj, name, mat, parent=None, bevel=0.0, smooth=False):
    obj.name = name
    if mat:
        obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Micro bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    if smooth and hasattr(obj.data, "polygons"):
        for face in obj.data.polygons:
            face.use_smooth = True
    if parent:
        obj.parent = parent
    return obj


def box(name, loc, scale, mat, parent, rotation=(0, 0, 0), bevel=0.06):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish_object(obj, name, mat, parent, bevel)


def ellipsoid(name, loc, scale, mat, parent, rotation=(0, 0, 0), subdivisions=3):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish_object(obj, name, mat, parent, smooth=True)


def cylinder(name, loc, radius, depth, mat, parent, rotation=(0, 0, 0), vertices=32, bevel=0.035):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
    return finish_object(bpy.context.object, name, mat, parent, bevel, smooth=True)


def cone(name, loc, radius1, radius2, depth, mat, parent, rotation=(0, 0, 0), vertices=32, bevel=0.025):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1, radius2=radius2, depth=depth, location=loc, rotation=rotation)
    return finish_object(bpy.context.object, name, mat, parent, bevel, smooth=True)


def torus(name, loc, major, minor, mat, parent, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=48, minor_segments=12, location=loc, rotation=rotation)
    return finish_object(bpy.context.object, name, mat, parent, smooth=True)


def segment(name, start, end, radius, mat, parent, taper=1.0):
    start_v, end_v = Vector(start), Vector(end)
    direction = end_v - start_v
    midpoint = (start_v + end_v) / 2
    bpy.ops.mesh.primitive_cone_add(
        vertices=24,
        radius1=radius,
        radius2=radius * taper,
        depth=direction.length,
        location=midpoint,
    )
    obj = bpy.context.object
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return finish_object(obj, name, mat, parent, 0.035, smooth=True)


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.materials,
        bpy.data.curves,
        bpy.data.meshes,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.armatures,
    ):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def add_panel_lines(root, glow, variant):
    # Hero-art-style energy seams on the chest and lower legs.
    z_shift = 0.02 if variant == "astra" else -0.02
    box("Chest_Seam_L", (-0.19, -0.445, 2.88 + z_shift), (0.025, 0.018, 0.29), glow, root, (0, 0, -0.38), 0.012)
    box("Chest_Seam_R", (0.28, -0.438, 2.84), (0.025, 0.018, 0.26), glow, root, (0, 0, 0.34), 0.012)
    box("Abdomen_Seam", (0.03, -0.34, 2.16), (0.28, 0.014, 0.026), glow, root, (0, 0, -0.05), 0.01)


def add_shield(root, center, accent, glow, dark):
    x, y, z = center
    rotation = (math.radians(90), 0, 0)
    # Physical emitter plus projected shield disc inspired by the key art.
    torus("Shield_Emitter_Rim", center, 0.47, 0.075, accent, root, rotation)
    torus("Shield_Emitter_Glow", (x, y - 0.018, z), 0.36, 0.026, glow, root, rotation)
    cylinder("Shield_Field", (x, y + 0.018, z), 0.40, 0.025, dark, root, rotation, 48, 0.01)
    cylinder("Shield_Hub", (x, y - 0.07, z), 0.115, 0.11, glow, root, rotation, 32, 0.025)
    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        end = (x + math.cos(rad) * 0.32, y - 0.085, z + math.sin(rad) * 0.32)
        segment(f"Shield_Spoke_{angle}", (x, y - 0.085, z), end, 0.015, glow, root)


def add_blaster(root, origin, accent, glow, armor, dark, light):
    x, y, z = origin
    axis_x = (0, math.radians(90), 0)
    # Multi-stage forearm cannon with rails, illuminated chamber, and flared muzzle.
    cylinder("Blaster_Core", (x, y, z), 0.245, 1.12, dark, root, axis_x, 32, 0.04)
    cone("Blaster_Taper", (x + 0.56, y, z), 0.29, 0.21, 0.42, armor, root, axis_x, 32, 0.035)
    cylinder("Blaster_Muzzle", (x + 0.80, y, z), 0.33, 0.14, light, root, axis_x, 32, 0.035)
    torus("Blaster_Muzzle_Glow", (x + 0.885, y, z), 0.19, 0.04, glow, root, (0, math.radians(90), 0))
    cylinder("Blaster_Bore", (x + 0.90, y, z), 0.13, 0.04, dark, root, axis_x, 32, 0.01)
    box("Blaster_Top_Rail", (x + 0.10, y, z + 0.27), (0.38, 0.12, 0.055), armor, root, (0, -0.08, 0), 0.03)
    box("Blaster_Lower_Rail", (x + 0.15, y, z - 0.25), (0.32, 0.10, 0.045), accent, root, (0, 0.06, 0), 0.025)
    box("Blaster_Energy_Cell", (x + 0.17, y - 0.245, z), (0.30, 0.025, 0.055), glow, root, (0, 0, 0), 0.025)


def build_pilot(callsign, accent_rgb, variant):
    graphite = make_material(f"{callsign}_Graphite", (0.006, 0.009, 0.019), 0.82, 0.16)
    under = make_material(f"{callsign}_Understructure", (0.018, 0.028, 0.048), 0.72, 0.26)
    armor = make_material(f"{callsign}_Gunmetal", (0.10, 0.14, 0.20), 0.88, 0.16)
    light = make_material(f"{callsign}_Ceramic", (0.54, 0.62, 0.72), 0.72, 0.17)
    accent = make_material(f"{callsign}_Accent", accent_rgb, 0.62, 0.14)
    glow = make_material(f"{callsign}_Energy", accent_rgb, 0.24, 0.13, accent_rgb, 12.0)
    visor = make_material(f"{callsign}_Visor", (0.002, 0.01, 0.022), 0.92, 0.07, accent_rgb, 3.2)
    shield_field = make_material(f"{callsign}_Shield_Field", (*accent_rgb,), 0.05, 0.12, accent_rgb, 1.3, 0.28)

    root = bpy.data.objects.new(callsign, None)
    bpy.context.collection.objects.link(root)
    root["design_reference"] = "public/og.png"
    root["character_role"] = "online arena pilot"
    root["facing_axis"] = "+X"

    # Compact black mechanical core under overlapping hard-surface plates.
    ellipsoid("Pelvis_Core", (0.00, 0, 1.88), (0.43, 0.32, 0.30), under, root)
    segment("Spine", (0.00, 0, 1.92), (0.02, 0, 2.70), 0.25, graphite, root, 0.82)
    ellipsoid("Torso_Core", (0.02, 0, 2.66), (0.56, 0.35, 0.70), under, root)
    box("Chest_Plate_L", (-0.20, -0.31, 2.86), (0.33, 0.10, 0.47), light, root, (0.06, -0.10, -0.16), 0.10)
    box("Chest_Plate_R", (0.31, -0.31, 2.82), (0.27, 0.105, 0.42), armor, root, (-0.06, 0.12, 0.14), 0.09)
    box("Sternum", (0.05, -0.415, 2.68), (0.16, 0.04, 0.35), graphite, root, (0, 0, -0.03), 0.05)
    torus("Chest_Reactor_Ring", (0.04, -0.47, 2.76), 0.17, 0.035, glow, root, (math.radians(90), 0, 0))
    cylinder("Chest_Reactor_Core", (0.04, -0.49, 2.76), 0.09, 0.045, glow, root, (math.radians(90), 0, 0), 32, 0.015)
    box("Collar_L", (-0.30, -0.02, 3.33), (0.32, 0.28, 0.12), armor, root, (0, -0.10, -0.18), 0.07)
    box("Collar_R", (0.32, -0.02, 3.32), (0.31, 0.28, 0.12), light, root, (0, 0.10, 0.18), 0.07)
    for z in (2.12, 2.28, 2.44):
        box(f"Abdominal_Plate_{z}", (0.02, -0.26, z), (0.35, 0.09, 0.075), armor if int(z * 100) % 2 else light, root, (0, 0, -0.03), 0.045)
    add_panel_lines(root, glow, variant)

    # Aerodynamic helmet: swept shell, inset face, and sharp visor line.
    ellipsoid("Helmet_Core", (0.02, 0, 3.78), (0.46, 0.39, 0.47), graphite, root, (0, -0.06, 0))
    ellipsoid("Helmet_Shell", (-0.07, 0.03, 3.86), (0.48, 0.40, 0.43), armor, root, (0, -0.15, 0))
    box("Faceplate", (0.22, -0.34, 3.72), (0.34, 0.075, 0.23), light, root, (0, -0.10, -0.03), 0.065)
    box("Visor_Slit", (0.24, -0.425, 3.85), (0.34, 0.025, 0.072), visor, root, (0, -0.08, -0.035), 0.035)
    box("Visor_Glow", (0.26, -0.453, 3.85), (0.27, 0.012, 0.025), glow, root, (0, -0.08, -0.035), 0.012)
    box("Helmet_Crest", (-0.34, 0.04, 4.16), (0.38, 0.20, 0.10), light if variant == "astra" else armor, root, (0, -0.16, -0.18), 0.055)
    box("Helmet_Fin", (-0.55, 0.05, 4.04), (0.36, 0.15, 0.075), accent, root, (0, -0.06, -0.30), 0.045)
    if variant == "vanta":
        box("Vanta_Cheek_Blade", (0.12, 0.29, 3.66), (0.30, 0.07, 0.08), accent, root, (0.08, 0.10, -0.18), 0.035)

    # Ball-and-socket shoulders with layered deltoid armor.
    ellipsoid("Cannon_Shoulder_Joint", (0.64, 0.00, 3.02), (0.25, 0.27, 0.25), graphite, root)
    ellipsoid("Cannon_Shoulder_Armor", (0.68, 0.02, 3.09), (0.39, 0.34, 0.28), light, root, (0.10, 0.05, 0))
    box("Cannon_Shoulder_Accent", (0.74, -0.29, 3.11), (0.22, 0.05, 0.075), accent, root, (0, 0, -0.08), 0.035)
    segment("Cannon_Upper_Arm", (0.68, 0, 2.98), (1.08, -0.01, 2.68), 0.22, under, root, 0.82)
    box("Cannon_Bicep_Plate", (0.88, -0.20, 2.82), (0.27, 0.09, 0.18), armor, root, (0.05, 0.22, -0.18), 0.065)
    add_blaster(root, (1.36, -0.01, 2.60), accent, glow, armor, graphite, light)

    ellipsoid("Shield_Shoulder_Joint", (-0.61, 0.07, 3.00), (0.24, 0.26, 0.24), graphite, root)
    ellipsoid("Shield_Shoulder_Armor", (-0.67, 0.08, 3.06), (0.37, 0.33, 0.27), armor, root, (-0.08, -0.05, 0))
    segment("Shield_Upper_Arm", (-0.63, 0.07, 2.96), (-1.00, 0.07, 2.56), 0.21, under, root, 0.85)
    box("Shield_Bicep_Plate", (-0.83, -0.16, 2.76), (0.25, 0.09, 0.17), light, root, (-0.06, -0.20, 0.20), 0.06)
    segment("Shield_Forearm", (-1.00, 0.07, 2.56), (-1.16, -0.02, 2.22), 0.19, armor, root, 0.90)
    add_shield(root, (-1.25, -0.20, 2.22), accent, glow, shield_field)

    # Sprinting legs: separated silhouettes and exposed luminous joints.
    ellipsoid("Hip_Front", (0.31, -0.03, 1.80), (0.25, 0.25, 0.25), graphite, root)
    segment("Front_Thigh_Core", (0.31, -0.03, 1.79), (0.82, -0.08, 1.30), 0.24, under, root, 0.86)
    box("Front_Thigh_Armor", (0.55, -0.24, 1.55), (0.23, 0.12, 0.37), light, root, (0.03, -0.30, -0.30), 0.08)
    ellipsoid("Front_Knee", (0.84, -0.08, 1.27), (0.24, 0.24, 0.22), graphite, root)
    torus("Front_Knee_Glow", (0.84, -0.30, 1.27), 0.12, 0.025, glow, root, (math.radians(90), 0, 0))
    segment("Front_Shin_Core", (0.84, -0.08, 1.20), (1.18, -0.12, 0.69), 0.20, under, root, 0.80)
    box("Front_Shin_Armor", (1.03, -0.24, 0.95), (0.20, 0.11, 0.35), armor, root, (0.03, -0.29, -0.30), 0.07)
    box("Front_Boot", (1.41, -0.12, 0.48), (0.40, 0.30, 0.17), light, root, (0.02, -0.06, -0.05), 0.075)
    box("Front_Boot_Toe", (1.70, -0.14, 0.45), (0.25, 0.27, 0.12), accent, root, (0, -0.04, -0.04), 0.06)

    ellipsoid("Hip_Rear", (-0.30, 0.14, 1.80), (0.25, 0.25, 0.25), graphite, root)
    segment("Rear_Thigh_Core", (-0.30, 0.14, 1.78), (-0.70, 0.17, 1.13), 0.23, under, root, 0.84)
    box("Rear_Thigh_Armor", (-0.49, -0.03, 1.47), (0.22, 0.11, 0.39), armor, root, (-0.02, 0.28, 0.29), 0.075)
    ellipsoid("Rear_Knee", (-0.72, 0.17, 1.09), (0.22, 0.22, 0.21), graphite, root)
    cylinder("Rear_Knee_Energy", (-0.72, -0.05, 1.09), 0.10, 0.06, glow, root, (math.radians(90), 0, 0), 24, 0.02)
    segment("Rear_Shin_Core", (-0.72, 0.17, 1.03), (-1.25, 0.18, 0.51), 0.19, under, root, 0.82)
    box("Rear_Shin_Armor", (-0.98, -0.01, 0.79), (0.19, 0.10, 0.35), light, root, (-0.02, 0.42, 0.43), 0.07)
    box("Rear_Boot", (-1.48, 0.16, 0.37), (0.40, 0.29, 0.16), armor, root, (0, 0.04, 0.06), 0.075)
    box("Rear_Heel_Accent", (-1.70, 0.16, 0.40), (0.18, 0.25, 0.10), accent, root, (0, 0.03, 0.05), 0.05)

    # Rear reactor vanes help the silhouette read at sprite scale.
    box("Reactor_Vane_Top", (-0.48, 0.22, 3.08), (0.12, 0.16, 0.36), armor, root, (0.22, 0.18, -0.22), 0.05)
    box("Reactor_Vane_Lower", (-0.52, 0.22, 2.58), (0.10, 0.14, 0.28), accent, root, (-0.18, 0.12, -0.16), 0.045)
    cylinder("Back_Reactor", (-0.42, 0.23, 2.78), 0.16, 0.15, glow, root, (math.radians(90), 0, 0), 32, 0.03)

    return root


def setup_render(accent_rgb):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = True
    scene.render.resolution_percentage = 100
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = bpy.data.worlds.new("Riftbound World") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.002, 0.004, 0.012, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.18

    bpy.ops.object.light_add(type="AREA", location=(4.6, -6.8, 7.8))
    key = bpy.context.object
    key.name = "Cool_Key"
    key.data.energy = 1250
    key.data.shape = "DISK"
    key.data.size = 4.0
    key.data.color = (0.64, 0.80, 1.0)
    look_at(key, (0.1, 0, 2.25))

    bpy.ops.object.light_add(type="AREA", location=(-4.8, 2.8, 5.4))
    rim = bpy.context.object
    rim.name = "Accent_Rim"
    rim.data.energy = 1450
    rim.data.size = 3.2
    rim.data.color = accent_rgb
    look_at(rim, (-0.1, 0, 2.35))

    bpy.ops.object.light_add(type="AREA", location=(0, 0.8, 7.5))
    top = bpy.context.object
    top.name = "Top_Strip"
    top.data.energy = 850
    top.data.shape = "RECTANGLE"
    top.data.size = 2.0
    top.data.size_y = 5.0
    top.data.color = (0.65, 0.57, 1.0)
    look_at(top, (0, 0, 2.2))

    bpy.ops.object.camera_add(location=(7.8, -16.2, 6.0))
    camera = bpy.context.object
    camera.name = "Pilot_Action_Camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 5.65
    look_at(camera, (0.15, 0, 2.20))
    scene.camera = camera


def render_character(output_dir, callsign, color, variant):
    clear_scene()
    setup_render(color)
    root = build_pilot(callsign, color, variant)

    png_path = os.path.join(output_dir, f"{callsign.lower()}.png")
    blend_path = os.path.join(output_dir, f"{callsign.lower()}.blend")
    glb_path = os.path.join(output_dir, f"{callsign.lower()}.glb")
    bpy.context.scene.render.filepath = png_path
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    bpy.ops.render.render(write_still=True)

    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for obj in root.children_recursive:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
    )


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    output_dir = os.path.abspath(argv[0] if argv else "public/assets/characters")
    os.makedirs(output_dir, exist_ok=True)
    render_character(output_dir, "Astra", (0.00, 0.76, 1.00), "astra")
    render_character(output_dir, "Vanta", (1.00, 0.03, 0.48), "vanta")
    print(f"Rendered hero-art-inspired Riftbound pilots to {output_dir}")


if __name__ == "__main__":
    main()
