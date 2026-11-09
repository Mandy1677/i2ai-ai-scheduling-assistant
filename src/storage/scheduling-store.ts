import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Category, RequestType, SchedulingAnalysis, Timing } from '../analysis/validation';
import { rankOf, sortByPriority, type RankableItem } from '../ranking/priority';
import { transaction } from './database';

// Validated scheduling items (ARCHITECTURE section 5, "Scheduling item").
// Holds only scheduling essentials and a scheduling-only summary.

export interface SchedulingItem extends RankableItem {
  id: string;
  requestType: RequestType;
  summary: string;
  timing: Timing | null;
  existingMeetingReference: string | null;
  evidence: string[];
  reviewNotes: string[];
  redactionFailed: boolean;
  priorityRank: number;
  promptVersion: string | null;
  model: string | null;
  confirmationState: 'confirmed' | 'unconfirmed';
}

export interface SaveMeta {
  processingItemId: string;
  receivedAt: string | null;
  sourceKey: string;
  promptVersion: string | null;
  model: string | null;
  redactionFailed: boolean;
  now: string;
}

interface Row {
  id: string;
  request_type: RequestType;
  category: Category | null;
  summary: string;
  timing_json: string | null;
  urgency_json: string | null;
  confirmation_state: 'confirmed' | 'unconfirmed';
  existing_meeting_ref: string | null;
  evidence_json: string | null;
  review_notes_json: string | null;
  prompt_version: string | null;
  analysis_model: string | null;
  redaction_failed: number;
  received_at: string | null;
  priority_rank: number;
  urgent: number;
  deadline: string | null;
  source_key: string;
}

const CONFIRMED: RequestType[] = ['confirmed-appointment', 'confirmed-reschedule'];

export class SchedulingStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Creates or replaces the scheduling item for one processed message. */
  save(analysis: SchedulingAnalysis, meta: SaveMeta): string {
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT scheduling_item_id AS id FROM scheduling_item_sources WHERE processing_item_id = ?')
        .get(meta.processingItemId) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      const values = [
        analysis.requestType,
        analysis.category,
        analysis.summary,
        JSON.stringify(analysis.timing),
        JSON.stringify(analysis.urgency),
        CONFIRMED.includes(analysis.requestType) ? 'confirmed' : 'unconfirmed',
        analysis.existingMeetingReference,
        JSON.stringify(analysis.evidence),
        JSON.stringify(analysis.reviewNotes),
        meta.promptVersion,
        meta.model,
        meta.redactionFailed ? 1 : 0,
        meta.receivedAt,
        rankOf(analysis.category),
        analysis.urgency.explicit ? 1 : 0,
        analysis.urgency.deadline,
        meta.now,
      ];
      if (existing) {
        this.db
          .prepare(
            `UPDATE scheduling_items SET request_type = ?, category = ?, summary = ?, timing_json = ?, urgency_json = ?,
               confirmation_state = ?, existing_meeting_ref = ?, evidence_json = ?, review_notes_json = ?,
               prompt_version = ?, analysis_model = ?, redaction_failed = ?, received_at = ?, priority_rank = ?,
               urgent = ?, deadline = ?, updated_at = ? WHERE id = ?`,
          )
          .run(...values, id);
      } else {
        this.db
          .prepare(
            `INSERT INTO scheduling_items (request_type, category, summary, timing_json, urgency_json,
               confirmation_state, existing_meeting_ref, evidence_json, review_notes_json, prompt_version,
               analysis_model, redaction_failed, received_at, priority_rank, urgent, deadline, updated_at,
               created_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...values, meta.now, id);
        this.db
          .prepare('INSERT INTO scheduling_item_sources (scheduling_item_id, processing_item_id) VALUES (?, ?)')
          .run(id, meta.processingItemId);
      }
      return id;
    });
  }

  /** All items in the fixed priority order (PRD F04). */
  listByPriority(): SchedulingItem[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, p.account_id || ':' || p.source_message_id AS source_key
         FROM scheduling_items s
         JOIN scheduling_item_sources l ON l.scheduling_item_id = s.id
         JOIN processing_items p ON p.id = l.processing_item_id`,
      )
      .all() as unknown as Row[];
    return sortByPriority(rows.map(toItem));
  }
}

function toItem(row: Row): SchedulingItem {
  return {
    id: row.id,
    requestType: row.request_type,
    category: row.category,
    summary: row.summary,
    timing: row.timing_json ? (JSON.parse(row.timing_json) as Timing) : null,
    existingMeetingReference: row.existing_meeting_ref,
    evidence: row.evidence_json ? (JSON.parse(row.evidence_json) as string[]) : [],
    reviewNotes: row.review_notes_json ? (JSON.parse(row.review_notes_json) as string[]) : [],
    redactionFailed: row.redaction_failed === 1,
    priorityRank: row.priority_rank,
    promptVersion: row.prompt_version,
    model: row.analysis_model,
    confirmationState: row.confirmation_state,
    urgentExplicit: row.urgent === 1,
    deadline: row.deadline,
    receivedAt: row.received_at,
    sourceKey: row.source_key,
  };
}
