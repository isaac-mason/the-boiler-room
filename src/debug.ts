import type { SparkRenderer } from '@sparkjsdev/spark';
import { debug as ccDebug, type World } from 'crashcat';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { Furnace } from './furnace';
import type { Performance } from './performance';

export type DebugOverlay = {
    element: HTMLDivElement;
    text: HTMLDivElement;
    /** Whether the text panel is shown (toggled with the backtick key). */
    enabled: boolean;
    /** Whether the physics wireframe is drawn (toggled by the checkbox). */
    showPhysics: boolean;
    /** Whether the navmesh wireframe is drawn (toggled by the checkbox). */
    showNavMesh: boolean;
    /** Whether the crowd-agent collision capsules are drawn (toggled by the checkbox). */
    showAgents: boolean;
    /** Whether the SDF light wireframes are drawn (toggled by the checkbox). */
    showLights: boolean;
    /** Debug furnace intensity override: 0..1 forces all VFX to that heat, null = live. */
    furnaceOverride: number | null;
    /** Line segments rendering the crashcat physics debug wireframe. Add to your scene. */
    physicsLines: THREE.LineSegments;
    /** Raycaster used for click-to-raycast against the scene. */
    raycaster: THREE.Raycaster;
    /** Marker placed at the last raycast hit point. Add to your scene. */
    raycastMarker: THREE.Mesh;
    /** World-space point of the last raycast hit, or null if nothing's been hit. */
    lastHit: THREE.Vector3 | null;
    /** The shadow-casting light being inspected, set by attachShadowDebug (else null). */
    shadowLight: THREE.PointLight | null;
    /** Wireframe sphere at the light sized to the shadow far range — the point light casts
     * shadows omnidirectionally (cube map), so a sphere is the honest coverage viz, not a
     * frustum. Toggled by the "shadow range" checkbox. */
    shadowRange: THREE.Mesh | null;
    /** Marker at the shadow light's position (so you can see where shadows originate). */
    shadowLightMarker: THREE.Mesh | null;
};

function createCheckbox(label: string, onChange: (checked: boolean) => void): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, label);
    return wrapper;
}

// A checkbox + range slider on one row. The checkbox arms the override; the
// slider value is reported via onChange only while armed (else `null` = live).
function createSlider(label: string, onChange: (value: number | null) => void): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '1';
    range.step = '0.01';
    range.value = '0';
    range.style.width = '90px';
    const emit = () => onChange(toggle.checked ? Number(range.value) : null);
    toggle.addEventListener('change', emit);
    range.addEventListener('input', emit);
    wrapper.append(toggle, label, range);
    return wrapper;
}

// An always-on labelled range slider that reports its value live, with a readout.
// `format` customises the readout (e.g. more decimals for tiny shadow-bias values).
function createRange(
    label: string,
    opts: { min: number; max: number; step: number; value: number; format?: (v: number) => string },
    onChange: (value: number) => void,
): HTMLLabelElement {
    const fmt = opts.format ?? ((v: number) => v.toFixed(2));
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(opts.min);
    range.max = String(opts.max);
    range.step = String(opts.step);
    range.value = String(opts.value);
    range.style.width = '80px';
    const readout = document.createElement('span');
    readout.textContent = fmt(opts.value);
    range.addEventListener('input', () => {
        const v = Number(range.value);
        readout.textContent = fmt(v);
        onChange(v);
    });
    wrapper.append(label, range, readout);
    return wrapper;
}

// Minimal debug overlay (plain DOM): a text panel showing the camera position
// (toggle with the backtick `) plus checkboxes toggling debug wireframes.
export function createDebugOverlay(perf: Performance): DebugOverlay {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'padding:6px 8px',
        'display:none',
        'flex-direction:column',
        'gap:4px',
        'font:12px/1.4 monospace',
        'color:#0f0',
        'background:rgba(0,0,0,0.6)',
        'z-index:1000',
    ].join(';');

    // Line segments for the physics wireframe. Coloured per-vertex by crashcat.
    const physicsLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    physicsLines.visible = false;
    physicsLines.frustumCulled = false; // geometry is rebuilt each frame; skip culling

    // Marker drawn at the last raycast hit. Non-raycastable so clicks don't hit it.
    const raycastMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 16, 12),
        // transparent:true → draws in the transparent pass, after (and on top of) the
        // Spark splats; depthTest off + high renderOrder keeps it visible through geometry.
        new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false, depthWrite: false, transparent: true }),
    );
    raycastMarker.visible = false;
    raycastMarker.renderOrder = 1000;
    raycastMarker.frustumCulled = false;
    raycastMarker.raycast = () => {};

    const overlay: DebugOverlay = {
        element,
        text: document.createElement('div'),
        enabled: false,
        showPhysics: false,
        showNavMesh: false,
        showAgents: false,
        showLights: false,
        furnaceOverride: null,
        physicsLines,
        raycaster: new THREE.Raycaster(),
        raycastMarker,
        lastHit: null,
        shadowLight: null,
        shadowRange: null,
        shadowLightMarker: null,
    };

    const physicsCheckbox = createCheckbox('physics debug', (checked) => {
        overlay.showPhysics = checked;
        physicsLines.visible = checked;
    });

    const navmeshCheckbox = createCheckbox('navmesh debug', (checked) => {
        overlay.showNavMesh = checked;
    });

    const agentsCheckbox = createCheckbox('agent capsules', (checked) => {
        overlay.showAgents = checked;
    });

    const lightsCheckbox = createCheckbox('lights debug', (checked) => {
        overlay.showLights = checked;
    });

    const furnaceSlider = createSlider('furnace heat', (value) => {
        overlay.furnaceOverride = value;
    });

    const lodSlider = createRange('lod scale', { min: 0.2, max: 2, step: 0.05, value: perf.lodScale }, (value) => {
        perf.lodScale = value;
    });

    overlay.text.style.cssText = 'white-space:pre;user-select:text;-webkit-user-select:text;cursor:text';

    element.append(physicsCheckbox, navmeshCheckbox, agentsCheckbox, lightsCheckbox, furnaceSlider, lodSlider, overlay.text);
    document.body.appendChild(element);

    window.addEventListener('keydown', (event) => {
        if (event.key === '`') {
            overlay.enabled = !overlay.enabled;
            element.style.display = overlay.enabled ? 'flex' : 'none';
            // Raycast is a panel feature — hide its marker when the panel closes.
            if (!overlay.enabled) overlay.raycastMarker.visible = false;
        }
    });

    return overlay;
}

// Add shadow-map debugging to the panel: a toggle showing the light's coverage sphere
// plus a marker at the light, and live sliders for the bias knobs — so you can dial out
// peter-panning / acne and see the result immediately.
export function attachShadowDebug(overlay: DebugOverlay, scene: THREE.Scene, light: THREE.PointLight): void {
    overlay.shadowLight = light;

    // Coverage sphere at the light, sized to the shadow far range. A point light casts
    // shadows omnidirectionally (a 6-face cube map), so a single CameraHelper frustum
    // would only show one arbitrary face and mislead — the sphere shows the true reach.
    // transparent+depthTest:false so it draws over the splats.
    const range = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 16), // unit sphere; scaled to shadow.camera.far each frame
        new THREE.MeshBasicMaterial({ wireframe: true, color: 0xffcc33, depthTest: false, depthWrite: false, transparent: true, opacity: 0.35 }),
    );
    range.renderOrder = 1000;
    range.visible = false;
    range.frustumCulled = false;
    range.raycast = () => {};
    scene.add(range);
    overlay.shadowRange = range;

    // A dot at the light so you can see where shadows are cast from.
    const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false, depthWrite: false, transparent: true }),
    );
    marker.position.copy(light.position);
    marker.renderOrder = 1000;
    marker.visible = false;
    marker.frustumCulled = false;
    marker.raycast = () => {};
    scene.add(marker);
    overlay.shadowLightMarker = marker;

    const rangeCheckbox = createCheckbox('shadow range', (checked) => {
        range.visible = checked;
        marker.visible = checked;
    });

    const biasRange = createRange(
        'shadow bias',
        { min: -0.003, max: 0.003, step: 0.0001, value: light.shadow.bias, format: (v) => v.toFixed(4) },
        (v) => {
            light.shadow.bias = v;
        },
    );
    const normalBiasRange = createRange(
        'normal bias',
        { min: 0, max: 0.02, step: 0.0005, value: light.shadow.normalBias, format: (v) => v.toFixed(4) },
        (v) => {
            light.shadow.normalBias = v;
        },
    );
    const radiusRange = createRange('shadow radius', { min: 0, max: 10, step: 0.5, value: light.shadow.radius }, (v) => {
        light.shadow.radius = v;
    });

    // Insert the shadow controls above the text readout so the readout stays last.
    for (const ctrl of [rangeCheckbox, biasRange, normalBiasRange, radiusRange]) {
        overlay.element.insertBefore(ctrl, overlay.text);
    }
}

// Wire up click-to-raycast against the scene (e.g. the splat). On each click the
// marker jumps to the hit point and overlay.lastHit is updated.
export function attachDebugRaycast(
    overlay: DebugOverlay,
    camera: THREE.Camera,
    scene: THREE.Scene,
    domElement: HTMLElement,
): void {
    const ndc = new THREE.Vector2();

    domElement.addEventListener('click', (event) => {
        if (!overlay.enabled) return; // only raycast while the debug panel is open

        const rect = domElement.getBoundingClientRect();
        ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        overlay.raycaster.setFromCamera(ndc, camera);
        const hit = overlay.raycaster.intersectObjects(scene.children, true)[0];
        if (!hit) return;

        overlay.lastHit = hit.point.clone();
        overlay.raycastMarker.position.copy(hit.point);
        overlay.raycastMarker.visible = true;
    });
}

export function updateDebugOverlay(
    overlay: DebugOverlay,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    furnace: Furnace,
    spark: SparkRenderer,
): void {
    if (!overlay.enabled) return;

    const p = camera.position;
    const t = controls.target;
    const h = overlay.lastHit;
    const active = spark.activeSplats.toLocaleString();
    const max = spark.maxSplats.toLocaleString();
    let text =
        `pos     ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\n` +
        `target  ${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}\n` +
        `hit     ${h ? `${h.x.toFixed(2)}, ${h.y.toFixed(2)}, ${h.z.toFixed(2)}` : '-'}\n` +
        `furnace int ${furnace.intensity.toFixed(2)}  pulse ${furnace.pulse.toFixed(2)}\n` +
        `splats  ${active} / ${max}  (lod x${spark.lodSplatScale.toFixed(2)})`;

    // Shadow readout + keep the coverage sphere synced to the (possibly moving) light.
    const sl = overlay.shadowLight;
    if (sl) {
        const cam = sl.shadow.camera;
        overlay.shadowLightMarker?.position.copy(sl.position);
        // Keep the coverage sphere on the light and sized to the (live-tweakable) far range.
        if (overlay.shadowRange?.visible) {
            overlay.shadowRange.position.copy(sl.position);
            overlay.shadowRange.scale.setScalar(cam.far);
        }
        text +=
            `\nshadow  bias ${sl.shadow.bias.toFixed(4)}  nbias ${sl.shadow.normalBias.toFixed(4)}  r ${sl.shadow.radius.toFixed(1)}` +
            `\n        map ${sl.shadow.mapSize.x}  near ${cam.near.toFixed(2)} far ${cam.far.toFixed(1)}  y ${sl.position.y.toFixed(2)}`;
    }

    overlay.text.textContent = text;
}

// Rebuild the physics wireframe from the crashcat debug helpers (flat line segments).
export function updatePhysicsDebug(overlay: DebugOverlay, world: World): void {
    if (!overlay.showPhysics) return;

    const { vertices, colors } = ccDebug.bodies(world);
    const geometry = overlay.physicsLines.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
