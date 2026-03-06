/**
 * CASC DB2 Extraction — Fetches WoW DB2 tables from Blizzard's CASC CDN
 * and exports them as JSON for the OpenQuest pipeline.
 */

import { CASCClient, WDCReader, DBDParser } from '@rhyster/wow-casc-dbc';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'raw');

// DB2 tables we need to extract
const TABLES = [
  'questline',
  'questlinexquest',
  'questobjective',
  'questpoiblob',
  'questpoipoint',
  'achievement',
  'achievementcategory',
  'criteria',
  'criteriatree',
  'vignette',
  'areapoi',
  'questv2',
  'questinfo',
  'gameobjects',         // treasure/glyph world positions
  'gameobjectdisplayinfo',
  'uimapassignment',     // world coord → UI map coord transform
  'creature',
  'questoffer',
] as const;

type ColumnData = number | bigint | string | undefined | (number | bigint | string | undefined)[];

function serializeRow(row: Record<string, ColumnData>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === 'bigint') {
      out[key] = Number(val);
    } else if (Array.isArray(val)) {
      out[key] = val.map(v => typeof v === 'bigint' ? Number(v) : v);
    } else {
      out[key] = val;
    }
  }
  return out;
}

async function extractTable(
  client: CASCClient,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  const dbPath = `dbfilesclient/${tableName}.db2`;
  console.log(`  Fetching ${dbPath}...`);

  const fileDataID = client.getFileDataIDByName(dbPath);
  if (fileDataID === undefined) {
    console.warn(`  WARNING: Could not find fileDataID for ${dbPath}`);
    return [];
  }

  const cKeys = client.getContentKeysByFileDataID(fileDataID);
  if (!cKeys || cKeys.length === 0) {
    console.warn(`  WARNING: No content keys for ${dbPath}`);
    return [];
  }

  // Prefer enUS locale
  const enUSFlag = CASCClient.LocaleFlags.enUS;
  const cKey = cKeys.find(k => (k.localeFlags & enUSFlag) !== 0) ?? cKeys[0];

  const result = await client.getFileByContentKey(cKey.cKey, true);
  const blocks = result.type === 'partial' ? result.blocks : undefined;

  const reader = new WDCReader(result.buffer, blocks ?? []);
  const parser = await DBDParser.parse(reader);

  const ids = parser.getAllIDs();
  const rows: Record<string, unknown>[] = [];

  for (const id of ids) {
    const row = parser.getRowData(id);
    if (row) {
      rows.push({ _ID: id, ...serializeRow(row) });
    }
  }

  console.log(`  ${tableName}: ${rows.length} rows`);
  return rows;
}

async function main() {
  console.log('OpenQuest — CASC DB2 Extraction');
  console.log('================================\n');

  // Get current WoW version
  console.log('Fetching WoW product version...');
  const version = await CASCClient.getProductVersion('us', 'wow');
  if (!version) {
    throw new Error('Could not fetch WoW product version');
  }
  console.log(`Build: ${version.VersionsName} (${version.BuildId})\n`);

  // Initialize CASC client
  console.log('Initializing CASC client...');
  const client = new CASCClient('us', 'wow', version);
  await client.init();

  console.log('Loading remote listfile...');
  await client.loadRemoteListFile();

  console.log('Loading TACT keys...');
  await client.loadRemoteTACTKeys();
  console.log();

  // Ensure output directory exists
  await mkdir(DATA_DIR, { recursive: true });

  // Extract each table
  console.log('Extracting DB2 tables:');
  for (const table of TABLES) {
    try {
      const rows = await extractTable(client, table);
      const outPath = join(DATA_DIR, `${table}.json`);
      await writeFile(outPath, JSON.stringify(rows, null, 2));
      console.log(`  → ${outPath}\n`);
    } catch (err) {
      console.error(`  ERROR extracting ${table}:`, err);
    }
  }

  console.log('Extraction complete!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
