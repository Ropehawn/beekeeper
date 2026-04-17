// packages/domain/intelligence/types.ts
export type TimestampISO = string;
export type UUID = string;
export type PredictionType =
  | 'swarm_risk'
  | 'queen_status'
  | 'varroa_load'
  | 'harvest_timing'
  | 'winter_survival'
  | 'disease_risk'
  | 'queen_quality'
  | 'requeen_timing';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type ReadinessState = 'ready' | 'partial' | 'not_ready';
export interface Evidence {
  signal: string;
  observation: string;
  contribution: number | null;
  sourceKind: 'sensor' | 'audio' | 'vision' | 'thermal' | 'inspection' | 'derived' | null;
  sourceId: UUID | null;
  recordedAt: TimestampISO | null;
  literatureRef: string | null;
}
export interface Prediction {
  id: UUID;
  hiveId: UUID;
  type: PredictionType;
  confidence: number;
  horizonDays: number | null;
  computedAt: TimestampISO;
  validUntil: TimestampISO | null;
  value: Record<string, unknown>;
  evidence: Evidence[];
}
export interface Alert {
  id: UUID;
  hiveId: UUID;
  severity: AlertSeverity;
  title: string;
  message: string;
  createdAt: TimestampISO;
  acknowledgedAt: TimestampISO | null;
  relatedPredictionId: UUID | null;
}
export interface ScoreComponent {
  key:
    | 'population'
    | 'queen_brood'
    | 'stores'
    | 'disease_pest'
    | 'behavior'
    | 'environment';
  score: number;
  reason: string | null;
}
export interface HealthScore {
  hiveId: UUID;
  score: number;
  computedAt: TimestampISO;
  components: ScoreComponent[];
}
export interface Readiness {
  hiveId: UUID;
  predictionType: PredictionType;
  state: ReadinessState;
  missingSignals: string[];
  degradedSignals: string[];
}
