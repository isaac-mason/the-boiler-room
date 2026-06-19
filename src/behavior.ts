// Coal-hauling behaviour: every mite competes to grab a coal from the clump,
// carry it to the dropoff, throw it into the boiler (which flares), then repeat.
// A fresh coal respawns on the clump for each one consumed.
import { type Vec3, vec3 } from 'mathcat';
import { type Coal, type CoalSystem, carryCoal, despawnCoal, holdCoalAt, spawnCoal, throwCoal } from './coal';
import { flareLighting, type Lighting } from './lighting';
import { AGENT_MAX_SPEED, getMiteCarryPoint, gripCoal, type Mite, type Mites, setArmTarget } from './mites';
import { isAgentAtTarget, type Navigation, setAgentMaxSpeed, setAgentTarget } from './navigation';
import { FLOOR_Y, type Physics } from './physics';
import { type Sparks, sparksBurst } from './sparks';
import { BOILER, CLUMP, DROPOFF, SPARK_ORIGIN } from './waypoints';

type TaskState = 'seek' | 'grab' | 'carry' | 'throw' | 'cooldown';
type Task = { state: TaskState; coal: Coal | null; cooldownUntil: number; grabStart: number; grabFrom: Vec3 };

export type Behavior = { tasks: Map<Mite, Task> };

export function initBehavior(): Behavior {
    return { tasks: new Map() };
}

const GRAB_RADIUS = 0.3; // how close to the clump counts as "at the pile"
const GRAB_DURATION = 0.45; // seconds to lift a coal from the ground to overhead
const ARRIVE = 0.18; // crowd "arrived at dropoff" threshold
const COOLDOWN = 0.6; // pause after a throw before seeking again
const THROW_TIME = 0.22; // projectile flight time — shorter = flatter (less vertical)
const GRAVITY = 9.81;
const BOILER_HIT_RADIUS = 0.25; // thrown coal this close to the boiler is consumed
const LANDED_SPEED = 0.05; // a thrown coal slower than this has come to rest
const RESPAWN_DROP_Y = 0.3; // drop fresh coal from this high above the clump (lands ON the pile)
const RESPAWN_JITTER = 0.05; // XZ spread so respawns don't stack in one column
// Absolute carry speeds (independent of the brisk unburdened base) — small coal
// is hauled at the light speed, the biggest coal at the heavy speed.
const CARRY_SPEED_LIGHT = 0.24;
const CARRY_SPEED_HEAVY = 0.09;
const CARRY_SIZE_MIN = 0.6; // matches coal.ts COAL_SIZE_MIN/MAX
const CARRY_SIZE_MAX = 1.8;

// Carry speed for a coal of the given size — bigger coal, slower mite.
function carrySpeed(size: number): number {
    const t = Math.min(Math.max((size - CARRY_SIZE_MIN) / (CARRY_SIZE_MAX - CARRY_SIZE_MIN), 0), 1);
    return CARRY_SPEED_LIGHT + (CARRY_SPEED_HEAVY - CARRY_SPEED_LIGHT) * t;
}

const _carry: Vec3 = [0, 0, 0];
const _held: Vec3 = [0, 0, 0];
const _vel: Vec3 = [0, 0, 0];

// An unclaimed loose coal near the clump, or null.
function findLooseCoal(coal: CoalSystem): Coal | null {
    for (const c of coal.list) {
        if (c.state !== 'loose') continue;
        if (vec3.distance(c.body.position, CLUMP) < GRAB_RADIUS + 0.3) return c;
    }
    return null;
}

// Velocity to lob from `start` to `target` over THROW_TIME seconds (gravity arc).
function computeThrow(start: Vec3, target: Vec3, out: Vec3): Vec3 {
    const t = THROW_TIME;
    out[0] = (target[0] - start[0]) / t;
    out[1] = (target[1] - start[1] + 0.5 * GRAVITY * t * t) / t;
    out[2] = (target[2] - start[2]) / t;
    return out;
}

export function updateBehavior(
    behavior: Behavior,
    mites: Mites,
    coal: CoalSystem,
    navigation: Navigation,
    physics: Physics,
    lighting: Lighting,
    sparks: Sparks,
    time: number,
): void {
    const world = physics.world;

    for (const mite of mites.list) {
        if (mite.mode !== 'crowd' || !mite.agentId) continue;

        let task = behavior.tasks.get(mite);
        if (!task) {
            task = { state: 'seek', coal: null, cooldownUntil: 0, grabStart: 0, grabFrom: [0, 0, 0] };
            behavior.tasks.set(mite, task);
            setAgentTarget(navigation, mite.agentId, CLUMP);
        }

        switch (task.state) {
            case 'seek': {
                // at the pile? grab an unclaimed coal (carryCoal flips it to 'carried' = claimed)
                if (isAgentAtTarget(navigation, mite.agentId, GRAB_RADIUS)) {
                    const c = findLooseCoal(coal);
                    if (c) {
                        carryCoal(world, c);
                        task.coal = c;
                        task.grabFrom[0] = c.body.position[0];
                        task.grabFrom[1] = c.body.position[1];
                        task.grabFrom[2] = c.body.position[2];
                        task.grabStart = time;
                        task.state = 'grab';
                        setAgentMaxSpeed(navigation, mite.agentId, carrySpeed(c.size)); // heavier = slower
                        mite.load = c.size; // burdened → struggling gait
                    }
                    // else wait at the clump for coal to (re)spawn
                }
                break;
            }
            case 'grab': {
                // animate the lift: arms + coal travel from the ground up to overhead,
                // then start carrying to the dropoff.
                const c = task.coal;
                if (c?.state !== 'carried') {
                    setArmTarget(mite, 0, null);
                    setArmTarget(mite, 1, null);
                    task.coal = null;
                    task.state = 'seek';
                    setAgentTarget(navigation, mite.agentId, CLUMP);
                    setAgentMaxSpeed(navigation, mite.agentId, AGENT_MAX_SPEED);
                    mite.load = 0;
                    break;
                }
                getMiteCarryPoint(mite, c.radius, _carry);
                const p = Math.min((time - task.grabStart) / GRAB_DURATION, 1);
                const e = p * p * (3 - 2 * p); // smoothstep ease
                vec3.lerp(_held, task.grabFrom, _carry, e);
                holdCoalAt(world, c, _held, mite.quaternion);
                gripCoal(mite, _held, c.radius);
                if (p >= 1) {
                    task.state = 'carry';
                    setAgentTarget(navigation, mite.agentId, DROPOFF);
                }
                break;
            }
            case 'carry': {
                const c = task.coal;
                if (c?.state !== 'carried') {
                    setArmTarget(mite, 0, null);
                    setArmTarget(mite, 1, null);
                    task.coal = null;
                    task.state = 'seek';
                    setAgentTarget(navigation, mite.agentId, CLUMP);
                    setAgentMaxSpeed(navigation, mite.agentId, AGENT_MAX_SPEED);
                    mite.load = 0;
                    break;
                }
                getMiteCarryPoint(mite, c.radius, _carry);
                holdCoalAt(world, c, _carry, mite.quaternion);
                gripCoal(mite, _carry, c.radius);
                if (isAgentAtTarget(navigation, mite.agentId, ARRIVE)) {
                    task.state = 'throw';
                }
                break;
            }
            case 'throw': {
                const c = task.coal;
                setArmTarget(mite, 0, null);
                setArmTarget(mite, 1, null);
                if (c) {
                    getMiteCarryPoint(mite, c.radius, _carry);
                    computeThrow(_carry, BOILER, _vel);
                    throwCoal(world, c, _vel);
                }
                task.coal = null;
                task.state = 'cooldown';
                task.cooldownUntil = time + COOLDOWN;
                setAgentTarget(navigation, mite.agentId, CLUMP);
                setAgentMaxSpeed(navigation, mite.agentId, AGENT_MAX_SPEED); // hands free → full speed
                mite.load = 0;
                break;
            }
            case 'cooldown': {
                if (time >= task.cooldownUntil) task.state = 'seek';
                break;
            }
        }
    }

    // Loop close: a thrown coal that reaches the boiler (or lands / falls through)
    // is consumed — flare the fire if it scored, and respawn a fresh lump.
    for (let i = coal.list.length - 1; i >= 0; i--) {
        const c = coal.list[i];
        if (c.state !== 'thrown') continue;

        const reached = vec3.distance(c.body.position, BOILER) < BOILER_HIT_RADIUS;
        const fell = c.body.position[1] < FLOOR_Y - 0.3;
        const v = c.body.motionProperties.linearVelocity;
        const landed = Math.hypot(v[0], v[1], v[2]) < LANDED_SPEED;

        if (reached || fell || landed) {
            if (reached) {
                flareLighting(lighting, 1);
                sparksBurst(sparks, SPARK_ORIGIN, 24); // embers fly out of the fire
            }
            despawnCoal(coal, physics, c);
            // drop the fresh coal from above so it lands ON the pile rather than
            // spawning inside it (which shoves it out violently)
            spawnCoal(coal, physics, [
                CLUMP[0] + (Math.random() * 2 - 1) * RESPAWN_JITTER,
                CLUMP[1] + RESPAWN_DROP_Y,
                CLUMP[2] + (Math.random() * 2 - 1) * RESPAWN_JITTER,
            ]);
        }
    }
}
