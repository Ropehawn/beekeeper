// packages/domain/hives/types.ts
export type TimestampISO = string;
export type UUID = string;
export type HiveStatus = 'active' | 'inactive' | 'deadout' | 'merged' | 'unknown';
export type ComponentType =
  | 'bottom_board'
  | 'brood_box'
  | 'medium_super'
  | 'honey_super'
  | 'feeder'
  | 'inner_cover'
  | 'outer_cover'
  | 'queen_excluder'
  | 'spacer'
  | 'unknown';
export type FrameStatus =
  | 'drawn'
  | 'undrawn'
  | 'brood'
  | 'honey'
  | 'mixed'
  | 'empty'
  | 'unknown';
export interface Apiary {
  id: UUID;
  name: string;
  locationName: string | null;
  timezone: string | null;
  createdAt: TimestampISO;
  updatedAt: TimestampISO;
}
export interface HiveFrame {
  id: UUID;
  frameNumber: number;
  status: FrameStatus;
  notes: string | null;
}
export interface HiveComponent {
  id: UUID;
  type: ComponentType;
  position: number;
  label: string | null;
  frameCount: number;
  frames: HiveFrame[];
}
export interface Hive {
  id: UUID;
  apiaryId: UUID;
  name: string;
  status: HiveStatus;
  strain: string | null;
  installedAt: TimestampISO | null;
  notes: string | null;
  createdAt: TimestampISO;
  updatedAt: TimestampISO;
}
export interface HiveWithStructure extends Hive {
  components: HiveComponent[];
}
export interface HiveSummary {
  hiveId: UUID;
  hiveName: string;
  status: HiveStatus;
  apiaryId: UUID;
  componentCount: number;
  frameCount: number;
  lastInspectionAt: TimestampISO | null;
  latestHealthScore: number | null;
}
