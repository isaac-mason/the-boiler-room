import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { type Collider, unpackCollider } from './collider-schema';
import { attachDebugRaycast, createDebugOverlay, updateDebugOverlay, updatePhysicsDebug } from './debug';
import { initNavigation, loadNavigation, updateNavigation } from './navigation';
import { createSplatCollider, initPhysics, updatePhysics } from './physics';
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

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(-0.79, 0.63, 1.34);

    // antialias: false is recommended for Spark — MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // SparkRenderer drives splat sorting and LOD streaming/updates for the .rad file.
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    const splat = new SplatMesh({ url: encodeURI('/Spirited Away Boiler Room-lod.rad') });
    scene.add(splat);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(-0.36, 0.48, -0.27);
    controls.update();

    const debug = createDebugOverlay();
    scene.add(debug.physicsLines);
    scene.add(debug.raycastMarker);
    attachDebugRaycast(debug, camera, scene, renderer.domElement);

    const physics = initPhysics();

    const navigation = initNavigation();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, camera, renderer, spark, splat, controls, debug, physics, navigation, collider: null as Collider | null };
}

type State = ReturnType<typeof init>;

async function load(state: State) {
    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;

    state.collider = await loadCollider(COLLIDER_URL);
    console.log(`collider loaded: ${state.collider.positions.length / 3} verts, ${state.collider.indices.length / 3} tris`);

    // Add the scene geometry to the physics world as a static triangle mesh.
    createSplatCollider(state.physics, state.collider);

    await loadNavigation(state.navigation);
}

function update(state: State, dt: number) {
    updatePhysics(state.physics, dt);
    state.controls.update();
    updateDebugOverlay(state.debug, state.camera, state.controls);
    updatePhysicsDebug(state.debug, state.physics.world);
    updateNavigation(state.navigation, state.scene, state.debug.showNavMesh);
    state.renderer.render(state.scene, state.camera);
}

async function start() {
    const state = init();
    await load(state);
    let lastTime = performance.now();
    function loop() {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        update(state, dt);
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
