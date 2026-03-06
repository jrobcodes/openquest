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
  npcName?: string;
  trackingQuestId?: number;
  level?: number;
  isCampaign?: boolean;
}

/** Get the best known location for a quest (accept > first objective > null). */
function questLocation(q: Quest): Coord | null {
  return q.acceptLocation || q.objectiveLocations[0] || q.turnInLocation || null;
}

/**
 * Modified Kahn's algorithm with nearest-neighbor priority.
 * Processes one quest at a time, emitting accept → objectives → turnin nodes.
 * After each turn-in, checks for nearby quests that can be batch-accepted.
 */
export function solveZoneRoute(
  quests: Quest[],
  extras: Extra[],
  startPosition?: Coord,
): RouteNode[] {
  if (quests.length === 0) return [];

  const questMap = new Map<number, Quest>();
  for (const q of quests) questMap.set(q.id, q);

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

  // Initialize available set (zero in-degree)
  const available = new Set<number>();
  for (const q of quests) {
    if ((inDegree.get(q.id) || 0) === 0) {
      available.add(q.id);
    }
  }

  const route: RouteNode[] = [];
  const completed = new Set<number>();
  let currentPos: Coord = startPosition ||
    questLocation(quests[0]) ||
    { x: 0, y: 0, mapId: quests[0].mapId };

  // Helper: pick nearest available quest
  function pickNearest(): number {
    let bestId = -1;
    let bestDist = Infinity;
    for (const qid of available) {
      const q = questMap.get(qid)!;
      const loc = questLocation(q) || currentPos;
      const dist = euclidean(currentPos, loc);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = qid;
      }
    }
    return bestId;
  }

  // Helper: mark quest completed and unlock dependents
  function completeQuest(questId: number): void {
    completed.add(questId);
    for (const depId of (dependents.get(questId) || [])) {
      const newDeg = (inDegree.get(depId) || 1) - 1;
      inDegree.set(depId, newDeg);
      if (newDeg === 0 && !completed.has(depId)) {
        available.add(depId);
      }
    }
  }

  // Helper: process a single quest (accept → objectives → turnin)
  function processQuest(quest: Quest): void {
    const loc = questLocation(quest);

    // Resolve accept/turnin with fallback to first objective location
    const acceptLoc = quest.acceptLocation || quest.objectiveLocations[0] || loc;
    const turnInLoc = quest.turnInLocation || quest.objectiveLocations[0] || loc;

    // Accept
    if (acceptLoc) {
      route.push({
        type: 'accept',
        questId: quest.id,
        questTitle: quest.title,
        location: acceptLoc,
        description: `Accept: ${quest.title}`,
        npcName: quest.acceptNpcName,
        level: quest.level,
        isCampaign: quest.flags.isCampaign || undefined,
      });
      currentPos = acceptLoc;
    }

    // Objectives (nearest-neighbor order)
    const objLocs = [...quest.objectiveLocations];
    while (objLocs.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < objLocs.length; i++) {
        const d = euclidean(currentPos, objLocs[i]);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      const objLoc = objLocs.splice(nearestIdx, 1)[0];
      route.push({
        type: 'objective',
        questId: quest.id,
        questTitle: quest.title,
        location: objLoc,
        description: `Complete objective: ${quest.title}`,
        level: quest.level,
        isCampaign: quest.flags.isCampaign || undefined,
      });
      currentPos = objLoc;
    }

    // Turn-in
    if (turnInLoc) {
      route.push({
        type: 'turnin',
        questId: quest.id,
        questTitle: quest.title,
        location: turnInLoc,
        description: `Turn in: ${quest.title}`,
        npcName: quest.turnInNpcName,
        level: quest.level,
        isCampaign: quest.flags.isCampaign || undefined,
      });
      currentPos = turnInLoc;
    }

    completeQuest(quest.id);
  }

  // Main loop
  while (available.size > 0) {
    const bestId = pickNearest();
    if (bestId === -1) break;

    const quest = questMap.get(bestId)!;
    available.delete(bestId);

    // Check for nearby quests we can batch-accept (same NPC cluster)
    const BATCH_RADIUS = 50;
    const batchQuests = [quest];
    const acceptLoc = quest.acceptLocation;

    if (acceptLoc) {
      // Only batch quests that are available AND nearby
      const nearbyIds: number[] = [];
      for (const qid of available) {
        const q = questMap.get(qid)!;
        if (q.acceptLocation && euclidean(acceptLoc, q.acceptLocation) < BATCH_RADIUS) {
          nearbyIds.push(qid);
        }
      }
      for (const qid of nearbyIds) {
        batchQuests.push(questMap.get(qid)!);
        available.delete(qid);
      }
    }

    if (batchQuests.length === 1) {
      // Simple case: process single quest
      processQuest(quest);
    } else {
      // Batch: accept all → do all objectives → turn in all

      // Accept all
      for (const bq of batchQuests) {
        const loc = bq.acceptLocation || bq.objectiveLocations[0] || questLocation(bq);
        if (loc) {
          route.push({
            type: 'accept',
            questId: bq.id,
            questTitle: bq.title,
            location: loc,
            description: `Accept: ${bq.title}`,
            npcName: bq.acceptNpcName,
            level: bq.level,
            isCampaign: bq.flags.isCampaign || undefined,
          });
          currentPos = loc;
        }
      }

      // Collect all objective locations with quest context
      const allObjs: { loc: Coord; quest: Quest }[] = [];
      for (const bq of batchQuests) {
        for (const loc of bq.objectiveLocations) {
          allObjs.push({ loc, quest: bq });
        }
      }

      // Nearest-neighbor through all objectives
      while (allObjs.length > 0) {
        let nearestIdx = 0;
        let nearestDist = Infinity;
        for (let i = 0; i < allObjs.length; i++) {
          const d = euclidean(currentPos, allObjs[i].loc);
          if (d < nearestDist) {
            nearestDist = d;
            nearestIdx = i;
          }
        }
        const { loc, quest: objQuest } = allObjs.splice(nearestIdx, 1)[0];
        route.push({
          type: 'objective',
          questId: objQuest.id,
          questTitle: objQuest.title,
          location: loc,
          description: `Complete objective: ${objQuest.title}`,
          level: objQuest.level,
          isCampaign: objQuest.flags.isCampaign || undefined,
        });
        currentPos = loc;
      }

      // Turn in all (nearest-neighbor order)
      const turnins = batchQuests
        .filter(bq => bq.turnInLocation || bq.objectiveLocations[0] || questLocation(bq))
        .map(bq => ({ quest: bq, loc: (bq.turnInLocation || bq.objectiveLocations[0] || questLocation(bq))! }));

      while (turnins.length > 0) {
        let nearestIdx = 0;
        let nearestDist = Infinity;
        for (let i = 0; i < turnins.length; i++) {
          const d = euclidean(currentPos, turnins[i].loc);
          if (d < nearestDist) {
            nearestDist = d;
            nearestIdx = i;
          }
        }
        const { quest: tiQuest, loc: tiLoc } = turnins.splice(nearestIdx, 1)[0];
        route.push({
          type: 'turnin',
          questId: tiQuest.id,
          questTitle: tiQuest.title,
          location: tiLoc,
          description: `Turn in: ${tiQuest.title}`,
          npcName: tiQuest.turnInNpcName,
          level: tiQuest.level,
          isCampaign: tiQuest.flags.isCampaign || undefined,
        });
        currentPos = tiLoc;
      }

      // Mark all completed
      for (const bq of batchQuests) {
        completeQuest(bq.id);
      }
    }
  }

  // Insert extras using cheapest insertion
  if (extras.length > 0) {
    insertExtras(route, extras);
  }

  return route;
}

/**
 * Cheapest insertion heuristic for extras (glyphs, treasures, rares).
 */
function insertExtras(route: RouteNode[], extras: Extra[]): void {
  for (const extra of extras) {
    const extraLoc = extra.location;
    let bestIdx = route.length;
    let bestCost = Infinity;

    for (let i = 0; i <= route.length; i++) {
      const prev = i > 0 ? route[i - 1].location : (route[0]?.location || extraLoc);
      const next = i < route.length ? route[i].location : (route[route.length - 1]?.location || extraLoc);

      const originalDist = i > 0 && i < route.length ? euclidean(prev, next) : 0;
      const newDist = euclidean(prev, extraLoc) + euclidean(extraLoc, next);
      const insertionCost = newDist - originalDist;

      if (insertionCost < bestCost) {
        bestCost = insertionCost;
        bestIdx = i;
      }
    }

    route.splice(bestIdx, 0, {
      type: 'collect',
      location: extraLoc,
      description: `Collect ${extra.type}: ${extra.name}`,
      extraType: extra.type,
      trackingQuestId: extra.trackingQuestId,
    });
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
    npcName: node.npcName,
    trackingQuestId: node.trackingQuestId,
    level: node.level,
    isCampaign: node.isCampaign,
  }));
}
