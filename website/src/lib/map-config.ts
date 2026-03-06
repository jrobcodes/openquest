export interface ZoneConfig {
  key: string;
  name: string;
  mapId: number;
  // Image dimensions (will be set based on actual map images)
  imageWidth: number;
  imageHeight: number;
}

export const zones: ZoneConfig[] = [
  { key: 'eversong', name: 'Eversong Woods', mapId: 2395, imageWidth: 3840, imageHeight: 2560 },
  { key: 'zulaman', name: "Zul'Aman", mapId: 2437, imageWidth: 3840, imageHeight: 2560 },
  { key: 'harandar', name: 'Harandar', mapId: 2413, imageWidth: 3840, imageHeight: 2560 },
  { key: 'voidstorm', name: 'Voidstorm', mapId: 2405, imageWidth: 3840, imageHeight: 2560 },
];

// Map zone names (as they appear in data) to zone keys
export const zoneNameToKey: Record<string, string> = {
  'Eversong Woods': 'eversong',
  "Zul'Aman": 'zulaman',
  'Harandar': 'harandar',
  'Voidstorm': 'voidstorm',
};

export const zoneKeyToName: Record<string, string> = {
  'eversong': 'Eversong Woods',
  'zulaman': "Zul'Aman",
  'harandar': 'Harandar',
  'voidstorm': 'Voidstorm',
};

export function getZoneByKey(key: string): ZoneConfig | undefined {
  return zones.find(z => z.key === key);
}

// Action type colors for route visualization
export const actionColors: Record<string, string> = {
  accept: '#22c55e',   // green
  turnin: '#3b82f6',   // blue
  objective: '#eab308', // yellow
  collect: '#a855f7',   // purple
  travel: '#6b7280',    // gray
};
