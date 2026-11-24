// The weekly Design Quality rubric — the 23-point version from the
// "Design Quality Metric Rubric" Google Sheet. Each criterion earns 0, ½ or 1
// point. Keys are stored with every graded piece (design_quality_pieces.scores),
// so never reuse or renumber a key: add a new key and bump RUBRIC_VERSION if
// the rubric changes, so old grades still read against the criteria they
// were scored on.

export const RUBRIC_VERSION = 'v23';

export interface RubricCriterion {
  key: string;
  text: string;
}

export interface RubricSection {
  title: string;
  criteria: RubricCriterion[];
}

export const RUBRIC: RubricSection[] = [
  {
    title: 'Bloom Rules',
    criteria: [
      { key: 'bloom_template_shape', text: "Blooms follow the template shape, while taking the client's requests into consideration" },
      { key: 'bloom_tilt', text: 'Flowers in the middle are tilted in the correct direction that the template dictates' },
      { key: 'bloom_color_distribution', text: 'Colors are evenly distributed throughout the design' },
      { key: 'bloom_types_spread', text: "Same flower types aren't next each other and evenly distributed throughout the design" },
      { key: 'bloom_no_center_placement', text: 'No center of any flower is in the bottom middle or in the exact center of the design as a whole' },
      { key: 'bloom_centers_visible', text: "Flower centers aren't covered up by other flowers or greenery" },
      { key: 'bloom_repaired', text: 'Blooms were repaired to look natural if there was a gap between petals. The centers of the flowers were cleaned of any pieces left from preservation.' },
    ],
  },
  {
    title: 'Greenery Rules',
    criteria: [
      { key: 'greenery_organic', text: 'Greenery is organically designed. Organic placement means greenery is in clumps that display the varieties in the bouquet and shows balanced color' },
      { key: 'greenery_outside_direction', text: 'Greenery face the correct direction on the outside of the design according to the template' },
      { key: 'greenery_middle_direction', text: 'Greenery face the correct direction in the middle of the design according to the template lines' },
      { key: 'greenery_staggered', text: 'Greenery placement is staggered and not all the same length' },
      { key: 'greenery_perimeter', text: 'Greenery goes around the whole perimeter of the design' },
      { key: 'greenery_frame_edge', text: "Greenery/flowers don't touch the edge of the frame (excluding designs where the template dictates flower placement on the edge)" },
    ],
  },
  {
    title: 'Overall Balance',
    criteria: [
      { key: 'balance_filler_middle', text: 'Filler flowers and greenery are placed throughout the middle of the design' },
      { key: 'balance_no_overcrowding', text: "There isn't overcrowding in the middle of the design" },
      { key: 'balance_negative_space', text: "Negative space/greenery are distributed evenly throughout the frame (if bouquet was more dense, its okay to be dense but make sure it's evenly dense across the design)" },
      { key: 'balance_centered', text: 'The design is centered within the frame' },
    ],
  },
  {
    title: 'Quality',
    criteria: [
      { key: 'quality_no_shadows', text: 'No harsh shadows are visible' },
      { key: 'quality_cropped_edge', text: 'Image is cropped to the edge of the frame' },
      { key: 'quality_straight', text: 'Image is cropped so it is straight, there is no tilting in any direction.' },
      { key: 'quality_color_adjusted', text: 'The colors of the image are adjusted, if needed, to match the real flowers (not too blue or too warm)' },
      { key: 'quality_in_focus', text: 'The frame is clear and in focus' },
      { key: 'quality_clean_board', text: "The white board looks nice and there aren't any floaties leftover from designing" },
    ],
  },
];

export const RUBRIC_KEYS: string[] = RUBRIC.flatMap(s => s.criteria.map(c => c.key));
export const RUBRIC_MAX = RUBRIC_KEYS.length; // 23

export const SCORE_OPTIONS = [0, 0.5, 1] as const;
export type CriterionScore = (typeof SCORE_OPTIONS)[number];

export function isValidScore(v: unknown): v is CriterionScore {
  return v === 0 || v === 0.5 || v === 1;
}

/** Sum of the criteria scored so far. */
export function pieceTotal(scores: Record<string, number> | null | undefined): number {
  if (!scores) return 0;
  return RUBRIC_KEYS.reduce((s, k) => s + (isValidScore(scores[k]) ? scores[k] : 0), 0);
}

export function scoredCount(scores: Record<string, number> | null | undefined): number {
  if (!scores) return 0;
  return RUBRIC_KEYS.filter(k => isValidScore(scores[k])).length;
}

/**
 * How many frames to grade for someone who worked `hours` in the week:
 * under 20 → 1, 20 up to 30 → 2, 30 or more → 3.
 */
export function piecesForHours(hours: number): number {
  if (hours >= 30) return 3;
  if (hours >= 20) return 2;
  return 1;
}

export const MAX_PIECES = 3;
