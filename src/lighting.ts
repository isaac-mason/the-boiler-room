import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from '@sparkjsdev/spark';
import * as THREE from 'three';

// Where the flickering tint originates from, in world space.
export const LIGHT_ORIGIN = new THREE.Vector3(-1.6, 0.09, -2.44);

const RADIUS = 4;

// A tight, intense "hot core" right at the boiler, on its own additive layer. It
// stacks on top of the broad glow so the splats right at the boiler read as
// white-hot, falling off fast into the surrounding warm glow.
const CORE_RADIUS = 0.5;
const CORE_HUE = 0.075; // hotter, toward yellow-white
const CORE_SAT = 0.55; // less saturated → whiter-hot, not deep orange
const CORE_LIGHTNESS_REST = 0.13;
const CORE_LIGHTNESS_FED = 0.45;

// Stacked sine waves at different speeds → a fire-like flicker signal centred on
// 0, roughly -1..1. Shared so other systems (e.g. dust) can flicker in sync.
export function flicker(time: number): number {
    const slow = Math.sin(time * 4);
    const medium = Math.sin(time * 9) * 0.6;
    const fast = Math.sin(time * 16) * 0.3;
    return (slow + medium + fast) / 1.9;
}

// How strongly the light flickers: 0 = steady glow, 1 = wild fire. Tune to taste.
const INTENSITY = 0.1;

const BASE_HUE = 0.06; // warm orange

// Resting (unfed) → fed (a coal in the fire). The flare lerps rest → fed, so the
// fire sits dim normally and swells to the "fed" level when coal is thrown in.
// (Fed values were the old resting values — this is the rebase.)
const BASE_LIGHTNESS_REST = 0.04;
const BASE_LIGHTNESS_FED = 0.12;

// Real point light for lighting regular three meshes (e.g. instanced dust mites)
// — the SDF only affects splats. Co-located with the SDF and flickers in sync.
const POINT_LIGHT_COLOR = new THREE.Color(1, 0.55, 0.25); // warm fire
const POINT_LIGHT_REST = 2; // dim resting intensity
const POINT_LIGHT_FED = 8; // intensity with the fire fed (was the resting value)
const POINT_LIGHT_FLICKER = 0.4; // fraction of base the flicker swings

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
    /** Flare "fuel" — set when fed coal, released slowly (sustained brightening). */
    flare: number;
    /** Smoothed visible flare level (attack/release toward `flare`). */
    flareLevel: number;
};

const FLARE_RELEASE = 0.985; // per-frame fuel decay — slow, so the brightening sustains
const FLARE_SMOOTH = 0.12; // how fast the visible level chases the fuel (attack + ease-out)
const FLARE_MAX = 2.5;

// Feed the fire — add fuel for a sustained brightening (e.g. when a coal is thrown in).
export function flareLighting(lighting: Lighting, amount = 1): void {
    lighting.flare = Math.min(lighting.flare + amount, FLARE_MAX);
}

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

    return { layer, light, coreLayer, core, helper, coreHelper, pointLight, flare: 0, flareLevel: 0 };
}

// Flicker the light's colour by stacking sine waves at different speeds for a
// chaotic, fire-like wobble. showHelper toggles the debug wireframe sphere.
export function updateLighting(lighting: Lighting, time: number, showHelper: boolean): void {
    const f = flicker(time);

    // Fuel releases slowly; the visible level eases toward it (quick swell, gentle fade).
    lighting.flare *= FLARE_RELEASE;
    lighting.flareLevel += (lighting.flare - lighting.flareLevel) * FLARE_SMOOTH;
    const fed = THREE.MathUtils.clamp(lighting.flareLevel, 0, 1); // 0 = resting, 1 = fully fed

    // Baseline lerps rest → fed; the flicker wobbles on top.
    const hue = BASE_HUE + f * 0.04 * INTENSITY;
    const saturation = 0.7;
    const baseLightness = THREE.MathUtils.lerp(BASE_LIGHTNESS_REST, BASE_LIGHTNESS_FED, fed);
    const lightness = THREE.MathUtils.clamp(baseLightness + f * 0.4 * INTENSITY, 0, 1);
    lighting.light.color.setHSL(hue, saturation, lightness);

    const baseIntensity = THREE.MathUtils.lerp(POINT_LIGHT_REST, POINT_LIGHT_FED, fed);
    lighting.pointLight.intensity = baseIntensity * (1 + f * POINT_LIGHT_FLICKER);

    // Hot core: much brighter, whiter, and flickering harder than the broad glow.
    const coreLightness = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(CORE_LIGHTNESS_REST, CORE_LIGHTNESS_FED, fed) + f * 0.5 * INTENSITY,
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
