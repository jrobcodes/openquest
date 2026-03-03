// OpenQuest — Shared Types

export interface Coord {
  x: number;
  y: number;
  z?: number;
  mapId: number;
}

export interface Objective {
  index: number;
  type: number; // 0=monster, 1=item, 2=object, 3=area, etc.
  description: string;
  amount: number;
  locations: Coord[];
}

export interface Rewards {
  xp?: number;
  gold?: number;
  items?: { id: number; name: string; quantity: number }[];
  reputation?: { factionId: number; factionName: string; amount: number }[];
}

export interface Quest {
  id: number;
  title: string;
  description: string;
  questLineId: number;
  questLineName: string;
  orderIndex: number;
  zone: string;
  mapId: number;
  acceptLocation: Coord | null;
  turnInLocation: Coord | null;
  objectiveLocations: Coord[];
  objectives: Objective[];
  rewards: Rewards;
  flags: {
    isCampaign: boolean;
    isLocalStory: boolean;
    isImportant: boolean;
  };
  prerequisites: number[]; // quest IDs that must complete first
  level?: number;
  questType?: number;
}

export interface Extra {
  id: number;
  type: 'glyph' | 'treasure' | 'rare';
  name: string;
  location: Coord;
  trackingQuestId?: number; // for completion detection
  achievementId?: number;
  zone: string;
}

export interface GuideStep {
  stepNumber: number;
  action: 'accept' | 'objective' | 'turnin' | 'travel' | 'collect';
  questId?: number;
  questTitle?: string;
  description: string;
  location: Coord;
  mapId: number;
  zone: string;
  extraType?: 'glyph' | 'treasure' | 'rare';
}

// DAG types
export interface DAGNode {
  questId: number;
  prerequisites: number[];
  dependents: number[];
  questLineId: number;
  orderIndex: number;
}

export interface DAG {
  nodes: Map<number, DAGNode>;
  roots: number[]; // quest IDs with no prerequisites
}

// Zone types
export interface ZoneInfo {
  mapId: number;
  name: string;
  quests: Quest[];
  extras: Extra[];
}

export interface ZoneTransition {
  fromMapId: number;
  toMapId: number;
  travelCost: number; // estimated distance
}

// Raw DB2 row types (from CASC extraction)
export interface RawQuestLine {
  ID: number;
  Name: string;
  Flags?: number;
}

export interface RawQuestLineXQuest {
  ID: number;
  QuestLineID: number;
  QuestID: number;
  OrderIndex: number;
  Flags?: number;
}

export interface RawQuestObjective {
  ID: number;
  QuestID: number;
  Type: number;
  ObjectID: number;
  Amount: number;
  Description: string;
  OrderIndex: number;
}

export interface RawQuestPOIBlob {
  _ID: number;
  ID: number;
  QuestID: number;
  ObjectiveIndex: number;
  MapID: number;
  UiMapID: number;
  NumPoints: number;
  PlayerConditionID?: number;
}

export interface RawQuestPOIPoint {
  ID: number;
  QuestPOIBlobID: number;
  X: number;
  Y: number;
  Z: number;
  PointIndex?: number;
}

export interface RawAreaPOI {
  ID: number;
  Name: string;
  Description?: string;
  Pos: [number, number];
  ContinentID?: number;
  AreaID?: number;
  Flags?: number;
  UiMapID?: number;
}

// Blizzard API response types
export interface BlizzardQuestResponse {
  id: number;
  title: string;
  description?: string;
  requirements?: {
    min_character_level?: number;
    max_character_level?: number;
  };
  rewards?: {
    experience?: number;
    money?: { value: number };
    items?: { item: { id: number; name: string }; quantity: number }[];
    reputations?: { reward: { id: number; name: string }; value: number }[];
  };
}
