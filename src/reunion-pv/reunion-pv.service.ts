import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateReunionPVInput } from './dto/reunion-pv.input';
import {
  PvStatut,
  ReunionPV,
  ReunionPVDocument,
} from './entities/reunion-pv.entity';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';

// Dedicated error codes — surfaced to GraphQL as the message body so the
// frontend can branch on the exact failure (invalid DI ref vs invalid
// participant vs duplicate reference) instead of a generic 500.
export const ERR_DI_NOT_FOUND = 'REUNION_PV_DI_NOT_FOUND';
export const ERR_CREATED_BY_NOT_FOUND = 'REUNION_PV_CREATED_BY_NOT_FOUND';
export const ERR_PARTICIPANT_NOT_FOUND = 'REUNION_PV_PARTICIPANT_NOT_FOUND';
export const ERR_RESPONSABLE_NOT_FOUND = 'REUNION_PV_RESPONSABLE_NOT_FOUND';

@Injectable()
export class ReunionPVService {
  constructor(
    @InjectModel('ReunionPV')
    private readonly reunionPVModel: Model<ReunionPVDocument>,
    @InjectModel('Profile') private readonly profileModel: Model<any>,
    @InjectModel('Di') private readonly diModel: Model<any>,
    private readonly discordHook: DiscordHookService,
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
    options?: { skipDiscord?: boolean },
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

    return saved;
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
