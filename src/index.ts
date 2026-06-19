import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { initBehavior, updateBehavior } from './behavior';
import { initCoal, spawnCoalClump, updateCoal } from './coal';
import { type Collider, unpackCollider } from './collider-schema';
import { attachDebugRaycast, createDebugOverlay, updateDebugOverlay, updatePhysicsDebug } from './debug';
import { initDust, updateDust } from './dust';
import { initLighting, updateLighting } from './lighting';
import { initMites, spawnMites, updateMitesPostStep, updateMitesPreStep } from './mites';
import { initNavigation, loadNavigation, updateCrowd, updateNavigation } from './navigation';
import { createSplatCollider, initPhysics, updatePhysics } from './physics';
import { initSparks, updateSparks } from './sparks';
import { CLUMP } from './waypoints';
import './style.css';

const COLLIDER_URL = '/collider.bin';

// Read the packed collision mesh back with packcat (built by scripts/build-collider.ts).
async function loadCollider(url: string): Promise<Collider> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load collider (${res.status}): ${url}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return unpackCollider(bytes);
}

function init() {
    const scene = new THREE.Scene();

    // Fill light for the standard-material meshes (mites). Spark splats are
    // self-lit and ignore three lights, so this only illuminates the creatures.
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a1c12, 0.8);
    scene.add(hemi);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(-0.37, 0.35, 0.16);

    // antialias: false is recommended for Spark — MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // SparkRenderer drives splat sorting and LOD streaming/updates for the .rad file.
    // Widen the LOD foveation cone so splats near the screen corners stay full-res
    // (defaults: coneFov0 90, coneFov 120, coneFoveate 0.4).
    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
    });
    scene.add(spark);

    const splat = new SplatMesh({ url: encodeURI('/Spirited Away Boiler Room-lod.rad') });
    scene.add(splat);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(-0.47, 0.38, -0.59);
    controls.update();

    const debug = createDebugOverlay();
    scene.add(debug.physicsLines);
    scene.add(debug.raycastMarker);
    attachDebugRaycast(debug, camera, scene, renderer.domElement);

    const physics = initPhysics();

    const navigation = initNavigation();

    const lighting = initLighting();
    scene.add(lighting.layer);
    scene.add(lighting.coreLayer);
    scene.add(lighting.helper);
    scene.add(lighting.coreHelper);
    scene.add(lighting.pointLight);

    const dust = initDust();
    scene.add(dust.points);

    const mites = initMites(physics);
    scene.add(mites.mesh);

    const coal = initCoal();
    scene.add(coal.mesh);

    const sparks = initSparks();
    scene.add(sparks.points);

    const behavior = initBehavior();

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
        physics,
        navigation,
        lighting,
        dust,
        mites,
        coal,
        sparks,
        behavior,
        collider: null as Collider | null,
    };
}

type State = ReturnType<typeof init>;

async function load(state: State) {
    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;

    state.collider = await loadCollider(COLLIDER_URL);
    console.log(`collider loaded: ${state.collider.positions.length / 3} verts, ${state.collider.indices.length / 3} tris`);

    // Add the scene geometry to the physics world as a static triangle mesh.
    createSplatCollider(state.physics, state.collider);

    // Drop the initial coal pile on the clump (needs the collider to land on).
    spawnCoalClump(state.coal, state.physics, CLUMP, 24);

    await loadNavigation(state.navigation);

    // Spawn the crawler mites now the collider + navmesh + crowd exist.
    spawnMites(state.mites, state.physics, state.navigation);
}

function update(state: State, dt: number, time: number) {
    updateBehavior(state.behavior, state.mites, state.coal, state.navigation, state.physics, state.lighting, state.sparks, time);
    updateCrowd(state.navigation, dt);
    updateMitesPreStep(state.mites, state.navigation, state.physics, dt);
    updatePhysics(state.physics, dt);
    updateMitesPostStep(state.mites, state.physics, dt);
    updateCoal(state.coal);
    updateSparks(state.sparks, dt);
    updateDust(state.dust, time);
    state.controls.update();
    updateLighting(state.lighting, time, state.debug.showLights);
    updateDebugOverlay(state.debug, state.camera, state.controls);
    updatePhysicsDebug(state.debug, state.physics.world);
    updateNavigation(state.navigation, state.scene, state.debug.showNavMesh);
    state.renderer.render(state.scene, state.camera);
}

async function start() {
    const state = init();
    await load(state);
    let lastTime = performance.now();
    let elapsed = 0;
    function loop() {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        elapsed += dt;
        update(state, dt, elapsed);
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
