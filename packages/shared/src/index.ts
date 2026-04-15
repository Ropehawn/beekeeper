// Component type specs matching wireframe 3D model
export const COMPONENT_SPECS = {
  "bottom-board": { label: "Bottom Board", w: 120, h: 6, d: 60, color: "#4a3728" },
  "entrance-reducer": { label: "Entrance Reducer", w: 120, h: 4, d: 10, color: "#5a4a3a" },
  "brood-box": { label: "Brood Box", w: 120, h: 60, d: 60, color: "#d4a052" },
  "queen-excluder": { label: "Queen Excluder", w: 120, h: 3, d: 60, color: "#b0b0b0" },
  "honey-super": { label: "Honey Super", w: 120, h: 40, d: 60, color: "#e8c96a" },
  "top-feeder": { label: "Top Feeder", w: 120, h: 20, d: 60, color: "#6a9fd8" },
  "inner-cover": { label: "Inner Cover", w: 124, h: 4, d: 64, color: "#c4a882" },
  "outer-cover": { label: "Outer Cover", w: 130, h: 8, d: 68, color: "#8b7355" },
} as const;

export type ComponentType = keyof typeof COMPONENT_SPECS;

export type UserRole = "queen" | "worker" | "spectator";

export type FrameSide = "front" | "back";

export type FrameSegments = {
  honey: number;
  brood: number;
  open: number;
  pollen: number;
};

// ── Frame Analysis (V2) ────────────────────────────────────────

/**
 * Specific image quality issues Claude may report.
 * Exhaustive union — any value not in this list is filtered out by the route parser.
 */
export type ImageQualityIssue =
  | "blurry"         // image is out of focus
  | "too_dark"       // underexposed, hard to distinguish cell contents
  | "too_bright"     // overexposed / washed out
  | "glare"          // reflective glare obscuring cells
  | "partial_frame"  // less than ~80% of the frame side is visible
  | "wrong_subject"  // image does not primarily show a beehive frame
  | "obstructed";    // bees, fingers, or equipment blocking significant comb area

/**
 * A disease or pest flag returned by Claude Vision.
 * Stored as objects (not strings) so confidence and description are preserved.
 */
export interface DiseaseFlag {
  type: string;        // varroa_mites_visible | chalkbrood | afb_signs | efb_signs | sacbrood | small_hive_beetles | wax_moths
  confidence: number;  // 0-100
  description: string; // what Claude saw that triggered this flag
}

/**
 * Normalised output of a Claude Vision frame analysis.
 * Returned by POST /api/v1/frames/:frameId/analyze and stored in
 * FrameAiObservation.normalizedResponse.
 */
export interface FrameAnalysisResult {
  photoId: string;
  side: FrameSide;
  honey: number;              // 0-100 % of visible comb
  brood: number;              // 0-100 % of visible comb
  open_comb: number;          // 0-100 % of visible comb
  pollen: number;             // 0-100 % of visible comb
  frame_visible_pct: number;  // 0-100: how much of the frame side appears in the photo
  image_quality_score: number;         // 0-100 overall image quality
  image_quality_issues: ImageQualityIssue[];
  confidence: number;         // 0-100 overall analysis confidence
  disease_flags: DiseaseFlag[];
  notes: string;
}

export interface FrameObservationInput {
  frameId: string;
  inspectionId?: string;
  frontHoney?: number;
  frontBrood?: number;
  frontOpen?: number;
  frontPollen?: number;
  backHoney?: number;
  backBrood?: number;
  backOpen?: number;
  backPollen?: number;
  queenSpotted?: boolean;
  notes?: string;
  /** UUIDs of FramePhoto rows that informed this observation (one per side, max 2). */
  sourcePhotoIds?: string[];
  /** UUIDs of FrameAiObservation rows — parallel array to sourcePhotoIds. */
  sourceAiObservationIds?: string[];
}

export interface ReceiptExtractionResult {
  vendor: string;
  date: string;
  order_ref: string | null;
  total: number;
  subtotal?: number;
  tax: number | null;
  type: "expense" | "income";
  category: "Equipment" | "Bees" | "Supplies" | "Treatment" | "Honey Sales" | "Other";
  description: string;
  confidence: number;
  line_items: {
    qty: number | null;
    sku: string | null;
    description: string;
    unit_price: number | null;
    amount: number;
  }[];
}
