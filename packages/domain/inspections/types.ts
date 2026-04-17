// packages/domain/inspections/types.ts
export type TimestampISO = string;
export type UUID = string;
export type QueenStatus =
  | 'seen'
  | 'not_seen'
  | 'queen_cells_present'
  | 'suspected_missing'
  | 'unknown';
export type BroodPattern = 'solid' | 'spotty' | 'none' | 'unknown';
export type Temperament = 'calm' | 'normal' | 'defensive' | 'aggressive' | 'unknown';
export type FrameSide = 'front' | 'back';
export type DiseaseFlag =
  | 'varroa'
  | 'chalkbrood'
  | 'foulbrood'
  | 'small_hive_beetle'
  | 'wax_moth'
  | 'none'
  | 'unknown';
export type ImageQualityIssue =
  | 'blur'
  | 'low_light'
  | 'glare'
  | 'partial_frame'
  | 'obstructed'
  | 'none';
export interface SideComposition {
  honeyPct: number | null;
  cappedBroodPct: number | null;
  openBroodPct: number | null;
  pollenPct: number | null;
  eggsPresent: boolean | null;
}
export interface FrameObservation {
  frameNumber: number;
  framePositionLabel?: string | null;
  front: SideComposition | null;
  back: SideComposition | null;
  notes: string | null;
  diseaseFlags: DiseaseFlag[];
}
export interface FramePhoto {
  id: UUID;
  hiveId: UUID;
  inspectionId: UUID | null;
  frameNumber: number | null;
  side: FrameSide | null;
  capturedAt: TimestampISO;
  uploadedAt: TimestampISO | null;
  storageKey: string | null;
  localPreviewUrl?: string | null;
}
export interface FramePhotoAnalysis {
  photoId: UUID;
  analyzedAt: TimestampISO;
  confidence: number | null;
  detectedQueen: boolean | null;
  composition: SideComposition | null;
  diseaseFlags: DiseaseFlag[];
  imageQualityIssues: ImageQualityIssue[];
  notes: string | null;
}
export interface InspectionDraft {
  hiveId: UUID;
  startedAt: TimestampISO;
  endedAt: TimestampISO | null;
  queenStatus: QueenStatus;
  broodPattern: BroodPattern;
  temperament: Temperament;
  populationEstimate: string | null;
  notes: string | null;
  frameObservations: FrameObservation[];
  framePhotos: FramePhoto[];
}
export interface InspectionRecord {
  id: UUID;
  hiveId: UUID;
  inspectedAt: TimestampISO;
  queenStatus: QueenStatus;
  broodPattern: BroodPattern;
  temperament: Temperament;
  populationEstimate: string | null;
  notes: string | null;
  frameObservations: FrameObservation[];
  createdAt: TimestampISO;
  updatedAt: TimestampISO;
}
export interface InspectionSummary {
  inspectionId: UUID;
  hiveId: UUID;
  inspectedAt: TimestampISO;
  queenStatus: QueenStatus;
  broodPattern: BroodPattern;
  notableDiseaseFlags: DiseaseFlag[];
  frameCountObserved: number;
  hasPhotos: boolean;
  notesPreview: string | null;
}
