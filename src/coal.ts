// Coal: deterministic convex-hull lumps, simulated as crashcat dynamic bodies
// and rendered instanced in a single THREE.BatchedMesh (the bodies rotate, so
// instances carry the full body quaternion). The creatures haul these to the boiler.
import { type ConvexHullShape, convexHull, MotionType, type RigidBody, rigidBody, scaled, type World } from 'crashcat';
import { mat4, type Quat, type Vec3 } from 'mathcat';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { OBJECT_LAYER_GHOST, OBJECT_LAYER_MOVING, type Physics } from './physics';

const SHAPE_COUNT = 6; // distinct deterministic lumps
const POINTS_PER_HULL = 14;
const COAL_RADIUS = 0.05; // ~ a creature body, a bit bigger (less tunnel-prone, so no CCD)
const COAL_CONVEX_RADIUS = 0.004; // hull rounding margin (must be << COAL_RADIUS)
const COAL_DENSITY = 400;
const COAL_SIZE_MIN = 0.6; // per-coal scale range — some small, some quite big
const COAL_SIZE_MAX = 1.8;
const MAX_COAL = 48; // BatchedMesh instance budget
const CLUMP_JITTER = 0.06;

const COLOR_COAL = new THREE.Color(0x18181b);

// Deterministic PRNG so the coal lumps are identical every reload.
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type CoalShape = { shape: ConvexHullShape; geometry: THREE.BufferGeometry };

// Generate the shape pool once at module load.
const COAL_SHAPES: CoalShape[] = (() => {
    const rng = mulberry32(0xc0a1c0a1);
    const out: CoalShape[] = [];
    for (let i = 0; i < SHAPE_COUNT; i++) {
        const positions: number[] = [];
        const v3: THREE.Vector3[] = [];
        for (let p = 0; p < POINTS_PER_HULL; p++) {
            // random direction on a sphere with a jittered radius → a lumpy rock
            const u = rng() * 2 - 1;
            const theta = rng() * Math.PI * 2;
            const s = Math.sqrt(1 - u * u);
            const rad = COAL_RADIUS * (0.55 + 0.45 * rng());
            const x = Math.cos(theta) * s * rad;
            const y = u * rad;
            const z = Math.sin(theta) * s * rad;
            positions.push(x, y, z);
            v3.push(new THREE.Vector3(x, y, z));
        }
        const shape = convexHull.create({ positions, convexRadius: COAL_CONVEX_RADIUS, density: COAL_DENSITY });
        // ConvexGeometry is non-indexed triangle soup; index it for BatchedMesh.
        const geometry = mergeVertices(new ConvexGeometry(v3));
        out.push({ shape, geometry });
    }
    return out;
})();

export type CoalState = 'loose' | 'carried' | 'thrown';

export type Coal = {
    body: RigidBody;
    shapeIndex: number;
    instance: number;
    state: CoalState;
    size: number; // scale factor (physics + render); bigger = heavier to carry
    radius: number; // world-space radius (COAL_RADIUS × size) — for accurate carrying
};

export type CoalSystem = {
    mesh: THREE.BatchedMesh;
    geoIds: number[]; // BatchedMesh geometry id per shape
    list: Coal[];
};

const _m4 = mat4.create();
const _m4three = new THREE.Matrix4();
const _scale: Vec3 = [1, 1, 1];

export function initCoal(): CoalSystem {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.15 });

    let maxVerts = 0;
    let maxIndices = 0;
    for (const { geometry } of COAL_SHAPES) {
        maxVerts += geometry.attributes.position.count;
        maxIndices += geometry.index?.count ?? 0;
    }

    const mesh = new THREE.BatchedMesh(MAX_COAL, maxVerts, maxIndices, material);
    mesh.perObjectFrustumCulled = false;
    mesh.frustumCulled = false;
    const geoIds = COAL_SHAPES.map(({ geometry }) => mesh.addGeometry(geometry));

    return { mesh, geoIds, list: [] };
}

// Spawn one loose coal (dynamic body + instance) at a world position.
export function spawnCoal(coal: CoalSystem, physics: Physics, position: Vec3): Coal | null {
    if (coal.list.length >= MAX_COAL) return null;

    const shapeIndex = Math.floor(Math.random() * SHAPE_COUNT);
    const size = COAL_SIZE_MIN + Math.random() * (COAL_SIZE_MAX - COAL_SIZE_MIN);

    // Scale the base hull per-coal (mass scales with the shape automatically).
    const body = rigidBody.create(physics.world, {
        shape: scaled.create({ shape: COAL_SHAPES[shapeIndex].shape, scale: [size, size, size] }),
        position,
        motionType: MotionType.DYNAMIC,
        objectLayer: OBJECT_LAYER_MOVING,
    });

    const instance = coal.mesh.addInstance(coal.geoIds[shapeIndex]);
    coal.mesh.setColorAt(instance, COLOR_COAL);

    const c: Coal = { body, shapeIndex, instance, state: 'loose', size, radius: COAL_RADIUS * size };
    coal.list.push(c);
    return c;
}

// Spawn a small pile around the clump (stacked a little so they settle, not interpenetrate).
export function spawnCoalClump(coal: CoalSystem, physics: Physics, center: Vec3, count: number): void {
    for (let i = 0; i < count; i++) {
        const position: Vec3 = [
            center[0] + (Math.random() * 2 - 1) * CLUMP_JITTER,
            center[1] + COAL_RADIUS + i * COAL_RADIUS * 1.5,
            center[2] + (Math.random() * 2 - 1) * CLUMP_JITTER,
        ];
        spawnCoal(coal, physics, position);
    }
}

export function despawnCoal(coal: CoalSystem, physics: Physics, c: Coal): void {
    rigidBody.remove(physics.world, c.body);
    coal.mesh.deleteInstance(c.instance);
    const i = coal.list.indexOf(c);
    if (i >= 0) coal.list.splice(i, 1);
}

// Pick the coal up: kinematic (held, no gravity), moved to the no-collision layer
// (so it doesn't jank against the carrier/other coal), and marked carried.
export function carryCoal(world: World, c: Coal): void {
    if (c.state !== 'carried') {
        rigidBody.setMotionType(world, c.body, MotionType.KINEMATIC, true);
        rigidBody.setObjectLayer(world, c.body, OBJECT_LAYER_GHOST);
        c.state = 'carried';
    }
}

// Snap a carried coal to a held world point + orientation each frame (so it
// rotates with the carrier instead of keeping its grab-time tumble).
export function holdCoalAt(world: World, c: Coal, point: Vec3, quaternion: Quat): void {
    rigidBody.setTransform(world, c.body, point, quaternion, true);
}

// Throw it: back to dynamic + the colliding layer, with a launch velocity.
export function throwCoal(world: World, c: Coal, velocity: Vec3): void {
    rigidBody.setMotionType(world, c.body, MotionType.DYNAMIC, true);
    rigidBody.setObjectLayer(world, c.body, OBJECT_LAYER_MOVING);
    rigidBody.setLinearVelocity(world, c.body, velocity);
    c.state = 'thrown';
}

// Force-drop a carried coal (carrier knocked over): back to dynamic + the
// colliding layer + loose, so it falls and can be picked up again.
export function dropCoal(world: World, c: Coal): void {
    if (c.state !== 'loose') {
        rigidBody.setMotionType(world, c.body, MotionType.DYNAMIC, true);
        rigidBody.setObjectLayer(world, c.body, OBJECT_LAYER_MOVING);
        c.state = 'loose';
    }
}

// Knock a coal around (pointer push). Releases it first if it was being carried.
export function pushCoal(world: World, c: Coal, velocity: Vec3): void {
    dropCoal(world, c);
    rigidBody.setLinearVelocity(world, c.body, velocity);
}

// Sync instance transforms from the bodies (post-physics). Carried coal is
// teleported by holdCoalAt, so its body transform is current too.
export function updateCoal(coal: CoalSystem): void {
    for (const c of coal.list) {
        _scale[0] = c.size;
        _scale[1] = c.size;
        _scale[2] = c.size;
        mat4.fromRotationTranslationScale(_m4, c.body.quaternion, c.body.position, _scale);
        _m4three.fromArray(_m4);
        coal.mesh.setMatrixAt(c.instance, _m4three);
    }
}
