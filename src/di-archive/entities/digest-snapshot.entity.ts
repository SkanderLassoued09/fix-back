import * as mongoose from 'mongoose';
import { Document } from 'mongoose';

/**
 * Daily snapshot of DiArchive completion metrics — captured at each
 * digest run for trend comparisons (day-over-day, week-over-week).
 *
 * `date` is normalized to a Tunis-midnight timestamp so day boundaries
 * align with the operational schedule (the cron fires at 08:00
 * Africa/Tunis). A unique index on `date` makes the daily upsert
 * idempotent — re-running the digest the same day mutates the existing
 * row instead of duplicating it, so the collection stays at exactly one
 * doc per business day.
 *
 * READ paths use these to compute:
 *   - trend jour  : todayIncompletes − yesterdayIncompletes
 *   - trend semaine : sevenDaysAgoIncompletes − todayIncompletes
 * A missing comparison row is not an error — the embed adapts its copy
 * (« première mesure » or omits the weekly line).
 */
export const DigestSnapshotSchema = new mongoose.Schema(
  {
    // Tunis-midnight timestamp — the business day the metric belongs to.
    // Unique so re-runs upsert the existing row (no duplicate per day).
    date: { type: Date, required: true, unique: true, index: true },

    totalDiArchive: { type: Number, required: true, default: 0 },
    totalIncompletes: { type: Number, required: true, default: 0 },
    completudePct: { type: Number, required: true, default: 100 },

    missingFacture: { type: Number, required: true, default: 0 },
    missingBc: { type: Number, required: true, default: 0 },
    missingBl: { type: Number, required: true, default: 0 },
    missingDevis: { type: Number, required: true, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

export interface DigestSnapshotDocument extends Document {
  date: Date;
  totalDiArchive: number;
  totalIncompletes: number;
  completudePct: number;
  missingFacture: number;
  missingBc: number;
  missingBl: number;
  missingDevis: number;
  createdAt: Date;
  updatedAt: Date;
}
