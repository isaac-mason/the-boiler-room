// Crawler "dust creatures" — a faithful port of the crawler sketch's physics + IK
// controller (sketches/crawler), scaled down, rendered instanced with a single
// THREE.BatchedMesh, with two added top arms. Steering/navmesh/behaviour come later.
//
// All vector/quat/matrix math is done with mathcat (the same lib crashcat uses,
// so positions/velocities/raycasts flow through with no conversion). THREE is
// used only for the rendering objects it requires (BatchedMesh, geometries,
// Color, and a single Matrix4 to hand to setMatrixAt).
import {
    CastRayStatus,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    DOF_ALL,
    type Filter,
    filter,
    MotionType,
    type RigidBody,
    rigidBody,
    sphere,
    type World,
} from 'crashcat';
import { mat4, type Quat, quat, remapClamp, type Vec3, vec3 } from 'mathcat';
import * as THREE from 'three';
import { bone, type Chain, fabrikFixedIterations, JointConstraintType } from './fabrik';
import {
    addCrowdAgent,
    getAgent,
    isAgentAtTarget,
    makeAgentParams,
    type Navigation,
    removeCrowdAgent,
    setAgentTarget,
    snapToNavMesh,
} from './navigation';
import { OBJECT_LAYER_MOVING, type Physics } from './physics';
import { CLUMP, CREATURE_COUNT, DROPOFF } from './scene';

/* ---------------- config (all spatial dims scaled by CREATURE_SCALE) ---------------- */

const CREATURE_SCALE = 0.06;

const BODY_RADIUS = 0.5 * CREATURE_SCALE;
const HEIGHT = 1.2 * CREATURE_SCALE; // body-centre ride height above the floor (a smidge lower → slightly more crouched)

const N_LEGS = 2;
const LEG_SEGMENTS = 4; // more joints → curvier, organic creature legs
const LEG_LENGTH = 1.25 * CREATURE_SCALE; // a little longer than the hip→ground reach → gentle bend, some slack
const ATTACH_RADIUS = 0.28 * CREATURE_SCALE; // hips close together under the body
const FOOT_RADIUS = 0.38 * CREATURE_SCALE; // feet roughly under the hips (a stance), not splayed out
const LEG_RADIUS = 0.05 * CREATURE_SCALE;
const LEG_IK_ITERATIONS = 6; // FABRIK passes per frame (reset each frame; longer chain needs more)
const LEG_JOINT_ROTOR = Math.PI / 2; // per-joint ball-constraint limit (back to loose — tight looked bad)
const LEG_ATTACH_Y = -0.3 * CREATURE_SCALE; // hips low-ish → legs come from the lower body (not so low it over-slacks)

const N_ARMS = 2;
const ARM_SEGMENTS = 4; // more joints → noodly, expressive arms
const ARM_LENGTH = 1.4 * CREATURE_SCALE;
const ARM_RADIUS = 0.06 * CREATURE_SCALE;
const ARM_IK_ITERATIONS = 5; // warm-started, but the longer chain needs a few more passes
const ARM_JOINT_ROTOR = Math.PI / 2; // looser ball limit → noodly, expressive arms
// Idle (not-carrying) arm swing — a smooth fore/aft walk-pump (driven off smoothed
// speed, NOT the noisy gait cadence, so it never gets erratic).
const ARM_SWING_SMOOTH = 5; // per-sec low-pass rate for the swing's speed input
const ARM_SWING_FREQ_BASE = 1.2; // swing Hz when standing
const ARM_SWING_FREQ_GAIN = 2.5; // extra Hz per unit speed
const ARM_OUT = 0.6; // reach direction: out to the side
const ARM_DOWN = 0.5; // reach direction: downward — arms hang down so the swing scoops DOWN through centre
const ARM_EXTEND = 0.95; // reach near full ARM_LENGTH → arm outstretched/straight, the whole limb sweeps the U
const ARM_SWING_AMP_BASE = 0.2; // fore/aft component of the reach dir when standing
const ARM_SWING_AMP_GAIN = 0.6; // extra fore/aft component per unit speed fraction
const ARM_U_LIFT = 0.9; // hand lifts this much at the fore/aft extremes → the 'U' scoops down at centre, up at the ends

// Time-based gait: each leg steps once per gait cycle on a schedule (no distance
// thresholds / emergency re-plants — those caused frantic stepping). Cadence
// scales with speed so the planted foot doesn't slip; stride = speed / cadence.
const STEP_ARC_HEIGHT = 0.1 * CREATURE_SCALE;
const STEP_CADENCE_BASE = 2.5; // gait cycles/sec when standing still
const STEP_CADENCE_GAIN = 9; // extra cycles/sec per unit of body speed (lower → fewer, larger steps)
const STEP_DURATION_FRAC = 0.45; // a step swing takes this fraction of a cycle (the rest is planted)
const STEP_LEAD_FRACTION = 0.35; // foot lands this fraction of a stride ahead; it then recedes ~0.55 → swings well behind too
const STEP_LEAD_MAX = 0.45 * CREATURE_SCALE; // but never lead by more than this — else the leg over-extends

// Carrying a coal: sell the struggle — laboured low cadence (→ fewer, longer
// lunges), dragging feet, body crushed down.
const CARRY_CADENCE_MULT = 0.35; // slower step cadence while burdened → fewer, wider strides
const CARRY_ARC_MULT = 0.35; // feet barely lift (heavy, dragging)
const CRUSH_PER_LOAD = 0.2 * CREATURE_SCALE; // body sinks this much per unit of coal size (heavier = lower)
const CARRY_FOOT_SPLAY = 0.45; // feet splay out this much per unit of load → wide stance keeps legs taut under the crush
const CARRY_STEP_LEAD = 0.65 * CREATURE_SCALE; // each lunge reaches this far ahead (wide footsteps)

// Movement bob: the body rises and dips with the gait while walking, so the
// creatures lope instead of gliding. Faded in by smoothed speed → no bob when idle.
const BOB_AMP = 0.18 * CREATURE_SCALE; // peak vertical bob (metres) at full stride
const BOB_CYCLES = 2; // body rises this many times per bob cycle (one per tripod push)
const BOB_FULL_SPEED = 0.22; // smoothed speed (m/s) at which the bob reaches full amplitude
// Legs scurry fast when unburdened (high cadence), but the body shouldn't heave at
// that rate — cap the bob cadence so it stays a calm lope. Carrying is already below
// this, so its (lovely) slow heave is unchanged.
const BOB_MAX_CADENCE = 1.6; // bob cycles/sec ceiling

// Crowd agent + kinematic ground-follow.
const AGENT_RADIUS = 0.05;
export const AGENT_MAX_SPEED = 0.28; // unburdened pace; carrying slows them further
const GROUND_RAY_UP = 0.3; // ground ray starts this far above the agent's navmesh Y
const GROUND_RAY_LEN = 1.2;
const GROUND_SMOOTH = 14; // per-sec low-pass on the ride height. The splat collider is
// bumpy, so a raw per-frame ground ray jitters the body; feet still IK to the true
// ground, so smoothing only the body height costs no contact accuracy.
const ARRIVE_THRESHOLD = 0.15; // crowd "at target" distance
const TURN_RATE = 8; // how fast the body yaws toward its heading (per second, slerp fraction)
const TURN_MIN_SPEED = 0.02; // below this speed, keep the current facing (don't spin in place)

// Ragdoll (pointer-knocked): the body goes dynamic and tumbles, limbs flailing.
const RAGDOLL_MIN_TIME = 1.6; // min seconds to tumble before recovery is allowed
const RAGDOLL_SETTLE_SPEED = 0.15; // recover once the tumbling body slows below this (m/s)
const RAGDOLL_PUSH = 1.2; // horizontal scatter speed, in a random direction (m/s)
const RAGDOLL_PUSH_UP = 3.0; // upward kick (m/s) — dominant, so they pop UP, not toward the back
const RAGDOLL_SPIN = 18; // tumble angular velocity magnitude (rad/s)
// Batting an already-downed creature with the cursor: ADD an impulse (don't reset
// its velocity, or it freezes), capped so repeated swipes can't fling it absurdly.
const RAGDOLL_KICK = 0.25; // horizontal impulse per swipe-event (× strength)
const RAGDOLL_KICK_UP = 0.3; // upward pop when batted (× strength)
const RAGDOLL_KICK_MAX = 0.9; // resulting speed cap (m/s) — a gentle jostle, not a fling
const RAGDOLL_KICK_SPIN = 0.15; // fraction of RAGDOLL_SPIN applied when batted
// Ragdoll limbs flail as 1-segment verlet pendulums: each tip dangles from its
// (tumbling) joint, sags under gravity, and lags the body's motion — so the limbs
// whip and swing instead of staying locked to the rest pose.
const RAGDOLL_LIMB_DAMP = 0.99; // velocity retained per frame — higher = looser, swingier
const RAGDOLL_LIMB_GRAVITY = 9.8; // m/s² sag pulling the dangling tips toward the floor
const RAGDOLL_LIMB_REACH = 0.95; // tip dangles within this fraction of limb length from the joint
const RAGDOLL_LIMB_ITERATIONS = 3; // FABRIK passes to track the whipping tip
const GETUP_DURATION = 0.7; // seconds to animate from the tumbled pose back to standing
const GETUP_ARM_RATE = 7; // per-sec lerp of the arms from their ragdoll pose toward rest (no snap)

const EYE_RADIUS = 0.14 * CREATURE_SCALE;
const IRIS_RADIUS = 0.05 * CREATURE_SCALE;
const N_EYES = 2;

// Googly-eye pupil physics (in eye-local normalised units: disc radius = 1).
const EYE_MAX = (EYE_RADIUS - IRIS_RADIUS) / EYE_RADIUS; // how far the pupil can roam
const EYE_GRAVITY = 11; // pupil droops downward
const EYE_MOVE_GAIN = 0.22; // how strongly body motion flings the pupil (inertia)
const EYE_DAMP = 0.86; // per-frame velocity damping
const EYE_RESTITUTION = 0.5; // bounce off the eye rim

// Swarm spawns in a disc around this world point, dropped a little above so the
// suspension settles them onto the floor.
const SPAWN_CENTER: Vec3 = [-0.75, -0.04, -2.01];
const SPAWN_RADIUS = 0.5; // horizontal spread (snapped onto the navmesh)

const INSTANCES_PER_CREATURE = 1 + N_LEGS * LEG_SEGMENTS + N_ARMS * ARM_SEGMENTS + N_EYES * 2;

/* ---------------- limb definitions (shared by every creature) ---------------- */

type LimbDef = {
    attachment: Vec3; // base, in body-local space
    restEnd: Vec3; // nominal straightened tip, in body-local space (initial IK pose)
    segments: number;
    length: number;
    phaseOffset: number; // legs only
    rotor: number; // per-joint ball-constraint angle limit
};

const LEG_DEFS: LimbDef[] = Array.from({ length: N_LEGS }, (_, i) => {
    // legs spread evenly, centred symmetric about the forward (+Z) axis — so 2
    // legs become a left/right pair, while 4 keep their original X layout.
    const angle = Math.PI / 2 + (i - (N_LEGS - 1) / 2) * ((Math.PI * 2) / N_LEGS);
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    return {
        attachment: [x * ATTACH_RADIUS, LEG_ATTACH_Y, z * ATTACH_RADIUS],
        restEnd: [x * FOOT_RADIUS, 0, z * FOOT_RADIUS],
        segments: LEG_SEGMENTS,
        length: LEG_LENGTH,
        phaseOffset: i > N_LEGS / 2 ? i / N_LEGS - 1 : i / N_LEGS,
        rotor: LEG_JOINT_ROTOR,
    };
});

const ARM_DEFS: LimbDef[] = Array.from({ length: N_ARMS }, (_, i) => {
    const side = i === 0 ? -1 : 1;
    // Shoulders: up on the upper-front of the body, clearly above + ahead of the
    // hips (LEG_ATTACH_Y, z≈0) so arms and legs read as separate limbs.
    const attachment: Vec3 = [side * 0.34 * CREATURE_SCALE, 0.12 * CREATURE_SCALE, 0.18 * CREATURE_SCALE];
    // Rest pose reaches out to the SIDE (slightly forward + down) at ~85% arm
    // length, so the arms sit at the body's sides where they're visible (and the
    // near-straight chain has no ambiguous elbow fold for FABRIK to flip).
    const reach = vec3.scale([0, 0, 0], vec3.normalize([0, 0, 0], [side * 1.0, -0.15, 0.45]), ARM_LENGTH * 0.85);
    const restEnd: Vec3 = [attachment[0] + reach[0], attachment[1] + reach[1], attachment[2] + reach[2]];
    return { attachment, restEnd, segments: ARM_SEGMENTS, length: ARM_LENGTH, phaseOffset: i, rotor: ARM_JOINT_ROTOR };
});

// Eyes, body-local: centred on the body height, bulging out past the front face.
const EYE_OFFSETS: Vec3[] = [
    [-0.18 * CREATURE_SCALE, 0, 0.56 * CREATURE_SCALE],
    [0.18 * CREATURE_SCALE, 0, 0.56 * CREATURE_SCALE],
];
const EYE_QUATERNION: Quat = quat.setAxisAngle(quat.create(), [1, 0, 0], -0.15);

/* ---------------- state ---------------- */

type LimbState = {
    def: LimbDef;
    chain: Chain;
    footPlacement: Vec3; // world, legs only
    goal: Vec3; // world
    current: Vec3; // world (interpolated effector)
    stepping: boolean;
    stepProgress: number;
    lastPhase: number; // gait phase last frame (legs only) — to detect the per-cycle step trigger
    flailPos: Vec3; // world-space limb tip while ragdolling (verlet pendulum)
    flailPrev: Vec3; // previous flailPos, for verlet velocity
    getupLocal: Vec3; // arms: eased local IK target during get-up (ragdoll pose → rest, no snap)
    // Arms only: when set, the arm reaches this WORLD point instead of its rest
    // pose (e.g. to carry a rock above the head). null → idle rest pose.
    worldTarget: Vec3 | null;
};

type Eye = {
    current: Vec3;
    prev: Vec3 | undefined;
    velocity: Vec3;
    local: Vec3; // iris offset in eye plane
};

export type CreatureMode = 'crowd' | 'velocity' | 'ragdoll' | 'getup';

export type Creature = {
    body: RigidBody;
    mode: CreatureMode;
    agentId: string | null; // crowd agent
    targetIndex: number; // phase-1 wander: 0 = clump, 1 = dropoff
    position: Vec3;
    quaternion: Quat; // body yaw — turns to face movement direction
    speed: number; // horizontal speed (m/s) — drives gait cadence + foot anticipation
    smoothSpeed: number; // low-passed speed — drives the (jitter-free) arm swing amplitude
    armPhase: number; // smoothly-accumulated arm-swing phase (0..1), so the swing never jitters
    load: number; // coal size being carried (0 = empty) — drives the "struggling" gait
    cadence: number; // current gait cycles/sec (set in pre-step, used to time step swings)
    ragdollTimer: number; // seconds spent ragdolling (mode === 'ragdoll') — for recovery
    // Animated get-up (mode === 'getup'): lerp/slerp the body from its tumbled pose
    // back to standing before re-attaching the crowd agent.
    getupTimer: number;
    getupFromPos: Vec3;
    getupFromQuat: Quat;
    getupToPos: Vec3; // standing body pose (navmesh point + ride height)
    stepCycleTime: number;
    bobPhase: number; // body-bob phase (0..1); advances at a capped cadence so it never gets frantic
    grounded: boolean;
    smoothGroundY: number; // low-passed ground height — damps per-frame ray noise (NaN until first hit)
    legs: LimbState[];
    arms: LimbState[];
    eyes: Eye[];
    // BatchedMesh instance ids
    bodyInstance: number;
    legInstances: number[][]; // [leg][segment]
    armInstances: number[][];
    eyeInstances: { white: number; iris: number }[];
};

export type Creatures = {
    mesh: THREE.BatchedMesh;
    geo: { body: number; limb: number; eye: number };
    list: Creature[];
    // Downward ground ray filter (static collider only), bound to the world, so
    // it's created in initCreatures and lives here, concrete. Used for kinematic body
    // Y and for foot placement.
    groundFilter: Filter;
};

/* ---------------- shared raycast scaffolding + temporaries ---------------- */

const groundCollector = createClosestCastRayCollector();
const groundSettings = createDefaultCastRaySettings();

const footCollector = createClosestCastRayCollector();
const footSettings = createDefaultCastRaySettings();

const UP: Vec3 = [0, 1, 0];
const FORWARD: Vec3 = [0, 0, 1]; // body-local forward (the +Z the creature faces)
const UPRIGHT: Quat = [0, 0, 0, 1]; // identity orientation (used on ragdoll recovery)

const _dir: Vec3 = [0, 0, 0];
const _mid: Vec3 = [0, 0, 0];
const _scaleV: Vec3 = [0, 0, 0];
const _q: Quat = quat.create();
const _m4 = mat4.create();
const _m4three = new THREE.Matrix4(); // transport for BatchedMesh.setMatrixAt
const _targetLocal: Vec3 = [0, 0, 0];
const _armRest: Vec3 = [0, 0, 0];
const _attachWorld: Vec3 = [0, 0, 0];
const _eyeWorld: Vec3 = [0, 0, 0];
const _eyeQuat: Quat = quat.create();
const _iris: Vec3 = [0, 0, 0];
const _targetQuat: Quat = quat.create();
const _quatConj: Quat = quat.create();
const _gripL: Vec3 = [0, 0, 0];
const _gripR: Vec3 = [0, 0, 0];
const _fwd: Vec3 = [0, 0, 0];
const _getupPos: Vec3 = [0, 0, 0];
const _getupQuat: Quat = [0, 0, 0, 1];

const COLOR_BODY = new THREE.Color(0x504438);
const COLOR_LIMB = new THREE.Color(0x382f26);
const COLOR_EYE = new THREE.Color(0xffffff);
const COLOR_IRIS = new THREE.Color(0x111111);

const ease = (x: number): number => -(Math.cos(Math.PI * x) - 1) / 2;
const rand = (min: number, max: number) => min + Math.random() * (max - min);

// body-local point → world: out = pos + quat·local
function bodyToWorld(out: Vec3, local: Vec3, creature: Creature): Vec3 {
    vec3.transformQuat(out, local, creature.quaternion);
    out[0] += creature.position[0];
    out[1] += creature.position[1];
    out[2] += creature.position[2];
    return out;
}

// world point → body-local: out = quat⁻¹·(world - pos)
function worldToBodyLocal(out: Vec3, world: Vec3, creature: Creature): Vec3 {
    out[0] = world[0] - creature.position[0];
    out[1] = world[1] - creature.position[1];
    out[2] = world[2] - creature.position[2];
    quat.conjugate(_quatConj, creature.quaternion);
    vec3.transformQuat(out, out, _quatConj);
    return out;
}

/* ---------------- construction ---------------- */

function makeChain(def: LimbDef): Chain {
    const chain: Chain = { bones: [] };
    const segmentLength = def.length / def.segments;
    const prev: Vec3 = [0, 0, 0];
    for (let i = 0; i < def.segments; i++) {
        const s: Vec3 = [prev[0], prev[1], prev[2]];
        const e: Vec3 = [prev[0], prev[1] - segmentLength, prev[2]];
        chain.bones.push(bone(s, e, { type: JointConstraintType.BALL, rotor: def.rotor }));
        prev[1] = e[1];
    }
    return chain;
}

function makeLimbState(def: LimbDef): LimbState {
    return {
        def,
        chain: makeChain(def),
        footPlacement: [0, 0, 0],
        goal: [0, 0, 0],
        current: [0, 0, 0],
        stepping: false,
        stepProgress: 1,
        lastPhase: 0,
        flailPos: [0, 0, 0],
        flailPrev: [0, 0, 0],
        getupLocal: [0, 0, 0],
        worldTarget: null,
    };
}

export function initCreatures(physics: Physics): Creatures {
    const bodyGeo = new THREE.SphereGeometry(1, 16, 12);
    const limbGeo = new THREE.CylinderGeometry(1, 1, 1, 6); // unit radius/height, centred on Y
    const eyeGeo = new THREE.CircleGeometry(1, 20); // flat disc facing +Z

    const material = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide });

    const maxInstances = CREATURE_COUNT * INSTANCES_PER_CREATURE;
    const maxVerts = bodyGeo.attributes.position.count + limbGeo.attributes.position.count + eyeGeo.attributes.position.count;
    const maxIndices = (bodyGeo.index?.count ?? 0) + (limbGeo.index?.count ?? 0) + (eyeGeo.index?.count ?? 0);

    const mesh = new THREE.BatchedMesh(maxInstances, maxVerts, maxIndices, material);
    mesh.perObjectFrustumCulled = false; // instances animate every frame
    mesh.frustumCulled = false;
    // Cast and receive the furnace shadows (creatures self-shadow and shadow each other).
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const geo = {
        body: mesh.addGeometry(bodyGeo),
        limb: mesh.addGeometry(limbGeo),
        eye: mesh.addGeometry(eyeGeo),
    };

    // Ground rays should only hit the static collider, never other (kinematic)
    // creatures or (dynamic) coal.
    const groundFilter = filter.forWorld(physics.world);
    groundFilter.bodyFilter = (b) => b.motionType === MotionType.STATIC;

    return { mesh, geo, list: [], groundFilter };
}

export function spawnCreatures(creatures: Creatures, physics: Physics, navigation: Navigation): void {
    const agentParams = makeAgentParams(AGENT_RADIUS, HEIGHT, AGENT_MAX_SPEED);

    for (let i = 0; i < CREATURE_COUNT; i++) {
        // uniform point in the spawn disc (sqrt for even area distribution)
        const angle = rand(0, Math.PI * 2);
        const r = SPAWN_RADIUS * Math.sqrt(Math.random());
        const sample: Vec3 = [SPAWN_CENTER[0] + Math.cos(angle) * r, SPAWN_CENTER[1], SPAWN_CENTER[2] + Math.sin(angle) * r];

        // Place the creature ON the navmesh, else its crowd agent has no valid poly
        // and never moves. Skip samples too far from any walkable surface.
        const position: Vec3 = [0, 0, 0];
        if (!snapToNavMesh(navigation, sample, position)) continue;

        // DOF_ALL so the body can tumble in ragdoll mode; in crowd/velocity modes
        // it's KINEMATIC and we drive its transform directly (upright).
        const body = rigidBody.create(physics.world, {
            shape: sphere.create({ radius: BODY_RADIUS, density: 100 }),
            position,
            motionType: MotionType.KINEMATIC,
            objectLayer: OBJECT_LAYER_MOVING,
            allowedDegreesOfFreedom: DOF_ALL,
        });

        const agentId = addCrowdAgent(navigation, position, agentParams);
        if (agentId) setAgentTarget(navigation, agentId, DROPOFF);

        const legs = LEG_DEFS.map(makeLimbState);
        const arms = ARM_DEFS.map(makeLimbState);
        const eyes: Eye[] = Array.from({ length: N_EYES }, () => ({
            current: [0, 0, 0],
            prev: undefined,
            velocity: [0, 0, 0],
            local: [0, 0, 0],
        }));

        const { mesh, geo } = creatures;
        const bodyInstance = mesh.addInstance(geo.body);
        mesh.setColorAt(bodyInstance, COLOR_BODY);

        const legInstances = legs.map((leg) =>
            leg.chain.bones.map(() => {
                const id = mesh.addInstance(geo.limb);
                mesh.setColorAt(id, COLOR_LIMB);
                return id;
            }),
        );
        const armInstances = arms.map((arm) =>
            arm.chain.bones.map(() => {
                const id = mesh.addInstance(geo.limb);
                mesh.setColorAt(id, COLOR_LIMB);
                return id;
            }),
        );
        const eyeInstances = eyes.map(() => {
            const white = mesh.addInstance(geo.eye);
            mesh.setColorAt(white, COLOR_EYE);
            const iris = mesh.addInstance(geo.eye);
            mesh.setColorAt(iris, COLOR_IRIS);
            return { white, iris };
        });

        creatures.list.push({
            body,
            mode: 'crowd',
            agentId,
            targetIndex: 1, // initial target set to DROPOFF above
            position: [position[0], position[1], position[2]],
            quaternion: [0, 0, 0, 1],
            speed: 0,
            smoothSpeed: 0,
            armPhase: Math.random(), // desync the swing across creatures
            load: 0,
            cadence: STEP_CADENCE_BASE,
            ragdollTimer: 0,
            getupTimer: 0,
            getupFromPos: [0, 0, 0],
            getupFromQuat: [0, 0, 0, 1],
            getupToPos: [0, 0, 0],
            stepCycleTime: Math.random(),
            bobPhase: Math.random(),
            grounded: false,
            smoothGroundY: NaN,
            legs,
            arms,
            eyes,
            bodyInstance,
            legInstances,
            armInstances,
            eyeInstances,
        });
    }
}

/* ---------------- controller ---------------- */

// crowd/velocity mode: kinematically drive the body. XZ follows the crowd agent,
// Y comes from a downward ground raycast (body hovers HEIGHT above the floor).
function driveKinematic(creature: Creature, world: World, navigation: Navigation, dt: number, groundFilter: Filter): void {
    if (!creature.agentId) return;
    const agent = getAgent(navigation, creature.agentId);
    if (!agent) return;

    const ax = agent.position[0];
    const ay = agent.position[1];
    const az = agent.position[2];

    const origin: Vec3 = [ax, ay + GROUND_RAY_UP, az];
    groundCollector.reset();
    castRay(world, groundCollector, groundSettings, origin, [0, -1, 0], GROUND_RAY_LEN, groundFilter);

    let groundY = ay;
    let grounded = false;
    if (groundCollector.hit.status === CastRayStatus.COLLIDING) {
        groundY = origin[1] - groundCollector.hit.fraction * GROUND_RAY_LEN;
        grounded = true;
    }

    // Low-pass the ride height so the bumpy collider's per-frame ray noise doesn't
    // jitter the body (snap to the first sample to avoid a startup pop).
    creature.smoothGroundY = Number.isNaN(creature.smoothGroundY)
        ? groundY
        : creature.smoothGroundY + (groundY - creature.smoothGroundY) * Math.min(dt * GROUND_SMOOTH, 1);
    groundY = creature.smoothGroundY;

    // Turn to face the direction of travel (yaw around Y), slerping smoothly.
    const vx = agent.velocity[0];
    const vz = agent.velocity[2];
    creature.speed = Math.hypot(vx, vz);
    if (creature.speed > TURN_MIN_SPEED) {
        const yaw = Math.atan2(vx, vz); // angle that rotates forward (+Z) onto (vx,vz)
        quat.setAxisAngle(_targetQuat, UP, yaw);
        quat.slerp(creature.quaternion, creature.quaternion, _targetQuat, Math.min(TURN_RATE * dt, 1));
    }

    // sink toward the floor when burdened — looks crushed under the coal
    const crush = creature.load * CRUSH_PER_LOAD;
    // movement bob: rise/dip with the gait, faded in by speed so idle creatures sit still
    const bobStrength = Math.min(creature.smoothSpeed / BOB_FULL_SPEED, 1);
    const bob = Math.sin(creature.bobPhase * Math.PI * 2 * BOB_CYCLES) * BOB_AMP * bobStrength;
    const target: Vec3 = [ax, groundY + HEIGHT - crush + bob, az];
    rigidBody.moveKinematic(creature.body, target, creature.quaternion, dt);
    creature.grounded = grounded;
}

function footPlacement(creature: Creature, world: World, footFilter: Filter): void {
    const pos = creature.position;
    for (const leg of creature.legs) {
        if (creature.grounded) {
            // rest-foot offset (rotated by yaw) + anticipation ahead along travel,
            // so the foot plants where the body is GOING — centres the gait, no trailing.
            // Carrying splays the stance wider so the legs stay taut under the crush.
            const splay = 1 + creature.load * CARRY_FOOT_SPLAY;
            vec3.set(_dir, leg.def.restEnd[0] * splay, leg.def.restEnd[1], leg.def.restEnd[2] * splay);
            vec3.transformQuat(_dir, _dir, creature.quaternion);
            vec3.transformQuat(_fwd, FORWARD, creature.quaternion);
            // lead the foot by a fraction of the current stride (= speed / cadence), so feet
            // plant AHEAD of the body proportionally at any pace, not lagging behind it.
            const stride = creature.cadence > 0 ? creature.speed / creature.cadence : 0;
            const lead = creature.load > 0 ? CARRY_STEP_LEAD : Math.min(stride * STEP_LEAD_FRACTION, STEP_LEAD_MAX);
            const originY = pos[1] - 0.2 * CREATURE_SCALE + HEIGHT / 2;
            const origin: Vec3 = [pos[0] + _dir[0] + _fwd[0] * lead, originY, pos[2] + _dir[2] + _fwd[2] * lead];
            const rayLength = 10 * CREATURE_SCALE;
            footCollector.reset();
            castRay(world, footCollector, footSettings, origin, [0, -1, 0], rayLength, footFilter);
            const hitDistance =
                footCollector.hit.status === CastRayStatus.COLLIDING ? footCollector.hit.fraction * rayLength : rayLength;
            vec3.set(leg.footPlacement, origin[0], origin[1] - hitDistance, origin[2]);
        } else {
            // airborne: splay legs outward (in body-yaw frame), bobbing
            vec3.set(_dir, leg.def.restEnd[0] - leg.def.attachment[0], 0, leg.def.restEnd[2] - leg.def.attachment[2]);
            vec3.transformQuat(_dir, _dir, creature.quaternion);
            vec3.normalize(_dir, _dir);
            vec3.scale(_dir, _dir, leg.def.length * 1.2);
            vec3.add(leg.footPlacement, pos, _dir);
            leg.footPlacement[1] += Math.sin(performance.now() / 100 + leg.def.phaseOffset) * 0.5 * CREATURE_SCALE;
            const vy = creature.body.motionProperties.linearVelocity[1];
            leg.footPlacement[1] += remapClamp(vy, -2, 2, 0.5, -0.5) * CREATURE_SCALE;
        }
    }
}

function stepping(creature: Creature, dt: number): void {
    for (const leg of creature.legs) {
        if (!creature.grounded) {
            leg.stepping = false;
            vec3.copy(leg.goal, leg.footPlacement);
            vec3.lerp(leg.current, leg.current, leg.goal, dt * 10);
            continue;
        }

        // detect this leg's once-per-cycle trigger as a phase wrap (robust to big
        // per-frame phase steps at sprint cadence — a window check would miss them).
        const legPhase = (creature.stepCycleTime + leg.def.phaseOffset) % 1;
        const wrapped = legPhase < leg.lastPhase;
        leg.lastPhase = legPhase;

        if (leg.stepping) {
            // swing takes STEP_DURATION_FRAC of a gait cycle, regardless of speed
            leg.stepProgress += (dt * creature.cadence) / STEP_DURATION_FRAC;
            if (leg.stepProgress >= 1) {
                leg.stepProgress = 1;
                leg.stepping = false;
            }
        } else if (wrapped) {
            // new cycle for this leg → step, planting at the anticipated spot.
            // (legs are offset half a cycle apart → they alternate)
            leg.stepping = true;
            leg.stepProgress = 0;
            vec3.copy(leg.goal, leg.footPlacement);
        }

        if (leg.stepping) {
            // chase the LIVE anticipated landing spot (which leads the moving body),
            // so the foot lands ahead — not at a stale, already-behind snapshot.
            vec3.copy(leg.goal, leg.footPlacement);
            vec3.lerp(leg.current, leg.current, leg.goal, leg.stepProgress);
            const eased = ease(leg.stepProgress);
            // carried → feet barely lift (dragging, struggling)
            const arc = creature.load > 0 ? STEP_ARC_HEIGHT * CARRY_ARC_MULT : STEP_ARC_HEIGHT;
            if (eased > 0 && eased < 1) leg.current[1] += Math.sin(eased * Math.PI) * arc;
        }
    }
}

// Solve the chain to targetLocal. When reset is true, the chain is first
// re-straightened toward restEnd (consistent bend bias — good for legs whose
// targets jump around). When false, FABRIK warm-starts from the current pose
// for temporal coherence (no elbow-fold flips) — used for the idle arms.
function solveLimb(limb: LimbState, targetLocal: Vec3, reset: boolean, iterations: number): void {
    const def = limb.def;

    if (reset) {
        const segmentLength = def.length / def.segments;
        vec3.sub(_dir, def.restEnd, def.attachment);
        vec3.normalize(_dir, _dir);
        vec3.scale(_dir, _dir, segmentLength);

        for (let i = 0; i < limb.chain.bones.length; i++) {
            const b = limb.chain.bones[i];
            const start = i === 0 ? def.attachment : limb.chain.bones[i - 1].end;
            b.start[0] = start[0];
            b.start[1] = start[1];
            b.start[2] = start[2];
            b.end[0] = b.start[0] + _dir[0];
            b.end[1] = b.start[1] + _dir[1];
            b.end[2] = b.start[2] + _dir[2];
        }
    }

    fabrikFixedIterations(limb.chain, def.attachment, targetLocal, iterations);
}

function solveLegs(creature: Creature): void {
    for (const leg of creature.legs) {
        worldToBodyLocal(_targetLocal, leg.current, creature);
        solveLimb(leg, _targetLocal, true, LEG_IK_ITERATIONS); // FABRIK: organic creature-leg bend
    }
}

// The idle arm-swing rest target (body-local), for arm `i`. Aims the hand a
// near-full-arm-length from the shoulder, out + down, swinging fore/aft. Keeping it
// near full extension means the long noodly arm stays taut and just POINTS — no
// chaotic folding.
function armRestTarget(creature: Creature, i: number, out: Vec3): void {
    const arm = creature.arms[i];
    const side = i === 0 ? -1 : 1;
    const swing = Math.sin((creature.armPhase + i * 0.5) * Math.PI * 2); // −1..1, arms opposite
    const speedFrac = Math.min(creature.smoothSpeed / AGENT_MAX_SPEED, 1);
    const swingAmt = ARM_SWING_AMP_BASE + ARM_SWING_AMP_GAIN * speedFrac;
    const fore = swing * swingAmt; // fore/aft, bigger when moving
    // 'U' arc: the hand lifts at the fore/aft extremes (swing²) and dips through the
    // centre — a pendulum sweep instead of a flat fore/aft line.
    const lift = ARM_U_LIFT * swing * swing * swingAmt;
    vec3.set(_dir, side * ARM_OUT, -ARM_DOWN + lift, fore);
    vec3.normalize(_dir, _dir);
    const reach = ARM_LENGTH * ARM_EXTEND;
    out[0] = arm.def.attachment[0] + _dir[0] * reach;
    out[1] = arm.def.attachment[1] + _dir[1] * reach;
    out[2] = arm.def.attachment[2] + _dir[2] * reach;
}

function solveArms(creature: Creature): void {
    for (let i = 0; i < creature.arms.length; i++) {
        const arm = creature.arms[i];
        if (arm.worldTarget) {
            // Reach a world point — into the body's (yawed) local frame for the IK.
            worldToBodyLocal(_targetLocal, arm.worldTarget, creature);
        } else {
            armRestTarget(creature, i, _targetLocal);
        }
        solveLimb(arm, _targetLocal, false, ARM_IK_ITERATIONS); // warm-start from current pose → smooth, no fold-flip
    }
}

// Googly pupil: a damped pendulum in the eye's 2D plane (≈ world XY, eyes face
// +Z). Droops down under gravity, gets flung opposite to the body's motion
// (inertia), and bounces off the eye rim. All in normalised (eye-radius) units.
function updateEye(eye: Eye, worldPos: Vec3, dt: number): void {
    if (dt <= 0) {
        vec3.copy(eye.current, worldPos);
        return;
    }

    // body motion this frame → normalised velocity (the pupil lags behind it)
    const inv = 1 / (EYE_RADIUS * dt);
    const vx = (worldPos[0] - eye.current[0]) * inv;
    const vy = (worldPos[1] - eye.current[1]) * inv;
    vec3.copy(eye.current, worldPos);

    // accumulate pupil velocity: inertia (opposite to motion) + gravity
    eye.velocity[0] += -vx * EYE_MOVE_GAIN * dt;
    eye.velocity[1] += (-vy * EYE_MOVE_GAIN - EYE_GRAVITY) * dt;

    const damp = EYE_DAMP ** (dt * 60);
    eye.velocity[0] *= damp;
    eye.velocity[1] *= damp;

    eye.local[0] += eye.velocity[0] * dt;
    eye.local[1] += eye.velocity[1] * dt;
    eye.local[2] = 0;

    // keep the pupil inside the eye, bouncing off the rim
    const dist = Math.hypot(eye.local[0], eye.local[1]);
    if (dist > EYE_MAX) {
        const nx = eye.local[0] / dist;
        const ny = eye.local[1] / dist;
        const d = eye.velocity[0] * nx + eye.velocity[1] * ny;
        eye.velocity[0] = (eye.velocity[0] - 2 * d * nx) * EYE_RESTITUTION;
        eye.velocity[1] = (eye.velocity[1] - 2 * d * ny) * EYE_RESTITUTION;
        eye.local[0] = nx * EYE_MAX;
        eye.local[1] = ny * EYE_MAX;
    }
}

/* ---------------- instance writing ---------------- */

function setInstance(mesh: THREE.BatchedMesh, id: number, position: Vec3, rotation: Quat, scale: Vec3): void {
    mat4.fromRotationTranslationScale(_m4, rotation, position, scale);
    _m4three.fromArray(_m4);
    mesh.setMatrixAt(id, _m4three);
}

function writeLimb(mesh: THREE.BatchedMesh, creature: Creature, chain: Chain, ids: number[], radius: number): void {
    for (let i = 0; i < chain.bones.length; i++) {
        const b = chain.bones[i];
        // bone midpoint (body-local) → world by the body yaw
        _mid[0] = (b.start[0] + b.end[0]) * 0.5;
        _mid[1] = (b.start[1] + b.end[1]) * 0.5;
        _mid[2] = (b.start[2] + b.end[2]) * 0.5;
        bodyToWorld(_mid, _mid, creature);
        // bone direction (body-local) → world by the body yaw
        vec3.sub(_dir, b.end, b.start);
        vec3.transformQuat(_dir, _dir, creature.quaternion);
        vec3.normalize(_dir, _dir);
        quat.rotationTo(_q, UP, _dir);
        vec3.set(_scaleV, radius, b.length, radius);
        setInstance(mesh, ids[i], _mid, _q, _scaleV);
    }
}

function writeCreature(mesh: THREE.BatchedMesh, creature: Creature): void {
    const pos = creature.position;

    // body
    vec3.set(_scaleV, BODY_RADIUS, BODY_RADIUS, BODY_RADIUS);
    setInstance(mesh, creature.bodyInstance, pos, creature.quaternion, _scaleV);

    // legs + arms
    for (let i = 0; i < creature.legs.length; i++)
        writeLimb(mesh, creature, creature.legs[i].chain, creature.legInstances[i], LEG_RADIUS);
    for (let i = 0; i < creature.arms.length; i++)
        writeLimb(mesh, creature, creature.arms[i].chain, creature.armInstances[i], ARM_RADIUS);

    // eyes — offset + facing rotated by the body yaw
    quat.mul(_eyeQuat, creature.quaternion, EYE_QUATERNION);
    for (let i = 0; i < creature.eyes.length; i++) {
        const inst = creature.eyeInstances[i];
        bodyToWorld(_eyeWorld, EYE_OFFSETS[i], creature);

        vec3.set(_scaleV, EYE_RADIUS, EYE_RADIUS, EYE_RADIUS);
        setInstance(mesh, inst.white, _eyeWorld, _eyeQuat, _scaleV);

        // iris: offset within the eye plane (jiggle) + slightly proud of the surface
        vec3.set(_iris, creature.eyes[i].local[0] * EYE_RADIUS, creature.eyes[i].local[1] * EYE_RADIUS, EYE_RADIUS * 0.15);
        vec3.transformQuat(_iris, _iris, _eyeQuat);
        vec3.add(_iris, _iris, _eyeWorld);
        vec3.set(_scaleV, IRIS_RADIUS, IRIS_RADIUS, IRIS_RADIUS);
        setInstance(mesh, inst.iris, _iris, _eyeQuat, _scaleV);
    }
}

/* ---------------- ragdoll (pointer interaction) ---------------- */

// Knock a creature over: body → dynamic, launched along `dir` with a tumble spin.
// Re-callable while ragdolling (re-kick). The behaviour drops any carried coal.
export function ragdollCreature(creature: Creature, navigation: Navigation, world: World, strength = 1): void {
    if (creature.mode !== 'ragdoll') {
        if (creature.agentId) {
            removeCrowdAgent(navigation, creature.agentId);
            creature.agentId = null;
        }
        rigidBody.setMotionType(world, creature.body, MotionType.DYNAMIC, true);
        creature.mode = 'ragdoll';
        creature.load = 0;
        setArmTarget(creature, 0, null);
        setArmTarget(creature, 1, null);
        // Seed the flail pendulums at the current rest-pose tips (no snap on entry).
        for (const limb of [...creature.legs, ...creature.arms]) {
            bodyToWorld(limb.flailPos, limb.def.restEnd, creature);
            vec3.copy(limb.flailPrev, limb.flailPos);
        }
    }
    // Pop UP with a random horizontal scatter (varied magnitude), so they launch
    // skyward and land roughly where they were instead of all piling at the back.
    // `strength` scales the whole launch (driven by pointer speed in interaction.ts).
    const angle = Math.random() * Math.PI * 2;
    const h = RAGDOLL_PUSH * (0.3 + Math.random() * 0.7) * strength;
    rigidBody.setLinearVelocity(world, creature.body, [
        Math.cos(angle) * h,
        RAGDOLL_PUSH_UP * (0.8 + Math.random() * 0.4) * strength,
        Math.sin(angle) * h,
    ]);
    const spin = RAGDOLL_SPIN * strength;
    rigidBody.setAngularVelocity(world, creature.body, [
        (Math.random() * 2 - 1) * spin,
        (Math.random() * 2 - 1) * spin,
        (Math.random() * 2 - 1) * spin,
    ]);
    creature.ragdollTimer = 0;
}

// Bat an already-ragdolling creature: ADD a velocity-scaled impulse (so it can be
// knocked around while down) rather than resetting its velocity. Capped so a fast
// sweep doesn't accumulate it into orbit.
export function kickRagdoll(creature: Creature, world: World, strength: number): void {
    const v = creature.body.motionProperties.linearVelocity;
    const angle = Math.random() * Math.PI * 2;
    const k = RAGDOLL_KICK * strength;
    let nx = v[0] + Math.cos(angle) * k;
    let nz = v[2] + Math.sin(angle) * k;
    const ny = Math.min(v[1] + RAGDOLL_KICK_UP * strength, RAGDOLL_KICK_MAX);
    const h = Math.hypot(nx, nz);
    if (h > RAGDOLL_KICK_MAX) {
        nx = (nx / h) * RAGDOLL_KICK_MAX;
        nz = (nz / h) * RAGDOLL_KICK_MAX;
    }
    rigidBody.setLinearVelocity(world, creature.body, [nx, ny, nz]);
    const spin = RAGDOLL_SPIN * RAGDOLL_KICK_SPIN * strength;
    rigidBody.setAngularVelocity(world, creature.body, [
        (Math.random() * 2 - 1) * spin,
        (Math.random() * 2 - 1) * spin,
        (Math.random() * 2 - 1) * spin,
    ]);
    creature.ragdollTimer = 0; // reset recovery so batting keeps it down
}

// Settled — begin the animated get-up: body → kinematic, captured tumbled pose
// lerps to standing (over GETUP_DURATION) before the agent re-attaches.
function startGetup(creature: Creature, navigation: Navigation, world: World, groundFilter: Filter): void {
    const snapped: Vec3 = [creature.body.position[0], creature.body.position[1], creature.body.position[2]];
    snapToNavMesh(navigation, creature.body.position, snapped); // leaves `snapped` as-is if off-mesh

    // Use the SAME ground raycast crowd uses for the standing height, so the body
    // ends the get-up exactly where driveKinematic will hold it (no snap on handover).
    const origin: Vec3 = [snapped[0], snapped[1] + GROUND_RAY_UP, snapped[2]];
    groundCollector.reset();
    castRay(world, groundCollector, groundSettings, origin, [0, -1, 0], GROUND_RAY_LEN, groundFilter);
    let groundY = snapped[1];
    if (groundCollector.hit.status === CastRayStatus.COLLIDING) {
        groundY = origin[1] - groundCollector.hit.fraction * GROUND_RAY_LEN;
    }

    rigidBody.setMotionType(world, creature.body, MotionType.KINEMATIC, true);
    vec3.copy(creature.getupFromPos, creature.body.position);
    quat.copy(creature.getupFromQuat, creature.body.quaternion);
    vec3.set(creature.getupToPos, snapped[0], groundY + HEIGHT, snapped[2]); // standing pose
    creature.mode = 'getup';
    creature.getupTimer = 0;
    creature.speed = 0;
    creature.smoothSpeed = 0;

    // Seed the arm get-up targets at their current (flailed) tips, so the get-up
    // eases them to the rest pose instead of snapping there.
    for (const arm of creature.arms) {
        vec3.copy(arm.getupLocal, arm.chain.bones[arm.chain.bones.length - 1].end);
    }
}

// Get-up finished: snap upright at the standing pose and re-attach the crowd agent.
function finishGetup(creature: Creature, navigation: Navigation): void {
    const params = makeAgentParams(AGENT_RADIUS, HEIGHT, AGENT_MAX_SPEED);
    creature.agentId = addCrowdAgent(navigation, creature.getupToPos, params);
    creature.mode = 'crowd';
    creature.quaternion[0] = 0;
    creature.quaternion[1] = 0;
    creature.quaternion[2] = 0;
    creature.quaternion[3] = 1;
    creature.grounded = false;
}

// While ragdolling: limbs hold their rest pose with a fast jitter, and the body's
// full (tumbling) orientation flings them around → flailing.
function ragdollLimbs(creature: Creature, dt: number): void {
    const g = RAGDOLL_LIMB_GRAVITY * dt * dt;
    for (const limb of [...creature.legs, ...creature.arms]) {
        const def = limb.def;
        // Joint (shoulder/hip) in world space — moves as the body tumbles + flies.
        bodyToWorld(_attachWorld, def.attachment, creature);

        // Verlet integrate the tip: carry momentum (whip/lag), sag under gravity.
        const px = limb.flailPos[0];
        const py = limb.flailPos[1];
        const pz = limb.flailPos[2];
        limb.flailPos[0] += (px - limb.flailPrev[0]) * RAGDOLL_LIMB_DAMP;
        limb.flailPos[1] += (py - limb.flailPrev[1]) * RAGDOLL_LIMB_DAMP - g;
        limb.flailPos[2] += (pz - limb.flailPrev[2]) * RAGDOLL_LIMB_DAMP;
        limb.flailPrev[0] = px;
        limb.flailPrev[1] = py;
        limb.flailPrev[2] = pz;

        // Constrain the tip to dangle within reach of the joint (pendulum length).
        const dx = limb.flailPos[0] - _attachWorld[0];
        const dy = limb.flailPos[1] - _attachWorld[1];
        const dz = limb.flailPos[2] - _attachWorld[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        const reach = def.length * RAGDOLL_LIMB_REACH;
        if (len > reach) {
            const s = reach / len;
            limb.flailPos[0] = _attachWorld[0] + dx * s;
            limb.flailPos[1] = _attachWorld[1] + dy * s;
            limb.flailPos[2] = _attachWorld[2] + dz * s;
        }

        // Bend the chain toward the world tip (FABRIK runs in body-local space).
        worldToBodyLocal(_targetLocal, limb.flailPos, creature);
        solveLimb(limb, _targetLocal, false, RAGDOLL_LIMB_ITERATIONS);
    }
}

/* ---------------- public update (split around the physics step) ---------------- */

// Set crowd-agent targets. Must run BEFORE updateCrowd so agents steer this
// frame. Phase-1 placeholder: ping-pong each creature between CLUMP and DROPOFF.
export function updateCreatureNavigation(creatures: Creatures, navigation: Navigation): void {
    for (const creature of creatures.list) {
        if (creature.mode !== 'crowd' || !creature.agentId) continue;
        if (isAgentAtTarget(navigation, creature.agentId, ARRIVE_THRESHOLD)) {
            creature.targetIndex = creature.targetIndex === 0 ? 1 : 0;
            setAgentTarget(navigation, creature.agentId, creature.targetIndex === 0 ? CLUMP : DROPOFF);
        }
    }
}

export function updateCreaturesPreStep(creatures: Creatures, navigation: Navigation, physics: Physics, dt: number): void {
    for (const creature of creatures.list) {
        if (creature.mode === 'ragdoll') {
            // tumble freely; begin the get-up once it's flailed a bit AND settled
            creature.ragdollTimer += dt;
            const v = creature.body.motionProperties.linearVelocity;
            if (creature.ragdollTimer > RAGDOLL_MIN_TIME && Math.hypot(v[0], v[1], v[2]) < RAGDOLL_SETTLE_SPEED) {
                startGetup(creature, navigation, physics.world, creatures.groundFilter);
            }
            continue;
        }
        if (creature.mode === 'getup') {
            // ease the body from its tumbled pose back to standing, then re-attach the agent
            creature.getupTimer += dt;
            const p = Math.min(creature.getupTimer / GETUP_DURATION, 1);
            const e = p * p * (3 - 2 * p); // smoothstep
            vec3.lerp(_getupPos, creature.getupFromPos, creature.getupToPos, e);
            quat.slerp(_getupQuat, creature.getupFromQuat, UPRIGHT, e);
            rigidBody.moveKinematic(creature.body, _getupPos, _getupQuat, dt);
            if (p >= 1) finishGetup(creature, navigation);
            continue;
        }
        driveKinematic(creature, physics.world, navigation, dt, creatures.groundFilter);
        // cadence rises with speed → quicker steps when running; carrying slows it (laboured)
        let cadence = STEP_CADENCE_BASE + creature.speed * STEP_CADENCE_GAIN;
        if (creature.load > 0) cadence *= CARRY_CADENCE_MULT;
        creature.cadence = cadence;
        creature.stepCycleTime = (creature.stepCycleTime + dt * cadence) % 1;
        // bob advances at the gait cadence but capped, so fast unburdened steps don't
        // make the body heave frantically.
        creature.bobPhase = (creature.bobPhase + dt * Math.min(cadence, BOB_MAX_CADENCE)) % 1;
    }
}

export function updateCreaturesPostStep(creatures: Creatures, physics: Physics, dt: number): void {
    for (const creature of creatures.list) {
        vec3.set(creature.position, creature.body.position[0], creature.body.position[1], creature.body.position[2]);

        if (creature.mode === 'ragdoll') {
            quat.copy(creature.quaternion, creature.body.quaternion); // full tumbling orientation
            ragdollLimbs(creature, dt);
            for (let i = 0; i < creature.eyes.length; i++) {
                bodyToWorld(_eyeWorld, EYE_OFFSETS[i], creature);
                updateEye(creature.eyes[i], _eyeWorld, dt);
            }
            writeCreature(creatures.mesh, creature);
            continue;
        }

        if (creature.mode === 'getup') {
            // render the righting orientation; plant the feet under the rising body
            // (lerp current→placement) so the legs reach the ground as it stands up.
            quat.copy(creature.quaternion, creature.body.quaternion);
            footPlacement(creature, physics.world, creatures.groundFilter);
            for (const leg of creature.legs) {
                vec3.lerp(leg.current, leg.current, leg.footPlacement, Math.min(dt * 12, 1));
            }
            solveLegs(creature);
            creature.smoothSpeed += (0 - creature.smoothSpeed) * Math.min(dt * ARM_SWING_SMOOTH, 1);
            creature.armPhase = (creature.armPhase + dt * ARM_SWING_FREQ_BASE) % 1;
            // Ease each arm from its flailed get-up pose toward the rest swing (no snap).
            for (let i = 0; i < creature.arms.length; i++) {
                const arm = creature.arms[i];
                armRestTarget(creature, i, _armRest);
                vec3.lerp(arm.getupLocal, arm.getupLocal, _armRest, Math.min(dt * GETUP_ARM_RATE, 1));
                solveLimb(arm, arm.getupLocal, false, ARM_IK_ITERATIONS);
            }
            for (let i = 0; i < creature.eyes.length; i++) {
                bodyToWorld(_eyeWorld, EYE_OFFSETS[i], creature);
                updateEye(creature.eyes[i], _eyeWorld, dt);
            }
            writeCreature(creatures.mesh, creature);
            continue;
        }

        footPlacement(creature, physics.world, creatures.groundFilter);
        stepping(creature, dt);
        solveLegs(creature);

        // Advance the SMOOTH arm-swing drivers (low-passed speed + accumulated phase)
        // so the swing stays stable even as the crowd velocity / cadence jitters.
        creature.smoothSpeed += (creature.speed - creature.smoothSpeed) * Math.min(dt * ARM_SWING_SMOOTH, 1);
        const armFreq = ARM_SWING_FREQ_BASE + creature.smoothSpeed * ARM_SWING_FREQ_GAIN;
        creature.armPhase = (creature.armPhase + dt * armFreq) % 1;
        solveArms(creature);

        for (let i = 0; i < creature.eyes.length; i++) {
            bodyToWorld(_eyeWorld, EYE_OFFSETS[i], creature);
            updateEye(creature.eyes[i], _eyeWorld, dt);
        }

        writeCreature(creatures.mesh, creature);
    }
}

/* ---------------- arm targeting API (for grab/carry/throw behaviour) ---------------- */

// Aim an arm's IK effector at a world point. Pass null to release back to the
// idle rest pose. The arm reaches it each frame via solveArms().
export function setArmTarget(creature: Creature, armIndex: number, worldTarget: Vec3 | null): void {
    const arm = creature.arms[armIndex];
    if (worldTarget === null) {
        arm.worldTarget = null;
    } else {
        if (!arm.worldTarget) arm.worldTarget = [0, 0, 0];
        vec3.copy(arm.worldTarget, worldTarget);
    }
}

// World point where a carried coal of the given radius is held — up near the
// head (a bit forward), but not hoisted fully overhead. In the body's yaw frame.
export function getCreatureCarryPoint(creature: Creature, radius: number, out: Vec3 = [0, 0, 0]): Vec3 {
    vec3.set(out, 0, BODY_RADIUS + radius * 0.4, 0.14 * CREATURE_SCALE);
    return bodyToWorld(out, out, creature);
}

// Cup the coal held at `center` from its lower-left / lower-right — slightly
// inside the surface and below the equator so the hands visibly grip it (offsets
// rotated into the body's yaw frame so the grip tracks the facing).
export function gripCoal(creature: Creature, center: Vec3, radius: number): void {
    vec3.set(_gripL, -radius * 0.8, -radius * 0.3, 0);
    vec3.transformQuat(_gripL, _gripL, creature.quaternion);
    _gripL[0] += center[0];
    _gripL[1] += center[1];
    _gripL[2] += center[2];
    setArmTarget(creature, 0, _gripL);

    vec3.set(_gripR, radius * 0.8, -radius * 0.3, 0);
    vec3.transformQuat(_gripR, _gripR, creature.quaternion);
    _gripR[0] += center[0];
    _gripR[1] += center[1];
    _gripR[2] += center[2];
    setArmTarget(creature, 1, _gripR);
}
