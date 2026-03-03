/**
 * Data Merge — Combines CASC DB2 data + Blizzard API enrichment into
 * the unified Quest and Extra models for Midnight zones.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Quest, Extra, Coord, Objective, Rewards,
  BlizzardQuestResponse,
} from '../shared/types.js';

const RAW_DIR = join(import.meta.dirname, '..', 'data', 'raw');
const ENRICHED_DIR = join(import.meta.dirname, '..', 'data', 'enriched');
const OUTPUT_DIR = join(import.meta.dirname, '..', 'data', 'midnight');

// Midnight zone UiMapIDs (verified from DB2 cross-reference)
const MIDNIGHT_ZONES: Record<number, string> = {
  2395: 'Eversong Woods',
  2437: "Zul'Aman",
  2413: 'Harandar',
  2405: 'Voidstorm',
};
const MIDNIGHT_MAP_IDS = new Set(Object.keys(MIDNIGHT_ZONES).map(Number));

// Quest line IDs that belong to Midnight (identified from DB2 data)
// Includes main story, side stories, and zone content — excludes WQ/repeatables
const MIDNIGHT_STORY_LINE_IDS = new Set([
  // Campaign / main story
  5719, 5720, 5721, // Whispers/Shadowfall/Ripple Effects
  5722, 5723, 5724, // Amani stories
  5725, 5726, 5727, // Of Caves/Call of Goddess/Emergence
  5728, 5729, 5730, // Into the Abyss/Night's Veil/Dawn of Reckoning
  5750, 5751, // Path of Light / Regrets
  5792, 5793, // Foothold / Voidspire
  5797, 5798, // March on Quel'Danas / Dawn of New Well
  5826, 5827, 5828, // Path of Light II/III/IV
  5909, // Legend of Aln'sharan
  5938, // Where War Slumbers
  5940, // Return to Scouting Map
  5945, 5947, 5948, // Prey / Rise of Red Dawn
  5951, // What Remains of Broken Throne
  5979, // The Darkening Sky
  6041, 6043, // Astalor / Ren'dorei
  6130, 6131, // Eversong Intro / Scouting Map
  // Side stories
  5778, 5781, // Healing Spirit / Aspiring Academic
  5804, 5805, // Theft Tracking / Port Detective
  5841, 5967, // Saltheril's Haven
  5898, // One Adventurous Hatchling
  5901, 5905, // Sorrowing Kin / Unlikely Friends
  5907, // A Goblin in Harandar
  5908, // Paladin Rescue
  5910, // The Grudge Pit
  5929, // The Empty Cradle
  5930, // The Cult Within
  5932, // Trials of Shul'ka
  5933, // The Nethersent
  5935, 5936, 5937, // Late Bloomers / Dance with Devil / Train Protegee
  5939, // Vengeance for Tolbani
  5943, 5944, // Shadow Puppets / Peril Among Petals
  5949, 5950, // Sunbath / Venomous History
  5952, // Greenspeaker's Vigil
  5958, // Daggerspine Landing
  5960, // Haranir Never Say Die
  5961, 5962, // To Be Changed / Nightbreaker
  5966, // Harandar's Kitchen
  5969, // Far Striding
  5971, // Voice of Nalorakk
  5974, 5975, // Crimson Rogue / Something Vile
  5977, // Cultivating Hope
  5981, // Between Two Trolls
  5982, // The Arcantina
  5988, // Loa of Murlocs
  5989, // Tailor Troubles
  5993, // Runestone Rumbles
  5999, // No Fear
  6001, // A More Potent Foe
  6010, // Void Peers Back
  6011, // Reclaiming De Honor
  6012, 6013, 6014, // Domanaar's Friend / Voice Inside / Oaths
  6017, 6018, // Secrets in Dark / Blinding Sun
  6020, // Flowers for Amalthea
  6022, // Go Low Go Loud
  6028, // Pathogenic Problem
  6030, // Scootin Through Silvermoon
  6032, // Spot Light
  6036, // Silence at Fungara
  6038, 6039, 6040, // Palette / Hunter's Rite / Predator
  6042, // Bitter Honor
  6044, 6045, // Beyond Walls / River-Walkers
  6048, // Sawdust
  6052, // Bloodstains
  6055, // Sound of Her Voice
  6209, // Legends of Haranir
  6224, // Something Vile (alt)
]);

// Raw DB2 row types (actual column names from extraction)
interface RawQuestLineRow {
  _ID: number;
  Name_lang: string;
  Flags: number;
}

interface RawQLXQRow {
  _ID: number;
  QuestLineID: number;
  QuestID: number;
  OrderIndex: number;
  Flags: number;
}

interface RawObjectiveRow {
  _ID: number;
  QuestID: number;
  Type: number;
  Amount: number;
  ObjectID: number;
  Description_lang: string;
  OrderIndex: number;
}

interface RawPOIBlobRow {
  _ID: number;
  QuestID: number;
  ObjectiveIndex: number;
  MapID: number;
  UiMapID: number;
  NumPoints: number;
}

interface RawPOIPointRow {
  _ID: number;
  QuestPOIBlobID: number;
  X: number;
  Y: number;
  Z: number;
}

interface RawVignetteRow {
  _ID: number;
  Name_lang: string;
  VisibleTrackingQuestID: number;
  RewardQuestID: number;
  Flags: number;
  VignetteType: number;
}

async function loadJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function main() {
  console.log('OpenQuest — Data Merge');
  console.log('======================\n');

  await mkdir(OUTPUT_DIR, { recursive: true });

  // Load all raw data
  console.log('Loading raw DB2 data...');
  const questLines = await loadJSON<RawQuestLineRow[]>(join(RAW_DIR, 'questline.json'));
  const qlxq = await loadJSON<RawQLXQRow[]>(join(RAW_DIR, 'questlinexquest.json'));
  const objectives = await loadJSON<RawObjectiveRow[]>(join(RAW_DIR, 'questobjective.json'));
  const poiBlobs = await loadJSON<RawPOIBlobRow[]>(join(RAW_DIR, 'questpoiblob.json'));
  const poiPoints = await loadJSON<RawPOIPointRow[]>(join(RAW_DIR, 'questpoipoint.json'));
  const vignettes = await loadJSON<RawVignetteRow[]>(join(RAW_DIR, 'vignette.json'));

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

  // QuestLine ID → name + flags
  const questLineInfo = new Map<number, { name: string; flags: number }>();
  for (const ql of questLines) {
    questLineInfo.set(ql._ID, { name: ql.Name_lang, flags: ql.Flags });
  }

  // QuestLineID → sorted entries
  const lineEntries = new Map<number, RawQLXQRow[]>();
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
  const questObjectives = new Map<number, RawObjectiveRow[]>();
  for (const obj of objectives) {
    if (!questObjectives.has(obj.QuestID)) {
      questObjectives.set(obj.QuestID, []);
    }
    questObjectives.get(obj.QuestID)!.push(obj);
  }

  // QuestID → POI blobs (only Midnight zones)
  const questPOIBlobMap = new Map<number, RawPOIBlobRow[]>();
  for (const blob of poiBlobs) {
    if (!MIDNIGHT_MAP_IDS.has(blob.UiMapID) && blob.UiMapID !== 0) continue;
    if (!questPOIBlobMap.has(blob.QuestID)) {
      questPOIBlobMap.set(blob.QuestID, []);
    }
    questPOIBlobMap.get(blob.QuestID)!.push(blob);
  }

  // POIBlob ID → points
  const blobPoints = new Map<number, RawPOIPointRow[]>();
  for (const pt of poiPoints) {
    if (!blobPoints.has(pt.QuestPOIBlobID)) {
      blobPoints.set(pt.QuestPOIBlobID, []);
    }
    blobPoints.get(pt.QuestPOIBlobID)!.push(pt);
  }

  // Find which quest IDs belong to Midnight (in a Midnight quest line AND have POI in Midnight zones)
  const midnightQuestIds = new Set<number>();
  for (const entry of qlxq) {
    if (!MIDNIGHT_STORY_LINE_IDS.has(entry.QuestLineID)) continue;
    // Check if this quest has POI in a Midnight zone
    const blobs = questPOIBlobMap.get(entry.QuestID);
    if (blobs && blobs.some(b => MIDNIGHT_MAP_IDS.has(b.UiMapID))) {
      midnightQuestIds.add(entry.QuestID);
    }
  }
  console.log(`Identified ${midnightQuestIds.size} Midnight quests with POI data.`);

  // Build prerequisites from quest lines
  // Within a quest line, quest at OrderIndex N depends on quest at OrderIndex N-1
  const prerequisites = new Map<number, Set<number>>();

  for (const [_lineId, entries] of lineEntries) {
    for (let i = 1; i < entries.length; i++) {
      const current = entries[i].QuestID;
      const prev = entries[i - 1].QuestID;
      if (!midnightQuestIds.has(current) || !midnightQuestIds.has(prev)) continue;
      if (!prerequisites.has(current)) {
        prerequisites.set(current, new Set());
      }
      prerequisites.get(current)!.add(prev);
    }
  }

  // Helpers
  function getBlobCentroid(blob: RawPOIBlobRow): Coord | null {
    const points = blobPoints.get(blob._ID);
    if (!points || points.length === 0) return null;

    const n = points.length;
    return {
      x: points.reduce((s, p) => s + p.X, 0) / n,
      y: points.reduce((s, p) => s + p.Y, 0) / n,
      z: points.reduce((s, p) => s + p.Z, 0) / n,
      mapId: blob.UiMapID || blob.MapID,
    };
  }

  function getQuestLocations(questId: number): {
    acceptLocation: Coord | null;
    turnInLocation: Coord | null;
    objectiveLocations: Coord[];
    mapId: number;
  } {
    const blobs = (questPOIBlobMap.get(questId) || [])
      .filter(b => MIDNIGHT_MAP_IDS.has(b.UiMapID));
    let acceptLocation: Coord | null = null;
    let turnInLocation: Coord | null = null;
    const objectiveLocations: Coord[] = [];
    let mapId = 0;

    for (const blob of blobs) {
      const centroid = getBlobCentroid(blob);
      if (!centroid) continue;

      if (!mapId) mapId = blob.UiMapID;

      if (blob.ObjectiveIndex === -1) {
        if (!acceptLocation) acceptLocation = centroid;
        else turnInLocation = centroid;
      } else {
        objectiveLocations.push(centroid);
      }
    }

    if (acceptLocation && !turnInLocation) {
      turnInLocation = acceptLocation;
    }

    return { acceptLocation, turnInLocation, objectiveLocations, mapId };
  }

  // Determine quest line flags for campaign/story classification
  // Flags interpretation (from observation):
  // 8 = campaign/story, 72 = side quest, 24 = important/key, 0 = WQ/repeatables
  function classifyFlags(lineId: number): { isCampaign: boolean; isLocalStory: boolean; isImportant: boolean } {
    const info = questLineInfo.get(lineId);
    if (!info) return { isCampaign: false, isLocalStory: false, isImportant: false };
    const f = info.flags;
    return {
      isCampaign: (f & 8) !== 0 && (f & 64) === 0, // flag 8 without 64 = campaign
      isLocalStory: (f & 64) !== 0, // flag 64 = side story
      isImportant: (f & 16) !== 0, // flag 16 = important
    };
  }

  // Build Quest objects
  console.log('Building quest objects...');
  const quests: Quest[] = [];
  const processedQuestIds = new Set<number>();

  // Track which quest line each quest first appears in
  const questFirstLine = new Map<number, number>();
  for (const entry of qlxq) {
    if (midnightQuestIds.has(entry.QuestID) && !questFirstLine.has(entry.QuestID)) {
      questFirstLine.set(entry.QuestID, entry.QuestLineID);
    }
  }

  for (const [lineId, entries] of lineEntries) {
    if (!MIDNIGHT_STORY_LINE_IDS.has(lineId)) continue;
    const info = questLineInfo.get(lineId);
    const lineName = info?.name || `QuestLine_${lineId}`;
    const flags = classifyFlags(lineId);

    for (const entry of entries) {
      if (!midnightQuestIds.has(entry.QuestID)) continue;
      if (processedQuestIds.has(entry.QuestID)) continue;
      processedQuestIds.add(entry.QuestID);

      const { acceptLocation, turnInLocation, objectiveLocations, mapId } =
        getQuestLocations(entry.QuestID);

      if (!mapId) continue; // Skip quests with no Midnight POI data

      const rawObjs = questObjectives.get(entry.QuestID) || [];
      const objs: Objective[] = rawObjs.map(o => ({
        index: o.OrderIndex,
        type: o.Type,
        description: o.Description_lang || '',
        amount: o.Amount,
        locations: [],
      }));

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
      const zoneName = MIDNIGHT_ZONES[mapId] || `Zone_${mapId}`;

      const quest: Quest = {
        id: entry.QuestID,
        title: api?.title || `Quest_${entry.QuestID}`,
        description: api?.description || '',
        questLineId: lineId,
        questLineName: lineName,
        orderIndex: entry.OrderIndex,
        zone: zoneName,
        mapId,
        acceptLocation,
        turnInLocation,
        objectiveLocations,
        objectives: objs,
        rewards,
        flags,
        prerequisites: prereqs ? [...prereqs] : [],
        level: api?.requirements?.min_character_level,
      };

      quests.push(quest);
    }
  }

  console.log(`Built ${quests.length} Midnight quests from story quest lines.`);

  // Zone breakdown
  const zoneCounts: Record<string, number> = {};
  for (const q of quests) {
    zoneCounts[q.zone] = (zoneCounts[q.zone] || 0) + 1;
  }
  for (const [zone, count] of Object.entries(zoneCounts)) {
    console.log(`  ${zone}: ${count} quests`);
  }

  // Build extras from Vignette data
  console.log('\nBuilding extras...');
  const extras: Extra[] = [];

  // Vignettes don't have coordinates directly — they reference tracking quests
  // which may have POI data. For now, collect vignettes that have tracking quests
  // which are in Midnight zones.
  for (const v of vignettes) {
    if (!v.Name_lang) continue;
    const trackingQuestId = v.VisibleTrackingQuestID || v.RewardQuestID;
    if (!trackingQuestId) continue;

    // Check if tracking quest has POI in Midnight zones
    const blobs = (questPOIBlobMap.get(trackingQuestId) || [])
      .filter(b => MIDNIGHT_MAP_IDS.has(b.UiMapID));
    if (blobs.length === 0) continue;

    const centroid = getBlobCentroid(blobs[0]);
    if (!centroid) continue;

    let type: Extra['type'] = 'rare';
    const lower = v.Name_lang.toLowerCase();
    if (lower.includes('treasure') || lower.includes('chest') || lower.includes('cache')) {
      type = 'treasure';
    } else if (lower.includes('glyph') || lower.includes('skyriding')) {
      type = 'glyph';
    }

    const zoneName = MIDNIGHT_ZONES[blobs[0].UiMapID] || `Zone_${blobs[0].UiMapID}`;

    extras.push({
      id: v._ID,
      type,
      name: v.Name_lang,
      location: centroid,
      trackingQuestId,
      zone: zoneName,
    });
  }

  console.log(`Built ${extras.length} extras (treasures + rares + glyphs).`);

  // Write output
  const questsPath = join(OUTPUT_DIR, 'quests.json');
  const extrasPath = join(OUTPUT_DIR, 'extras.json');
  const statsPath = join(OUTPUT_DIR, 'stats.json');

  await writeFile(questsPath, JSON.stringify(quests, null, 2));
  await writeFile(extrasPath, JSON.stringify(extras, null, 2));

  const zones = new Set(quests.map(q => q.zone));
  const stats = {
    totalQuests: quests.length,
    totalExtras: extras.length,
    zones: [...zones],
    questLines: [...new Set(quests.map(q => q.questLineName))],
    questsWithLocations: quests.filter(q => q.acceptLocation).length,
    questsWithRewards: quests.filter(q => q.rewards.xp || q.rewards.gold).length,
    campaignQuests: quests.filter(q => q.flags.isCampaign).length,
    sideStoryQuests: quests.filter(q => q.flags.isLocalStory).length,
  };
  await writeFile(statsPath, JSON.stringify(stats, null, 2));

  console.log(`\nOutput:`);
  console.log(`  ${questsPath} (${quests.length} quests)`);
  console.log(`  ${extrasPath} (${extras.length} extras)`);
  console.log(`  ${statsPath}`);
  console.log(`\nZones: ${[...zones].join(', ')}`);
  console.log(`Quest lines: ${stats.questLines.length}`);
  console.log(`Campaign: ${stats.campaignQuests}, Side stories: ${stats.sideStoryQuests}`);
  console.log(`Quests with locations: ${stats.questsWithLocations}/${quests.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
