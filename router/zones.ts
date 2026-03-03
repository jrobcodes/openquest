/**
 * Zone Decomposition — Groups quests by zone and determines optimal zone ordering.
 */

import type { Quest, Extra, ZoneInfo, ZoneTransition, Coord, DAG } from '../shared/types.js';
import { findCrossZoneEdges } from './dag.js';

export function euclidean(a: Coord, b: Coord): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Group quests and extras by zone (mapId).
 */
export function groupByZone(quests: Quest[], extras: Extra[]): Map<number, ZoneInfo> {
  const zones = new Map<number, ZoneInfo>();

  for (const q of quests) {
    if (!q.mapId) continue;
    if (!zones.has(q.mapId)) {
      zones.set(q.mapId, {
        mapId: q.mapId,
        name: q.zone,
        quests: [],
        extras: [],
      });
    }
    zones.get(q.mapId)!.quests.push(q);
  }

  for (const e of extras) {
    const mapId = e.location.mapId;
    if (!mapId) continue;
    if (!zones.has(mapId)) {
      zones.set(mapId, {
        mapId,
        name: e.zone,
        quests: [],
        extras: [],
      });
    }
    zones.get(mapId)!.extras.push(e);
  }

  return zones;
}

/**
 * Build inter-zone transition constraints from cross-zone quest dependencies.
 * If quest A (zone X) must complete before quest B (zone Y), then zone X
 * must be visited (at least partially) before zone Y.
 */
export function buildZoneConstraints(
  dag: DAG,
  questMap: Map<number, Quest>,
): Map<number, Set<number>> {
  // zonePrereqs: mapId → set of mapIds that must be visited before this zone
  const zonePrereqs = new Map<number, Set<number>>();

  const crossZoneEdges = findCrossZoneEdges(dag, questMap);
  for (const edge of crossZoneEdges) {
    const fromQuest = questMap.get(edge.from);
    const toQuest = questMap.get(edge.to);
    if (!fromQuest || !toQuest) continue;

    const fromMapId = fromQuest.mapId;
    const toMapId = toQuest.mapId;
    if (fromMapId === toMapId) continue;

    if (!zonePrereqs.has(toMapId)) {
      zonePrereqs.set(toMapId, new Set());
    }
    zonePrereqs.get(toMapId)!.add(fromMapId);
  }

  return zonePrereqs;
}

/**
 * Find the optimal zone ordering by brute-forcing all valid topological orders.
 * With only ~4 Midnight zones, this is trivially fast (max 24 permutations).
 *
 * Scoring: minimize total inter-zone travel distance (using zone centroids).
 */
export function solveZoneOrder(
  zones: Map<number, ZoneInfo>,
  zonePrereqs: Map<number, Set<number>>,
): number[] {
  const zoneIds = [...zones.keys()];
  const n = zoneIds.length;

  if (n === 0) return [];
  if (n === 1) return zoneIds;

  // Compute zone centroids
  const centroids = new Map<number, Coord>();
  for (const [mapId, zone] of zones) {
    const locs: Coord[] = [];
    for (const q of zone.quests) {
      if (q.acceptLocation) locs.push(q.acceptLocation);
    }
    if (locs.length > 0) {
      centroids.set(mapId, {
        x: locs.reduce((s, l) => s + l.x, 0) / locs.length,
        y: locs.reduce((s, l) => s + l.y, 0) / locs.length,
        mapId,
      });
    } else {
      centroids.set(mapId, { x: 0, y: 0, mapId });
    }
  }

  // Generate all permutations
  function* permutations(arr: number[]): Generator<number[]> {
    if (arr.length <= 1) {
      yield arr;
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const perm of permutations(rest)) {
        yield [arr[i], ...perm];
      }
    }
  }

  // Check if a permutation respects zone prerequisites
  function isValidOrder(order: number[]): boolean {
    const visited = new Set<number>();
    for (const mapId of order) {
      const prereqs = zonePrereqs.get(mapId);
      if (prereqs) {
        for (const prereq of prereqs) {
          if (!visited.has(prereq)) return false;
        }
      }
      visited.add(mapId);
    }
    return true;
  }

  // Score: total travel distance between consecutive zone centroids
  function scorePath(order: number[]): number {
    let dist = 0;
    for (let i = 1; i < order.length; i++) {
      const a = centroids.get(order[i - 1]);
      const b = centroids.get(order[i]);
      if (a && b) dist += euclidean(a, b);
    }
    return dist;
  }

  let bestOrder: number[] = zoneIds;
  let bestScore = Infinity;

  for (const perm of permutations(zoneIds)) {
    if (!isValidOrder(perm)) continue;
    const score = scorePath(perm);
    if (score < bestScore) {
      bestScore = score;
      bestOrder = perm;
    }
  }

  return bestOrder;
}
