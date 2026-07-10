import {
    addTile,
    createFindNearestPolyResult,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    type NavMesh,
    type NavMeshTile,
    type Vec3,
} from 'navcat';
import { crowd } from 'navcat/blocks';
import { createNavMeshHelper, type DebugObject } from 'navcat/three';
import * as THREE from 'three';

import { NAVMESH_URL } from './scene';

const CROWD_MAX_AGENT_RADIUS = 0.1;
const FIND_HALF_EXTENTS: Vec3 = [0.5, 1, 0.5];

type NavMeshData = {
    origin: Vec3;
    tileWidth: number;
    tileHeight: number;
    tiles: NavMeshTile[];
};

export type Navigation = {
    navMesh: NavMesh | null;
    navMeshHelper: DebugObject | null;
    crowd: crowd.Crowd | null;
    /** Wireframe cylinders showing each crowd agent's collision capsule (debug). */
    agentDebug: THREE.Group | null;
};

export function initNavigation(): Navigation {
    return {
        navMesh: null,
        navMeshHelper: null,
        crowd: null,
        agentDebug: null,
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
    navigation.crowd = crowd.create(CROWD_MAX_AGENT_RADIUS);
    // Default placement tolerance is just maxAgentRadius (tiny) — widen it so an
    // agent snaps onto the navmesh even if its spawn point isn't exactly on a poly.
    navigation.crowd.agentPlacementHalfExtents = [1, 2, 1];
}

/* ---------------- crowd (agent steering / avoidance) ---------------- */

const _nearest = createFindNearestPolyResult();

// Default agent params for a creature of the given radius/height/speed.
export function makeAgentParams(radius: number, height: number, maxSpeed: number): crowd.AgentParams {
    return {
        radius,
        height,
        maxAcceleration: maxSpeed * 8,
        maxSpeed,
        collisionQueryRange: radius * 6,
        separationWeight: 1,
        updateFlags:
            crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
            crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
            crowd.CrowdUpdateFlags.SEPARATION |
            crowd.CrowdUpdateFlags.OPTIMIZE_VIS |
            crowd.CrowdUpdateFlags.OPTIMIZE_TOPO,
        queryFilter: DEFAULT_QUERY_FILTER,
    };
}

export function addCrowdAgent(navigation: Navigation, position: Vec3, params: crowd.AgentParams): string | null {
    if (!navigation.crowd || !navigation.navMesh) return null;
    return crowd.addAgent(navigation.crowd, navigation.navMesh, position, params);
}

export function removeCrowdAgent(navigation: Navigation, agentId: string): void {
    if (navigation.crowd) crowd.removeAgent(navigation.crowd, agentId);
}

// Snap a world point onto the nearest navmesh poly. Returns false if none is
// within the search box. Also used by recovery (re-grounding an off-mesh creature).
export function snapToNavMesh(navigation: Navigation, point: Vec3, out: Vec3): boolean {
    if (!navigation.navMesh) return false;
    findNearestPoly(_nearest, navigation.navMesh, point, FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!_nearest.success) return false;
    out[0] = _nearest.position[0];
    out[1] = _nearest.position[1];
    out[2] = _nearest.position[2];
    return true;
}

export function getAgent(navigation: Navigation, agentId: string): crowd.Agent | undefined {
    return navigation.crowd?.agents[agentId];
}

export function setAgentMaxSpeed(navigation: Navigation, agentId: string, maxSpeed: number): void {
    const agent = navigation.crowd?.agents[agentId];
    if (agent) agent.maxSpeed = maxSpeed;
}

// Send an agent toward a world point (snapped onto the navmesh).
export function setAgentTarget(navigation: Navigation, agentId: string, target: Vec3): boolean {
    if (!navigation.crowd || !navigation.navMesh) return false;
    findNearestPoly(_nearest, navigation.navMesh, target, FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!_nearest.success) return false;
    return crowd.requestMoveTarget(navigation.crowd, agentId, _nearest.nodeRef, _nearest.position);
}

export function setAgentVelocity(navigation: Navigation, agentId: string, velocity: Vec3): boolean {
    if (!navigation.crowd) return false;
    return crowd.requestMoveVelocity(navigation.crowd, agentId, velocity);
}

export function isAgentAtTarget(navigation: Navigation, agentId: string, threshold: number): boolean {
    if (!navigation.crowd) return false;
    return crowd.isAgentAtTarget(navigation.crowd, agentId, threshold);
}

export function updateCrowd(navigation: Navigation, dt: number): void {
    if (!navigation.crowd || !navigation.navMesh) return;
    crowd.update(navigation.crowd, navigation.navMesh, dt);
}

export function updateNavigation(navigation: Navigation, scene: THREE.Scene, show: boolean): void {
    if (!navigation.navMesh) return;

    if (show && !navigation.navMeshHelper) {
        const helper = createNavMeshHelper(navigation.navMesh);

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

// Shared unit cylinder (radius 1, height 1, base at y=0) + material for agent capsules.
// Each agent reuses these, scaled to its radius/height — so toggling is allocation-free
// after the first frame. Cylinder (not capsule) because agent height < 2·radius here, so
// a real capsule would collapse to a blob; the cylinder shows the detour collision volume.
let agentCapsuleGeo: THREE.CylinderGeometry | null = null;
let agentCapsuleMat: THREE.MeshBasicMaterial | null = null;

// Draw a wireframe cylinder per crowd agent sized to its radius/height, positioned with
// its base on the navmesh (the agent's feet). Toggled by the debug panel; reconciles the
// cylinder pool to the live agent set each frame while shown.
export function updateAgentDebug(navigation: Navigation, scene: THREE.Scene, show: boolean): void {
    if (!show) {
        if (navigation.agentDebug) navigation.agentDebug.visible = false;
        return;
    }
    if (!navigation.crowd) return;

    if (!navigation.agentDebug) {
        navigation.agentDebug = new THREE.Group();
        navigation.agentDebug.frustumCulled = false;
        scene.add(navigation.agentDebug);
    }
    const group = navigation.agentDebug;
    group.visible = true;

    if (!agentCapsuleGeo) {
        // Unit cylinder translated so its base sits at y=0 (agent position = feet).
        agentCapsuleGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
        agentCapsuleGeo.translate(0, 0.5, 0);
    }
    if (!agentCapsuleMat) {
        // transparent + depthTest:false + high renderOrder → draws on top of the splats.
        agentCapsuleMat = new THREE.MeshBasicMaterial({
            color: 0x00e5ff,
            wireframe: true,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            opacity: 0.7,
        });
    }

    const agents = navigation.crowd.agents;
    const seen = new Set<string>();
    for (const id in agents) {
        const agent = agents[id];
        let mesh = group.getObjectByName(id) as THREE.Mesh | undefined;
        if (!mesh) {
            mesh = new THREE.Mesh(agentCapsuleGeo, agentCapsuleMat);
            mesh.name = id;
            mesh.frustumCulled = false;
            mesh.renderOrder = 1000;
            mesh.raycast = () => {};
            group.add(mesh);
        }
        mesh.position.set(agent.position[0], agent.position[1], agent.position[2]);
        mesh.scale.set(agent.radius, agent.height, agent.radius);
        seen.add(id);
    }
    // Drop cylinders for agents that no longer exist (e.g. removed on despawn).
    for (const child of [...group.children]) {
        if (!seen.has(child.name)) group.remove(child);
    }
}
