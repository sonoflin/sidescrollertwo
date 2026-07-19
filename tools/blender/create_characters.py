"""Build the hero-art-inspired Riftbound Arena pilots.

Design reference: public/og.png

Outputs for each pilot:
  - an editable, rigid-body-rigged Blender scene
  - a game-ready GLB model with named animation clips
  - a transparent 1024px action-pose render
  - an 8x8 transparent animation sprite sheet and JSON manifest

Run with:
  blender --background --python tools/blender/create_characters.py -- public/assets/characters
"""

from __future__ import annotations

import math
import json
import os
import shutil
import sys
import tempfile
from array import array

import bpy
from mathutils import Vector


ANIMATION_SPECS = (
    ("Idle", 1, 48, 8, True),
    ("Run", 1, 24, 16, True),
    ("Jump", 1, 30, 14, False),
    ("Fire", 1, 14, 18, False),
    ("Shield", 1, 24, 12, True),
    ("Dash", 1, 16, 20, False),
    ("Hit", 1, 12, 18, False),
    ("Defeat", 1, 40, 12, False),
)
ATLAS_FRAME_SIZE = 256
ATLAS_COLUMNS = 8


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
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
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


def create_bone(edit_bones, name, head, tail, parent=None):
    bone = edit_bones.new(name)
    bone.head = head
    bone.tail = tail
    bone.parent = parent
    bone.use_connect = False
    return bone


def rigid_parent_to_bone(obj, armature, bone_name):
    world = obj.matrix_world.copy()
    obj.parent = armature
    obj.parent_type = "BONE"
    obj.parent_bone = bone_name
    obj.matrix_world = world


def create_pilot_rig(root, callsign):
    """Create a rigid-body armature suited to a segmented combat robot."""
    meshes = [obj for obj in root.children if obj.type == "MESH"]
    rig_data = bpy.data.armatures.new(f"{callsign}_PilotRig")
    rig = bpy.data.objects.new(f"{callsign}_PilotRig", rig_data)
    bpy.context.collection.objects.link(rig)
    rig.parent = root
    rig.show_in_front = True
    rig["rig_type"] = "rigid segmented pilot"
    rig["facing_axis"] = "+X"

    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bones = rig_data.edit_bones
    master = create_bone(bones, "master", (0, 0, 0.18), (0, 0, 0.78))
    pelvis = create_bone(bones, "pelvis", (0, 0, 1.66), (0, 0, 2.10), master)
    spine = create_bone(bones, "spine", (0, 0, 2.02), (0.02, 0, 3.40), pelvis)
    create_bone(bones, "head", (0.02, 0, 3.34), (0.02, 0, 4.28), spine)

    cannon_upper = create_bone(bones, "cannon_upper", (0.64, 0, 3.02), (1.08, -0.01, 2.68), spine)
    create_bone(bones, "cannon_forearm", (1.08, -0.01, 2.68), (2.26, -0.01, 2.60), cannon_upper)
    shield_upper = create_bone(bones, "shield_upper", (-0.61, 0.07, 3.00), (-1.00, 0.07, 2.56), spine)
    create_bone(bones, "shield_forearm", (-1.00, 0.07, 2.56), (-1.25, -0.20, 2.22), shield_upper)

    front_thigh = create_bone(bones, "front_thigh", (0.31, -0.03, 1.80), (0.84, -0.08, 1.27), pelvis)
    front_shin = create_bone(bones, "front_shin", (0.84, -0.08, 1.27), (1.18, -0.12, 0.69), front_thigh)
    create_bone(bones, "front_foot", (1.18, -0.12, 0.69), (1.72, -0.14, 0.45), front_shin)
    rear_thigh = create_bone(bones, "rear_thigh", (-0.30, 0.14, 1.80), (-0.72, 0.17, 1.09), pelvis)
    rear_shin = create_bone(bones, "rear_shin", (-0.72, 0.17, 1.09), (-1.25, 0.18, 0.51), rear_thigh)
    create_bone(bones, "rear_foot", (-1.25, 0.18, 0.51), (-1.72, 0.16, 0.40), rear_shin)
    bpy.ops.object.mode_set(mode="OBJECT")

    def bone_for_object(name):
        if name.startswith(("Helmet_", "Faceplate", "Visor_")):
            return "head"
        if name.startswith("Blaster_"):
            return "cannon_forearm"
        if name.startswith(("Cannon_Shoulder", "Cannon_Upper", "Cannon_Bicep")):
            return "cannon_upper"
        if name.startswith(("Shield_Forearm", "Shield_Emitter", "Shield_Field", "Shield_Hub", "Shield_Spoke")):
            return "shield_forearm"
        if name.startswith(("Shield_Shoulder", "Shield_Upper", "Shield_Bicep")):
            return "shield_upper"
        if name.startswith(("Front_Boot", "Front_Boot_Toe")):
            return "front_foot"
        if name.startswith(("Front_Knee", "Front_Shin")):
            return "front_shin"
        if name.startswith(("Hip_Front", "Front_Thigh")):
            return "front_thigh"
        if name.startswith(("Rear_Boot", "Rear_Heel")):
            return "rear_foot"
        if name.startswith(("Rear_Knee", "Rear_Shin")):
            return "rear_shin"
        if name.startswith(("Hip_Rear", "Rear_Thigh")):
            return "rear_thigh"
        if name.startswith("Pelvis_"):
            return "pelvis"
        return "spine"

    for obj in meshes:
        rigid_parent_to_bone(obj, rig, bone_for_object(obj.name))
    return rig


def rz(degrees):
    return (0.0, 0.0, math.radians(degrees))


def key_pose(rig, frame, rotations=None, locations=None, scales=None):
    rotations = rotations or {}
    locations = locations or {}
    scales = scales or {}
    for bone in rig.pose.bones:
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = rotations.get(bone.name, (0.0, 0.0, 0.0))
        bone.location = locations.get(bone.name, (0.0, 0.0, 0.0))
        bone.scale = scales.get(bone.name, (1.0, 1.0, 1.0))
        bone.keyframe_insert(data_path="rotation_euler", frame=frame, group=bone.name)
        bone.keyframe_insert(data_path="location", frame=frame, group=bone.name)
        bone.keyframe_insert(data_path="scale", frame=frame, group=bone.name)


def make_action(rig, name, end_frame, fps, loop, poses, interpolation="BEZIER"):
    action = bpy.data.actions.new(name=name)
    action.use_fake_user = True
    action["clip_name"] = name
    action["fps"] = fps
    action["loop"] = loop
    action["gameplay_ready"] = True
    rig.animation_data.action = action
    previous_interpolation = bpy.context.preferences.edit.keyframe_new_interpolation_type
    bpy.context.preferences.edit.keyframe_new_interpolation_type = interpolation
    for frame, rotations, locations, scales in poses:
        key_pose(rig, frame, rotations, locations, scales)
    bpy.context.preferences.edit.keyframe_new_interpolation_type = previous_interpolation
    action.frame_start = 1
    action.frame_end = end_frame
    return action


def create_pilot_animations(rig, root):
    rig.animation_data_create()
    actions = {}

    idle_base = {
        "master": rz(1), "spine": rz(-1), "front_thigh": rz(28), "front_shin": rz(-10),
        "front_foot": rz(-5), "rear_thigh": rz(-24), "rear_shin": rz(11), "rear_foot": rz(4),
        "cannon_upper": rz(-3), "shield_upper": rz(4),
    }
    idle_breathe = {**idle_base, "master": rz(0), "spine": rz(1), "head": rz(-2), "cannon_upper": rz(-1), "shield_upper": rz(2)}
    actions["Idle"] = make_action(rig, "Idle", 48, 8, True, [
        (1, idle_base, {}, {}),
        (13, idle_breathe, {"master": (0, 0, 0.035)}, {}),
        (25, idle_base, {}, {}),
        (37, {**idle_breathe, "head": rz(2)}, {"master": (0, 0, 0.02)}, {}),
        (48, idle_base, {}, {}),
    ])

    run_contact = {
        "master": rz(8), "spine": rz(-4), "head": rz(-2), "cannon_upper": rz(-4), "shield_upper": rz(7),
        "front_thigh": rz(0), "front_shin": rz(0), "front_foot": rz(0),
        "rear_thigh": rz(0), "rear_shin": rz(0), "rear_foot": rz(0),
    }
    run_pass = {
        "master": rz(10), "spine": rz(-5), "front_thigh": rz(25), "front_shin": rz(-22),
        "front_foot": rz(-8), "rear_thigh": rz(-20), "rear_shin": rz(22), "rear_foot": rz(8),
        "cannon_upper": rz(4), "shield_upper": rz(-5),
    }
    run_reverse = {
        "master": rz(8), "spine": rz(-4), "head": rz(2), "front_thigh": rz(58), "front_shin": rz(-38),
        "front_foot": rz(-12), "rear_thigh": rz(-48), "rear_shin": rz(34), "rear_foot": rz(12),
        "cannon_upper": rz(12), "shield_upper": rz(-12),
    }
    actions["Run"] = make_action(rig, "Run", 24, 16, True, [
        (1, run_contact, {}, {}),
        (7, run_pass, {"master": (0, 0, 0.055)}, {}),
        (13, run_reverse, {}, {}),
        (19, {**run_pass, "cannon_upper": rz(-8), "shield_upper": rz(10)}, {"master": (0, 0, 0.055)}, {}),
        (24, run_contact, {}, {}),
    ], "LINEAR")

    actions["Jump"] = make_action(rig, "Jump", 30, 14, False, [
        (1, {**idle_base, "master": rz(8), "front_thigh": rz(38), "rear_thigh": rz(-34)}, {"master": (0, 0, -0.12)}, {}),
        (7, {"master": rz(10), "spine": rz(-4), "front_thigh": rz(65), "front_shin": rz(-52), "rear_thigh": rz(-62), "rear_shin": rz(48), "front_foot": rz(-12), "rear_foot": rz(12)}, {"master": (0.05, 0, 0.16)}, {}),
        (15, {"master": rz(6), "spine": rz(-3), "head": rz(-2), "front_thigh": rz(54), "front_shin": rz(-46), "rear_thigh": rz(-50), "rear_shin": rz(42)}, {"master": (0.08, 0, 0.28)}, {}),
        (23, {"master": rz(4), "front_thigh": rz(32), "front_shin": rz(-20), "rear_thigh": rz(-30), "rear_shin": rz(22)}, {"master": (0.04, 0, 0.08)}, {}),
        (30, idle_base, {}, {}),
    ])

    actions["Fire"] = make_action(rig, "Fire", 14, 18, False, [
        (1, idle_base, {}, {}),
        (3, {**idle_base, "master": rz(-3), "spine": rz(3), "cannon_upper": rz(-12), "cannon_forearm": rz(-8), "head": rz(3)}, {"master": (-0.055, 0, 0)}, {}),
        (6, {**idle_base, "cannon_upper": rz(-7), "cannon_forearm": rz(-4)}, {"master": (-0.025, 0, 0)}, {}),
        (14, idle_base, {}, {}),
    ], "LINEAR")

    shield_guard = {
        **idle_base, "master": rz(-5), "spine": rz(5), "head": rz(3),
        "shield_upper": rz(-64), "shield_forearm": rz(-38), "cannon_upper": rz(9),
        "front_thigh": rz(34), "rear_thigh": rz(-30),
    }
    actions["Shield"] = make_action(rig, "Shield", 24, 12, True, [
        (1, shield_guard, {"master": (-0.04, 0, -0.02)}, {}),
        (7, {**shield_guard, "shield_forearm": rz(-42)}, {"master": (-0.055, 0, -0.01)}, {"shield_forearm": (1.03, 1.03, 1.03)}),
        (13, shield_guard, {"master": (-0.04, 0, -0.02)}, {}),
        (19, {**shield_guard, "shield_forearm": rz(-34)}, {"master": (-0.025, 0, -0.01)}, {"shield_forearm": (0.98, 0.98, 0.98)}),
        (24, shield_guard, {"master": (-0.04, 0, -0.02)}, {}),
    ])

    actions["Dash"] = make_action(rig, "Dash", 16, 20, False, [
        (1, run_contact, {}, {}),
        (3, {"master": rz(24), "spine": rz(-9), "head": rz(-6), "cannon_upper": rz(-10), "shield_upper": rz(16), "front_thigh": rz(30), "front_shin": rz(-34), "rear_thigh": rz(-24), "rear_shin": rz(28)}, {"master": (0.18, 0, -0.03)}, {}),
        (9, {"master": rz(27), "spine": rz(-11), "head": rz(-7), "cannon_upper": rz(-14), "shield_upper": rz(20), "front_thigh": rz(36), "front_shin": rz(-38), "rear_thigh": rz(-30), "rear_shin": rz(32)}, {"master": (0.28, 0, 0.02)}, {}),
        (13, {**run_contact, "master": rz(16)}, {"master": (0.12, 0, 0)}, {}),
        (16, run_contact, {}, {}),
    ], "LINEAR")

    actions["Hit"] = make_action(rig, "Hit", 12, 18, False, [
        (1, idle_base, {}, {}),
        (3, {**idle_base, "master": rz(-18), "spine": rz(10), "head": rz(10), "cannon_upper": rz(16), "shield_upper": rz(20), "front_thigh": rz(18), "rear_thigh": rz(-14)}, {"master": (-0.18, 0, 0.04)}, {}),
        (7, {**idle_base, "master": rz(7), "spine": rz(-5), "head": rz(-4)}, {"master": (0.05, 0, 0)}, {}),
        (12, idle_base, {}, {}),
    ], "LINEAR")

    actions["Defeat"] = make_action(rig, "Defeat", 40, 12, False, [
        (1, idle_base, {}, {}),
        (8, {**idle_base, "master": rz(-24), "spine": rz(13), "head": rz(12), "cannon_upper": rz(26), "shield_upper": rz(32), "front_thigh": rz(10), "rear_thigh": rz(-8)}, {"master": (-0.16, 0, -0.08)}, {}),
        (20, {"master": rz(-62), "spine": rz(18), "head": rz(18), "cannon_upper": rz(48), "cannon_forearm": rz(24), "shield_upper": rz(55), "shield_forearm": rz(24), "front_thigh": rz(42), "front_shin": rz(-28), "rear_thigh": rz(-18), "rear_shin": rz(32)}, {"master": (-0.42, 0, -0.62)}, {}),
        (31, {"master": rz(-84), "spine": rz(12), "head": rz(22), "cannon_upper": rz(62), "cannon_forearm": rz(30), "shield_upper": rz(72), "shield_forearm": rz(36), "front_thigh": rz(54), "front_shin": rz(-34), "rear_thigh": rz(-8), "rear_shin": rz(42)}, {"master": (-0.55, 0, -1.17)}, {}),
        (40, {"master": rz(-88), "spine": rz(9), "head": rz(25), "cannon_upper": rz(66), "cannon_forearm": rz(34), "shield_upper": rz(76), "shield_forearm": rz(40), "front_thigh": rz(58), "front_shin": rz(-36), "rear_thigh": rz(-5), "rear_shin": rz(45)}, {"master": (-0.58, 0, -1.24)}, {}),
    ])

    clip_metadata = {
        name.lower(): {"action": name, "start": start, "end": end, "fps": fps, "loop": loop}
        for name, start, end, fps, loop in ANIMATION_SPECS
    }
    root["animation_clips"] = json.dumps(clip_metadata, separators=(",", ":"))
    rig["animation_clips"] = root["animation_clips"]
    rig.animation_data.action = actions["Idle"]
    bpy.context.scene.frame_set(1)
    return actions, clip_metadata


def sampled_frames(start, end, loop):
    if loop:
        span = end - start
        return [round(start + span * i / ATLAS_COLUMNS) for i in range(ATLAS_COLUMNS)]
    return [round(start + (end - start) * i / (ATLAS_COLUMNS - 1)) for i in range(ATLAS_COLUMNS)]


def render_animation_atlas(output_dir, callsign, rig, actions, clip_metadata):
    scene = bpy.context.scene
    old_x, old_y = scene.render.resolution_x, scene.render.resolution_y
    scene.render.resolution_x = ATLAS_FRAME_SIZE
    scene.render.resolution_y = ATLAS_FRAME_SIZE
    scene.render.resolution_percentage = 100
    sheet_width = ATLAS_FRAME_SIZE * ATLAS_COLUMNS
    sheet_height = ATLAS_FRAME_SIZE * len(ANIMATION_SPECS)
    sheet_pixels = array("f", [0.0]) * (sheet_width * sheet_height * 4)
    original_filepath = scene.render.filepath
    temporary_frames = tempfile.mkdtemp(prefix=f"riftbound-{callsign.lower()}-")

    manifest_clips = {}
    try:
        for row, (name, start, end, fps, loop) in enumerate(ANIMATION_SPECS):
            rig.animation_data.action = actions[name]
            frames = sampled_frames(start, end, loop)
            # Force Blender's layered action system to evaluate a newly assigned
            # clip even when its first sample matches the current scene frame.
            scene.frame_set(min(end, start + 1))
            scene.frame_set(start)
            bpy.context.view_layer.update()
            for column, frame in enumerate(frames):
                scene.frame_set(frame)
                bpy.context.view_layer.update()
                frame_path = os.path.join(temporary_frames, f"{row:02d}-{column:02d}.png")
                scene.render.filepath = frame_path
                bpy.ops.render.render(write_still=True)
                frame_image = bpy.data.images.load(frame_path, check_existing=False)
                frame_pixels = array("f", frame_image.pixels[:])
                expected_pixels = ATLAS_FRAME_SIZE * ATLAS_FRAME_SIZE * 4
                if len(frame_pixels) != expected_pixels:
                    raise RuntimeError(
                        f"Unexpected atlas frame size for {name} frame {frame}: "
                        f"{tuple(frame_image.size)} / {len(frame_pixels)} pixels"
                    )
                for source_y in range(ATLAS_FRAME_SIZE):
                    source_start = source_y * ATLAS_FRAME_SIZE * 4
                    source_end = source_start + ATLAS_FRAME_SIZE * 4
                    # Blender image pixels begin at the bottom-left, while Phaser
                    # numbers sprite-sheet frames from the top-left.
                    target_y = (len(ANIMATION_SPECS) - 1 - row) * ATLAS_FRAME_SIZE + source_y
                    target_start = (target_y * sheet_width + column * ATLAS_FRAME_SIZE) * 4
                    sheet_pixels[target_start : target_start + ATLAS_FRAME_SIZE * 4] = frame_pixels[source_start:source_end]
                bpy.data.images.remove(frame_image)
            manifest_clips[name.lower()] = {
                **clip_metadata[name.lower()],
                "atlasStart": row * ATLAS_COLUMNS,
                "atlasEnd": row * ATLAS_COLUMNS + ATLAS_COLUMNS - 1,
                "samples": frames,
            }
    finally:
        scene.render.filepath = original_filepath
        shutil.rmtree(temporary_frames, ignore_errors=True)

    image_name = f"{callsign}_AnimationAtlas"
    existing = bpy.data.images.get(image_name)
    if existing:
        bpy.data.images.remove(existing)
    sheet = bpy.data.images.new(image_name, width=sheet_width, height=sheet_height, alpha=True, float_buffer=False)
    sheet.pixels.foreach_set(sheet_pixels)
    atlas_path = os.path.join(output_dir, f"{callsign.lower()}-spritesheet.png")
    sheet.filepath_raw = atlas_path
    sheet.file_format = "PNG"
    sheet.save()

    manifest = {
        "character": callsign,
        "frameWidth": ATLAS_FRAME_SIZE,
        "frameHeight": ATLAS_FRAME_SIZE,
        "columns": ATLAS_COLUMNS,
        "rows": len(ANIMATION_SPECS),
        "clips": manifest_clips,
    }
    with open(os.path.join(output_dir, f"{callsign.lower()}-animations.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")

    rig.animation_data.action = actions["Idle"]
    scene.frame_set(1)
    scene.render.resolution_x = old_x
    scene.render.resolution_y = old_y
    return atlas_path


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
    rig = create_pilot_rig(root, callsign)
    actions, clip_metadata = create_pilot_animations(rig, root)

    png_path = os.path.join(output_dir, f"{callsign.lower()}.png")
    blend_path = os.path.join(output_dir, f"{callsign.lower()}.blend")
    glb_path = os.path.join(output_dir, f"{callsign.lower()}.glb")
    rig.animation_data.action = actions["Run"]
    bpy.context.scene.frame_set(1)
    bpy.context.scene.render.filepath = png_path
    bpy.ops.render.render(write_still=True)
    render_animation_atlas(output_dir, callsign, rig, actions, clip_metadata)

    rig.animation_data.action = actions["Idle"]
    bpy.context.scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)

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
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_reset_pose_bones=True,
        export_anim_slide_to_zero=True,
    )
    print(f"{callsign}: exported {', '.join(actions)} plus animation atlas")


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    output_dir = os.path.abspath(argv[0] if argv else "public/assets/characters")
    os.makedirs(output_dir, exist_ok=True)
    render_character(output_dir, "Astra", (0.00, 0.76, 1.00), "astra")
    render_character(output_dir, "Vanta", (1.00, 0.03, 0.48), "vanta")
    print(f"Rendered animated hero-art-inspired Riftbound pilots to {output_dir}")


if __name__ == "__main__":
    main()
