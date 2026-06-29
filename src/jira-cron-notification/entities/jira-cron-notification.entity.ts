import mongoose, { Document } from 'mongoose';

/**
 * JiraCronNotification — ingestion queue for Jira issues. The standalone crons
 * (ACTION=SYNC_JIRA_DUE_SOON / SYNC_JIRA_TASKS) upsert one row per issue PER DAY
 * in status PENDING; a SEPARATE Discord-sender flow (out of scope) later picks
 * up PENDING rows, sends them, and flips the status.
 *
 * Collection: `jira_cron_notifications`.
 *
 * Dedup contract: `dedupeKey = `{issueKey}:{YYYY-MM-DD}`` (the day in
 * Africa/Tunis) is UNIQUE. Ingestion uses
 * `updateOne({ dedupeKey }, { $setOnInsert: … }, { upsert:true })`, so within a
 * day re-polling the same issue NEVER creates a duplicate and NEVER resurrects a
 * row already PROCESSED/FAILED that day. The NEXT day produces a new key ⇒ a
 * fresh PENDING (daily "re-nudge" until the task is done). The unique index also
 * guards against a concurrent double-run.
 */

export type JiraCronNotificationStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'FAILED';

export const JiraCronNotificationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    // Idempotency key — `{issueKey}:{YYYY-MM-DD}` (Africa/Tunis day). Unique so a
    // concurrent double-run can't insert the same issue twice the same day, and
    // a new day yields a new key (daily re-nudge).
    dedupeKey: { type: String, required: true, unique: true, index: true },
    source: { type: String, default: 'JIRA' },
    issueKey: { type: String },
    titre: { type: String },
    // Assignee — email when Jira exposes it, else display name, else null.
    responsable: { type: String, default: null },
    echeance: { type: Date, default: null },
    url: { type: String },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
  },
  { timestamps: true, collection: 'jira_cron_notifications' },
);

export type JiraCronNotificationDocument = Document & {
  status: JiraCronNotificationStatus;
  dedupeKey: string;
  source: string;
  issueKey: string;
  titre: string;
  responsable: string | null;
  echeance: Date | null;
  url: string;
  attempts: number;
  lastError: string | null;
};
