// Pointer interaction: click/tap a mite to knock it into a ragdoll, or a coal to
// shove it (which makes its carrier drop it). Uses a THREE.Raycaster and a
// ray→point distance test (the instanced mites/coal are too small/dynamic to
// raycast per-triangle reliably). Clicks are distinguished from orbit-drags.
import * as THREE from 'three';
import { type Coal, type CoalSystem, pushCoal } from './coal';
import { type Mite, type Mites, ragdollMite } from './mites';
import type { Navigation } from './navigation';
import type { Physics } from './physics';

const MITE_CLICK_RADIUS = 0.1; // world-space pick tolerance around a mite
const COAL_CLICK_FACTOR = 2.2; // pick tolerance = coal radius × this
const COAL_PUSH_SPEED = 1.6; // knock speed along the click ray (m/s)
const COAL_PUSH_UP = 1.0; // upward component of the knock (m/s)
const CLICK_MOVE_PX = 6; // a pointer that moves more than this is a drag, not a click
const CLICK_MAX_MS = 500; // and one held longer than this isn't a click either

const raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _p = new THREE.Vector3();
const _rel = new THREE.Vector3();

type Deps = {
    camera: THREE.Camera;
    mites: Mites;
    coal: CoalSystem;
    navigation: Navigation;
    physics: Physics;
};

export function attachInteraction(canvas: HTMLElement, deps: Deps): void {
    let downX = 0;
    let downY = 0;
    let downT = 0;
    canvas.addEventListener('pointerdown', (e) => {
        downX = e.clientX;
        downY = e.clientY;
        downT = performance.now();
    });
    canvas.addEventListener('pointerup', (e) => {
        const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
        if (moved <= CLICK_MOVE_PX && performance.now() - downT <= CLICK_MAX_MS) {
            handleClick(e, deps);
        }
    });
}

function handleClick(e: PointerEvent, deps: Deps): void {
    const { camera, mites, coal, navigation, physics } = deps;

    _ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
    _ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(_ndc, camera);
    const ray = raycaster.ray;

    // Pick whatever the cursor is most directly ON: smallest perpendicular distance
    // to the ray, normalised by each object's click radius (so a mite the cursor is
    // centred on beats a coal that merely happens to be nearer the camera).
    let bestScore = Infinity;
    let hitMite: Mite | null = null;
    let hitCoal: Coal | null = null;

    const miteR2 = MITE_CLICK_RADIUS * MITE_CLICK_RADIUS;
    for (const mite of mites.list) {
        _p.set(mite.position[0], mite.position[1], mite.position[2]);
        const dSq = ray.distanceSqToPoint(_p);
        if (dSq > miteR2) continue;
        if (_rel.copy(_p).sub(ray.origin).dot(ray.direction) <= 0) continue; // behind camera
        const score = dSq / miteR2;
        if (score < bestScore) {
            bestScore = score;
            hitMite = mite;
            hitCoal = null;
        }
    }
    for (const c of coal.list) {
        _p.set(c.body.position[0], c.body.position[1], c.body.position[2]);
        const cr2 = (c.radius * COAL_CLICK_FACTOR) ** 2;
        const dSq = ray.distanceSqToPoint(_p);
        if (dSq > cr2) continue;
        if (_rel.copy(_p).sub(ray.origin).dot(ray.direction) <= 0) continue;
        const score = dSq / cr2;
        if (score < bestScore) {
            bestScore = score;
            hitCoal = c;
            hitMite = null;
        }
    }

    if (hitMite) {
        ragdollMite(hitMite, navigation, physics.world, [ray.direction.x, ray.direction.y, ray.direction.z]);
    } else if (hitCoal) {
        pushCoal(physics.world, hitCoal, [
            ray.direction.x * COAL_PUSH_SPEED,
            ray.direction.y * COAL_PUSH_SPEED + COAL_PUSH_UP,
            ray.direction.z * COAL_PUSH_SPEED,
        ]);
    }
}
