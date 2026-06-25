import * as THREE from 'three';
import { flicker, LIGHT_ORIGIN } from './lighting';

// Floating dust as a GPU-animated THREE.Points cloud. Each mote drifts in the
// vertex shader (no per-frame CPU work, no Spark sort jitter) and brightens as it
// nears the boiler light, with the glow pulsing on the shared fire flicker.

const COUNT = 2500;

// World-space box the dust fills (roughly the boiler-room interior).
const BOUNDS_MIN = new THREE.Vector3(-2.3, 0.2, -4);
const BOUNDS_MAX = new THREE.Vector3(1, 2.5, 1);

const vertexShader = /* glsl */ `
    uniform float uTime;
    uniform vec3 uLightPos;
    uniform vec3 uLightColor;
    uniform float uLightIntensity;
    uniform float uLightRadius;
    uniform float uCoreRadius;
    uniform float uCoreBoost;
    uniform float uSize;
    uniform float uPixelRatio;
    uniform vec3 uBaseColor;
    uniform float uBaseAlpha;
    uniform float uLitAlpha;
    uniform float uSway;
    uniform float uBob;

    attribute float aSeed;

    varying vec3 vColor;
    varying float vAlpha;

    void main() {
        float phase = aSeed * 6.2831853;
        vec3 p = position;
        p.x += sin(uTime * 0.25 + phase) * uSway;
        p.y += sin(uTime * 0.30 + phase) * uBob;
        p.z += cos(uTime * 0.20 + phase) * uSway;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize * uPixelRatio / -mv.z, 1.0, 64.0);

        // brighten as the mote nears the boiler light, pulsing with the flicker
        float d = distance(p, uLightPos);
        float glow = clamp((1.0 - smoothstep(0.0, uLightRadius, d)) * uLightIntensity, 0.0, 1.0);
        // tight, intense hot core right at the boiler — sells the heat coming off it
        float core = pow(max(1.0 - d / uCoreRadius, 0.0), 2.0) * uLightIntensity;
        vColor = mix(uBaseColor, uLightColor, glow) + uLightColor * core * uCoreBoost;
        vAlpha = clamp(mix(uBaseAlpha, uLitAlpha, glow) + core * 0.4, 0.0, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    varying vec3 vColor;
    varying float vAlpha;

    void main() {
        // soft round mote (1 at centre → 0 at edge). smoothstep needs edge0<edge1,
        // so invert rather than smoothstep(0.5, 0.0, d) (which is undefined in GLSL).
        float d = length(gl_PointCoord - 0.5);
        // soft feathered mote: small core, wide falloff to the edge
        float a = (1.0 - smoothstep(0.15, 0.5, d)) * vAlpha;
        if (a < 0.002) discard;
        gl_FragColor = vec4(vColor, a);
    }
`;

export type Dust = {
    points: THREE.Points;
    material: THREE.ShaderMaterial;
};

export function initDust(): Dust {
    const size = new THREE.Vector3().subVectors(BOUNDS_MAX, BOUNDS_MIN);

    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
        positions[i * 3] = BOUNDS_MIN.x + Math.random() * size.x;
        positions[i * 3 + 1] = BOUNDS_MIN.y + Math.random() * size.y;
        positions[i * 3 + 2] = BOUNDS_MIN.z + Math.random() * size.z;
        seeds[i] = Math.random();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false, // transparent — don't occlude others, but DO get occluded (depthTest stays on)
        blending: THREE.NormalBlending,
        uniforms: {
            uTime: { value: 0 },
            uLightPos: { value: LIGHT_ORIGIN.clone() },
            uLightColor: { value: new THREE.Color(1.0, 0.62, 0.28) }, // super-bright glow at the boiler
            uLightIntensity: { value: 0 },
            uLightRadius: { value: 6 }, // falloff radius of the boiler bloom
            uCoreRadius: { value: 2.0 }, // tight hot core radius near the boiler
            uCoreBoost: { value: 1.8 }, // how much hotter/brighter the core is
            uSize: { value: 9.0 }, // base point size factor (× pixelRatio / depth)
            uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
            uBaseColor: { value: new THREE.Color(0.7, 0.58, 0.45) }, // warm ambient — full room is lit
            uBaseAlpha: { value: 0.55 }, // every mote is clearly visible
            uLitAlpha: { value: 1.0 }, // pops at the boiler
            uSway: { value: 0.06 },
            uBob: { value: 0.05 },
        },
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false; // motes drift outside the static bounds
    // The splat is transparent and writes no depth, so transparent sort order
    // between it and the dust flips with the camera. Force the dust to draw after
    // the splat for stable visibility; depthTest still lets the opaque creatures/coal
    // occlude it.
    points.renderOrder = 10;

    return { points, material };
}

// `heat` is the shared furnace intensity (0..1). Motes near the boiler glow
// brighter as the fire is stoked, on top of the per-frame flicker (~-1..1).
export function updateDust(dust: Dust, time: number, heat: number): void {
    const u = dust.material.uniforms;
    u.uTime.value = time;
    u.uLightIntensity.value = THREE.MathUtils.clamp(0.4 + heat * 0.4 + flicker(time) * 0.45, 0, 1);
}
