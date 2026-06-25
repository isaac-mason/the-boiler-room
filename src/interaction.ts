// Pointer interaction: sweep the cursor over the creatures to knock them into
// ragdolls, or over a coal to shove it (which makes its carrier drop it). A
// hover/touch-driven "wand" — far more discoverable than the old click-to-knock.
// Uses a THREE.Raycaster + a ray→point distance test (the instanced creatures/coal
// are too small/dynamic to raycast per-triangle reliably).
import * as THREE from 'three';
import { type CoalSystem, pushCoal } from './coal';
import { type Creatures, ragdollCreature } from './creatures';
import type { Navigation } from './navigation';
import type { Physics } from './physics';

const CREATURE_SWEEP_RADIUS = 0.14; // world-space reach of the cursor wand around a creature
const COAL_SWEEP_FACTOR = 2.4; // coal reach = coal radius × this
const COAL_PUSH_SPEED = 1.6; // shove speed along the cursor ray (m/s)
const COAL_PUSH_UP = 1.0; // upward component of the shove (m/s)

const raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _p = new THREE.Vector3();
const _rel = new THREE.Vector3();

type Deps = {
    camera: THREE.Camera;
    creatures: Creatures;
    coal: CoalSystem;
    navigation: Navigation;
    physics: Physics;
};

export function attachInteraction(canvas: HTMLElement, deps: Deps): void {
    canvas.addEventListener('pointermove', (e) => {
        // Mouse: react on hover only (no button held), so the wand never fights an
        // orbit-drag. Touch/pen have no hover, so react to the drag itself.
        if (e.pointerType === 'mouse' && e.buttons !== 0) return;
        sweep(e, deps);
    });
}

function sweep(e: PointerEvent, deps: Deps): void {
    const { camera, creatures, coal, navigation, physics } = deps;

    _ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
    _ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(_ndc, camera);
    const ray = raycaster.ray;

    // Knock every creature the cursor passes near. Skip ones already tumbling —
    // re-calling ragdoll would re-zero their velocity each event and freeze them.
    const creatureR2 = CREATURE_SWEEP_RADIUS * CREATURE_SWEEP_RADIUS;
    for (const creature of creatures.list) {
        if (creature.mode === 'ragdoll') continue;
        _p.set(creature.position[0], creature.position[1], creature.position[2]);
        if (ray.distanceSqToPoint(_p) > creatureR2) continue;
        if (_rel.copy(_p).sub(ray.origin).dot(ray.direction) <= 0) continue; // behind camera
        ragdollCreature(creature, navigation, physics.world);
    }

    // Shove any coal the cursor passes near (drops it from its carrier).
    for (const c of coal.list) {
        _p.set(c.body.position[0], c.body.position[1], c.body.position[2]);
        const coalR2 = (c.radius * COAL_SWEEP_FACTOR) ** 2;
        if (ray.distanceSqToPoint(_p) > coalR2) continue;
        if (_rel.copy(_p).sub(ray.origin).dot(ray.direction) <= 0) continue;
        pushCoal(physics.world, c, [
            ray.direction.x * COAL_PUSH_SPEED,
            ray.direction.y * COAL_PUSH_SPEED + COAL_PUSH_UP,
            ray.direction.z * COAL_PUSH_SPEED,
        ]);
    }
}
