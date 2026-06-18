import { build, float32Array, object, type SchemaType, uint32Array } from 'packcat';

/**
 * Triangle-mesh collider geometry: flat world-space positions (xyz triples)
 * and triangle indices. Written by scripts/build-collider.ts, read in index.ts.
 */
export const colliderSchema = object({
    positions: float32Array(),
    indices: uint32Array(),
});

export type Collider = SchemaType<typeof colliderSchema>;

const codec = build(colliderSchema);

export const packCollider = codec.pack;
export const unpackCollider = codec.unpack;
