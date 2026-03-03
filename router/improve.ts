/**
 * SOP-3-Exchange Local Search — Improves route quality while
 * respecting quest precedence constraints and intra-quest step ordering.
 */

import type { GuideStep, Quest } from '../shared/types.js';
import { euclidean } from './zones.js';

/**
 * Calculate total route distance.
 */
function totalDistance(steps: GuideStep[]): number {
  let dist = 0;
  for (let i = 1; i < steps.length; i++) {
    dist += euclidean(steps[i - 1].location, steps[i].location);
  }
  return dist;
}

/**
 * Validate that a candidate route satisfies all constraints:
 * 1. Inter-quest prerequisites: accept of quest B comes after turnin of prereq A
 * 2. Intra-quest ordering: for each quest, accept < objectives < turnin in step order
 */
function isValidRoute(
  steps: GuideStep[],
  questPrereqs: Map<number, Set<number>>,
): boolean {
  const completedQuests = new Set<number>();
  const acceptedQuests = new Set<number>();
  const questObjDone = new Set<number>(); // quests whose objectives have all appeared

  // Track per-quest step ordering: accept must come before objectives, which must come before turnin
  let lastQuestAction = new Map<number, string>(); // questId → last action seen

  for (const step of steps) {
    if (!step.questId) continue;
    const qid = step.questId;
    const prev = lastQuestAction.get(qid);

    if (step.action === 'accept') {
      // Check inter-quest prereqs
      const prereqs = questPrereqs.get(qid);
      if (prereqs) {
        for (const prereq of prereqs) {
          if (!completedQuests.has(prereq)) return false;
        }
      }
      // Accept must be first action for this quest
      if (prev) return false; // already saw something for this quest
      acceptedQuests.add(qid);
    } else if (step.action === 'objective') {
      // Must have already accepted
      if (!acceptedQuests.has(qid)) return false;
      // Must not have already turned in
      if (completedQuests.has(qid)) return false;
    } else if (step.action === 'turnin') {
      // Must have already accepted
      if (!acceptedQuests.has(qid)) return false;
      // Must not have already turned in
      if (completedQuests.has(qid)) return false;
      completedQuests.add(qid);
    }

    lastQuestAction.set(qid, step.action);
  }

  return true;
}

/**
 * Or-opt local search: try relocating contiguous segments of quest steps
 * to different positions, accepting only moves that improve distance
 * and maintain all constraints.
 *
 * Only relocates complete "quest blocks" (all steps for a single quest together)
 * to preserve intra-quest ordering.
 */
export function improve(
  steps: GuideStep[],
  quests: Quest[],
  maxPasses: number = 5,
): GuideStep[] {
  const questPrereqs = new Map<number, Set<number>>();
  for (const q of quests) {
    if (q.prerequisites.length > 0) {
      questPrereqs.set(q.id, new Set(q.prerequisites));
    }
  }

  let improved = [...steps];
  let bestDist = totalDistance(improved);

  // Identify quest blocks: contiguous ranges of steps for the same quest
  function findQuestBlocks(route: GuideStep[]): { questId: number; start: number; end: number }[] {
    const blocks: { questId: number; start: number; end: number }[] = [];
    let i = 0;
    while (i < route.length) {
      const step = route[i];
      if (!step.questId) {
        i++;
        continue;
      }
      const qid = step.questId;
      const start = i;
      while (i < route.length && route[i].questId === qid) {
        i++;
      }
      blocks.push({ questId: qid, start, end: i });
    }
    return blocks;
  }

  for (let pass = 0; pass < maxPasses; pass++) {
    let anyImprovement = false;
    const blocks = findQuestBlocks(improved);

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const segLen = block.end - block.start;

      // Try relocating this quest block to each other position
      for (let targetBi = 0; targetBi < blocks.length; targetBi++) {
        if (targetBi === bi) continue;

        // Build candidate: remove block, insert at target position
        const candidate = [...improved];
        const segment = candidate.splice(block.start, segLen);

        // Adjust target index after removal
        let insertIdx = blocks[targetBi].start;
        if (targetBi > bi) {
          insertIdx -= segLen;
        }

        candidate.splice(insertIdx, 0, ...segment);

        // Check constraints
        if (!isValidRoute(candidate, questPrereqs)) continue;

        const candidateDist = totalDistance(candidate);
        if (candidateDist < bestDist - 0.01) {
          improved = candidate;
          bestDist = candidateDist;
          anyImprovement = true;
          break;
        }
      }

      if (anyImprovement) break;
    }

    if (!anyImprovement) {
      if (pass > 0) {
        console.log(`  Local search converged after ${pass + 1} passes.`);
      }
      break;
    }
  }

  // Re-number steps
  for (let i = 0; i < improved.length; i++) {
    improved[i] = { ...improved[i], stepNumber: i + 1 };
  }

  return improved;
}

/**
 * Validate that all precedence constraints are satisfied in the route.
 */
export function validateRoute(steps: GuideStep[], quests: Quest[]): {
  valid: boolean;
  violations: string[];
} {
  const questPrereqs = new Map<number, number[]>();
  const localQuestIds = new Set(quests.map(q => q.id));
  for (const q of quests) {
    if (q.prerequisites.length > 0) {
      questPrereqs.set(q.id, q.prerequisites);
    }
  }

  const violations: string[] = [];
  const completedQuests = new Set<number>();
  const acceptedQuests = new Set<number>();

  for (const step of steps) {
    if (step.action === 'accept' && step.questId) {
      const prereqs = questPrereqs.get(step.questId);
      if (prereqs) {
        for (const prereq of prereqs) {
          if (!completedQuests.has(prereq)) {
            const isCrossZone = !localQuestIds.has(prereq);
            const tag = isCrossZone ? ' (cross-zone)' : '';
            violations.push(
              `Quest ${step.questId} (${step.questTitle}) accepted before prereq ${prereq} completed (step ${step.stepNumber})${tag}`,
            );
          }
        }
      }
      acceptedQuests.add(step.questId);
    }
    if (step.action === 'objective' && step.questId) {
      if (!acceptedQuests.has(step.questId)) {
        violations.push(
          `Quest ${step.questId} (${step.questTitle}) objective before accept (step ${step.stepNumber})`,
        );
      }
    }
    if (step.action === 'turnin' && step.questId) {
      if (!acceptedQuests.has(step.questId)) {
        violations.push(
          `Quest ${step.questId} (${step.questTitle}) turnin before accept (step ${step.stepNumber})`,
        );
      }
      completedQuests.add(step.questId);
    }
  }

  return { valid: violations.length === 0, violations };
}
