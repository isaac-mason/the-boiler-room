import type { Vec3 } from 'mathcat';

// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; the per-effect
// "feel" constants (fire swell, shimmer strength, particle counts, …) stay in
// their own system files, since they're the look you keep regardless of geometry.

// --- Assets (served from public/; see the README's asset pipeline) ---
export const SPLAT_URL = '/Spirited Away Boiler Room-lod.rad';
export const COLLIDER_URL = '/collider.bin';
export const NAVMESH_URL = '/navmesh.json';

// --- Camera framing (world-space) ---
export const CAMERA_POSITION: Vec3 = [-0.37, 0.35, 0.16];
export const CAMERA_TARGET: Vec3 = [-0.47, 0.38, -0.59];

// --- World landmarks (world-space) ---
export const FIRE_ORIGIN: Vec3 = [-1.6, 0.09, -2.44]; // boiler fire — drives lighting, heat shimmer, dust
export const CLUMP: Vec3 = [0.82, -0.01, -1.8]; // where coal spawns + is picked up
export const DROPOFF: Vec3 = [-1.48, 0.05, -2.33]; // where mites stop to throw (close to the boiler)
export const BOILER: Vec3 = [-1.68, 0.15, -2.3]; // throw target (boiler mouth)
export const SPARK_ORIGIN: Vec3 = [-1.55, 0.2, -2.45]; // where embers fly out of the fire

// --- Physics ---
export const FLOOR_Y = -0.1; // floor / kill-plane height for coal that falls through
export const FLOOR_HALF_EXTENTS: Vec3 = [5, 0.1, 5]; // catch-plane footprint under the scene

// --- Population & scale ---
export const COAL_COUNT = 24; // lumps in the starting pile
export const MITE_COUNT = 20; // creatures hauling coal
