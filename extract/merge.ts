/**
 * Data Merge — Combines CASC DB2 data + Blizzard API enrichment into
 * the unified Quest and Extra models for Midnight zones.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Quest, Extra, Coord, Objective, Rewards,
  RawQuestLine, RawQuestLineXQuest, RawQuestObjective,
  RawQuestPOIBlob, RawQuestPOIPoint, BlizzardQuestResponse,
} from '../shared/types.js';

const RAW_DIR = join(import.meta.dirname, '..', 'data', 'raw');
const ENRICHED_DIR = join(import.meta.dirname, '..', 'data', 'enriched');
const OUTPUT_DIR = join(import.meta.dirname, '..', 'data', 'midnight');

// Midnight zone UiMapIDs — these need to be verified from actual DB2 data
// The addon uses placeholder IDs 2369-2372; we'll try to detect them from data
// and fall back to including all quest line quests if zone filtering fails.
const MIDNIGHT_ZONE_NAMES = new Set([
  'eversong', "eversong woods",
  "zul'aman", 'zulaman', "zul'aman",
  'harandar',
  'voidstorm',
  // Sub-zones and alternates
  'silvermoon', "quel'thalas", 'ghostlands', 'sunwell', 'tranquillien',
]);

// We'll build this map from AreaPOI data
let midnightMapIds = new Set<number>();

async function loadJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

function isMidnightZone(name: string): boolean {
  const lower = name.toLowerCase();
  return [...MIDNIGHT_ZONE_NAMES].some(z => lower.includes(z));
}

async function main() {
  console.log('OpenQuest — Data Merge');
  console.log('======================\n');

  await mkdir(OUTPUT_DIR, { recursive: true });

  // Load all raw data
  console.log('Loading raw DB2 data...');
  const questLines = await loadJSON<(RawQuestLine & { _ID: number })[]>(join(RAW_DIR, 'questline.json'));
  const qlxq = await loadJSON<(RawQuestLineXQuest & { _ID: number })[]>(join(RAW_DIR, 'questlinexquest.json'));
  const objectives = await loadJSON<(RawQuestObjective & { _ID: number })[]>(join(RAW_DIR, 'questobjective.json'));
  const poiBlobs = await loadJSON<(RawQuestPOIBlob & { _ID: number })[]>(join(RAW_DIR, 'questpoiblob.json'));
  const poiPoints = await loadJSON<(RawQuestPOIPoint & { _ID: number })[]>(join(RAW_DIR, 'questpoipoint.json'));
  const areaPOIs = await loadJSON<{ _ID: number; Name?: string; Name_lang?: string; Pos?: [number, number]; UiMapID?: number; ContinentID?: number }[]>(join(RAW_DIR, 'areapoi.json'));

  // Load enriched API data
  console.log('Loading API enrichment data...');
  let apiData: Record<string, BlizzardQuestResponse> = {};
  try {
    apiData = await loadJSON<Record<string, BlizzardQuestResponse>>(join(ENRICHED_DIR, 'quests-api.json'));
  } catch {
    console.warn('No API enrichment data found. Continuing without it.');
  }

  // Build lookup maps
  console.log('Building indexes...\n');

  // QuestLine ID → name
  const questLineNames = new Map<number, string>();
  for (const ql of questLines) {
    questLineNames.set(ql._ID, ql.Name || `QuestLine_${ql._ID}`);
  }

  // QuestID → quest line entries (a quest can appear in multiple lines)
  const questToLines = new Map<number, RawQuestLineXQuest[]>();
  for (const entry of qlxq) {
    if (!questToLines.has(entry.QuestID)) {
      questToLines.set(entry.QuestID, []);
    }
    questToLines.get(entry.QuestID)!.push(entry);
  }

  // QuestLineID → sorted entries
  const lineEntries = new Map<number, RawQuestLineXQuest[]>();
  for (const entry of qlxq) {
    if (!lineEntries.has(entry.QuestLineID)) {
      lineEntries.set(entry.QuestLineID, []);
    }
    lineEntries.get(entry.QuestLineID)!.push(entry);
  }
  for (const entries of lineEntries.values()) {
    entries.sort((a, b) => a.OrderIndex - b.OrderIndex);
  }

  // QuestID → objectives
  const questObjectives = new Map<number, RawQuestObjective[]>();
  for (const obj of objectives) {
    if (!questObjectives.has(obj.QuestID)) {
      questObjectives.set(obj.QuestID, []);
    }
    questObjectives.get(obj.QuestID)!.push(obj);
  }

  // QuestID → POI blobs
  const questPOIBlobMap = new Map<number, RawQuestPOIBlob[]>();
  for (const blob of poiBlobs) {
    if (!questPOIBlobMap.has(blob.QuestID)) {
      questPOIBlobMap.set(blob.QuestID, []);
    }
    questPOIBlobMap.get(blob.QuestID)!.push(blob);
  }

  // POIBlob ID → points
  const blobPoints = new Map<number, RawQuestPOIPoint[]>();
  for (const pt of poiPoints) {
    if (!blobPoints.has(pt.QuestPOIBlobID)) {
      blobPoints.set(pt.QuestPOIBlobID, []);
    }
    blobPoints.get(pt.QuestPOIBlobID)!.push(pt);
  }

  // Detect Midnight UiMapIDs from AreaPOI names
  for (const poi of areaPOIs) {
    const name = poi.Name || poi.Name_lang || '';
    if (isMidnightZone(name) && poi.UiMapID) {
      midnightMapIds.add(poi.UiMapID);
    }
  }

  // Also detect from POI blobs — find UiMapIDs that appear in our quest data
  // We'll use a broader approach: collect all UiMapIDs from quest POI blobs
  const allUiMapIds = new Set<number>();
  for (const blob of poiBlobs) {
    if (blob.UiMapID) allUiMapIds.add(blob.UiMapID);
  }

  console.log(`Detected ${midnightMapIds.size} potential Midnight zone map IDs from AreaPOI.`);
  if (midnightMapIds.size === 0) {
    console.log('Could not auto-detect Midnight zones. Will include all quest line quests.');
  }

  // Build prerequisites from quest lines
  // Within a quest line, quest at OrderIndex N depends on quest at OrderIndex N-1
  const prerequisites = new Map<number, Set<number>>();

  for (const [_lineId, entries] of lineEntries) {
    for (let i = 1; i < entries.length; i++) {
      const current = entries[i].QuestID;
      const prev = entries[i - 1].QuestID;
      if (!prerequisites.has(current)) {
        prerequisites.set(current, new Set());
      }
      prerequisites.get(current)!.add(prev);
    }
  }

  // Helper: get centroid of POI points for a quest blob
  function getBlobCentroid(blob: RawQuestPOIBlob): Coord | null {
    const points = blobPoints.get(blob._ID);
    if (!points || points.length === 0) return null;

    const sumX = points.reduce((s, p) => s + p.X, 0);
    const sumY = points.reduce((s, p) => s + p.Y, 0);
    const sumZ = points.reduce((s, p) => s + p.Z, 0);
    const n = points.length;

    return {
      x: sumX / n,
      y: sumY / n,
      z: sumZ / n,
      mapId: blob.UiMapID || blob.MapID,
    };
  }

  // Helper: get quest locations from POI data
  function getQuestLocations(questId: number): {
    acceptLocation: Coord | null;
    turnInLocation: Coord | null;
    objectiveLocations: Coord[];
    mapId: number;
  } {
    const blobs = questPOIBlobMap.get(questId) || [];
    let acceptLocation: Coord | null = null;
    let turnInLocation: Coord | null = null;
    const objectiveLocations: Coord[] = [];
    let mapId = 0;

    for (const blob of blobs) {
      const centroid = getBlobCentroid(blob);
      if (!centroid) continue;

      if (!mapId) mapId = blob.UiMapID || blob.MapID;

      // ObjectiveIndex -1 typically means the quest giver/turn-in location
      // ObjectiveIndex 0+ are objective locations
      if (blob.ObjectiveIndex === -1 || blob.ObjectiveIndex === 255) {
        // This is usually the accept/turn-in area
        if (!acceptLocation) acceptLocation = centroid;
        else turnInLocation = centroid;
      } else {
        objectiveLocations.push(centroid);
      }
    }

    // If we only got one location from ObjectiveIndex -1, use it as both accept and turn-in
    if (acceptLocation && !turnInLocation) {
      turnInLocation = acceptLocation;
    }

    return { acceptLocation, turnInLocation, objectiveLocations, mapId };
  }

  // Helper: determine zone name from mapId
  function getZoneName(mapId: number): string {
    // Try to find from AreaPOI
    for (const poi of areaPOIs) {
      if (poi.UiMapID === mapId) {
        return poi.Name || poi.Name_lang || `Zone_${mapId}`;
      }
    }
    return `Zone_${mapId}`;
  }

  // Build Quest objects
  console.log('Building quest objects...');
  const quests: Quest[] = [];
  const processedQuestIds = new Set<number>();

  // Process all quests that appear in quest lines
  for (const [lineId, entries] of lineEntries) {
    const lineName = questLineNames.get(lineId) || `QuestLine_${lineId}`;

    for (const entry of entries) {
      if (processedQuestIds.has(entry.QuestID)) continue;
      processedQuestIds.add(entry.QuestID);

      const { acceptLocation, turnInLocation, objectiveLocations, mapId } =
        getQuestLocations(entry.QuestID);

      // Get objectives
      const rawObjs = questObjectives.get(entry.QuestID) || [];
      const objs: Objective[] = rawObjs.map(o => ({
        index: o.OrderIndex,
        type: o.Type,
        description: o.Description || '',
        amount: o.Amount,
        locations: [], // filled from POI data above via objectiveLocations
      }));

      // Get API enrichment
      const api = apiData[entry.QuestID.toString()];
      const rewards: Rewards = {};
      if (api?.rewards) {
        rewards.xp = api.rewards.experience;
        rewards.gold = api.rewards.money?.value;
        rewards.items = api.rewards.items?.map(i => ({
          id: i.item.id,
          name: i.item.name,
          quantity: i.quantity,
        }));
        rewards.reputation = api.rewards.reputations?.map(r => ({
          factionId: r.reward.id,
          factionName: r.reward.name,
          amount: r.value,
        }));
      }

      const prereqs = prerequisites.get(entry.QuestID);

      const quest: Quest = {
        id: entry.QuestID,
        title: api?.title || `Quest_${entry.QuestID}`,
        description: api?.description || '',
        questLineId: lineId,
        questLineName: lineName,
        orderIndex: entry.OrderIndex,
        zone: mapId ? getZoneName(mapId) : 'Unknown',
        mapId,
        acceptLocation,
        turnInLocation,
        objectiveLocations,
        objectives: objs,
        rewards,
        flags: {
          isCampaign: false, // will be set from addon data if available
          isLocalStory: false,
          isImportant: false,
        },
        prerequisites: prereqs ? [...prereqs] : [],
        level: api?.requirements?.min_character_level,
      };

      quests.push(quest);
    }
  }

  console.log(`Built ${quests.length} total quests from ${lineEntries.size} quest lines.`);

  // Filter to Midnight zones if we detected any
  let midnightQuests: Quest[];
  if (midnightMapIds.size > 0) {
    midnightQuests = quests.filter(q => midnightMapIds.has(q.mapId));
    console.log(`Filtered to ${midnightQuests.length} Midnight quests.`);
  } else {
    // Without zone detection, output all quests — user can filter later
    midnightQuests = quests;
    console.log('No zone filtering applied — outputting all quests.');
  }

  // Build extras from Vignette data (treasures, rares)
  console.log('\nBuilding extras...');
  let extras: Extra[] = [];
  try {
    const vignettes = await loadJSON<{
      _ID: number;
      Name?: string;
      Name_lang?: string;
      QuestID?: number;
      Flags?: number;
      VisibleTrackingQuestID?: number;
      UiMapID?: number;
      X?: number;
      Y?: number;
    }[]>(join(RAW_DIR, 'vignette.json'));

    for (const v of vignettes) {
      const name = v.Name || v.Name_lang || '';
      if (!name) continue;

      // Classify: treasures have "treasure" or "chest" in name, rares are everything else with a tracking quest
      let type: 'treasure' | 'rare' = 'rare';
      const lower = name.toLowerCase();
      if (lower.includes('treasure') || lower.includes('chest') || lower.includes('cache')) {
        type = 'treasure';
      }

      if (v.QuestID || v.VisibleTrackingQuestID) {
        extras.push({
          id: v._ID,
          type,
          name,
          location: {
            x: v.X || 0,
            y: v.Y || 0,
            mapId: v.UiMapID || 0,
          },
          trackingQuestId: v.VisibleTrackingQuestID || v.QuestID,
          zone: v.UiMapID ? getZoneName(v.UiMapID) : 'Unknown',
        });
      }
    }
  } catch {
    console.warn('Could not load vignette data. Skipping extras.');
  }

  // TODO: Add glyphs from Achievement data when we have Midnight achievement IDs
  console.log(`Built ${extras.length} extras (treasures + rares).`);

  // Filter extras to Midnight zones
  if (midnightMapIds.size > 0) {
    extras = extras.filter(e => midnightMapIds.has(e.location.mapId));
    console.log(`Filtered to ${extras.length} Midnight extras.`);
  }

  // Write output
  const questsPath = join(OUTPUT_DIR, 'quests.json');
  const extrasPath = join(OUTPUT_DIR, 'extras.json');
  const statsPath = join(OUTPUT_DIR, 'stats.json');

  await writeFile(questsPath, JSON.stringify(midnightQuests, null, 2));
  await writeFile(extrasPath, JSON.stringify(extras, null, 2));

  // Compute stats
  const zones = new Set(midnightQuests.map(q => q.zone));
  const stats = {
    totalQuests: midnightQuests.length,
    totalExtras: extras.length,
    zones: [...zones],
    questLines: [...new Set(midnightQuests.map(q => q.questLineName))],
    questsWithLocations: midnightQuests.filter(q => q.acceptLocation).length,
    questsWithRewards: midnightQuests.filter(q => q.rewards.xp || q.rewards.gold).length,
  };
  await writeFile(statsPath, JSON.stringify(stats, null, 2));

  console.log(`\nOutput:`);
  console.log(`  ${questsPath} (${midnightQuests.length} quests)`);
  console.log(`  ${extrasPath} (${extras.length} extras)`);
  console.log(`  ${statsPath}`);
  console.log(`\nZones: ${[...zones].join(', ')}`);
  console.log(`Quest lines: ${stats.questLines.length}`);
  console.log(`Quests with locations: ${stats.questsWithLocations}/${midnightQuests.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
