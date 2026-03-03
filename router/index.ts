/**
 * Router Entry Point — Loads merged quest data, builds DAG,
 * solves zone ordering, runs per-zone solver + improvement,
 * and outputs the final guide.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Quest, Extra, GuideStep } from '../shared/types.js';
import { buildDAG, validateDAG } from './dag.js';
import { groupByZone, buildZoneConstraints, solveZoneOrder, euclidean } from './zones.js';
import { solveZoneRoute, routeToSteps } from './solver.js';
import { improve, validateRoute } from './improve.js';
import { toJSON, toLua, routeStats } from './output.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'midnight');
const OUTPUT_DIR = join(import.meta.dirname, '..', 'data', 'midnight');

type Mode = 'full' | 'campaign' | 'campaign-key';

async function main() {
  const mode: Mode = (process.argv[2] as Mode) || 'full';
  console.log('OpenQuest — Route Optimization Engine');
  console.log(`Mode: ${mode}`);
  console.log('=====================================\n');

  // Load data
  console.log('Loading quest data...');
  const quests: Quest[] = JSON.parse(await readFile(join(DATA_DIR, 'quests.json'), 'utf-8'));
  let extras: Extra[] = JSON.parse(await readFile(join(DATA_DIR, 'extras.json'), 'utf-8'));

  console.log(`Loaded ${quests.length} quests, ${extras.length} extras.\n`);

  // Filter by mode
  let filteredQuests = quests;
  if (mode === 'campaign') {
    filteredQuests = quests.filter(q => q.flags.isCampaign);
    extras = []; // no extras in campaign-only mode
    console.log(`Campaign mode: ${filteredQuests.length} campaign quests.`);
  } else if (mode === 'campaign-key') {
    filteredQuests = quests.filter(q => q.flags.isCampaign || q.flags.isImportant);
    extras = []; // minimal extras
    console.log(`Campaign+Key mode: ${filteredQuests.length} quests.`);
  }

  if (filteredQuests.length === 0) {
    console.log('No quests to route. Exiting.');
    return;
  }

  // Build DAG
  console.log('Building quest dependency DAG...');
  const dag = buildDAG(filteredQuests);
  console.log(`DAG: ${dag.nodes.size} nodes, ${dag.roots.length} roots.`);

  // Validate DAG
  const validation = validateDAG(dag);
  if (!validation.valid) {
    console.error(`WARNING: Found ${validation.cycleNodes.length} nodes in cycles:`);
    for (const id of validation.cycleNodes.slice(0, 10)) {
      const q = filteredQuests.find(q => q.id === id);
      console.error(`  Quest ${id}: ${q?.title || 'Unknown'}`);
    }
    console.error('Continuing anyway — cycle nodes may produce suboptimal routing.\n');
  } else {
    console.log('DAG validation passed — no cycles.\n');
  }

  // Group by zone
  const zones = groupByZone(filteredQuests, extras);
  console.log(`Zones: ${zones.size}`);
  for (const [mapId, zone] of zones) {
    console.log(`  ${zone.name} (${mapId}): ${zone.quests.length} quests, ${zone.extras.length} extras`);
  }
  console.log();

  // Solve zone ordering
  const questMap = new Map(filteredQuests.map(q => [q.id, q]));
  const zonePrereqs = buildZoneConstraints(dag, questMap);
  const zoneOrder = solveZoneOrder(zones, zonePrereqs);
  console.log('Zone order:', zoneOrder.map(id => zones.get(id)?.name || id).join(' → '));
  console.log();

  // Solve per-zone routes
  const allSteps: GuideStep[] = [];
  let stepCounter = 1;
  let currentPos: { x: number; y: number; mapId: number } | undefined;

  for (const mapId of zoneOrder) {
    const zone = zones.get(mapId);
    if (!zone) continue;

    console.log(`Solving route for ${zone.name}...`);

    const route = solveZoneRoute(zone.quests, zone.extras, currentPos);
    const steps = routeToSteps(route, zone.name, mapId, stepCounter);

    console.log(`  Raw route: ${steps.length} steps`);

    // Improve
    const improvedSteps = improve(steps, zone.quests);

    // Validate
    const routeValidation = validateRoute(improvedSteps, zone.quests);
    if (!routeValidation.valid) {
      console.warn(`  WARNING: Route validation found ${routeValidation.violations.length} violations:`);
      for (const v of routeValidation.violations.slice(0, 5)) {
        console.warn(`    ${v}`);
      }
    } else {
      console.log('  Route validation passed.');
    }

    // Re-number steps
    for (const step of improvedSteps) {
      step.stepNumber = stepCounter++;
    }

    allSteps.push(...improvedSteps);

    // Update current position for next zone
    if (improvedSteps.length > 0) {
      const last = improvedSteps[improvedSteps.length - 1];
      currentPos = last.location;
    }

    console.log(`  Final: ${improvedSteps.length} steps\n`);
  }

  // Calculate and compare distances
  const naiveDistance = calculateNaiveDistance(filteredQuests);
  const optimizedDistance = calculateRouteDistance(allSteps);
  const improvement = naiveDistance > 0
    ? ((1 - optimizedDistance / naiveDistance) * 100).toFixed(1)
    : '0';

  console.log('=== Route Summary ===');
  const stats = routeStats(allSteps);
  console.log(`Total steps: ${stats.totalSteps}`);
  console.log(`Unique quests: ${stats.uniqueQuests}`);
  console.log(`Accepts: ${stats.accepts}, Objectives: ${stats.objectives}, Turn-ins: ${stats.turnins}`);
  console.log(`Extras: ${stats.collects} (${stats.extras.glyphs} glyphs, ${stats.extras.treasures} treasures, ${stats.extras.rares} rares)`);
  console.log(`Zones: ${stats.zones.join(', ')}`);
  console.log(`\nDistance comparison:`);
  console.log(`  Naive (quest ID order): ${naiveDistance.toFixed(0)}`);
  console.log(`  Optimized route:        ${optimizedDistance.toFixed(0)}`);
  console.log(`  Improvement:            ${improvement}%`);
  console.log();

  // Output
  await mkdir(OUTPUT_DIR, { recursive: true });

  const jsonPath = join(OUTPUT_DIR, `guide-${mode}.json`);
  const luaPath = join(OUTPUT_DIR, `guide-${mode}.lua`);
  const statsPath = join(OUTPUT_DIR, `guide-${mode}-stats.json`);

  await writeFile(jsonPath, toJSON(allSteps));
  await writeFile(luaPath, toLua(allSteps));
  await writeFile(statsPath, JSON.stringify({
    ...stats,
    naiveDistance,
    optimizedDistance,
    improvementPct: parseFloat(improvement),
    mode,
    generatedAt: new Date().toISOString(),
  }, null, 2));

  console.log('Output files:');
  console.log(`  ${jsonPath}`);
  console.log(`  ${luaPath}`);
  console.log(`  ${statsPath}`);
}

function calculateNaiveDistance(quests: Quest[]): number {
  let dist = 0;
  const sorted = [...quests].sort((a, b) => a.id - b.id);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].acceptLocation || sorted[i - 1].objectiveLocations[0];
    const curr = sorted[i].acceptLocation || sorted[i].objectiveLocations[0];
    if (prev && curr) {
      dist += euclidean(prev, curr);
    }
  }
  return dist;
}

function calculateRouteDistance(steps: GuideStep[]): number {
  let dist = 0;
  for (let i = 1; i < steps.length; i++) {
    dist += euclidean(steps[i - 1].location, steps[i].location);
  }
  return dist;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
