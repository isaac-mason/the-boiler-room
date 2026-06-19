import type { Vec3 } from 'mathcat';

// Shared world-space waypoints for the coal-hauling loop.
export const CLUMP: Vec3 = [0.82, -0.01, -1.8]; // where coal spawns + is picked up
export const DROPOFF: Vec3 = [-1.48, 0.05, -2.33]; // where mites stop to throw (close to the boiler)
export const BOILER: Vec3 = [-1.68, 0.15, -2.3]; // throw target (boiler mouth)
export const SPARK_ORIGIN: Vec3 = [-1.55, 0.2, -2.45]; // where embers fly out of the fire
