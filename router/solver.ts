/**
 * Per-Zone Route Solver — Builds an optimized quest route within a zone
 * using topological sort with nearest-neighbor priority, turn-in batching,
 * and cheapest insertion for extras.
 */

import type { Quest, Extra, Coord, GuideStep } from '../shared/types.js';
import { euclidean } from './zones.js';

interface RouteNode {
  type: 'accept' | 'objective' | 'turnin' | 'collect';
  questId?: number;
  questTitle?: string;
  location: Coord;
  description: string;
  extraType?: 'glyph' | 'treasure' | 'rare';
}

/**
 * Modified Kahn's algorithm with nearest-neighbor priority.
 * Maintains a set of "available" quests (all prereqs done) and always
 * picks the one closest to the current position.
 */
export function solveZoneRoute(
  quests: Quest[],
  extras: Extra[],
  startPosition?: Coord,
): RouteNode[] {
  if (quests.length === 0) return [];

  const questMap = new Map<number, Quest>();
  for (const q of quests) questMap.set(q.id, q);

  // Only consider prerequisites that are within this zone's quest set
  const localQuestIds = new Set(quests.map(q => q.id));
  const inDegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();

  for (const q of quests) {
    const localPrereqs = q.prerequisites.filter(p => localQuestIds.has(p));
    inDegree.set(q.id, localPrereqs.length);

    for (const prereq of localPrereqs) {
      if (!dependents.has(prereq)) dependents.set(prereq, []);
      dependents.get(prereq)!.push(q.id);
    }
  }

  // Step 1: Build backbone route using topo-sort + nearest-neighbor
  const available = new Set<number>();
  for (const q of quests) {
    if ((inDegree.get(q.id) || 0) === 0) {
      available.add(q.id);
    }
  }

  const route: RouteNode[] = [];
  const completed = new Set<number>();
  let currentPos: Coord = startPosition || quests[0].acceptLocation || { x: 0, y: 0, mapId: 0 };

  while (available.size > 0) {
    // Pick nearest available quest (by accept location)
    let bestId = -1;
    let bestDist = Infinity;

    for (const qid of available) {
      const q = questMap.get(qid)!;
      const loc = q.acceptLocation || q.objectiveLocations[0] || currentPos;
      const dist = euclidean(currentPos, loc);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = qid;
      }
    }

    if (bestId === -1) break;

    const quest = questMap.get(bestId)!;
    available.delete(bestId);

    // Step 1a: Check for nearby quests we can batch-accept
    const batchAccept = [quest];
    const BATCH_RADIUS = 50; // cluster radius for batching

    if (quest.acceptLocation) {
      for (const qid of available) {
        const q = questMap.get(qid)!;
        if (q.acceptLocation && euclidean(quest.acceptLocation, q.acceptLocation) < BATCH_RADIUS) {
          batchAccept.push(q);
        }
      }
    }

    // Accept all batched quests
    for (const bq of batchAccept) {
      if (bq.id !== bestId) available.delete(bq.id);

      if (bq.acceptLocation) {
        route.push({
          type: 'accept',
          questId: bq.id,
          questTitle: bq.title,
          location: bq.acceptLocation,
          description: `Accept: ${bq.title}`,
        });
        currentPos = bq.acceptLocation;
      }
    }

    // Do objectives for all batched quests (ordered by proximity)
    const allObjectiveNodes: RouteNode[] = [];
    for (const bq of batchAccept) {
      for (const loc of bq.objectiveLocations) {
        allObjectiveNodes.push({
          type: 'objective',
          questId: bq.id,
          questTitle: bq.title,
          location: loc,
          description: `Complete objective: ${bq.title}`,
        });
      }
    }

    // Sort objective nodes by nearest-neighbor from current position
    const remaining = [...allObjectiveNodes];
    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = euclidean(currentPos, remaining[i].location);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      const node = remaining.splice(nearestIdx, 1)[0];
      route.push(node);
      currentPos = node.location;
    }

    // Step 1b: Check for turn-in batching
    const batchTurnin: Quest[] = [];
    for (const bq of batchAccept) {
      if (bq.turnInLocation) {
        batchTurnin.push(bq);
      }
    }

    // Sort turn-ins by proximity and add them
    batchTurnin.sort((a, b) => {
      const da = euclidean(currentPos, a.turnInLocation!);
      const db = euclidean(currentPos, b.turnInLocation!);
      return da - db;
    });

    for (const bq of batchTurnin) {
      route.push({
        type: 'turnin',
        questId: bq.id,
        questTitle: bq.title,
        location: bq.turnInLocation!,
        description: `Turn in: ${bq.title}`,
      });
      currentPos = bq.turnInLocation!;
    }

    // Mark all batched quests as completed and unlock dependents
    for (const bq of batchAccept) {
      completed.add(bq.id);
      const deps = dependents.get(bq.id) || [];
      for (const depId of deps) {
        const newDeg = (inDegree.get(depId) || 1) - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0 && !completed.has(depId)) {
          available.add(depId);
        }
      }
    }
  }

  // Step 3: Insert extras using cheapest insertion
  if (extras.length > 0) {
    insertExtras(route, extras);
  }

  return route;
}

/**
 * Cheapest insertion heuristic for extras (glyphs, treasures, rares).
 * For each extra, find the route leg where inserting it adds minimum distance.
 */
function insertExtras(route: RouteNode[], extras: Extra[]): void {
  for (const extra of extras) {
    const extraLoc = extra.location;
    let bestIdx = route.length; // default: append at end
    let bestCost = Infinity;

    for (let i = 0; i <= route.length; i++) {
      const prev = i > 0 ? route[i - 1].location : (route[0]?.location || extraLoc);
      const next = i < route.length ? route[i].location : (route[route.length - 1]?.location || extraLoc);

      // Cost of inserting: dist(prev, extra) + dist(extra, next) - dist(prev, next)
      const originalDist = i > 0 && i < route.length ? euclidean(prev, next) : 0;
      const newDist = euclidean(prev, extraLoc) + euclidean(extraLoc, next);
      const insertionCost = newDist - originalDist;

      if (insertionCost < bestCost) {
        bestCost = insertionCost;
        bestIdx = i;
      }
    }

    const node: RouteNode = {
      type: 'collect',
      location: extraLoc,
      description: `Collect ${extra.type}: ${extra.name}`,
      extraType: extra.type,
    };

    route.splice(bestIdx, 0, node);
  }
}

/**
 * Convert RouteNode[] to GuideStep[] with step numbers and zone info.
 */
export function routeToSteps(
  route: RouteNode[],
  zone: string,
  mapId: number,
  startStep: number = 1,
): GuideStep[] {
  return route.map((node, i) => ({
    stepNumber: startStep + i,
    action: node.type,
    questId: node.questId,
    questTitle: node.questTitle,
    description: node.description,
    location: node.location,
    mapId: node.location.mapId || mapId,
    zone,
    extraType: node.extraType,
  }));
}
