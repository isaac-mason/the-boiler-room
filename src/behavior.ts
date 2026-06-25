// Coal-hauling behaviour: every creature competes to grab a coal from the clump,
// carry it to the dropoff, throw it into the boiler (which flares), then repeat.
// A fresh coal respawns on the clump for each one consumed.
import { type Vec3, vec3 } from 'mathcat';
import { type Coal, type CoalSystem, carryCoal, despawnCoal, dropCoal, holdCoalAt, spawnCoal, throwCoal } from './coal';
import { AGENT_MAX_SPEED, type Creature, type Creatures, getCreatureCarryPoint, gripCoal, setArmTarget } from './creatures';
import { type Furnace, stokeFurnace } from './furnace';
import { isAgentAtTarget, type Navigation, setAgentMaxSpeed, setAgentTarget } from './navigation';
import type { Physics } from './physics';
import { BOILER, CLUMP, DROPOFF, FLOOR_Y, SPARK_ORIGIN } from './scene';
import { type Sparks, sparksBurst } from './sparks';

type TaskState = 'seek' | 'grab' | 'carry' | 'throw' | 'cooldown';
type Task = {
    state: TaskState;
    coal: Coal | null; // the coal being carried (grab/carry/throw)
    cooldownUntil: number;
    grabStart: number;
    grabFrom: Vec3;
    seekCoal: Coal | null; // the loose coal being walked toward (seek)
    seekPos: Vec3; // last position we pathed to (re-path if it rolls away)
};

export type Behavior = { tasks: Map<Creature, Task> };

export function initBehavior(): Behavior {
    return { tasks: new Map() };
}

const GRAB_RADIUS = 0.13; // must be ~on top of the coal to grab it (else it looks force-pulled)
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

// Carry speed for a coal of the given size — bigger coal, slower creature.
function carrySpeed(size: number): number {
    const t = Math.min(Math.max((size - CARRY_SIZE_MIN) / (CARRY_SIZE_MAX - CARRY_SIZE_MIN), 0), 1);
    return CARRY_SPEED_LIGHT + (CARRY_SPEED_HEAVY - CARRY_SPEED_LIGHT) * t;
}

const _carry: Vec3 = [0, 0, 0];
const _held: Vec3 = [0, 0, 0];
const _vel: Vec3 = [0, 0, 0];

const RETARGET_DIST = 0.15; // re-path to the sought coal if it has rolled this far from our target

// Nearest unclaimed (loose) coal to a point, anywhere in the room — so dropped
// coal gets collected, not just the clump pile.
function findNearestLooseCoal(coal: CoalSystem, pos: Vec3): Coal | null {
    let best: Coal | null = null;
    let bestSq = Infinity;
    for (const c of coal.list) {
        if (c.state !== 'loose') continue;
        const dx = c.body.position[0] - pos[0];
        const dy = c.body.position[1] - pos[1];
        const dz = c.body.position[2] - pos[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestSq) {
            bestSq = d;
            best = c;
        }
    }
    return best;
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
    creatures: Creatures,
    coal: CoalSystem,
    navigation: Navigation,
    physics: Physics,
    furnace: Furnace,
    sparks: Sparks,
    time: number,
): void {
    const world = physics.world;

    for (const creature of creatures.list) {
        const existing = behavior.tasks.get(creature);

        // Ragdolled / agent-less (e.g. pointer-knocked): drop any carried coal so it
        // isn't left frozen in mid-air, and reset the task for when it recovers.
        if (creature.mode !== 'crowd' || !creature.agentId) {
            if (existing?.coal && existing.coal.state === 'carried') dropCoal(world, existing.coal);
            if (existing) {
                existing.coal = null;
                existing.seekCoal = null;
                existing.state = 'seek';
            }
            creature.load = 0;
            setArmTarget(creature, 0, null);
            setArmTarget(creature, 1, null);
            continue;
        }

        let task = existing;
        if (!task) {
            task = {
                state: 'seek',
                coal: null,
                cooldownUntil: 0,
                grabStart: 0,
                grabFrom: [0, 0, 0],
                seekCoal: null,
                seekPos: [0, 0, 0],
            };
            behavior.tasks.set(creature, task);
        }

        switch (task.state) {
            case 'seek': {
                // walk to the NEAREST loose coal anywhere (so dropped coal gets cleaned up)
                const c = findNearestLooseCoal(coal, creature.position);
                if (!c) {
                    // nothing loose — wait near the clump where coal spawns
                    if (task.seekCoal) {
                        task.seekCoal = null;
                        setAgentTarget(navigation, creature.agentId, CLUMP);
                    }
                    break;
                }
                // (re)path when the target coal changes or has rolled away
                if (c !== task.seekCoal || vec3.distance(c.body.position, task.seekPos) > RETARGET_DIST) {
                    task.seekCoal = c;
                    vec3.copy(task.seekPos, c.body.position);
                    setAgentTarget(navigation, creature.agentId, c.body.position);
                }
                // close enough? grab it (carryCoal flips it to 'carried' = claimed)
                if (vec3.distance(creature.position, c.body.position) < GRAB_RADIUS) {
                    carryCoal(world, c);
                    task.coal = c;
                    task.seekCoal = null;
                    task.grabFrom[0] = c.body.position[0];
                    task.grabFrom[1] = c.body.position[1];
                    task.grabFrom[2] = c.body.position[2];
                    task.grabStart = time;
                    task.state = 'grab';
                    setAgentMaxSpeed(navigation, creature.agentId, carrySpeed(c.size)); // heavier = slower
                    creature.load = c.size; // burdened → struggling gait
                }
                break;
            }
            case 'grab': {
                // animate the lift: arms + coal travel from the ground up to overhead,
                // then start carrying to the dropoff.
                const c = task.coal;
                if (c?.state !== 'carried') {
                    setArmTarget(creature, 0, null);
                    setArmTarget(creature, 1, null);
                    task.coal = null;
                    task.seekCoal = null;
                    task.state = 'seek';
                    setAgentTarget(navigation, creature.agentId, CLUMP);
                    setAgentMaxSpeed(navigation, creature.agentId, AGENT_MAX_SPEED);
                    creature.load = 0;
                    break;
                }
                getCreatureCarryPoint(creature, c.radius, _carry);
                const p = Math.min((time - task.grabStart) / GRAB_DURATION, 1);
                const e = p * p * (3 - 2 * p); // smoothstep ease
                vec3.lerp(_held, task.grabFrom, _carry, e);
                holdCoalAt(world, c, _held, creature.quaternion);
                gripCoal(creature, _held, c.radius);
                if (p >= 1) {
                    task.state = 'carry';
                    setAgentTarget(navigation, creature.agentId, DROPOFF);
                }
                break;
            }
            case 'carry': {
                const c = task.coal;
                if (c?.state !== 'carried') {
                    setArmTarget(creature, 0, null);
                    setArmTarget(creature, 1, null);
                    task.coal = null;
                    task.seekCoal = null;
                    task.state = 'seek';
                    setAgentTarget(navigation, creature.agentId, CLUMP);
                    setAgentMaxSpeed(navigation, creature.agentId, AGENT_MAX_SPEED);
                    creature.load = 0;
                    break;
                }
                getCreatureCarryPoint(creature, c.radius, _carry);
                holdCoalAt(world, c, _carry, creature.quaternion);
                gripCoal(creature, _carry, c.radius);
                if (isAgentAtTarget(navigation, creature.agentId, ARRIVE)) {
                    task.state = 'throw';
                }
                break;
            }
            case 'throw': {
                const c = task.coal;
                setArmTarget(creature, 0, null);
                setArmTarget(creature, 1, null);
                if (c) {
                    getCreatureCarryPoint(creature, c.radius, _carry);
                    computeThrow(_carry, BOILER, _vel);
                    throwCoal(world, c, _vel);
                }
                task.coal = null;
                task.state = 'cooldown';
                task.cooldownUntil = time + COOLDOWN;
                setAgentTarget(navigation, creature.agentId, CLUMP);
                setAgentMaxSpeed(navigation, creature.agentId, AGENT_MAX_SPEED); // hands free → full speed
                creature.load = 0;
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
                stokeFurnace(furnace, 1); // the shared "fire is hot" signal — all VFX read it
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
