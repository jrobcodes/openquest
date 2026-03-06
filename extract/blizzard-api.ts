/**
 * Blizzard API Enrichment — Fetches quest details from the Blizzard Game Data API
 * and enriches our extracted DB2 data with titles, descriptions, rewards, etc.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlizzardQuestResponse } from '../shared/types.js';

const RAW_DIR = join(import.meta.dirname, '..', 'data', 'raw');
const ENRICHED_DIR = join(import.meta.dirname, '..', 'data', 'enriched');
const CACHE_PATH = join(ENRICHED_DIR, 'api-cache.json');

// Blizzard API credentials
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET || '';

const API_BASE = 'https://us.api.blizzard.com';
const NAMESPACE = 'static-us'; // will be overridden with specific build if needed
const LOCALE = 'en_US';

// Rate limiting: 36,000 req/hr = 10/sec max. Blizzard may return 401
// instead of 429 when rate-limited, invalidating the token.
const RATE_LIMIT_DELAY = 120; // ms between requests (~8/sec, well under limit)
const BATCH_SIZE = 50;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

let accessToken: string | null = null;

async function getAccessToken(): Promise<string> {
  if (accessToken) return accessToken;

  console.log('Authenticating with Blizzard API...');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const resp = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Auth failed: ${resp.status} ${resp.statusText} — ${text}`);
  }

  const data = (await resp.json()) as TokenResponse;
  accessToken = data.access_token;
  console.log('Authenticated successfully.\n');
  return accessToken;
}

async function fetchQuest(questId: number, retries = 2): Promise<BlizzardQuestResponse | null> {
  const token = await getAccessToken();
  const url = `${API_BASE}/data/wow/quest/${questId}?namespace=${NAMESPACE}&locale=${LOCALE}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.status === 404) return null;

  // 401/429 may indicate rate limiting — back off and retry with fresh token
  if ((resp.status === 401 || resp.status === 429) && retries > 0) {
    console.warn(`  Rate limit suspected (${resp.status}) for quest ${questId}, backing off...`);
    accessToken = null; // force re-auth on next attempt
    await sleep(5000 * (3 - retries)); // 5s, then 10s
    return fetchQuest(questId, retries - 1);
  }

  if (!resp.ok) {
    console.warn(`  API error for quest ${questId}: ${resp.status}`);
    return null;
  }

  return (await resp.json()) as BlizzardQuestResponse;
}

async function loadCache(): Promise<Map<number, BlizzardQuestResponse>> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const arr = JSON.parse(raw) as [number, BlizzardQuestResponse][];
    return new Map(arr);
  } catch {
    return new Map();
  }
}

async function saveCache(cache: Map<number, BlizzardQuestResponse>): Promise<void> {
  await writeFile(CACHE_PATH, JSON.stringify([...cache.entries()], null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('OpenQuest — Blizzard API Enrichment');
  console.log('====================================\n');

  await mkdir(ENRICHED_DIR, { recursive: true });

  // Load quest IDs from the extracted QuestLineXQuest data
  const qlxqPath = join(RAW_DIR, 'questlinexquest.json');
  let qlxqData: { QuestID: number }[];
  try {
    qlxqData = JSON.parse(await readFile(qlxqPath, 'utf-8'));
  } catch {
    console.error(`Could not read ${qlxqPath}. Run extract:casc first.`);
    process.exit(1);
  }

  // Also load QuestV2 for broader quest ID coverage
  const qv2Path = join(RAW_DIR, 'questv2.json');
  let qv2Data: { _ID: number }[] = [];
  try {
    qv2Data = JSON.parse(await readFile(qv2Path, 'utf-8'));
  } catch {
    console.log('No questv2.json found, using only QuestLineXQuest IDs.');
  }

  // Collect unique quest IDs from quest lines
  const questIds = new Set<number>();
  for (const row of qlxqData) {
    if (row.QuestID) questIds.add(row.QuestID);
  }
  console.log(`Found ${questIds.size} unique quest IDs from quest lines.\n`);

  // Load cache
  const cache = await loadCache();
  console.log(`Cache has ${cache.size} entries.`);

  // Determine which quests need fetching
  const toFetch = [...questIds].filter(id => !cache.has(id));
  console.log(`Need to fetch ${toFetch.length} quests from API.\n`);

  if (toFetch.length === 0) {
    console.log('All quests already cached!');
  } else {
    let fetched = 0;
    let notFound = 0;

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const batch = toFetch.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(toFetch.length / BATCH_SIZE);
      console.log(`Batch ${batchNum}/${totalBatches} (${batch.length} quests)...`);

      for (const questId of batch) {
        const data = await fetchQuest(questId);
        if (data) {
          cache.set(questId, data);
          fetched++;
        } else {
          notFound++;
        }
        await sleep(RATE_LIMIT_DELAY);
      }

      // Save cache after each batch
      await saveCache(cache);
    }

    console.log(`\nFetched ${fetched} quests, ${notFound} not found.`);
  }

  // Write enriched data: quest ID → API response
  const enrichedPath = join(ENRICHED_DIR, 'quests-api.json');
  const enrichedData: Record<string, BlizzardQuestResponse> = {};
  for (const [id, data] of cache) {
    if (questIds.has(id)) {
      enrichedData[id] = data;
    }
  }
  await writeFile(enrichedPath, JSON.stringify(enrichedData, null, 2));
  console.log(`\nWrote ${Object.keys(enrichedData).length} enriched quests to ${enrichedPath}`);

  // Save full cache
  await saveCache(cache);
  console.log('Cache saved.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
