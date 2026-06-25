/**
 * Build a solo navmesh from the Spark collider GLB.
 *
 * Reads the collider .glb, extracts world-space walkable geometry via
 * gltf-transform, generates a solo navmesh with navcat, and writes the tile
 * (+ origin / tile size) to public/navmesh.json. The browser rebuilds the
 * NavMesh from that JSON in src/navigation.ts.
 *
 * Usage:
 *   pnpm build:navmesh [input.glb] [output.json]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { generateSoloNavMesh, type SoloNavMeshOptions } from 'navcat/blocks';

const INPUT = process.argv[2] ?? 'assets/BoilerRoom_collider.glb';
const OUTPUT = process.argv[3] ?? 'public/navmesh.json';

async function main() {
    /* read input mesh (world-space positions + indices) */

    console.log('Reading walkable mesh from', INPUT);
    const io = new NodeIO();
    const doc = await io.read(resolve(INPUT));
    const root = doc.getRoot();

    const positions: number[] = [];
    const indices: number[] = [];

    for (const node of root.listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;

        // Bake the node's world transform so the navmesh lines up with the splat
        // and the physics collider (which bakes transforms the same way).
        const m = node.getWorldMatrix();

        for (const prim of mesh.listPrimitives()) {
            const posAccessor = prim.getAttribute('POSITION');
            const indexAccessor = prim.getIndices();
            if (!posAccessor || !indexAccessor) continue;

            const baseVertex = positions.length / 3;

            const src = posAccessor.getArray();
            if (!src) continue;
            for (let i = 0; i < posAccessor.getCount(); i++) {
                const x = src[i * 3];
                const y = src[i * 3 + 1];
                const z = src[i * 3 + 2];
                positions.push(m[0] * x + m[4] * y + m[8] * z + m[12]);
                positions.push(m[1] * x + m[5] * y + m[9] * z + m[13]);
                positions.push(m[2] * x + m[6] * y + m[10] * z + m[14]);
            }

            const idx = indexAccessor.getArray();
            if (!idx) continue;
            for (let i = 0; i < idx.length; i++) {
                indices.push(idx[i] + baseVertex);
            }
        }
    }

    console.log(`  ${positions.length / 3} vertices, ${indices.length / 3} triangles`);

    /* generate solo navmesh */

    const cs = 0.02;
    const ch = 0.02;

    const walkableRadiusWorld = 0.2;
    const walkableClimbWorld = 0.2;
    const walkableHeightWorld = 1;

    const options: SoloNavMeshOptions = {
        cellSize: cs,
        cellHeight: ch,
        walkableRadiusVoxels: Math.ceil(walkableRadiusWorld / cs),
        walkableRadiusWorld,
        walkableClimbVoxels: Math.ceil(walkableClimbWorld / ch),
        walkableClimbWorld,
        walkableHeightVoxels: Math.ceil(walkableHeightWorld / ch),
        walkableHeightWorld,
        walkableSlopeAngleDegrees: 45,
        borderSize: 1,
        minRegionArea: 8,
        mergeRegionArea: 20,
        maxSimplificationError: 1.3,
        maxEdgeLength: 12,
        maxVerticesPerPoly: 6,
        detailSampleDistance: 6,
        detailSampleMaxError: 1,
    };

    console.log('Generating solo navmesh...');
    const { navMesh } = generateSoloNavMesh({ positions, indices }, options);

    /* write result to file */

    const tiles = Object.values(navMesh.tiles);
    const result = {
        origin: navMesh.origin,
        tileWidth: navMesh.tileWidth,
        tileHeight: navMesh.tileHeight,
        tiles,
    };

    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, JSON.stringify(result));

    console.log(`Wrote ${OUTPUT}: ${tiles.length} tiles`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
