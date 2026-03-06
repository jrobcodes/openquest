/**
 * Fetch quest giver/ender NPC data from Wowhead for all Midnight quests.
 *
 * Scrapes each quest's Wowhead page to extract Start/End NPC names and IDs
 * from Quick Facts markup and embedded map objective data.
 *
 * Run: npx tsx scripts/fetch-quest-npcs.ts
 *
 * Features:
 * - Polite random delays (2-5s) between requests
 * - Incremental progress saves every 20 quests
 * - Resume support — re-run to pick up where you left off
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const DATA_DIR = join(import.meta.dirname, '..', 'data');
const OUTPUT = join(DATA_DIR, 'enriched', 'quest-npcs.json');

interface QuestNPC {
  questId: number;
  questTitle: string;
  startNpcName?: string;
  startNpcId?: number;
  endNpcName?: string;
  endNpcId?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Random delay between 2-5 seconds to be respectful of Wowhead. */
function randomDelay(): number {
  return 2000 + Math.random() * 3000;
}

async function fetchQuestNPCs(questId: number): Promise<Omit<QuestNPC, 'questTitle'>> {
  const result: Omit<QuestNPC, 'questTitle'> = { questId };

  const resp = await fetch(`https://www.wowhead.com/quest=${questId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OpenQuest/0.1; quest-guide-research)',
      'Accept': 'text/html',
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for quest ${questId}`);
  }

  const html = await resp.text();

  // === Strategy 1: Quick Facts markup ===
  // Wowhead renders Quick Facts using WH.markup which contains patterns like:
  //   Start: [url=/npc=235405/magister-umbric]Magister Umbric[/url]
  //   End: [url=/npc=235411/magister-umbric]Magister Umbric[/url]

  const startMarkup = html.match(/Start:\s*\[url=\/npc=(\d+)[^\]]*\]([^\[]+)\[\/url\]/);
  if (startMarkup) {
    result.startNpcId = parseInt(startMarkup[1]);
    result.startNpcName = startMarkup[2].trim();
  }

  const endMarkup = html.match(/End:\s*\[url=\/npc=(\d+)[^\]]*\]([^\[]+)\[\/url\]/);
  if (endMarkup) {
    result.endNpcId = parseInt(endMarkup[1]);
    result.endNpcName = endMarkup[2].trim();
  }

  // === Strategy 2: Embedded map objectives JSON ===
  // The page embeds mapper data like:
  //   "objectives":{...,"point":"start",...,"id":235405,...}
  // This is more reliable when Quick Facts uses a different format.

  if (!result.startNpcId) {
    const startObj = html.match(/"point"\s*:\s*"start"[^}]*?"id"\s*:\s*(\d+)/);
    if (startObj) {
      result.startNpcId = parseInt(startObj[1]);
    }
  }

  if (!result.endNpcId) {
    const endObj = html.match(/"point"\s*:\s*"end"[^}]*?"id"\s*:\s*(\d+)/);
    if (endObj) {
      result.endNpcId = parseInt(endObj[1]);
    }
  }

  // === Strategy 3: HTML table (older Wowhead format) ===
  // Some pages use <th>Start</th>...<a href="/npc=NNNNN">NPC Name</a>
  if (!result.startNpcName) {
    const startHtml = html.match(/Start\s*<\/th>[\s\S]*?<a href="\/npc=(\d+)[^"]*">([^<]+)<\/a>/);
    if (startHtml) {
      result.startNpcId = parseInt(startHtml[1]);
      result.startNpcName = startHtml[2].trim();
    }
  }

  if (!result.endNpcName) {
    const endHtml = html.match(/End\s*<\/th>[\s\S]*?<a href="\/npc=(\d+)[^"]*">([^<]+)<\/a>/);
    if (endHtml) {
      result.endNpcId = parseInt(endHtml[1]);
      result.endNpcName = endHtml[2].trim();
    }
  }

  // === Strategy 4: Try to get NPC name from npc ID if we have ID but no name ===
  // Look for the npc name anywhere on the page near the npc ID
  if (result.startNpcId && !result.startNpcName) {
    const nameMatch = html.match(new RegExp(`/npc=${result.startNpcId}[^"]*"[^>]*>([^<]+)<`));
    if (nameMatch) {
      result.startNpcName = nameMatch[1].trim();
    }
  }

  if (result.endNpcId && !result.endNpcName) {
    const nameMatch = html.match(new RegExp(`/npc=${result.endNpcId}[^"]*"[^>]*>([^<]+)<`));
    if (nameMatch) {
      result.endNpcName = nameMatch[1].trim();
    }
  }

  return result;
}

async function main() {
  console.log('OpenQuest -- Wowhead Quest NPC Scraper');
  console.log('=======================================\n');

  const quests: { id: number; title: string }[] = JSON.parse(
    await readFile(join(DATA_DIR, 'midnight', 'quests.json'), 'utf-8')
  );
  const questIds = quests.map(q => q.id);
  const titleMap = new Map(quests.map(q => [q.id, q.title]));

  console.log(`Found ${questIds.length} quests to process`);
  console.log(`Estimated time: ~${Math.round(questIds.length * 3.5 / 60)} minutes (with polite delays)\n`);

  await mkdir(join(DATA_DIR, 'enriched'), { recursive: true });

  // Load existing progress for resume support
  let results: QuestNPC[] = [];
  const seen = new Set<number>();

  if (existsSync(OUTPUT)) {
    results = JSON.parse(await readFile(OUTPUT, 'utf-8'));
    for (const r of results) seen.add(r.questId);
    console.log(`Resuming: ${seen.size} quests already fetched\n`);
  }

  let fetched = 0;
  let errors = 0;

  for (const qid of questIds) {
    if (seen.has(qid)) continue;

    try {
      const npcData = await fetchQuestNPCs(qid);
      const entry: QuestNPC = {
        ...npcData,
        questTitle: titleMap.get(qid) || '',
      };
      results.push(entry);
      seen.add(qid);
      fetched++;

      const startLabel = entry.startNpcName
        ? `start=${entry.startNpcName} (${entry.startNpcId})`
        : entry.startNpcId
          ? `start=npc#${entry.startNpcId}`
          : 'no start NPC';
      const endLabel = entry.endNpcName
        ? `end=${entry.endNpcName} (${entry.endNpcId})`
        : entry.endNpcId
          ? `end=npc#${entry.endNpcId}`
          : 'no end NPC';

      console.log(`  [${seen.size}/${questIds.length}] Quest ${qid} "${titleMap.get(qid)}": ${startLabel} | ${endLabel}`);
    } catch (err) {
      errors++;
      console.error(`  [${seen.size}/${questIds.length}] Quest ${qid} ERROR: ${err}`);

      // Still record it so we can retry later with a flag
      results.push({
        questId: qid,
        questTitle: titleMap.get(qid) || '',
      });
      seen.add(qid);
    }

    // Save progress every 20 quests
    if (fetched % 20 === 0) {
      await writeFile(OUTPUT, JSON.stringify(results, null, 2));
      console.log('  (progress saved)');
    }

    // Polite random delay
    await sleep(randomDelay());
  }

  // Final save
  await writeFile(OUTPUT, JSON.stringify(results, null, 2));

  // Summary
  const withStart = results.filter(r => r.startNpcName).length;
  const withStartId = results.filter(r => r.startNpcId).length;
  const withEnd = results.filter(r => r.endNpcName).length;
  const withEndId = results.filter(r => r.endNpcId).length;

  console.log('\n=======================================');
  console.log(`Done! Processed ${results.length} quests (${fetched} new, ${errors} errors)`);
  console.log(`  Start NPC name: ${withStart}/${results.length}`);
  console.log(`  Start NPC ID:   ${withStartId}/${results.length}`);
  console.log(`  End NPC name:   ${withEnd}/${results.length}`);
  console.log(`  End NPC ID:     ${withEndId}/${results.length}`);
  console.log(`\nOutput: ${OUTPUT}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
