import { addTile, createNavMesh, type NavMesh, type NavMeshTile, type Vec3 } from 'navcat';
import { createNavMeshHelper, type DebugObject } from 'navcat/three';
import * as THREE from 'three';

const NAVMESH_URL = '/navmesh.json';

type NavMeshData = {
    origin: Vec3;
    tileWidth: number;
    tileHeight: number;
    tiles: NavMeshTile[];
};

export type Navigation = {
    navMesh: NavMesh | null;
    navMeshHelper: DebugObject | null;
};

export function initNavigation(): Navigation {
    return {
        navMesh: null,
        navMeshHelper: null,
    };
}

export async function loadNavigation(navigation: Navigation): Promise<void> {
    const res = await fetch(NAVMESH_URL);
    if (!res.ok) throw new Error(`Failed to load navmesh (${res.status})`);

    const data = (await res.json()) as NavMeshData;

    const navMesh = createNavMesh();
    navMesh.origin = data.origin;
    navMesh.tileWidth = data.tileWidth;
    navMesh.tileHeight = data.tileHeight;
    for (const tile of data.tiles) {
        addTile(navMesh, tile);
    }

    navigation.navMesh = navMesh;
}

// Show/hide the navmesh debug wireframe, building it lazily on first show.
export function updateNavigation(navigation: Navigation, scene: THREE.Scene, show: boolean): void {
    if (!navigation.navMesh) return;

    if (show && !navigation.navMeshHelper) {
        const helper = createNavMeshHelper(navigation.navMesh);

        // Draw the overlay on top of the splat instead of z-fighting with it.
        helper.object.traverse((o) => {
            if (o instanceof THREE.Mesh) {
                o.frustumCulled = false;
                o.renderOrder = 999;

                const materials = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.MeshBasicMaterial[];
                for (const mat of materials) {
                    mat.transparent = true;
                    mat.opacity = 0.5;
                    mat.depthWrite = false;
                    mat.depthTest = false;
                }
            }
        });

        scene.add(helper.object);
        navigation.navMeshHelper = helper;
    } else if (!show && navigation.navMeshHelper) {
        scene.remove(navigation.navMeshHelper.object);
        navigation.navMeshHelper.dispose();
        navigation.navMeshHelper = null;
    }
}
