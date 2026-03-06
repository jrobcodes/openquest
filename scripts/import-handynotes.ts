/**
 * Import HandyNotes Midnight data — Parses zarillion's HandyNotes plugin Lua
 * files and converts rares, treasures, and glyphs into our Extra[] JSON format.
 *
 * Data source: https://github.com/zarillion/handynotes-plugins (MIT License)
 * Run: npx tsx scripts/import-handynotes.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUTPUT_DIR = join(import.meta.dirname, '..', 'data', 'handynotes');
const RAW_DIR = join(import.meta.dirname, '..', 'data', 'raw');
const REPO = 'zarillion/handynotes-plugins';
const ZONE_FILES: Record<string, { file: string; mapId: number; name: string }> = {
  eversong: { file: 'eversong_woods.lua', mapId: 2395, name: 'Eversong Woods' },
  zulaman: { file: 'zul_aman.lua', mapId: 2437, name: "Zul'Aman" },
  harandar: { file: 'harandar.lua', mapId: 2413, name: 'Harandar' },
  voidstorm: { file: 'voidstorm.lua', mapId: 2405, name: 'Voidstorm' },
};

interface HandyNotesNode {
  type: 'rare' | 'treasure' | 'glyph';
  coord: number;        // packed XXYYYYYY
  x: number;            // normalized 0-1
  y: number;            // normalized 0-1
  mapId: number;
  zone: string;
  npcId?: number;       // for rares
  questId?: number;     // tracking quest
  achievementId?: number;
  criteriaId?: number;
  name?: string;        // from inline comment
}

function decodeCoord(packed: number): { x: number; y: number } {
  const x = Math.floor(packed / 10000) / 10000;
  const y = (packed % 10000) / 10000;
  return { x, y };
}

function parseZoneLua(lua: string, mapId: number, zoneName: string): HandyNotesNode[] {
  const nodes: HandyNotesNode[] = [];

  // Track sub-map IDs declared as Map({id = XXXX})
  // e.g., local smc = Map({id = 2393}) means smc.nodes[...] uses mapId 2393
  const mapAliases = new Map<string, number>();
  mapAliases.set('map', mapId);

  const mapDeclRegex = /local\s+(\w+)\s*=\s*Map\(\{id\s*=\s*(\d+)/g;
  let mapMatch;
  while ((mapMatch = mapDeclRegex.exec(lua)) !== null) {
    mapAliases.set(mapMatch[1], parseInt(mapMatch[2]));
  }

  // Match node entries: <alias>.nodes[COORD] = Type({...})
  // Capture: alias, coord, type, content block, and trailing comment (name)
  const nodeRegex = /(\w+)\.nodes\[(\d+)\]\s*=\s*(Rare|Treasure|SkyridingGlyph|PT)\(\{([\s\S]*?)\}\)(?:\s*--\s*(.*))?/g;
  let match;

  while ((match = nodeRegex.exec(lua)) !== null) {
    const [, alias, coordStr, nodeType, content, comment] = match;
    const coord = parseInt(coordStr);
    const { x, y } = decodeCoord(coord);
    const nodeMapId = mapAliases.get(alias) || mapId;

    let type: HandyNotesNode['type'];
    if (nodeType === 'Rare') type = 'rare';
    else if (nodeType === 'SkyridingGlyph') type = 'glyph';
    else type = 'treasure';

    // Extract fields from content
    const idMatch = content.match(/\bid\s*=\s*(\d+)/);
    const questMatch = content.match(/\bquest\s*=\s*(\d+)/);
    const achMatch = content.match(/Achievement\(\{id\s*=\s*(\d+)(?:,\s*criteria\s*=\s*(\d+))?/);

    const node: HandyNotesNode = {
      type,
      coord,
      x,
      y,
      mapId: nodeMapId,
      zone: zoneName,
    };

    if (idMatch) node.npcId = parseInt(idMatch[1]);
    if (questMatch) node.questId = parseInt(questMatch[1]);
    if (achMatch) {
      node.achievementId = parseInt(achMatch[1]);
      if (achMatch[2]) node.criteriaId = parseInt(achMatch[2]);
    }
    if (comment?.trim()) node.name = comment.trim();

    nodes.push(node);
  }

  return nodes;
}

async function fetchZoneFile(zone: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${REPO}/master/plugins/12_Midnight/zones/${zone}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${zone}: ${resp.status}`);
  return resp.text();
}

async function main() {
  console.log('OpenQuest — HandyNotes Data Import');
  console.log('===================================\n');
  console.log(`Source: github.com/${REPO} (MIT License)\n`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const allNodes: HandyNotesNode[] = [];

  for (const [key, zone] of Object.entries(ZONE_FILES)) {
    console.log(`Fetching ${zone.name} (${zone.file})...`);
    const lua = await fetchZoneFile(zone.file);
    const nodes = parseZoneLua(lua, zone.mapId, zone.name);

    const glyphs = nodes.filter(n => n.type === 'glyph');
    const rares = nodes.filter(n => n.type === 'rare');
    const treasures = nodes.filter(n => n.type === 'treasure');

    console.log(`  ${glyphs.length} glyphs, ${rares.length} rares, ${treasures.length} treasures`);
    allNodes.push(...nodes);
  }

  console.log(`\nTotal: ${allNodes.length} nodes`);
  console.log(`  Glyphs: ${allNodes.filter(n => n.type === 'glyph').length}`);
  console.log(`  Rares: ${allNodes.filter(n => n.type === 'rare').length}`);
  console.log(`  Treasures: ${allNodes.filter(n => n.type === 'treasure').length}`);

  // Load UiMapAssignment for coordinate conversion
  // Region = [worldX_min, worldY_min, z_min, worldX_max, worldY_max, z_max]
  // WoW world: X = north-south, Y = east-west
  // UI map: x = left-right (east-west), y = top-bottom (north-south)
  // Transform: worldX = maxX - ui_y * (maxX - minX), worldY = maxY - ui_x * (maxY - minY)
  type UiMapAssignment = { UiMapID: number; Region: number[] };
  const uma: UiMapAssignment[] = JSON.parse(await readFile(join(RAW_DIR, 'uimapassignment.json'), 'utf-8'));
  const regionByMap = new Map<number, number[]>();
  for (const entry of uma) {
    if (!regionByMap.has(entry.UiMapID)) {
      regionByMap.set(entry.UiMapID, entry.Region);
    }
  }

  function toWorldCoords(uiX: number, uiY: number, mapId: number): { x: number; y: number } {
    const r = regionByMap.get(mapId);
    if (!r) {
      console.warn(`  No UiMapAssignment for mapId ${mapId}, using raw normalized coords`);
      return { x: uiX * 10000, y: uiY * 10000 };
    }
    return {
      x: r[3] - uiY * (r[3] - r[0]),  // worldX from ui_y
      y: r[4] - uiX * (r[4] - r[1]),  // worldY from ui_x
    };
  }

  // Convert to our Extra format with world coordinates
  const extras = allNodes.map((n, i) => {
    const world = toWorldCoords(n.x, n.y, n.mapId);
    return {
      id: `hn-${n.type}-${i}`,
      type: n.type,
      name: n.name || `${n.zone} ${n.type} ${i}`,
      mapId: n.mapId,
      zone: n.zone,
      location: { x: Math.round(world.x), y: Math.round(world.y), z: 0, mapId: n.mapId },
      npcId: n.npcId,
      questId: n.questId,
      achievementId: n.achievementId,
      criteriaId: n.criteriaId,
    };
  });

  // Write raw parsed data
  const rawPath = join(OUTPUT_DIR, 'nodes-raw.json');
  await writeFile(rawPath, JSON.stringify(allNodes, null, 2));
  console.log(`\nWrote raw nodes: ${rawPath}`);

  // Write extras format
  const extrasPath = join(OUTPUT_DIR, 'extras.json');
  await writeFile(extrasPath, JSON.stringify(extras, null, 2));
  console.log(`Wrote extras: ${extrasPath}`);

  // Write attribution
  const attrPath = join(OUTPUT_DIR, 'ATTRIBUTION.md');
  await writeFile(attrPath, `# HandyNotes Data Attribution

Coordinate data for rares, treasures, and skyriding glyphs imported from:

**Source:** https://github.com/${REPO}
**License:** MIT (Copyright 2022 Zarillion)
**Import date:** ${new Date().toISOString().split('T')[0]}

The original data was hand-collected in-game by the HandyNotes community.
`);
  console.log(`Wrote attribution: ${attrPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
