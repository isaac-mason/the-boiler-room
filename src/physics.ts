import {
    addBroadphaseLayer,
    addObjectLayer,
    type BodyId,
    box,
    createWorld,
    createWorldSettings,
    enableCollision,
    MotionType,
    registerAll,
    rigidBody,
    triangleMesh,
    updateWorld,
    type World,
} from 'crashcat';
import type { Collider } from './collider-schema';

// Register all shapes & constraints up front. Simplest during development; swap
// for granular registerShapes/registerConstraints later for better tree-shaking.
registerAll();

const settings = createWorldSettings();

// Earth gravity.
settings.gravity = [0, -9.81, 0];

export const BROADPHASE_LAYER_MOVING = addBroadphaseLayer(settings);
export const BROADPHASE_LAYER_NOT_MOVING = addBroadphaseLayer(settings);

export const OBJECT_LAYER_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_MOVING);
export const OBJECT_LAYER_NOT_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_NOT_MOVING);

enableCollision(settings, OBJECT_LAYER_MOVING, OBJECT_LAYER_NOT_MOVING);
enableCollision(settings, OBJECT_LAYER_MOVING, OBJECT_LAYER_MOVING);

export type Physics = {
    world: World;
};

export const FLOOR_Y = -0.1;

export function initPhysics(): Physics {
    const world = createWorld(settings);

    rigidBody.create(world, {
        shape: box.create({ halfExtents: [5, 0.1, 5] }),
        position: [0, FLOOR_Y, 0],
        motionType: MotionType.STATIC,
        objectLayer: OBJECT_LAYER_NOT_MOVING,
    });

    return { world };
}

// Clamp the frame delta so a long pause (e.g. tab refocus) can't blow up the sim.
const MAX_DELTA = 1 / 30;

export function updatePhysics(physics: Physics, dt: number): void {
    updateWorld(physics.world, undefined, Math.min(dt, MAX_DELTA));
}

/**
 * Add the splat scene's collision geometry as a single static triangle-mesh body.
 * Returns the body id — don't hold the body reference, it's pooled (see crashcat README).
 */
export function createSplatCollider(physics: Physics, collider: Collider): BodyId {
    const shape = triangleMesh.create({
        positions: Array.from(collider.positions),
        indices: Array.from(collider.indices),
    });

    const body = rigidBody.create(physics.world, {
        shape,
        motionType: MotionType.STATIC,
        objectLayer: OBJECT_LAYER_NOT_MOVING,
    });

    return body.id;
}
