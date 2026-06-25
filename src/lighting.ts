import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from '@sparkjsdev/spark';
import * as THREE from 'three';

import type { Furnace } from './furnace';
import { FIRE_ORIGIN } from './scene';

// Where the flickering tint originates from, in world space (as a THREE.Vector3
// for the SDF lights; the source of truth is FIRE_ORIGIN in scene.ts).
export const LIGHT_ORIGIN = new THREE.Vector3(FIRE_ORIGIN[0], FIRE_ORIGIN[1], FIRE_ORIGIN[2]);

const RADIUS = 4;

// A tight, intense "hot core" right at the boiler, on its own additive layer. It
// stacks on top of the broad glow so the splats right at the boiler read as
// white-hot, falling off fast into the surrounding warm glow.
const CORE_RADIUS = 0.85;
const CORE_HUE = 0.075; // hotter, toward yellow-white
const CORE_SAT = 0.55; // less saturated → whiter-hot, not deep orange
const CORE_LIGHTNESS_REST = 0.12;
const CORE_LIGHTNESS_FED = 0.3; // lower peak → hot-orange, not blown-out white

// Stacked sine waves at different speeds → a fire-like flicker signal centred on
// 0, roughly -1..1. Shared so other systems (e.g. dust) can flicker in sync.
export function flicker(time: number): number {
    const slow = Math.sin(time * 4);
    const medium = Math.sin(time * 9) * 0.6;
    const fast = Math.sin(time * 16) * 0.3;
    return (slow + medium + fast) / 1.9;
}

// A second, much calmer flicker signal for the room-wide glow: slow + low variance,
// so the whole room gently breathes instead of strobing. The chaotic `flicker`
// above is reserved for the tight hot core, which keeps the boiler lively.
function flickerCalm(time: number): number {
    return (Math.sin(time * 2.0) + Math.sin(time * 3.6) * 0.25) / 1.25;
}

// Broad room glow — gently dynamic, smooth (not erratic) so it's never oppressive.
const GLOBAL_FLICKER_AMP = 0.05; // lightness wobble of the broad glow
const GLOBAL_HUE_AMP = 0.006; // hue wobble of the broad glow

// Hot core — chaotic + punchy, to offset the now-calm room.
const CORE_FLICKER_AMP = 0.12; // lightness wobble of the hot core (was ~0.05)
const CORE_PULSE = 0.2; // extra core brightness on a coal-blast pulse (lower → less white flash)

const BASE_HUE = 0.06; // warm orange

// Resting (unfed) → fed (a coal in the fire). The fire sits dim normally and
// swells to the "fed" level driven by the shared furnace intensity (furnace.ts).
// Darker base → the room recedes into shadow and the boiler reads as the one
// central heat source, instead of the whole room glowing brightly.
const BASE_LIGHTNESS_REST = 0.025;
const BASE_LIGHTNESS_FED = 0.08;

// Real point light for lighting regular three meshes (e.g. the instanced creatures)
// — the SDF only affects splats. Co-located with the SDF and flickers in sync.
const POINT_LIGHT_COLOR = new THREE.Color(1, 0.55, 0.25); // warm fire
const POINT_LIGHT_REST = 2; // dim resting intensity
const POINT_LIGHT_FED = 8; // intensity with the fire fed (was the resting value)
const POINT_LIGHT_FLICKER = 0.3; // fraction of base the (calm) flicker swings on the creatures

export type Lighting = {
    /** SplatEdit layer (ADD_RGBA) that tints nearby splats. Add to your scene. */
    layer: SplatEdit;
    /** Spherical SDF light whose colour flickers each frame. */
    light: SplatEditSdf;
    /** Second ADD_RGBA layer for the tight hot core. Add to your scene. */
    coreLayer: SplatEdit;
    /** Tight, intense SDF right at the boiler — sells the heat. */
    core: SplatEditSdf;
    /** Wireframe sphere visualising the SDF. Add to your scene; toggle via debug panel. */
    helper: THREE.Mesh;
    /** Wireframe sphere visualising the hot core SDF. Add to your scene; toggled with the helper. */
    coreHelper: THREE.Mesh;
    /** Real point light at the same spot, for lighting non-splat meshes. Add to your scene. */
    pointLight: THREE.PointLight;
};

export function initLighting(): Lighting {
    // ADD_RGBA additively tints splats inside the SDF, like the dynamic-lighting example.
    const layer = new SplatEdit({
        rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA,
        sdfSmooth: 0.1,
        softEdge: 1.4,
    });

    const light = new SplatEditSdf({
        type: SplatEditSdfType.SPHERE,
        color: new THREE.Color(1, 0.6, 0.3),
        radius: RADIUS,
        opacity: 1,
    });
    light.position.copy(LIGHT_ORIGIN);
    layer.add(light);

    // Tight hot core on its own additive layer (tighter soft edge → a defined hot spot).
    const coreLayer = new SplatEdit({
        rgbaBlendMode: SplatEditRgbaBlendMode.ADD_RGBA,
        sdfSmooth: 0.1,
        softEdge: 0.7,
    });
    const core = new SplatEditSdf({
        type: SplatEditSdfType.SPHERE,
        color: new THREE.Color(1, 0.7, 0.4),
        radius: CORE_RADIUS,
        opacity: 1,
    });
    core.position.copy(LIGHT_ORIGIN);
    coreLayer.add(core);

    const helper = new THREE.Mesh(
        new THREE.SphereGeometry(RADIUS, 16, 16),
        new THREE.MeshBasicMaterial({ wireframe: true, color: light.color, depthTest: false }),
    );
    helper.position.copy(LIGHT_ORIGIN);
    helper.visible = false;
    helper.renderOrder = 1000;
    helper.frustumCulled = false;
    helper.raycast = () => {};

    const coreHelper = new THREE.Mesh(
        new THREE.SphereGeometry(CORE_RADIUS, 16, 16),
        new THREE.MeshBasicMaterial({ wireframe: true, color: core.color, depthTest: false }),
    );
    coreHelper.position.copy(LIGHT_ORIGIN);
    coreHelper.visible = false;
    coreHelper.renderOrder = 1000;
    coreHelper.frustumCulled = false;
    coreHelper.raycast = () => {};

    const pointLight = new THREE.PointLight(POINT_LIGHT_COLOR, POINT_LIGHT_REST);
    pointLight.position.copy(LIGHT_ORIGIN);

    return { layer, light, coreLayer, core, helper, coreHelper, pointLight };
}

// Flicker the light's colour by stacking sine waves at different speeds for a
// chaotic, fire-like wobble. The "fed" baseline tracks the shared furnace
// intensity; the blast pulse pops the hot core. showHelper toggles the wireframe.
export function updateLighting(lighting: Lighting, furnace: Furnace, time: number, showHelper: boolean): void {
    const fLocal = flicker(time); // chaotic — drives the tight hot core
    const fCalm = flickerCalm(time); // gentle breath — drives the room-wide glow

    const fed = THREE.MathUtils.clamp(furnace.intensity, 0, 1); // 0 = resting, 1 = fully fed

    // Broad glow: a calm, low-variance breath on top of the rest → fed baseline.
    const hue = BASE_HUE + fCalm * GLOBAL_HUE_AMP;
    const saturation = 0.7;
    const baseLightness = THREE.MathUtils.lerp(BASE_LIGHTNESS_REST, BASE_LIGHTNESS_FED, fed);
    const lightness = THREE.MathUtils.clamp(baseLightness + fCalm * GLOBAL_FLICKER_AMP, 0, 1);
    lighting.light.color.setHSL(hue, saturation, lightness);

    const baseIntensity = THREE.MathUtils.lerp(POINT_LIGHT_REST, POINT_LIGHT_FED, fed);
    lighting.pointLight.intensity = baseIntensity * (1 + fCalm * POINT_LIGHT_FLICKER);

    // Hot core: chaotic, punchy flicker + a hard pop on each coal-blast pulse — the
    // lively boiler that offsets the calm room.
    const coreLightness = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(CORE_LIGHTNESS_REST, CORE_LIGHTNESS_FED, fed) + furnace.pulse * CORE_PULSE + fLocal * CORE_FLICKER_AMP,
        0,
        1,
    );
    lighting.core.color.setHSL(CORE_HUE, CORE_SAT, coreLightness);

    lighting.helper.visible = showHelper;
    lighting.coreHelper.visible = showHelper;
    if (showHelper) {
        (lighting.helper.material as THREE.MeshBasicMaterial).color.copy(lighting.light.color);
        (lighting.coreHelper.material as THREE.MeshBasicMaterial).color.copy(lighting.core.color);
    }
}
