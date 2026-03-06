import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RAW_DIR = join(import.meta.dirname, '..', 'data', 'raw');
const HN_DIR = join(import.meta.dirname, '..', 'data', 'handynotes');

async function main() {
  const hn = JSON.parse(await readFile(join(HN_DIR, 'extras.json'), 'utf-8'));
  const uma = JSON.parse(await readFile(join(RAW_DIR, 'uimapassignment.json'), 'utf-8'));
  const quests = JSON.parse(await readFile(join(import.meta.dirname, '..', 'data', 'midnight', 'quests.json'), 'utf-8'));

  const mainZones = new Set([2395, 2437, 2413, 2405]);

  // Find sub-maps from HandyNotes data
  console.log('=== Sub-maps with extras ===');
  const subMaps: Record<number, { zone: string; count: number; types: Record<string, number>; items: any[] }> = {};
  for (const e of hn) {
    if (!mainZones.has(e.mapId)) {
      if (!subMaps[e.mapId]) subMaps[e.mapId] = { zone: e.zone, count: 0, types: {}, items: [] };
      subMaps[e.mapId].count++;
      subMaps[e.mapId].types[e.type] = (subMaps[e.mapId].types[e.type] || 0) + 1;
      subMaps[e.mapId].items.push(e);
    }
  }

  for (const [id, info] of Object.entries(subMaps)) {
    console.log(`\n  MapID ${id} — ${info.zone}: ${info.count} extras`, JSON.stringify(info.types));
    // Check UiMapAssignment for this sub-map
    const assignment = uma.find((u: any) => u.UiMapID === Number(id));
    if (assignment) {
      console.log(`    Region: [${assignment.Region.slice(0, 2).join(', ')} ... ${assignment.Region.slice(3, 5).join(', ')}]`);
      console.log(`    AreaID: ${assignment.AreaID}, MapID: ${assignment.MapID}`);
    } else {
      console.log('    No UiMapAssignment found');
    }
    // Show items
    for (const item of info.items) {
      console.log(`    - ${item.type}: ${item.name} at (${item.location.x}, ${item.location.y})`);
    }
  }

  // Also check: do any quests exist on sub-maps?
  console.log('\n=== Quests on sub-maps ===');
  const questSubMaps: Record<number, number> = {};
  for (const q of quests) {
    if (!mainZones.has(q.mapId)) {
      questSubMaps[q.mapId] = (questSubMaps[q.mapId] || 0) + 1;
    }
  }
  if (Object.keys(questSubMaps).length === 0) {
    console.log('  None — all quests are on main zone maps');
  } else {
    for (const [id, count] of Object.entries(questSubMaps)) {
      console.log(`  MapID ${id}: ${count} quests`);
    }
  }

  // Check UiMap parent hierarchy — do sub-maps have parent zones?
  // Look at Eversong's HandyNotes Lua for sub-map declarations
  console.log('\n=== Sub-map to parent zone mapping ===');
  // From HandyNotes eversong_woods.lua: smc = Map({id = 2393}), iqd = Map({id = 2424})
  // These are sub-areas within the Eversong Woods zone file
  const knownParents: Record<number, { parent: number; name: string }> = {
    2393: { parent: 2395, name: 'Silvermoon City → Eversong Woods' },
    2424: { parent: 2395, name: "Isle of Quel'Danas → Eversong Woods" },
  };
  for (const [subId, info] of Object.entries(knownParents)) {
    console.log(`  ${subId}: ${info.name}`);
  }
}

main();
