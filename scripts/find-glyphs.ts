import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RAW = join(import.meta.dirname, '..', 'data', 'raw');

async function main() {
  const ct = JSON.parse(await readFile(join(RAW, 'criteriatree.json'), 'utf-8'));
  const cr = JSON.parse(await readFile(join(RAW, 'criteria.json'), 'utf-8'));
  const ach = JSON.parse(await readFile(join(RAW, 'achievement.json'), 'utf-8'));
  const poiblob = JSON.parse(await readFile(join(RAW, 'questpoiblob.json'), 'utf-8'));
  const poipoints = JSON.parse(await readFile(join(RAW, 'questpoipoint.json'), 'utf-8'));

  // Zone glyph hunter achievements
  const glyphHunters = [61576, 61582, 61583]; // Eversong, Harandar, Voidstorm

  // Check for Zul'Aman glyph hunter
  const zulGlyph = ach.filter((a: any) =>
    (a.Title_lang || '').includes('Glyph Hunter') &&
    (a.Title_lang || '').toLowerCase().includes('aman')
  );
  if (zulGlyph.length > 0) {
    console.log("Found Zul'Aman glyph hunter:", zulGlyph[0]._ID, zulGlyph[0].Title_lang);
    glyphHunters.push(zulGlyph[0]._ID);
  }

  // Collect individual glyph achievement IDs from each zone hunter
  const allGlyphs: { achId: number; name: string; zone: string }[] = [];

  for (const hunterId of glyphHunters) {
    const a = ach.find((a: any) => a._ID === hunterId);
    if (!a) continue;
    const rootTreeId = a.Criteria_tree;
    if (!rootTreeId) continue;

    const children = ct.filter((t: any) => t.Parent === rootTreeId);
    for (const c of children) {
      const crit = cr.find((r: any) => r._ID === c.CriteriaID);
      if (crit && crit.Type === 8) {
        allGlyphs.push({ achId: crit.Asset, name: c.Description_lang, zone: a.Title_lang });
      }
    }
  }

  console.log(`Found ${allGlyphs.length} individual glyph achievements\n`);

  // For each glyph, find its tracking quest via criteria
  let withCoords = 0;
  let withoutCoords = 0;

  for (const g of allGlyphs) {
    const glyphAch = ach.find((a: any) => a._ID === g.achId);
    if (!glyphAch) {
      console.log(`  ${g.name} — achievement ${g.achId} not found`);
      withoutCoords++;
      continue;
    }

    const treeId = glyphAch.Criteria_tree;
    const treeChildren = ct.filter((t: any) => t.Parent === treeId);

    let found = false;
    for (const tc of treeChildren) {
      const crit = cr.find((r: any) => r._ID === tc.CriteriaID);
      if (!crit) continue;

      // Type 27 = complete quest, Type 110 = location, Type 28 = complete quest (alt)
      const questId = crit.Asset;
      const blobs = poiblob.filter((b: any) => b.QuestID === questId);

      if (blobs.length > 0) {
        const pts: any[] = [];
        for (const b of blobs) {
          pts.push(...poipoints.filter((p: any) => p.QuestPOIBlobID === b._ID));
        }
        if (pts.length > 0) {
          const cx = pts.reduce((s: number, p: any) => s + p.X, 0) / pts.length;
          const cy = pts.reduce((s: number, p: any) => s + p.Y, 0) / pts.length;
          console.log(`  ${g.name} — quest ${questId} at (${cx.toFixed(0)}, ${cy.toFixed(0)}) map ${blobs[0].UiMapID}`);
          withCoords++;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      // Try to look up by achievement criteria directly
      console.log(`  ${g.name} — no POI data (ach ${g.achId}, tree ${treeId})`);
      withoutCoords++;
    }
  }

  console.log(`\nWith coordinates: ${withCoords}`);
  console.log(`Without coordinates: ${withoutCoords}`);
}

main();
