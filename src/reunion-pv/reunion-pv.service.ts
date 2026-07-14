import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CreateReunionPVInput,
  UpdateReunionPVDetailsInput,
} from './dto/reunion-pv.input';
import {
  PvStatut,
  ReunionPV,
  ReunionPVDocument,
} from './entities/reunion-pv.entity';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { JiraService } from 'src/jira/jira.service';

// Dedicated error codes — surfaced to GraphQL as the message body so the
// frontend can branch on the exact failure (invalid DI ref vs invalid
// participant vs duplicate reference) instead of a generic 500.
export const ERR_DI_NOT_FOUND = 'REUNION_PV_DI_NOT_FOUND';
export const ERR_CREATED_BY_NOT_FOUND = 'REUNION_PV_CREATED_BY_NOT_FOUND';
export const ERR_PARTICIPANT_NOT_FOUND = 'REUNION_PV_PARTICIPANT_NOT_FOUND';
export const ERR_RESPONSABLE_NOT_FOUND = 'REUNION_PV_RESPONSABLE_NOT_FOUND';
export const ERR_PV_NOT_FOUND = 'REUNION_PV_NOT_FOUND';
export const ERR_PV_FINALISED = 'REUNION_PV_FINALISED';

@Injectable()
export class ReunionPVService {
  private readonly logger = new Logger(ReunionPVService.name);

  constructor(
    @InjectModel('ReunionPV')
    private readonly reunionPVModel: Model<ReunionPVDocument>,
    @InjectModel('Profile') private readonly profileModel: Model<any>,
    @InjectModel('Di') private readonly diModel: Model<any>,
    private readonly discordHook: DiscordHookService,
    private readonly jiraService: JiraService,
  ) {}

  /**
   * Concurrency-safe reference generator: scans existing references for
   * the current year, takes max(seq)+1. On the rare race where two
   * concurrent inserts land on the same seq, the unique index on
   * `reference` rejects one and `create()` retries — see `create()`
   * below. Format: `PV-{YYYY}-{seq}` (3-pad for readability).
   */
  private async nextReference(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `PV-${year}-`;
    const rows = await this.reunionPVModel
      .find(
        { reference: { $regex: `^${prefix}\\d+$` } },
        { reference: 1 },
      )
      .lean();
    let max = 0;
    for (const r of rows) {
      const tail = String((r as any)?.reference || '').slice(prefix.length);
      const n = parseInt(tail, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  /**
   * Validate every ref (DI, createdBy, participants[].profile,
   * actions[].responsable) up-front. Throwing here means NOTHING is
   * written — no half-created PV with broken refs.
   */
  private async assertRefs(input: CreateReunionPVInput): Promise<void> {
    if (input.diId) {
      const di = await this.diModel.findOne({ _id: input.diId }).lean();
      if (!di) throw new BadRequestException(ERR_DI_NOT_FOUND);
    }
    const author = await this.profileModel
      .findOne({ _id: input.createdById })
      .lean();
    if (!author) throw new BadRequestException(ERR_CREATED_BY_NOT_FOUND);

    const partIds = (input.participants ?? [])
      .map((p) => p?.profile)
      .filter(Boolean);
    for (const id of partIds) {
      const found = await this.profileModel.findOne({ _id: id }).lean();
      if (!found) throw new BadRequestException(ERR_PARTICIPANT_NOT_FOUND);
    }
    const respIds = (input.actions ?? [])
      .map((a) => a?.responsable)
      .filter(Boolean) as string[];
    for (const id of respIds) {
      const found = await this.profileModel.findOne({ _id: id }).lean();
      if (!found) throw new BadRequestException(ERR_RESPONSABLE_NOT_FOUND);
    }
  }

  /**
   * Create a PV: validate refs, generate `reference`, persist, push the
   * new id onto `Di.pvReunions` (when a DI is linked), then fire the
   * Discord notification — best-effort, a webhook failure must NEVER
   * roll back the persisted PV.
   *
   * Retries on duplicate-reference (race between concurrent inserts) up
   * to 3 times before surfacing the error.
   */
  async create(
    input: CreateReunionPVInput,
    options?: { skipDiscord?: boolean; skipJira?: boolean },
  ): Promise<ReunionPVDocument> {
    await this.assertRefs(input);

    let saved: ReunionPVDocument | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const reference = await this.nextReference();
      const doc: any = {
        reference,
        titre: input.titre,
        objet: input.objet ?? '',
        dateReunion: input.dateReunion,
        lieu: input.lieu ?? '',
        modalite: input.modalite ?? undefined,
        di: input.diId ?? null,
        contexteRetour: input.contexteRetour
          ? {
              niveau: input.contexteRetour.niveau,
              motif: input.contexteRetour.motif ?? '',
            }
          : null,
        createdBy: input.createdById,
        participants: (input.participants ?? []).map((p) => ({
          profile: p.profile,
          statut: p.statut,
        })),
        ordreDuJour: input.ordreDuJour ?? [],
        decisions: input.decisions ?? [],
        pointsDiscutes: input.pointsDiscutes ?? [],
        actions: (input.actions ?? []).map((a) => ({
          titre: a.titre,
          description: a.description ?? '',
          responsable: a.responsable ?? null,
          echeance: a.echeance ?? null,
          priorite: a.priorite,
          statut: a.statut,
          jira: { synced: false, issueKey: null, url: null },
        })),
        // 5M / Ishikawa — persist only when the section carries data (a
        // problem statement or at least one retained cause), else keep null.
        ishikawa:
          input.ishikawa &&
          ((input.ishikawa.probleme ?? '').trim().length > 0 ||
            (input.ishikawa.familles ?? []).some(
              (f) => (f.causes ?? []).length > 0,
            ))
            ? {
                probleme: input.ishikawa.probleme ?? '',
                familles: (input.ishikawa.familles ?? []).map((f) => ({
                  key: f.key,
                  label: f.label ?? '',
                  causes: (f.causes ?? []).map((c) => ({
                    label: c.label,
                    detail: c.detail ?? '',
                    custom: c.custom ?? false,
                  })),
                })),
              }
            : null,
        prochaineReunion: input.prochaineReunion ?? null,
        statut: input.statut ?? PvStatut.BROUILLON,
      };
      try {
        saved = (await this.reunionPVModel.create(doc)) as ReunionPVDocument;
      } catch (e: any) {
        lastErr = e;
        if (e?.code !== 11000) throw e; // not a dup-key → bubble
        // Else: ref collision, loop with a fresh `nextReference()`.
      }
    }
    if (!saved) throw lastErr ?? new Error('REUNION_PV_REF_COLLISION');

    // Inverse link on the Di document. Best-effort: a failed push must
    // not undo the PV (we logged the meeting, the link is recoverable).
    if (input.diId) {
      try {
        await this.diModel.updateOne(
          { _id: input.diId },
          { $push: { pvReunions: saved._id } },
        );
      } catch {
        /* swallow — PV persisted, link can be reconciled later */
      }
    }

    // Discord — fire-and-forget. Mocked in tests via the service mock,
    // or skipped explicitly via the `skipDiscord` option (used by the
    // resolver when the request carries `x-test-run: 1`).
    if (!options?.skipDiscord) {
      try {
        const di = input.diId
          ? await this.diModel.findOne({ _id: input.diId }).lean()
          : null;
        const profile = await this.profileModel
          .findOne({ _id: input.createdById })
          .lean();
        await this.discordHook.sendReunionPvCreated({
          pv: saved,
          di,
          profile,
        });
      } catch {
        /* swallow — Discord is non-critical */
      }
    }

    // Jira — best-effort. Each "Action à mener" becomes a Jira issue in the
    // configured project AFTER the PV is persisted, so a Jira outage / 4xx can
    // never undo a meeting that was already saved. Inert until JIRA_* env is
    // set; skipped on QA traffic (x-test-run) exactly like Discord. Per-issue
    // failures are logged by JiraService (OperationalError, severity LOW).
    if (!options?.skipJira) {
      try {
        await this.syncActionsToJira(saved);
      } catch {
        /* swallow — Jira is non-critical; JiraService already logged */
      }
    }

    return saved;
  }

  /**
   * Mirror every "Action à mener" into a Jira issue and write the resulting
   * issue key/url/assignFailed back onto the PV's `actions[].jira` sub-doc.
   *
   * IDEMPOTENT (update-not-duplicate): an action that already carries a
   * `jira.issueKey` is UPDATED in place (PUT), never recreated — so editing an
   * action N times keeps ONE Jira issue. An action without an issueKey is
   * created. Skips empty-title actions. No-op when Jira is unconfigured.
   * Best-effort throughout — never throws to the caller.
   *
   * `assignFailed`: set true when the action had a responsable EMAIL but Jira
   * couldn't map it to an account (issue still created/updated, unassigned —
   * the task is never lost) so the UI/logs can surface it.
   */
  private async syncActionsToJira(saved: ReunionPVDocument): Promise<void> {
    if (!this.jiraService.isConfigured) return;

    // Work on a plain object so the `$set` write carries no Mongoose internals.
    const plain: any =
      typeof (saved as any).toObject === 'function'
        ? (saved as any).toObject()
        : saved;
    const actions: any[] = plain.actions ?? [];
    if (!actions.length) return;

    const meeting = {
      _id: String(saved._id),
      reference: plain.reference,
      titre: plain.titre,
    };

    let changed = false;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (!a || !(a.titre ?? '').trim()) continue;

      // Resolve the responsable Profile → email so Jira can map an assignee.
      let assigneeEmail: string | null = null;
      if (a.responsable) {
        const prof = await this.profileModel
          .findOne({ _id: a.responsable })
          .lean()
          .catch(() => null);
        assigneeEmail = (prof as any)?.email ?? null;
      }

      const jiraInput = {
        titre: a.titre,
        description: a.description,
        priorite: a.priorite,
        echeance: a.echeance,
        assigneeEmail,
      };

      const existingKey = a?.jira?.issueKey;
      const result = existingKey
        ? await this.jiraService.updateIssueForAction(
            existingKey,
            jiraInput,
            meeting,
          )
        : await this.jiraService.createIssueForAction(jiraInput, meeting);

      if (result?.issueKey) {
        // assignFailed only when an email WAS provided but not mapped.
        const assignFailed = !!assigneeEmail && !result.assigned;
        actions[i].jira = {
          synced: true,
          issueKey: result.issueKey,
          url: result.url,
          assignFailed,
        };
        changed = true;
        if (assignFailed) {
          this.logger.warn(
            `Jira: action "${String(a.titre).slice(0, 60)}" (PV ${
              meeting.reference
            }) créée/mise à jour NON assignée — email non-Jira: ${assigneeEmail}`,
          );
        }
      }
    }

    if (changed) {
      await this.reunionPVModel
        .updateOne({ _id: saved._id }, { $set: { actions } })
        .catch(() => {
          /* the issues exist in Jira; the back-link is recoverable */
        });
    }
  }

  /**
   * Phase-2 "document the meeting" write: fill the detailed sections (ordre du
   * jour, points, décisions, actions, 5M) from the detail modal, then push each
   * action to Jira (idempotent). Only allowed while the PV is BROUILLON; a
   * FINALISE PV is locked. Load-modify-save so Mongoose generates `_id`s for
   * brand-new action sub-docs and carries existing `jira` sub-docs over (matched
   * by the `_id` the frontend echoes back).
   */
  async updateReunionDetails(
    input: UpdateReunionPVDetailsInput,
    options?: { skipJira?: boolean },
  ): Promise<ReunionPVDocument> {
    const pv = await this.reunionPVModel.findById(input._id);
    if (!pv) throw new NotFoundException(ERR_PV_NOT_FOUND);
    if ((pv as any).statut === PvStatut.FINALISE) {
      throw new BadRequestException(ERR_PV_FINALISED);
    }

    // Validate responsables up-front — nothing written on a bad ref.
    const respIds = (input.actions ?? [])
      .map((a) => a?.responsable)
      .filter(Boolean) as string[];
    for (const id of respIds) {
      const found = await this.profileModel.findOne({ _id: id }).lean();
      if (!found) throw new BadRequestException(ERR_RESPONSABLE_NOT_FOUND);
    }

    if (input.ordreDuJour !== undefined) {
      (pv as any).ordreDuJour = input.ordreDuJour;
    }
    if (input.decisions !== undefined) {
      (pv as any).decisions = input.decisions;
    }
    if (input.pointsDiscutes !== undefined) {
      (pv as any).pointsDiscutes = input.pointsDiscutes.map((p) => ({
        titre: p.titre,
        contenu: p.contenu ?? '',
      }));
    }

    if (input.actions !== undefined) {
      const prev: any[] = ((pv as any).actions ?? []).map((a: any) =>
        typeof a.toObject === 'function' ? a.toObject() : a,
      );
      (pv as any).actions = input.actions.map((a) => {
        // Carry the existing jira sub-doc over (matched by _id) so an edited
        // action keeps its issueKey → updateIssueForAction, not a duplicate.
        const existing = a._id
          ? prev.find((x) => String(x._id) === String(a._id))
          : null;
        return {
          ...(a._id ? { _id: a._id } : {}),
          titre: a.titre,
          description: a.description ?? '',
          responsable: a.responsable ?? null,
          echeance: a.echeance ?? null,
          priorite: a.priorite,
          statut: a.statut,
          jira: existing?.jira ?? {
            synced: false,
            issueKey: null,
            url: null,
            assignFailed: false,
          },
        };
      });
    }

    if (input.ishikawa !== undefined) {
      (pv as any).ishikawa =
        input.ishikawa &&
        ((input.ishikawa.probleme ?? '').trim().length > 0 ||
          (input.ishikawa.familles ?? []).some(
            (f) => (f.causes ?? []).length > 0,
          ))
          ? {
              probleme: input.ishikawa.probleme ?? '',
              familles: (input.ishikawa.familles ?? []).map((f) => ({
                key: f.key,
                label: f.label ?? '',
                causes: (f.causes ?? []).map((c) => ({
                  label: c.label,
                  detail: c.detail ?? '',
                  custom: c.custom ?? false,
                })),
              })),
            }
          : null;
    }

    if (input.statut) (pv as any).statut = input.statut;

    const saved = (await pv.save()) as ReunionPVDocument;

    // Push actions to Jira (create/update). Best-effort; never rolls back.
    if (!options?.skipJira) {
      try {
        await this.syncActionsToJira(saved);
      } catch {
        /* swallow — Jira is non-critical; JiraService already logged */
      }
    }

    // Return the freshest doc (jira back-links written by syncActionsToJira).
    return (await this.reunionPVModel.findById(saved._id)) as ReunionPVDocument;
  }

  /**
   * REUNION_REMINDER cron body — find meetings starting within the next
   * `REUNION_REMINDER_WINDOW_MIN` minutes (default 5) that were not yet
   * reminded, and post ONE Discord reminder each with a deep-link that opens
   * the detail modal. Idempotent + concurrency-safe: each PV is atomically
   * CLAIMED (`reminderSent` false→true) before the send, so overlapping cron
   * runs (every 1-2 min) never double-notify; a failed send reverts the flag
   * so the next run retries. Returns a summary for logging/tests.
   */
  async sendDueReminders(
    now: Date = new Date(),
  ): Promise<{ candidates: number; sent: number; failed: number }> {
    const windowMin =
      Number(process.env.REUNION_REMINDER_WINDOW_MIN ?? 5) || 5;
    const until = new Date(now.getTime() + windowMin * 60 * 1000);

    const candidates: any[] = await this.reunionPVModel
      .find({
        reminderSent: { $ne: true },
        dateReunion: { $gte: now, $lte: until },
      })
      .lean();

    let sent = 0;
    let failed = 0;
    for (const pv of candidates) {
      // Atomic claim (false→true). A parallel run that already claimed it
      // returns null ⇒ we skip, so the reminder fires exactly once.
      const claimed: any = await this.reunionPVModel.findOneAndUpdate(
        { _id: pv._id, reminderSent: { $ne: true } },
        { $set: { reminderSent: true } },
        { new: true },
      );
      if (!claimed) continue;

      try {
        const url = this.buildReunionDeepLink(String(claimed._id));
        await this.discordHook.sendReunionReminder({ pv: claimed, url });
        sent++;
      } catch (e) {
        // Revert so the next run retries — never lose a reminder to a flaky hook.
        failed++;
        await this.reunionPVModel
          .updateOne({ _id: pv._id }, { $set: { reminderSent: false } })
          .catch(() => undefined);
      }
    }

    return { candidates: candidates.length, sent, failed };
  }

  /** Deep-link the Discord reminder points at → opens the detail modal.
   *  Null when APP_BASE_URL isn't configured (embed sent without a link). */
  private buildReunionDeepLink(pvId: string): string | null {
    const base = (process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');
    if (!base) return null;
    return `${base}/tickets/reunions?open=${encodeURIComponent(pvId)}`;
  }

  /** Single PV by id, with populated DI / createdBy / participants. */
  async findById(_id: string): Promise<ReunionPVDocument> {
    const pv = await this.reunionPVModel.findOne({ _id }).lean();
    if (!pv) throw new NotFoundException('REUNION_PV_NOT_FOUND');
    return pv as ReunionPVDocument;
  }

  /** All PVs attached to a DI, newest first. */
  async findByDi(diId: string): Promise<ReunionPVDocument[]> {
    return this.reunionPVModel
      .find({ di: diId })
      .sort({ createdAt: -1 })
      .lean() as any;
  }

  /** All PVs authored by a profile, newest first. */
  async findByCreatedBy(profileId: string): Promise<ReunionPVDocument[]> {
    return this.reunionPVModel
      .find({ createdBy: profileId })
      .sort({ createdAt: -1 })
      .lean() as any;
  }

  /**
   * All PVs, newest first, hard-capped to 200 to keep the response small.
   * Used by the "Réunions" menu list page. A future paginated variant will
   * replace this once the volume grows.
   */
  async findAll(limit = 200): Promise<ReunionPVDocument[]> {
    return this.reunionPVModel
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean() as any;
  }
}
