/**
 * SOP-3-Exchange Local Search — Improves route quality while
 * respecting quest precedence constraints.
 *
 * SOP = Sequential Ordering Problem (TSP with precedence constraints)
 */

import type { GuideStep, Quest, Coord } from '../shared/types.js';
import { euclidean } from './zones.js';

/**
 * Check if moving step at index `from` to index `to` would violate
 * any precedence constraints.
 */
function wouldViolatePrecedence(
  steps: GuideStep[],
  fromIdx: number,
  toIdx: number,
  questPrereqs: Map<number, Set<number>>,
): boolean {
  const step = steps[fromIdx];
  if (!step.questId) return false; // non-quest steps (extras) can move freely

  const prereqs = questPrereqs.get(step.questId);

  if (toIdx < fromIdx) {
    // Moving earlier: check that all prereqs still appear before new position
    if (prereqs) {
      for (const prereqId of prereqs) {
        // Find latest turn-in of this prereq before toIdx
        let found = false;
        for (let i = 0; i < toIdx; i++) {
          if (steps[i].questId === prereqId && steps[i].action === 'turnin') {
            found = true;
            break;
          }
        }
        if (!found) return true; // prereq not completed before new position
      }
    }
  } else {
    // Moving later: check that no dependent's accept appears between old and new position
    for (let i = fromIdx + 1; i <= toIdx; i++) {
      if (steps[i].action === 'accept' && steps[i].questId) {
        const depPrereqs = questPrereqs.get(steps[i].questId!);
        if (depPrereqs?.has(step.questId!)) {
          return true; // a dependent would start before this prereq completes
        }
      }
    }
  }

  return false;
}

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
 * SOP-3-exchange: try swapping 3 route segments.
 * We use a simplified or-opt variant: try relocating segments of 1-3 steps
 * to different positions in the route, accepting only improving moves.
 */
export function improve(
  steps: GuideStep[],
  quests: Quest[],
  maxPasses: number = 5,
): GuideStep[] {
  // Build prereq map
  const questPrereqs = new Map<number, Set<number>>();
  for (const q of quests) {
    if (q.prerequisites.length > 0) {
      questPrereqs.set(q.id, new Set(q.prerequisites));
    }
  }

  let improved = [...steps];
  let bestDist = totalDistance(improved);

  for (let pass = 0; pass < maxPasses; pass++) {
    let anyImprovement = false;

    // Try relocating individual steps and pairs
    for (let segLen = 1; segLen <= 3; segLen++) {
      for (let i = 0; i < improved.length - segLen + 1; i++) {
        const segment = improved.slice(i, i + segLen);

        // Don't break up quest accept/objective/turnin sequences for same quest
        const questIds = new Set(segment.filter(s => s.questId).map(s => s.questId!));
        if (questIds.size > 1) continue; // mixed segment, skip

        for (let j = 0; j < improved.length - segLen + 1; j++) {
          if (j === i) continue;
          if (Math.abs(j - i) <= segLen) continue; // overlapping

          // Check precedence for each step in segment
          let violates = false;
          for (let k = 0; k < segLen; k++) {
            if (wouldViolatePrecedence(improved, i + k, j + k, questPrereqs)) {
              violates = true;
              break;
            }
          }
          if (violates) continue;

          // Try the move
          const candidate = [...improved];
          const removed = candidate.splice(i, segLen);
          const insertIdx = j > i ? j - segLen : j;
          candidate.splice(insertIdx, 0, ...removed);

          const candidateDist = totalDistance(candidate);
          if (candidateDist < bestDist - 0.01) {
            improved = candidate;
            bestDist = candidateDist;
            anyImprovement = true;
            break; // restart from beginning of this segment length
          }
        }

        if (anyImprovement) break;
      }

      if (anyImprovement) break;
    }

    if (!anyImprovement) {
      console.log(`  Local search converged after ${pass + 1} passes.`);
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
  for (const q of quests) {
    if (q.prerequisites.length > 0) {
      questPrereqs.set(q.id, q.prerequisites);
    }
  }

  const violations: string[] = [];
  const completedQuests = new Set<number>();

  for (const step of steps) {
    if (step.action === 'accept' && step.questId) {
      const prereqs = questPrereqs.get(step.questId);
      if (prereqs) {
        for (const prereq of prereqs) {
          if (!completedQuests.has(prereq)) {
            violations.push(
              `Quest ${step.questId} (${step.questTitle}) accepted before prereq ${prereq} completed (step ${step.stepNumber})`,
            );
          }
        }
      }
    }
    if (step.action === 'turnin' && step.questId) {
      completedQuests.add(step.questId);
    }
  }

  return { valid: violations.length === 0, violations };
}
