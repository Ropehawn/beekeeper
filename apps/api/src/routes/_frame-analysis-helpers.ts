/**
 * Shared helpers for frame photo analysis routes.
 *
 * Used by:
 *   - frame-photos.ts      (base64 analyze route — DEPRECATED)
 *   - frame-photo-actions.ts (R2 analyze-by-photoId route)
 *
 * Both analyze paths produce identical response shapes and identical domain
 * event payloads. All logic that must stay in sync lives here.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ImageQualityIssue, DiseaseFlag } from "@beekeeper/shared";
import { logger } from "../lib/logger";

// ── Prompt ───────────────────────────────────────────────────────────────────
// Must be kept in sync with the AnalysisData type and the parsers below.
// ImageQualityIssue values are listed explicitly so the model uses exact strings.

export const FRAME_ANALYSIS_PROMPT = `You are analyzing a photograph of one side of a beehive frame.
Estimate the approximate percentage of visible comb cells occupied by each content type.

Return ONLY a valid JSON object with no other text or markdown:
{
  "honey": <integer 0-100>,
  "brood": <integer 0-100>,
  "open_comb": <integer 0-100>,
  "pollen": <integer 0-100>,
  "frame_visible_pct": <integer 0-100>,
  "image_quality_score": <integer 0-100>,
  "image_quality_issues": [],
  "confidence": <integer 0-100>,
  "disease_flags": [],
  "notes": "<short observation if anything notable, else empty string>"
}

Rules:
- honey + brood + open_comb + pollen should not exceed 100
- empty cells, foundation, and undrawn comb count toward open_comb
- frame_visible_pct: what percentage of the full frame side is visible in this photo
  (100 = full frame visible, 50 = roughly half the frame is cut off or outside frame)
- image_quality_score: 0-100 overall image quality for beehive cell analysis
- image_quality_issues: array of zero or more values from this EXACT list only —
  "blurry" | "too_dark" | "too_bright" | "glare" | "partial_frame" | "wrong_subject" | "obstructed"
- confidence: 90+ = clear photo, clearly identifiable contents; 70-89 = somewhat unclear; below 70 = poor quality
- disease_flags: array of objects, each with:
    "type": one of varroa_mites_visible | chalkbrood | afb_signs | efb_signs | sacbrood | small_hive_beetles | wax_moths
    "confidence": integer 0-100 (how certain you are of this flag)
    "description": short string describing what you saw
  Include only clearly visible signs. Empty array if none.
- If this is not a beehive frame photo: add "wrong_subject" to image_quality_issues,
  set confidence to 0, set all percentage fields to 0`;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AnalysisData {
  honey: number;
  brood: number;
  open_comb: number;
  pollen: number;
  frame_visible_pct: number;
  image_quality_score: number;
  image_quality_issues: ImageQualityIssue[];
  confidence: number;
  disease_flags: DiseaseFlag[];
  notes: string;
}

export const ZERO_ANALYSIS: AnalysisData = {
  honey: 0,
  brood: 0,
  open_comb: 0,
  pollen: 0,
  frame_visible_pct: 0,
  image_quality_score: 0,
  image_quality_issues: [],
  confidence: 0,
  disease_flags: [],
  notes: "",
};

// ── Parsers ──────────────────────────────────────────────────────────────────

const VALID_QUALITY_ISSUES = new Set<ImageQualityIssue>([
  "blurry", "too_dark", "too_bright", "glare",
  "partial_frame", "wrong_subject", "obstructed",
]);

export function clamp(v: unknown): number {
  return Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
}

export function parseImageQualityIssues(issues: unknown): ImageQualityIssue[] {
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (i): i is ImageQualityIssue =>
      typeof i === "string" && VALID_QUALITY_ISSUES.has(i as ImageQualityIssue)
  );
}

export function parseDiseaseFlags(flags: unknown): DiseaseFlag[] {
  if (!Array.isArray(flags)) return [];
  const result: DiseaseFlag[] = [];
  for (const f of flags) {
    if (
      f !== null &&
      typeof f === "object" &&
      typeof (f as Record<string, unknown>).type === "string" &&
      typeof (f as Record<string, unknown>).confidence === "number" &&
      typeof (f as Record<string, unknown>).description === "string"
    ) {
      result.push({
        type: String((f as Record<string, unknown>).type),
        confidence: clamp((f as Record<string, unknown>).confidence),
        description: String((f as Record<string, unknown>).description).slice(0, 500),
      });
    }
  }
  return result;
}

export function parseAnalysis(parsed: Record<string, unknown>): AnalysisData {
  return {
    honey: clamp(parsed.honey),
    brood: clamp(parsed.brood),
    open_comb: clamp(parsed.open_comb),
    pollen: clamp(parsed.pollen),
    frame_visible_pct: clamp(parsed.frame_visible_pct),
    image_quality_score: clamp(parsed.image_quality_score),
    image_quality_issues: parseImageQualityIssues(parsed.image_quality_issues),
    confidence: clamp(parsed.confidence),
    disease_flags: parseDiseaseFlags(parsed.disease_flags),
    notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 500) : "",
  };
}

// ── Claude Vision call ────────────────────────────────────────────────────────

/**
 * Calls Claude Vision with a base64-encoded image and returns:
 *   - rawAnthropicMessage: the full Anthropic API envelope (always set if the API call succeeded,
 *     null if the API threw before returning)
 *   - analysisData: parsed AnalysisData (ZERO_ANALYSIS with a failure note on any error)
 *   - normalizedResult: parsed AnalysisData if successful, null if parsing failed
 *
 * Never throws — all errors are caught and reflected in the returned values.
 */
export async function callClaudeVision(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
  modelVersion: string
): Promise<{
  rawAnthropicMessage: Record<string, unknown> | null;
  analysisData: AnalysisData;
  normalizedResult: AnalysisData | null;
}> {
  const client = new Anthropic({ apiKey });
  let rawAnthropicMessage: Record<string, unknown> | null = null;
  let normalizedResult: AnalysisData | null = null;
  let analysisData: AnalysisData = { ...ZERO_ANALYSIS };

  try {
    const message = await client.messages.create({
      model: modelVersion,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                data: imageBase64,
              },
            },
            { type: "text", text: FRAME_ANALYSIS_PROMPT },
          ],
        },
      ],
    });

    // Capture the full Anthropic envelope immediately — before any parsing.
    rawAnthropicMessage = message as unknown as Record<string, unknown>;

    const rawText = message.content[0].type === "text" ? message.content[0].text : "";

    // Extract JSON — handle markdown code-fence wrapping (```json ... ```)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in AI response");

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    analysisData = parseAnalysis(parsed);
    normalizedResult = analysisData;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Claude Vision error"
    );
    analysisData = { ...ZERO_ANALYSIS, notes: "Analysis failed — see server logs" };
    // rawAnthropicMessage is kept as-is:
    //   null     → API threw before returning (e.g. timeout, auth error)
    //   non-null → API returned but parsing failed (message preserved for debugging)
  }

  return { rawAnthropicMessage, analysisData, normalizedResult };
}
