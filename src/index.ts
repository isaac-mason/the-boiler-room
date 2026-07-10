import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { initBehavior, updateBehavior, updateCarriedCoal } from './behavior';
import { initCoal, spawnCoalClump, updateCoal } from './coal';
import { type Collider, unpackCollider } from './collider-schema';
import { initCreatures, spawnCreatures, updateCreaturesPostStep, updateCreaturesPreStep } from './creatures';
import { attachDebugRaycast, attachShadowDebug, createDebugOverlay, updateDebugOverlay, updatePhysicsDebug } from './debug';
import { initDust } from './dust';
import { furnaceHeat, initFurnace, updateFurnace } from './furnace';
import { initHeat, updateHeat } from './heat';
import { attachInteraction } from './interaction';
import { initLighting, updateLighting } from './lighting';
import { initNavigation, loadNavigation, updateAgentDebug, updateCrowd, updateNavigation } from './navigation';
import { applyPerformance, initPerformance } from './performance';
import { createSplatCollider, initPhysics, updatePhysics } from './physics';
import { CAMERA_POSITION, CAMERA_TARGET, CLUMP, COAL_COUNT, COLLIDER_URL, SPLAT_URL } from './scene';
import { attachShadowCatcher, initShadows, updateShadows } from './shadows';
import { initSparks, updateSparks } from './sparks';
import './style.css';

function init() {
    const scene = new THREE.Scene();

    // Fill light for the standard-material meshes (creatures). Spark splats are
    // self-lit and ignore three lights, so this only illuminates the creatures.
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a1c12, 0.5);
    scene.add(hemi);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // antialias: false is recommended for Spark — MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // SparkRenderer drives splat sorting and LOD streaming/updates for the .rad file.
    // enableLod + enableLodFetching turn on LOD paging (both default true — kept
    // explicit so the paging contract is obvious). Widen the LOD foveation cone so
    // splats near the screen corners stay full-res (defaults: coneFov0 90, coneFov
    // 120, coneFoveate 0.4).
    const spark = new SparkRenderer({
        renderer,
        enableLod: true,
        enableLodFetching: true,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
    });
    scene.add(spark);

    // paged: true is REQUIRED for a .rad (LOD-paged) asset — Spark only decodes .rad
    // through its PagedSplats path. Without it the mesh falls back to PackedSplats,
    // which has no .rad decoder, so nothing streams in. rootUrl is taken from `url`.
    const splat = new SplatMesh({ url: encodeURI(SPLAT_URL), paged: true });
    scene.add(splat);

    // Heat shimmer: wobble the scene splats near the furnace (see heat.ts).
    const heat = initHeat();
    splat.worldModifier = heat.modifier;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    // Runtime perf/quality settings (LOD budget, …); the debug panel tweaks these.
    const perf = initPerformance();

    const debug = createDebugOverlay(perf);
    scene.add(debug.physicsLines);
    scene.add(debug.raycastMarker);
    attachDebugRaycast(debug, camera, scene, renderer.domElement);

    const physics = initPhysics();

    const navigation = initNavigation();

    // Shared "how hot is the fire" signal — every visual system reads this.
    const furnace = initFurnace();

    const lighting = initLighting();
    scene.add(lighting.coreLayer);
    scene.add(lighting.coreHelper);
    scene.add(lighting.ambientLayer);
    scene.add(lighting.ambientHelper);
    scene.add(lighting.pointLight);

    // Cast creature shadows from the furnace point light; the catcher is attached in load().
    const shadows = initShadows(renderer, lighting.pointLight);
    attachShadowDebug(debug, scene, lighting.pointLight);

    const dust = initDust();
    scene.add(dust.mesh);

    const creatures = initCreatures(physics);
    scene.add(creatures.mesh);

    const coal = initCoal();
    scene.add(coal.mesh);

    const sparks = initSparks();
    scene.add(sparks.points);

    const behavior = initBehavior();

    // Click/tap a creature → ragdoll it; click coal → shove it (carrier drops it).
    attachInteraction(renderer.domElement, { camera, creatures, coal, navigation, physics });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        spark,
        splat,
        controls,
        debug,
        perf,
        physics,
        navigation,
        furnace,
        lighting,
        shadows,
        heat,
        dust,
        creatures,
        coal,
        sparks,
        behavior,
        collider: null as Collider | null,
    };
}

type State = ReturnType<typeof init>;

async function loadCollider(url: string): Promise<Collider> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load collider (${res.status}): ${url}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return unpackCollider(bytes);
}

async function load(state: State) {
    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;

    state.collider = await loadCollider(COLLIDER_URL);
    console.log(`collider loaded: ${state.collider.positions.length / 3} verts, ${state.collider.indices.length / 3} tris`);

    // Add the scene geometry to the physics world as a static triangle mesh.
    createSplatCollider(state.physics, state.collider);

    // The collider doubles as the shadow catcher — splats can't receive shadows themselves.
    attachShadowCatcher(state.scene, state.collider, state.shadows);

    // Drop the initial coal pile on the clump (needs the collider to land on).
    spawnCoalClump(state.coal, state.physics, CLUMP, COAL_COUNT);

    await loadNavigation(state.navigation);

    // Spawn the crawler creatures now the collider + navmesh + crowd exist.
    spawnCreatures(state.creatures, state.physics, state.navigation);
}

function update(state: State, dt: number, time: number) {
    // Advance the shared furnace signal first so every system reads this frame's value.
    state.furnace.override = state.debug.furnaceOverride;
    updateFurnace(state.furnace, dt);
    updateBehavior(
        state.behavior,
        state.creatures,
        state.coal,
        state.navigation,
        state.physics,
        state.furnace,
        state.sparks,
        time,
    );
    updateCrowd(state.navigation, dt);
    updateCreaturesPreStep(state.creatures, state.navigation, state.physics, dt);
    updatePhysics(state.physics, dt);
    updateCreaturesPostStep(state.creatures, state.physics, dt);
    updateCarriedCoal(state.behavior, state.physics);
    updateCoal(state.coal, state.physics, dt);
    updateSparks(state.sparks, dt);
    state.controls.update();
    updateLighting(state.lighting, state.furnace, time, state.debug.showLights);
    // Lighten the shadows as the fire's diffuse fill washes into them.
    updateShadows(state.shadows, furnaceHeat(state.furnace));
    updateHeat(state.heat, state.furnace);
    applyPerformance(state.perf, state.spark);
    updateDebugOverlay(state.debug, state.camera, state.controls, state.furnace, state.spark);
    updatePhysicsDebug(state.debug, state.physics.world);
    updateNavigation(state.navigation, state.scene, state.debug.showNavMesh);
    updateAgentDebug(state.navigation, state.scene, state.debug.showAgents);
    state.renderer.render(state.scene, state.camera);
}

// Fade out + remove the loading overlay once everything's ready.
function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

// `splat.initialized` only means the file is decoded — the splats aren't on
// screen until Spark has sorted them and streamed in the LOD pages. The render
// loop drives that, and `spark.activeSplats` climbs from 0 as splats become
// renderable. So we run the loop with the overlay still up and lift it once that
// count crosses a fraction of the model's total. Expressed as a fraction (not a
// raw count) so it scales if the asset changes; timeout is a backstop in case
// frustum culling / LOD plateaus the count below the threshold.
const SPLAT_READY_FRACTION = 0.8; // lift once this share of the model's splats are rendered
const SPLAT_WAIT_TIMEOUT_MS = 10000; // ... but never keep the loader up longer than this
const MAX_DT = 0.1; // clamp dt so a stall/tab-switch can't jump physics + animation forward

async function start() {
    const state = init();
    await load(state);

    let lastTime = performance.now();
    let elapsed = 0;

    let loaderUp = true;
    const startedAt = performance.now();

    function loop() {
        const now = performance.now();
        const dt = Math.min((now - lastTime) / 1000, MAX_DT);
        lastTime = now;
        elapsed += dt;
        update(state, dt, elapsed); // renders the frame, which drives Spark's sort + LOD streaming

        if (loaderUp) {
            const active = state.spark.activeSplats;
            const total = state.splat.numSplats;
            const ready = total > 0 && active >= total * SPLAT_READY_FRACTION;
            if (ready || now - startedAt >= SPLAT_WAIT_TIMEOUT_MS) {
                loaderUp = false;
                console.log(`splats ready: ${active}/${total} active${ready ? '' : ' (timed out)'}`);
                hideLoading();
            }
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
