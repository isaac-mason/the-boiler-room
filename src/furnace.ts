import * as THREE from 'three';

// Single source of truth for "how active is the furnace right now" — the shared
// signal every visual system reads, so lighting, heat shimmer, dust and embers
// all swell together when a coal is thrown in. Two channels:
//
//   intensity — sustained 0..1 level (the "slider"). Rises when stoked, decays
//               slowly. Drives baseline brightness / shimmer / dust glow.
//   pulse     — sharp 0..1 transient that spikes the instant a coal lands and
//               decays fast. Lets systems react to the *blast* itself, layered on
//               top of the sustained level.

export type Furnace = {
    /** Raw accumulated stoke energy; decays slowly. Feeds `intensity`. */
    fuel: number;
    /** Smoothed sustained activity: 0 = resting … 1 = roaring. The shared slider. */
    intensity: number;
    /** Sharp blast transient, 0..1 — spikes on stoke, decays fast. */
    pulse: number;
    /** Debug override: when set, forces `intensity` to this value (ignores fuel). */
    override: number | null;
};

const FUEL_MAX = 2.5; // ceiling on stored fuel (sustained level can't run away)
const FUEL_RELEASE = 0.985; // per-60fps-frame fuel decay — slow, so the swell sustains
const INTENSITY_SMOOTH = 0.12; // per-60fps-frame attack toward fuel (quick swell, eased)
const PULSE_DECAY = 0.86; // per-60fps-frame pulse decay — fast, a blast lasts ~0.3s

export function initFurnace(): Furnace {
    return { fuel: 0, intensity: 0, pulse: 0, override: null };
}

// Stoke the fire when a coal is consumed — `amount` scales the fuel added
// (1 = a standard lump). Every stoke also kicks the blast pulse to full.
export function stokeFurnace(furnace: Furnace, amount = 1): void {
    furnace.fuel = Math.min(furnace.fuel + amount, FUEL_MAX);
    furnace.pulse = 1;
}

// Advance the signal. The per-frame rates are dt-scaled so the feel is identical
// at any framerate (they were tuned at 60fps).
export function updateFurnace(furnace: Furnace, dt: number): void {
    const frames = dt * 60;

    furnace.fuel *= FUEL_RELEASE ** frames;
    const attack = 1 - (1 - INTENSITY_SMOOTH) ** frames;
    furnace.intensity += (furnace.fuel - furnace.intensity) * attack;
    furnace.pulse *= PULSE_DECAY ** frames;

    if (furnace.override !== null) furnace.intensity = furnace.override;
}

// The combined "felt heat" (0..1) for systems that want one number: sustained
// intensity plus a dab of the blast pulse.
export function furnaceHeat(furnace: Furnace, pulseKick = 0.6): number {
    return THREE.MathUtils.clamp(furnace.intensity + furnace.pulse * pulseKick, 0, 1);
}
