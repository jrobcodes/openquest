/**
 * Guide Output — Generates structured guide steps and exports
 * as JSON (for addon + web) and Lua table (for WoW addon).
 */

import type { GuideStep } from '../shared/types.js';

/**
 * Export guide as JSON string.
 */
export function toJSON(steps: GuideStep[]): string {
  return JSON.stringify(steps, null, 2);
}

/**
 * Escape a string for Lua.
 */
function luaEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

/**
 * Export guide as a Lua table string for the WoW addon.
 *
 * Output format:
 * ```lua
 * OpenQuestGuide = {
 *   { step = 1, action = "accept", questId = 12345, ... },
 *   ...
 * }
 * ```
 */
export function toLua(steps: GuideStep[], varName: string = 'OpenQuestGuide'): string {
  const lines: string[] = [];
  lines.push(`${varName} = {`);

  for (const step of steps) {
    const fields: string[] = [];
    fields.push(`step = ${step.stepNumber}`);
    fields.push(`action = "${step.action}"`);

    if (step.questId !== undefined) {
      fields.push(`questId = ${step.questId}`);
    }
    if (step.questTitle) {
      fields.push(`questTitle = "${luaEscape(step.questTitle)}"`);
    }

    fields.push(`description = "${luaEscape(step.description)}"`);
    fields.push(`x = ${step.location.x.toFixed(4)}`);
    fields.push(`y = ${step.location.y.toFixed(4)}`);

    if (step.location.z !== undefined) {
      fields.push(`z = ${step.location.z.toFixed(4)}`);
    }

    fields.push(`mapId = ${step.mapId}`);
    fields.push(`zone = "${luaEscape(step.zone)}"`);

    if (step.mapX !== undefined && step.mapY !== undefined) {
      fields.push(`mapX = ${step.mapX.toFixed(4)}`);
      fields.push(`mapY = ${step.mapY.toFixed(4)}`);
    }

    if (step.extraType) {
      fields.push(`extraType = "${step.extraType}"`);
    }

    if (step.trackingQuestId !== undefined) {
      fields.push(`trackingQuestId = ${step.trackingQuestId}`);
    }

    if (step.npcName) {
      fields.push(`npcName = "${luaEscape(step.npcName)}"`);
    }

    if (step.level) {
      fields.push(`level = ${step.level}`);
    }

    if (step.isCampaign) {
      fields.push(`isCampaign = true`);
    }

    lines.push(`  { ${fields.join(', ')} },`);
  }

  lines.push('}\n');
  return lines.join('\n');
}

/**
 * Generate route statistics for verification.
 */
export function routeStats(steps: GuideStep[]): {
  totalSteps: number;
  accepts: number;
  objectives: number;
  turnins: number;
  collects: number;
  travels: number;
  uniqueQuests: number;
  extras: { glyphs: number; treasures: number; rares: number };
  zones: string[];
} {
  const quests = new Set<number>();
  let accepts = 0, objectives = 0, turnins = 0, collects = 0, travels = 0;
  let glyphs = 0, treasures = 0, rares = 0;
  const zones = new Set<string>();

  for (const step of steps) {
    if (step.questId) quests.add(step.questId);
    zones.add(step.zone);

    switch (step.action) {
      case 'accept': accepts++; break;
      case 'objective': objectives++; break;
      case 'turnin': turnins++; break;
      case 'collect': collects++; break;
      case 'travel': travels++; break;
    }

    switch (step.extraType) {
      case 'glyph': glyphs++; break;
      case 'treasure': treasures++; break;
      case 'rare': rares++; break;
    }
  }

  return {
    totalSteps: steps.length,
    accepts,
    objectives,
    turnins,
    collects,
    travels,
    uniqueQuests: quests.size,
    extras: { glyphs, treasures, rares },
    zones: [...zones],
  };
}
