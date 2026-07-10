import * as THREE from 'three';

import type { Collider } from './collider-schema';

/**
 * Furnace shadows for the creatures. Gaussian splats can't cast or receive shadows
 * (Spark renders them outside three's material pipeline), so shadows are faked with a
 * shadow-map trick:
 *
 *   - the furnace point light casts, so shadows radiate outward from the fire,
 *   - the standard-material creatures and coal are the only casters,
 *   - the physics collider, aligned with the splat world, is rebuilt as an invisible
 *     ShadowMaterial "catcher" so shadows land on the splat floor and walls.
 *
 * The furnace is stationary, so its cube shadow map needs no per-frame update.
 */

const SHADOW_MAP_SIZE = 1024; // per cube face; the room is small so this stays crisp
const SHADOW_CAMERA_NEAR = 0.02;
const SHADOW_CAMERA_FAR = 12; // world units — comfortably spans the boiler room
const SHADOW_RADIUS = 3; // PCF softness of the shadow edge

// Catcher tuning. depthWrite:false so it doesn't punch holes in the splats drawn
// behind it; the render order puts it in the transparent pass *after* the splats,
// while its depthTest still lets the opaque creatures occlude it.
const CATCHER_RENDER_ORDER = 1000;

// Shadow darkness is driven by furnace heat (updateShadows): a cold furnace throws
// hard, dark shadows; as the fire roars its warm bounce/fill light washes into them
// and lightens them. COOL is the resting look; HOT is fully-fed.
const CATCHER_OPACITY_COOL = 0.22; // resting (heat 0) — darker
const CATCHER_OPACITY_HOT = 0.09; // roaring (heat 1) — fill light lifts the shadows

export type Shadows = {
    /** The furnace point light doing the shadow casting. */
    light: THREE.PointLight;
    /** Catcher material; its opacity tracks furnace heat. Null until the collider loads. */
    catcher: THREE.ShadowMaterial | null;
};

// Enable shadow mapping and turn the furnace point light into the shadow caster.
export function initShadows(renderer: THREE.WebGLRenderer, light: THREE.PointLight): Shadows {
    // PCF soft shadows. Only the creatures cast; the splats and the catcher never
    // enter the shadow pass, so the cost is one cube-map render of the crowd.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    light.castShadow = true;
    light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    light.shadow.radius = SHADOW_RADIUS;
    // The scene is tiny (creatures are CREATURE_SCALE = 0.06), so bias has to be tiny
    // too — larger values push the contact shadow off the crawlers' feet (peter-panning).
    light.shadow.bias = -0.0003;
    light.shadow.normalBias = 0.001;
    const cam = light.shadow.camera; // PerspectiveCamera, one per cube face
    cam.near = SHADOW_CAMERA_NEAR;
    cam.far = SHADOW_CAMERA_FAR;
    cam.updateProjectionMatrix();

    return { light, catcher: null };
}

// Rebuild the collider as an invisible shadow catcher: a ShadowMaterial mesh that shows
// nothing but the shadows it receives. Its opacity is later driven by furnace heat.
export function attachShadowCatcher(scene: THREE.Scene, collider: Collider, shadows: Shadows): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(collider.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(collider.indices, 1));
    geometry.computeVertexNormals(); // so normalBias can offset along the surface

    const material = new THREE.ShadowMaterial({ opacity: CATCHER_OPACITY_COOL });
    material.depthWrite = false;
    shadows.catcher = material;

    const catcher = new THREE.Mesh(geometry, material);
    catcher.castShadow = false;
    catcher.receiveShadow = true;
    catcher.renderOrder = CATCHER_RENDER_ORDER;
    catcher.frustumCulled = false;
    catcher.raycast = () => {}; // never intercept clicks/raycasts

    scene.add(catcher);
}

// Lighten the shadows as the furnace heats up (heat 0..1), as if the fire's diffuse
// fill light were washing into them. Cheap; safe to call every frame.
export function updateShadows(shadows: Shadows, heat: number): void {
    if (!shadows.catcher) return; // catcher not attached yet (collider still loading)
    shadows.catcher.opacity = THREE.MathUtils.lerp(CATCHER_OPACITY_COOL, CATCHER_OPACITY_HOT, THREE.MathUtils.clamp(heat, 0, 1));
}
