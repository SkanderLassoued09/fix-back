import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { DiArchiveDocument } from './entities/di-archive.entity';
import { DigestSnapshotDocument } from './entities/digest-snapshot.entity';
import { isDocMissing } from './di-archive-filter.util';

// The « document manquant » rule now lives in `di-archive-filter.util` so the
// digest AND the /archives filter share ONE definition. Re-exported here to keep
// the existing import path (`from './di-archive-digest.service'`) working.
export { isDocMissing };

/**
 * DIGEST_DI_ARCHIVE_INCOMPLETES — daily documentary-completion report.
 *
 * Enriched embed with:
 *  - global completion % (complete / total × 100, rounded)
 *  - incompletes count + day-over-day arrow (▼ N depuis hier / ▲ N /
 *    « première mesure »)
 *  - per-document breakdown with fixed emoji colors (🔴 Facture, 🟠 BC,
 *    🟠 BL, 🟡 Devis) and a static « ⚠️ facturation à risque » label
 *    on the facture line
 *  - weekly progress (« N DI complétées cette semaine », omitted when
 *    no ~7d comparison exists or delta is non-positive)
 *
 * Trend data comes from the `digest_snapshots` collection — a single
 * upsert per business day (Africa/Tunis boundaries) makes the write
 * idempotent. This is the ONLY write in the whole pipeline; DiArchive
 * is strictly read-only.
 *
 * Discord errors are swallowed at the `postEmbed` layer (never throws),
 * so an ACTION run always exits cleanly.
 */
@Injectable()
export class DiArchiveDigestService {
  private readonly logger = new Logger(DiArchiveDigestService.name);

  /** Bar width used for the code-block breakdown lines — 12 dots between
   *  the label and the count keeps the block readable at typical Discord
   *  window widths. */
  private static readonly LABEL_WIDTH = 12;

  constructor(
    @InjectModel('DiArchive')
    private readonly diArchiveModel: Model<DiArchiveDocument>,
    @InjectModel('DigestSnapshot')
    private readonly snapshotModel: Model<DigestSnapshotDocument>,
    private readonly discord: DiscordHookService,
  ) {}

  /**
   * Compute the digest + post it + upsert today's snapshot.
   * Returns the summary so the cron trigger can one-line-log it and the
   * tests can assert on numbers without inspecting the Discord payload.
   */
  async buildAndSend(): Promise<{
    total: number;
    totalIncompletes: number;
    completudePct: number;
    missing: { bc: number; bl: number; devis: number; facture: number };
    trendDay: number | null; // yesterdayIncompletes − today (positive = improvement)
    trendWeek: number | null; // sevenDaysAgo − today (positive = improvement)
    posted: boolean;
  }> {
    // ── 1. Read metrics ────────────────────────────────────────────
    // Single pass over the whole collection. `.lean()` returns plain
    // objects (no Mongoose overhead) and we project only the 4 text refs
    // we need — the `DriveDocRef` slots are intentionally IGNORED here
    // (uploads are tracked by a separate future job).
    //
    // Read-only: no writes on DiArchive anywhere in this flow.
    const rows = await this.diArchiveModel
      .find({}, { bcRef: 1, blRef: 1, devisRef: 1, factureRef: 1 })
      .lean();

    const total = rows.length;
    const missing = { bc: 0, bl: 0, devis: 0, facture: 0 };
    let totalIncompletes = 0;
    for (const r of rows as Array<any>) {
      // Per-doc missing → per-doc counter (the 4 counters can and should
      // differ, because the missing pattern is different per column).
      const bcMissing = isDocMissing(r?.bcRef);
      const blMissing = isDocMissing(r?.blRef);
      const devisMissing = isDocMissing(r?.devisRef);
      const factureMissing = isDocMissing(r?.factureRef);
      if (bcMissing) missing.bc++;
      if (blMissing) missing.bl++;
      if (devisMissing) missing.devis++;
      if (factureMissing) missing.facture++;
      // Complétude d'une DI : au moins un manquant ⇒ INCOMPLET.
      if (bcMissing || blMissing || devisMissing || factureMissing) {
        totalIncompletes++;
      }
    }

    // Guard division-by-zero: empty archive = trivially 100% complete.
    const completudePct =
      total === 0 ? 100 : Math.round(((total - totalIncompletes) / total) * 100);

    // ── 2. Fetch trend snapshots ───────────────────────────────────
    const todayKey = this.startOfTunisDay(new Date());
    const yesterdayKey = new Date(todayKey.getTime() - 24 * 60 * 60 * 1000);
    const weekAgoKey = new Date(todayKey.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Day trend: most-recent snapshot strictly before today. Even if the
    // cron missed a day, the previous existing snapshot still yields a
    // meaningful "depuis hier" delta (the label stays « depuis hier » per
    // spec; users understand it as « depuis la dernière mesure »).
    const previous = await this.snapshotModel
      .findOne({ date: { $lt: todayKey } })
      .sort({ date: -1 })
      .lean();
    const trendDay =
      previous != null ? previous.totalIncompletes - totalIncompletes : null;

    // Week trend: the nearest snapshot within (weekAgo ≤ date < today).
    // We pick the OLDEST match so ~7d back is closest to "a week ago"
    // even if the exact day is missing.
    const weekSnap = await this.snapshotModel
      .findOne({ date: { $gte: weekAgoKey, $lt: todayKey } })
      .sort({ date: 1 })
      .lean();
    const trendWeek =
      weekSnap != null ? weekSnap.totalIncompletes - totalIncompletes : null;

    // ── 3. Build embed description (code block for alignment) ──────
    const description = this.buildDescription({
      total,
      totalIncompletes,
      completudePct,
      missing,
      trendDay,
      trendWeek,
    });

    await this.discord.postEmbed('APP_ALERT', {
      embeds: [
        {
          title: '📊 FIXTRONIX · Suivi documentaire DiArchive',
          description,
          color: 16289308, // amber — constant across cases per user spec
          footer: { text: 'Fixtronix · Digest quotidien' },
          timestamp: new Date().toISOString(),
        },
      ],
    });

    // ── 4. Upsert today's snapshot (idempotent, ONLY write) ────────
    // findOneAndUpdate with upsert:true is atomic + idempotent; a second
    // run today mutates the same doc via the unique `date` index.
    await this.snapshotModel.updateOne(
      { date: todayKey },
      {
        $set: {
          totalDiArchive: total,
          totalIncompletes,
          completudePct,
          missingFacture: missing.facture,
          missingBc: missing.bc,
          missingBl: missing.bl,
          missingDevis: missing.devis,
        },
        $setOnInsert: { date: todayKey },
      },
      { upsert: true },
    );

    this.logger.log(
      `DiArchive digest sent: total=${total} incompletes=${totalIncompletes} pct=${completudePct}% ` +
        `facture=${missing.facture} bc=${missing.bc} bl=${missing.bl} devis=${missing.devis} ` +
        `trendDay=${trendDay ?? 'n/a'} trendWeek=${trendWeek ?? 'n/a'}`,
    );

    return {
      total,
      totalIncompletes,
      completudePct,
      missing,
      trendDay,
      trendWeek,
      posted: true,
    };
  }

  // ── Description builder ──────────────────────────────────────────

  private buildDescription(input: {
    total: number;
    totalIncompletes: number;
    completudePct: number;
    missing: { bc: number; bl: number; devis: number; facture: number };
    trendDay: number | null;
    trendWeek: number | null;
  }): string {
    const {
      total,
      totalIncompletes,
      completudePct,
      missing,
      trendDay,
      trendWeek,
    } = input;
    const complete = total - totalIncompletes;
    const sep = '━'.repeat(30);

    // ✅ / ⚠️ header emoji reacts to the completion percentage. Kept in
    // the description (not the embed color) so it never fights the amber
    // brand.
    const headerEmoji = completudePct >= 90 ? '✅' : completudePct >= 70 ? '🟡' : '⚠️';

    const arrow = this.formatDayArrow(trendDay);

    // The breakdown lines live inside a ``` block so Discord renders
    // them in monospace and the dot-padding stays aligned.
    const line = (
      emoji: string,
      label: string,
      count: number,
      suffix = '',
    ): string => {
      const dots = '.'.repeat(
        Math.max(1, DiArchiveDigestService.LABEL_WIDTH - label.length),
      );
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
      const countCol = String(count).padStart(4, ' ');
      return `${emoji} ${label} ${dots} ${countCol} (${pct}%)${suffix ? '  ' + suffix : ''}`;
    };

    const parts: string[] = [];
    parts.push(sep);
    parts.push(`${headerEmoji} Complétude globale : ${completudePct}% (${complete}/${total})`);

    if (totalIncompletes > 0) {
      parts.push(`📉 ${totalIncompletes} DI incomplètes  ${arrow}`);
    } else {
      parts.push('🎉 0 DI incomplète');
    }
    parts.push('');
    parts.push('Répartition des manquants :');
    parts.push('```');
    parts.push(
      line('🔴', 'Facture', missing.facture, '⚠️ facturation à risque'),
    );
    parts.push(line('🟠', 'BC', missing.bc));
    parts.push(line('🟠', 'BL', missing.bl));
    parts.push(line('🟡', 'Devis', missing.devis));
    parts.push('```');

    // Weekly progress — only when we have a positive delta (business win).
    // A negative or zero delta gets omitted per spec ("adapter le message
    // ou l'omettre") — silence is preferable to celebrating a regression.
    if (trendWeek != null && trendWeek > 0) {
      parts.push(
        `🎯 En bonne voie : ${trendWeek} DI complétée${trendWeek > 1 ? 's' : ''} cette semaine`,
      );
    }
    parts.push(sep);

    return parts.join('\n').slice(0, 2000); // Discord description hard cap
  }

  /** Day-over-day arrow. Positive delta = fewer incompletes = improvement (▼). */
  private formatDayArrow(delta: number | null): string {
    if (delta == null) return '(première mesure)';
    if (delta === 0) return '(= depuis hier)';
    if (delta > 0) return `▼ ${delta} depuis hier`;
    return `▲ ${Math.abs(delta)} depuis hier`;
  }

  /**
   * Africa/Tunis midnight of the given moment, returned as a Date. Tunisia
   * is UTC+1 year-round (no DST), so the offset is a stable 60 minutes.
   * Hardcoded so we don't depend on an external tz library.
   */
  private startOfTunisDay(now: Date): Date {
    const TUNIS_OFFSET_MIN = 60;
    // Shift into Tunis time, floor to start of that day, shift back to UTC.
    const shifted = new Date(now.getTime() + TUNIS_OFFSET_MIN * 60_000);
    const shiftedMidnight = new Date(
      Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    return new Date(shiftedMidnight.getTime() - TUNIS_OFFSET_MIN * 60_000);
  }
}
