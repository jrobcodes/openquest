/**
 * Quest Dependency DAG — Builds and validates a directed acyclic graph
 * from quest prerequisite relationships.
 */

import type { Quest, DAG, DAGNode } from '../shared/types.js';

/**
 * Build a DAG from quest prerequisite relationships.
 * Each quest's prerequisites[] field defines incoming edges.
 */
export function buildDAG(quests: Quest[]): DAG {
  const nodes = new Map<number, DAGNode>();
  const questMap = new Map<number, Quest>();

  for (const q of quests) {
    questMap.set(q.id, q);
  }

  // Create nodes for all quests
  for (const q of quests) {
    nodes.set(q.id, {
      questId: q.id,
      prerequisites: [...q.prerequisites],
      dependents: [],
      questLineId: q.questLineId,
      orderIndex: q.orderIndex,
    });
  }

  // Build dependent edges (reverse of prerequisites)
  for (const q of quests) {
    for (const prereqId of q.prerequisites) {
      const prereqNode = nodes.get(prereqId);
      if (prereqNode) {
        prereqNode.dependents.push(q.id);
      }
      // If prereq isn't in our quest set, it's an external dependency — ignore
    }
  }

  // Find roots (no prerequisites, or all prerequisites are external)
  const questIds = new Set(quests.map(q => q.id));
  const roots: number[] = [];
  for (const [id, node] of nodes) {
    const internalPrereqs = node.prerequisites.filter(p => questIds.has(p));
    if (internalPrereqs.length === 0) {
      roots.push(id);
    }
  }

  return { nodes, roots };
}

/**
 * Validate the DAG is acyclic. Returns list of quest IDs in any cycles found.
 * Uses Kahn's algorithm — if not all nodes are processed, there's a cycle.
 */
export function validateDAG(dag: DAG): { valid: boolean; cycleNodes: number[] } {
  const inDegree = new Map<number, number>();
  const questIds = new Set(dag.nodes.keys());

  // Calculate in-degree (only counting internal edges)
  for (const [id, node] of dag.nodes) {
    const internalPrereqs = node.prerequisites.filter(p => questIds.has(p));
    inDegree.set(id, internalPrereqs.length);
  }

  // Start with all zero in-degree nodes
  const queue: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const processed = new Set<number>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    processed.add(current);

    const node = dag.nodes.get(current)!;
    for (const depId of node.dependents) {
      if (!questIds.has(depId)) continue;
      const newDeg = (inDegree.get(depId) || 0) - 1;
      inDegree.set(depId, newDeg);
      if (newDeg === 0) {
        queue.push(depId);
      }
    }
  }

  const cycleNodes = [...questIds].filter(id => !processed.has(id));
  return { valid: cycleNodes.length === 0, cycleNodes };
}

/**
 * Get all quests in topological order (any valid ordering).
 */
export function topologicalSort(dag: DAG): number[] {
  const questIds = new Set(dag.nodes.keys());
  const inDegree = new Map<number, number>();

  for (const [id, node] of dag.nodes) {
    const internalPrereqs = node.prerequisites.filter(p => questIds.has(p));
    inDegree.set(id, internalPrereqs.length);
  }

  const queue: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    const node = dag.nodes.get(current)!;
    for (const depId of node.dependents) {
      if (!questIds.has(depId)) continue;
      const newDeg = (inDegree.get(depId) || 0) - 1;
      inDegree.set(depId, newDeg);
      if (newDeg === 0) queue.push(depId);
    }
  }

  return order;
}

/**
 * Find cross-zone edges: prerequisite relationships that span different zones.
 */
export function findCrossZoneEdges(
  dag: DAG,
  questMap: Map<number, Quest>,
): { from: number; to: number; fromZone: string; toZone: string }[] {
  const edges: { from: number; to: number; fromZone: string; toZone: string }[] = [];

  for (const [id, node] of dag.nodes) {
    const quest = questMap.get(id);
    if (!quest) continue;

    for (const prereqId of node.prerequisites) {
      const prereq = questMap.get(prereqId);
      if (!prereq) continue;

      if (quest.zone !== prereq.zone) {
        edges.push({
          from: prereqId,
          to: id,
          fromZone: prereq.zone,
          toZone: quest.zone,
        });
      }
    }
  }

  return edges;
}
