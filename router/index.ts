/**
 * Router Entry Point — Loads merged quest data, builds DAG,
 * solves zone ordering, runs per-zone solver + improvement,
 * and outputs the final guide.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Quest, Extra, GuideStep, Coord, UiMapRegion } from '../shared/types.js';
import { buildDAG, validateDAG } from './dag.js';
import { groupByZone, buildZoneConstraints, solveZoneOrder, euclidean } from './zones.js';
import { solveZoneRoute, routeToSteps } from './solver.js';
import { improve, validateRoute } from './improve.js';
import { toJSON, toLua, routeStats } from './output.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'midnight');
const RAW_DIR = join(import.meta.dirname, '..', 'data', 'raw');
const OUTPUT_DIR = join(import.meta.dirname, '..', 'data', 'midnight');

type Mode = 'full' | 'campaign' | 'campaign-key';

// Zone name → UiMapID lookup
const ZONE_IDS: Record<string, number> = {
  eversong: 2395,
  zulaman: 2437,
  harandar: 2413,
  voidstorm: 2405,
};

/**
 * Load UiMapAssignment data and build a lookup of Region bounds per UiMapID.
 * Used to convert world coordinates to normalized 0-1 map coordinates.
 */
async function loadMapRegions(): Promise<Map<number, UiMapRegion>> {
  const raw = JSON.parse(await readFile(join(RAW_DIR, 'uimapassignment.json'), 'utf-8'));
  const regions = new Map<number, UiMapRegion>();
  for (const entry of raw) {
    // Only store first (OrderIndex 0) entry per UiMapID
    if (!regions.has(entry.UiMapID) || entry.OrderIndex === 0) {
      regions.set(entry.UiMapID, {
        UiMapID: entry.UiMapID,
        Region: entry.Region,
      });
    }
  }
  return regions;
}

/**
 * Convert world coordinates to normalized 0-1 map coordinates.
 * WoW world X/Y are swapped relative to map display axes.
 */
function worldToMap(worldX: number, worldY: number, region: UiMapRegion): { mapX: number; mapY: number } | null {
  const R = region.Region;
  // R = [minX, minY, zMin, maxX, maxY, zMax]
  const mapX = (R[4] - worldY) / (R[4] - R[1]);
  const mapY = (R[3] - worldX) / (R[3] - R[0]);
  if (mapX < -0.1 || mapX > 1.1 || mapY < -0.1 || mapY > 1.1) return null;
  return { mapX: Math.max(0, Math.min(1, mapX)), mapY: Math.max(0, Math.min(1, mapY)) };
}

/**
 * Attach normalized mapX/mapY to all guide steps.
 */
function attachMapCoords(steps: GuideStep[], regions: Map<number, UiMapRegion>): void {
  let converted = 0;
  for (const step of steps) {
    const region = regions.get(step.mapId);
    if (!region) continue;
    const result = worldToMap(step.location.x, step.location.y, region);
    if (result) {
      step.mapX = result.mapX;
      step.mapY = result.mapY;
      converted++;
    }
  }
  console.log(`Map coordinates: ${converted}/${steps.length} steps converted.`);
}

function parseZoneOrder(arg: string | undefined): number[] | null {
  if (!arg) return null;
  const names = arg.toLowerCase().split(',').map(s => s.trim());
  const ids: number[] = [];
  for (const name of names) {
    const id = ZONE_IDS[name.replace(/[' -]/g, '')];
    if (!id) {
      console.error(`Unknown zone: "${name}". Valid zones: ${Object.keys(ZONE_IDS).join(', ')}`);
      process.exit(1);
    }
    ids.push(id);
  }
  return ids;
}

async function main() {
  const mode: Mode = (process.argv[2] as Mode) || 'full';
  const zoneOrderArg = process.argv[3]; // optional: "eversong,zulaman,harandar,voidstorm"
  console.log('OpenQuest — Route Optimization Engine');
  console.log(`Mode: ${mode}`);
  if (zoneOrderArg) console.log(`Zone order override: ${zoneOrderArg}`);
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
  const manualOrder = parseZoneOrder(zoneOrderArg);
  const zoneOrder = manualOrder || solveZoneOrder(zones, zonePrereqs);
  const orderLabel = manualOrder ? '(manual)' : '(auto-optimized)';
  console.log(`Zone order ${orderLabel}:`, zoneOrder.map(id => zones.get(id)?.name || id).join(' → '));
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

    // Validate (only intra-zone — cross-zone deps are handled by zone ordering)
    const routeValidation = validateRoute(improvedSteps, zone.quests);
    if (!routeValidation.valid) {
      // Filter out cross-zone violations
      const intraZoneViolations = routeValidation.violations.filter(v => !v.includes('(cross-zone)'));
      if (intraZoneViolations.length > 0) {
        console.warn(`  WARNING: ${intraZoneViolations.length} intra-zone violations:`);
        for (const v of intraZoneViolations.slice(0, 5)) {
          console.warn(`    ${v}`);
        }
      } else {
        console.log(`  Route validation passed (${routeValidation.violations.length} cross-zone deps OK).`);
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
  const chainDistance = calculateChainOrderDistance(filteredQuests);
  const optimizedDistance = calculateRouteDistance(allSteps);
  const vsNaive = naiveDistance > 0
    ? ((1 - optimizedDistance / naiveDistance) * 100).toFixed(1)
    : '0';
  const vsChain = chainDistance > 0
    ? ((1 - optimizedDistance / chainDistance) * 100).toFixed(1)
    : '0';

  console.log('=== Route Summary ===');
  const stats = routeStats(allSteps);
  console.log(`Total steps: ${stats.totalSteps}`);
  console.log(`Unique quests: ${stats.uniqueQuests}`);
  console.log(`Accepts: ${stats.accepts}, Objectives: ${stats.objectives}, Turn-ins: ${stats.turnins}`);
  console.log(`Extras: ${stats.collects} (${stats.extras.glyphs} glyphs, ${stats.extras.treasures} treasures, ${stats.extras.rares} rares)`);
  console.log(`Zones: ${stats.zones.join(', ')}`);
  console.log(`\nDistance comparison:`);
  console.log(`  Naive (quest ID order):       ${naiveDistance.toFixed(0)}`);
  console.log(`  Chain order (one chain/time):  ${chainDistance.toFixed(0)}`);
  console.log(`  Optimized route:               ${optimizedDistance.toFixed(0)}`);
  console.log(`  vs naive: ${vsNaive}%  vs chain: ${vsChain}%`);
  console.log();

  // Attach normalized map coordinates
  const mapRegions = await loadMapRegions();
  attachMapCoords(allSteps, mapRegions);

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
    chainDistance,
    optimizedDistance,
    vsNaivePct: parseFloat(vsNaive),
    vsChainPct: parseFloat(vsChain),
    mode,
    generatedAt: new Date().toISOString(),
  }, null, 2));

  console.log('Output files:');
  console.log(`  ${jsonPath}`);
  console.log(`  ${luaPath}`);
  console.log(`  ${statsPath}`);
}

function calculateNaiveDistance(quests: Quest[]): number {
  // Calculate distance of doing quests in quest ID order within each zone
  // Route: for each quest, accept → objectives → turnin, measuring all travel
  const byZone = new Map<number, Quest[]>();
  for (const q of quests) {
    if (!byZone.has(q.mapId)) byZone.set(q.mapId, []);
    byZone.get(q.mapId)!.push(q);
  }

  let dist = 0;
  for (const zoneQuests of byZone.values()) {
    const sorted = [...zoneQuests].sort((a, b) => a.id - b.id);
    let pos: Coord | null = null;

    for (const q of sorted) {
      const accept = q.acceptLocation || q.objectiveLocations[0] || q.turnInLocation;
      if (!accept) continue;

      if (pos) dist += euclidean(pos, accept);
      pos = accept;

      for (const obj of q.objectiveLocations) {
        dist += euclidean(pos!, obj);
        pos = obj;
      }

      const turnin = q.turnInLocation || accept;
      dist += euclidean(pos!, turnin);
      pos = turnin;
    }
  }
  return dist;
}

function calculateChainOrderDistance(quests: Quest[]): number {
  // Calculate distance of doing quests in quest-chain order (orderIndex within questLine)
  // This is closer to what a player would naturally do — follow each chain sequentially
  const byZone = new Map<number, Quest[]>();
  for (const q of quests) {
    if (!byZone.has(q.mapId)) byZone.set(q.mapId, []);
    byZone.get(q.mapId)!.push(q);
  }

  let dist = 0;
  for (const zoneQuests of byZone.values()) {
    // Sort by questLine then orderIndex — do one chain at a time
    const sorted = [...zoneQuests].sort((a, b) => {
      if (a.questLineId !== b.questLineId) return a.questLineId - b.questLineId;
      return a.orderIndex - b.orderIndex;
    });
    let pos: Coord | null = null;

    for (const q of sorted) {
      const accept = q.acceptLocation || q.objectiveLocations[0] || q.turnInLocation;
      if (!accept) continue;

      if (pos) dist += euclidean(pos, accept);
      pos = accept;

      for (const obj of q.objectiveLocations) {
        dist += euclidean(pos!, obj);
        pos = obj;
      }

      const turnin = q.turnInLocation || accept;
      dist += euclidean(pos!, turnin);
      pos = turnin;
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
