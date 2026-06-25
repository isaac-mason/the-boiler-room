import { dyno, type GsplatModifier, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { type Furnace, furnaceHeat } from './furnace';
import { LIGHT_ORIGIN } from './lighting';

// Heat shimmer — a Spark world-modifier. Instead of a screen-space filter, this
// jiggles the actual scene splats' world positions inside a sphere around the
// furnace: an upward-scrolling noise displacement whose strength falls off from
// the core out to the radius. The geometry itself wobbles like air over a flame,
// so it reads as "this thing is dangerously hot" from any angle.

const { dynoBlock, dynoFloat, dynoVec3, defineGsplat, unindentLines } = dyno;

// World-space radius of the hot zone around the furnace.
const RADIUS = 1.1;

// Max world-space displacement (metres) at the core. Small — shimmer is a subtle bend.
const STRENGTH = 0.012;

// World-space frequency of the wobble. Higher = finer ripples.
const SCALE = 3.4;

// Value-noise field, scrolling upward, sampled in world space.
const NOISE_GLSL = /* glsl */ `
    float heatHash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float heatNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(heatHash(i), heatHash(i + vec2(1.0, 0.0)), u.x),
            mix(heatHash(i + vec2(0.0, 1.0)), heatHash(i + vec2(1.0, 1.0)), u.x),
            u.y
        );
    }
`;

export type Heat = {
    /** The world-modifier dyno graph — assign to `splat.worldModifier`. */
    modifier: GsplatModifier;
    /** Hot-zone centre (world space). Mutate `.value` to move the furnace. */
    uOrigin: ReturnType<typeof dynoVec3>;
    /** Extra shimmer when the fire is fed — mutate `.value` (0 = resting). */
    uFed: ReturnType<typeof dynoFloat>;
};

export function initHeat(): Heat {
    const uOrigin = dynoVec3(new THREE.Vector3().copy(LIGHT_ORIGIN));
    const uRadius = dynoFloat(RADIUS);
    const uStrength = dynoFloat(STRENGTH);
    const uScale = dynoFloat(SCALE);
    const uFed = dynoFloat(0);

    const modifier = dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
        if (!gsplat) throw new Error('heat modifier: no gsplat input');

        const node = dyno.dyno({
            inTypes: {
                gsplat: dyno.Gsplat,
                origin: 'vec3',
                radius: 'float',
                strength: 'float',
                scale: 'float',
                time: 'float',
                fed: 'float',
            },
            outTypes: { gsplat: dyno.Gsplat },
            inputs: {
                gsplat,
                origin: uOrigin,
                radius: uRadius,
                strength: uStrength,
                scale: uScale,
                time: SplatMesh.dynoTime, // auto-updated by the SparkRenderer each frame
                fed: uFed,
            },
            globals: () => [defineGsplat, NOISE_GLSL],
            statements: ({ inputs, outputs }) => {
                const g = outputs.gsplat;
                return unindentLines(`
                    ${g} = ${inputs.gsplat};
                    vec3 rel = ${inputs.gsplat}.center - ${inputs.origin};
                    float dist = length(rel);
                    float mask = 1.0 - smoothstep(${inputs.radius} * 0.15, ${inputs.radius}, dist);
                    mask *= mask; // bias the heat toward the core
                    if (mask > 0.0) {
                        float t = ${inputs.time};
                        vec3 p = ${inputs.gsplat}.center * ${inputs.scale};
                        float nx = heatNoise(p.yz + vec2(0.0, -t * 1.4));
                        float ny = heatNoise(p.xz * 1.1 + vec2(-t * 1.1, t * 0.3));
                        float nz = heatNoise(p.xy * 1.3 + vec2(t * 0.2, -t * 1.9));
                        vec3 off = (vec3(nx, ny, nz) - 0.5) * 2.0;
                        off.y = abs(off.y) * 1.5; // heat rises — bias the wobble upward
                        ${g}.center = ${inputs.gsplat}.center
                            + off * ${inputs.strength} * mask * (1.0 + ${inputs.fed} * 1.5);
                    }
                `);
            },
        });

        return { gsplat: node.outputs.gsplat };
    });

    return { modifier, uOrigin, uFed };
}

// Shimmer rides the sustained intensity and surges on each blast. The generous
// pulse kick (0.9) makes a coal landing ripple the air distinctly from the glow.
export function updateHeat(heat: Heat, furnace: Furnace): void {
    heat.uFed.value = furnaceHeat(furnace, 0.9);
}
