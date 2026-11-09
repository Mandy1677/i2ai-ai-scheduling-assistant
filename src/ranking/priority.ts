import type { Category } from '../analysis/validation';

// Fixed priority order from PRD F04, applied locally. The model only
// classifies; it never assigns ranks. Priority orders attention and labels;
// it never moves a confirmed appointment's time.

export const CATEGORY_RANK: Record<Category, number> = {
  patient: 1,
  'thriveworks-pr': 2,
  'business-personal': 3,
  'interactive-foundation': 4,
  pennwest: 5,
};

export const CATEGORY_LABELS: Record<Category, string> = {
  patient: 'Patient',
  'thriveworks-pr': 'Jennifer / Thriveworks PR',
  'business-personal': 'Business Partners / Personal',
  'interactive-foundation': 'Interactive Foundation',
  pennwest: 'PennWest University',
};

/** Unclassified items sort after every business priority; this is not a sixth priority. */
export const UNCLASSIFIED_RANK = 6;

export interface RankableItem {
  category: Category | null;
  urgentExplicit: boolean;
  deadline: string | null;
  receivedAt: string | null;
  /** Stable source identity for deterministic ties. */
  sourceKey: string;
}

export function rankOf(category: Category | null): number {
  return category ? CATEGORY_RANK[category] : UNCLASSIFIED_RANK;
}

/** Readable label, e.g. "P1 Patient" or "Unclassified". */
export function priorityLabel(category: Category | null): string {
  return category ? `P${CATEGORY_RANK[category]} ${CATEGORY_LABELS[category]}` : 'Unclassified';
}

/**
 * Category rank first; within a rank, explicit urgency, then the earlier
 * stated deadline (missing deadlines last), then receipt order, then source.
 */
export function comparePriority(a: RankableItem, b: RankableItem): number {
  return (
    rankOf(a.category) - rankOf(b.category) ||
    Number(b.urgentExplicit) - Number(a.urgentExplicit) ||
    compareNullableAsc(a.deadline, b.deadline) ||
    compareNullableAsc(a.receivedAt, b.receivedAt) ||
    (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0)
  );
}

function compareNullableAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export function sortByPriority<T extends RankableItem>(items: T[]): T[] {
  return [...items].sort(comparePriority);
}
