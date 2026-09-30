import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateStatInput, PauseLogInput } from './dto/create-stat.input';
import { InjectModel } from '@nestjs/mongoose';
import { Stat } from './entities/stat.entity';
import { Model } from 'mongoose';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import {
  CLOSING_STATUS_VALUES,
  STATUS_DI,
  TECH_STATUS_DI_VALUES,
} from 'src/di/di.status';
import { PaginationConfigDi } from 'src/di/dto/create-di.input';
import { Di } from 'src/di/entities/di.entity';
import { LogsDiService } from 'src/logs-di/logs-di.service';
import { v4 as uuidv4 } from 'uuid';
import { Profile } from 'src/profile/entities/profile.entity';
import { Company } from 'src/company/entities/company.entity';
import { Client } from 'src/clients/entities/client.entity';
import { DiscordHookService } from 'src/discord-hook/discord-hook.service';
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
import {
  DiStatConsistencyMismatch,
  DiStatConsistencyReport,
} from './entities/stat.entity';
import {
  TechAssignmentKind,
  TechIdentity,
  techIdentityMatches,
} from 'src/auth/tech-ownership';
import { withErrorContext } from '../common/error-context';
@Injectable()
export class StatService {
  private readonly logger = new Logger(StatService.name);

  /**
   * Authorization guard for technician work-actions (start / pause / resume /
   * finish of Diagnostic & Réparation). Throws `ForbiddenException` unless the
   * acting user is the technician the DI is assigned to for the given `kind`.
   *
   * This is the REAL security boundary: the frontend only greys the button, so
   * a direct GraphQL call to `changeStatusInRepair` / `changeStatusInDiagnostic`
   * / `tech_start*` would otherwise let anyone act on anyone's DI. Wired into
   * DiResolver before the DiService transition runs.
   *
   * The latest Stat for the DI is used (retour cycles create several); the
   * active work-action always targets the most recent one.
   */
  async assertTechOwnsDi(
    idDi: string,
    user: TechIdentity | undefined | null,
    kind: TechAssignmentKind,
  ): Promise<void> {
    try {
      if (!user) {
        throw new ForbiddenException('Authentification requise.');
      }

      const stat: any = await this.StatModel.findOne({ _idDi: idDi })
        .select('id_tech_diag id_tech_rep')
        .sort({ createdAt: -1 })
        .lean();

      if (!stat) {
        throw new ForbiddenException(
          `Aucune affectation technicien trouvée pour la DI '${idDi}'.`,
        );
      }

      const assigned = kind === 'diag' ? stat.id_tech_diag : stat.id_tech_rep;

      if (techIdentityMatches(assigned, user)) {
        return;
      }

      throw new ForbiddenException(
        kind === 'diag'
          ? "Diagnostic refusé : cette DI est affectée à un autre technicien."
          : "Réparation refusée : cette DI est affectée à un autre technicien.",
      );
    } catch (error) {
      throw withErrorContext(error, 'StatService.assertTechOwnsDi');
    }
  }

  constructor(
    @InjectModel('Stat') private StatModel: Model<Stat>,
    @InjectModel('Di') private diModel: Model<Di>,
    @InjectModel('Profile') private profileModel: Model<Profile>,
    @InjectModel('Company') private companyModel: Model<Company>,
    @InjectModel('Location') private locationModel: Model<Location>,
    @InjectModel('Client') private clientModel: Model<Client>,
    private readonly notificationGateway: NotificationsGateway,
    private readonly profileService: ProfileService,
    private readonly logsDiService: LogsDiService,
    private readonly discordHookService: DiscordHookService,
    private readonly operationalErrorService: OperationalErrorService,
  ) {}

  /**
   * Tiny helper used at the single Discord-side-effect site (createStat).
   * Routes Discord failures through the operational-error pipeline (daily
   * log + Discord ops channel) without breaking the calling mutation.
   * Same pattern as DiService.captureDiscordFailure.
   */
  private async captureDiscordFailure(
    method: string,
    err: unknown,
    payload?: Record<string, any>,
  ) {
    try {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method,
        severity: 'LOW',
        error: 'Discord notification failed',
        message: (err as Error)?.message ?? String(err),
        payload,
      });
    } catch (error) {
      throw withErrorContext(error, 'StatService.captureDiscordFailure');
    }
  }

  /**
   * Filtre CANONIQUE d'une ligne Stat — le cycle est TOUJOURS dedans, **0
   * compris**. Pendant exact de l'index unique `{_idDi, ignoreCount}` : un
   * filtre qui le porte ne peut matcher qu'UNE ligne.
   *
   * Sans lui, `findOne({ _idDi })` rend l'ORDRE NATUREL — qui n'est même pas
   * fiablement le plus ancien (mesuré : le plus ancien dans 41 cas sur 84) —
   * donc le technicien d'un autre cycle, de façon intermittente. Les branches
   * `cycle > 0 ? {...} : { _idDi }` laissaient précisément le flux original
   * (cycle 0) non scopé.
   */
  private cycleFilter(_idDi: string, ignoreCount?: number | null) {
    try {
      return { _idDi, ignoreCount: ignoreCount ?? 0 };
    } catch (error) {
      throw withErrorContext(error, 'StatService.cycleFilter');
    }
  }

  async generateStatId(): Promise<number> {
    try {
      let indexStat = 0;
      const lastStat = await this.StatModel.findOne(
        {},
        {},
        { sort: { createdAt: -1 } },
      );

      if (lastStat) {
        indexStat = +lastStat._id.substring(4);

        return indexStat + 1;
      }

      return indexStat;
    } catch (error) {
      throw withErrorContext(error, 'StatService.generateStatId');
    }
  }

  async createStat(createStatInput: CreateStatInput): Promise<Stat> {
    try {
      // ── Manager gate ──────────────────────────────────────────────────────
      // After a Retour, the diagnostic technician can NOT be (re)assigned until
      // the manager relaunches the DI into the flow (status → PENDING1). Enforced
      // server-side (not just greyed in the UI) so a direct API call can't bypass
      // it. Only the diagnostic assignment (`id_tech_diag`) is gated — repair
      // assignment happens at PENDING3 and is unaffected. Placed before the
      // try/catch so this expected business rejection isn't logged as an
      // operational error.
      if (createStatInput?.id_tech_diag) {
        const RETOUR_STATUSES = [
          STATUS_DI.Retour1.status,
          STATUS_DI.Retour2.status,
          STATUS_DI.Retour3.status,
        ];
        const gateDi = await this.diModel.findOne({
          _id: createStatInput._idDi,
        });
        if (gateDi && RETOUR_STATUSES.includes(gateDi.status)) {
          throw new ForbiddenException(
            "Affectation du technicien diagnostic impossible pendant un retour : la DI doit d'abord être relancée par le manager (statut PENDING1).",
          );
        }
      }
      try {
        const index = await this.generateStatId();

        createStatInput._id = uuidv4();

        const di = await this.diModel.findOne({ _id: createStatInput._idDi });

        if (di.ignoreCount > 0) {
          createStatInput.ignoreCount = di.ignoreCount;
        }

        // ── Réaffectation diagnostic dans le MÊME cycle (post-abandon) ─────────
        // Une ligne Stat existe déjà pour ce (DI, cycle) → on NE crée PAS de
        // doublon : on met à jour le pointeur `id_tech_diag` et on OUVRE une
        // nouvelle entrée d'historique. Blocage MÊME-TECH : un technicien déjà
        // affecté sur ce cycle (donc ayant abandonné) est refusé côté serveur.
        if (createStatInput.id_tech_diag) {
          const cycle = di?.ignoreCount ?? 0;
          const filter = this.cycleFilter(createStatInput._idDi, cycle);
          const tech = createStatInput.id_tech_diag;

          // Garde MÊME-TECH + écriture en UNE SEULE opération atomique.
          //
          // Avant : `findOne` → contrôle en mémoire → mutation → `save()`.
          //   1. `save()` réécrit le document ENTIER sous garde de version, d'où
          //      les `VersionError` (« No matching document found for id … ») et,
          //      sous deux clics concurrents, la PERTE de l'entrée d'historique
          //      de l'un des deux ;
          //   2. la garde était une lecture SÉPARÉE de l'écriture : deux
          //      affectations simultanées du même tech la passaient toutes deux.
          //
          // Ici `'diagAssignments.tech': { $ne: tech }` porte la garde DANS le
          // filtre : Mongo ne peut pas l'évaluer puis se faire doubler. `$push`
          // ajoute sans réécrire le tableau, donc deux affectations concurrentes
          // se cumulent au lieu de s'écraser.
          // Chrono déjà cumulé sur le cycle : point de départ imputé au nouveau
          // technicien. Sert aussi à distinguer les deux sens d'un `null` plus bas.
          const currentRow = await this.StatModel.findOne(filter).lean<any>();

          const reassigned: any = await this.StatModel.findOneAndUpdate(
            { ...filter, 'diagAssignments.tech': { $ne: tech } },
            {
              $set: { id_tech_diag: tech },
              $push: {
                diagAssignments: {
                  tech,
                  assignedAt: new Date(),
                  abandonedAt: null,
                  motif: null,
                  abandonedBy: null,
                  diagTimeStart: currentRow?.diag_time ?? '00:00:00',
                  diagTime: null,
                },
              },
            },
            { new: true },
          );

          // `null` recouvre deux cas DISTINCTS : soit la ligne du cycle existe et
          // c'est la garde même-tech qui a mordu (→ refus), soit il n'y a pas
          // encore de ligne pour ce cycle (→ création plus bas).
          if (!reassigned && currentRow) {
            throw new ForbiddenException(
              "Ce technicien a déjà été affecté à cette DI sur ce cycle et l'a abandonnée — choisissez un autre technicien.",
            );
          }

          if (reassigned) {
            const statWithStatusReassigned = {
              ...reassigned.toObject(),
              status: di?.status || null,
            };
            const reassignedProfile = await this.profileService.findProlileById(
              createStatInput.id_tech_diag,
            );
            this.notificationGateway.updateTicket({
              action: 'updateState',
              content: { di, states: statWithStatusReassigned },
              target: reassignedProfile,
            });
            return await statWithStatusReassigned;
          }
        }

        // Snapshot du cycle retour — ouvert SEULEMENT ici, c.-à-d. après la
        // branche de réaffectation (qui ressort plus haut) et après le refus
        // MÊME-TECH. Avant, il était créé tout en haut, sans condition : une
        // réaffectation — même REFUSÉE — laissait une 2e ligne pour le même
        // (DI, cycle), et le routeur pouvait ensuite lire la ligne vide et croire
        // qu'il n'y avait pas d'erreur Fixtronix. La création est désormais
        // idempotente de toute façon (`$setOnInsert`), ceci est la 2e barrière.
        // SANS CONDITION depuis la separation par cycle : le cycle 0 (flux
        // original) a lui aussi sa ligne. C'est ce qui permet au dossier de lire
        // « Flux original » et « Retour N » dans la MEME structure, donc sans
        // aucun repli sur la DI — le repli etait la source du melange entre flux.
        await this.logsDiService.create(
          createStatInput._idDi,
          di.ignoreCount ?? 0,
        );

        // Première affectation du cycle : ouvre la 1re entrée d'historique.
        const statDoc: any = new this.StatModel(createStatInput);
        if (createStatInput.id_tech_diag) {
          statDoc.diagAssignments = [
            {
              tech: createStatInput.id_tech_diag,
              assignedAt: new Date(),
              abandonedAt: null,
              motif: null,
              abandonedBy: null,
              diagTimeStart: createStatInput.diag_time ?? '00:00:00',
              diagTime: null,
            },
          ];
        }
        const result = await statDoc.save();

        if (!result) {
          throw new InternalServerErrorException('Unable to create');
        }

        const statTech = await this.StatModel.findOne({ _id: result._id });

        const statWithStatus = {
          ...statTech.toObject(),
          status: di?.status || null,
        };

        const profile = await this.profileService.findProlileById(
          result.id_tech_diag,
        );

        // NO Discord notification here. Diagnostic assignment is a two-mutation
        // flow (createStat → coordinator_ToDiag); the SINGLE, complete Discord
        // embed is fired by `coordinator_ToDiag` via `sendDiagnosticAssigned`
        // (real DI number/title/client + technician). The old
        // `sendDiAssignedToTech` call here ran first — before the DI was moved to
        // DIAGNOSTIC — and, worse, spread a Mongoose document (`{...di}`) which
        // drops the data fields → a duplicate "DI Assigned to Technician" embed
        // with N/A DI Number/Title/Client. Removed to leave exactly one notif.

        // existing socket notification
        this.notificationGateway.updateTicket({
          action: 'updateState',
          content: { di, states: statWithStatus },
          target: profile,
        });

        return statWithStatus;
      } catch (error) {
        // Rejets MÉTIER attendus (gate Retour, blocage même-tech post-abandon) :
        // on propage sans les journaliser comme erreur opérationnelle (HIGH).
        if (error instanceof ForbiddenException) {
          throw error;
        }
        await this.operationalErrorService.capture({
          module: 'stat',
          submodule: 'statService',
          method: 'CREATE_STAT',
          severity: 'HIGH',
          error: 'Failed to create Stat',
          message: (error as Error)?.message ?? String(error),
          payload: {
            diId: createStatInput?._idDi,
            techDiag: createStatInput?.id_tech_diag,
            techRep: createStatInput?.id_tech_rep,
          },
        });
        throw error;
      }
    } catch (error) {
      throw withErrorContext(error, 'StatService.createStat');
    }
  }

  async findUserLinkedToConcernedDi(_idDi: string) {
    try {
      return await this.StatModel.findOne({ _idDi });
    } catch (error) {
      throw withErrorContext(error, 'StatService.findUserLinkedToConcernedDi');
    }
  }

  async checkDiStatConsistency(limit = 100): Promise<DiStatConsistencyReport> {
    try {
      const safeLimit = Math.min(Math.max(limit || 100, 1), 500);
      const generatedAt = new Date().toISOString();

      const diRecords = await this.diModel
        .find({ isDeleted: false })
        .sort({ updatedAt: -1 })
        .limit(safeLimit)
        .select('_id _idnum status ignoreCount')
        .lean();

      const diIds = diRecords.map((di: any) => di._id);

      const statRecords = await this.StatModel.find({ _idDi: { $in: diIds } })
        .select('_id _idDi status ignoreCount')
        .lean();

      const statsByDiId = statRecords.reduce((acc, stat: any) => {
        acc[stat._idDi] = acc[stat._idDi] || [];
        acc[stat._idDi].push(stat);
        return acc;
      }, {});

      const mismatches: DiStatConsistencyMismatch[] = [];

      for (const di of diRecords as any[]) {
        const stats = statsByDiId[di._id] || [];

        if (stats.length === 0) {
          mismatches.push({
            _idDi: di._id,
            _idnum: di._idnum,
            diStatus: di.status,
            diIgnoreCount: di.ignoreCount || 0,
            mismatchType: 'MISSING_STAT',
            severity: 'WARN',
            message: `No Stat document found for DI ${di._id}`,
          });
          continue;
        }

        if (stats.length > 1) {
          mismatches.push({
            _idDi: di._id,
            _idnum: di._idnum,
            diStatus: di.status,
            diIgnoreCount: di.ignoreCount || 0,
            mismatchType: 'MULTIPLE_STATS',
            severity: 'WARN',
            message: `Multiple Stat documents found for DI ${di._id}`,
          });
        }

        const expectedIgnoreCount = di.ignoreCount || 0;
        const matchingStat =
          stats.find((stat) => (stat.ignoreCount || 0) === expectedIgnoreCount) ||
          stats[0];

        if (matchingStat.status !== di.status) {
          mismatches.push({
            _idDi: di._id,
            _idnum: di._idnum,
            diStatus: di.status,
            statStatus: matchingStat.status,
            diIgnoreCount: expectedIgnoreCount,
            statIgnoreCount: matchingStat.ignoreCount || 0,
            mismatchType: 'STATUS_MISMATCH',
            severity: 'WARN',
            message: `DI status '${di.status}' does not match Stat status '${matchingStat.status}'`,
          });
        }
      }

      const report: DiStatConsistencyReport = {
        checkedDiCount: diRecords.length,
        mismatchCount: mismatches.length,
        missingStatCount: mismatches.filter(
          (mismatch) => mismatch.mismatchType === 'MISSING_STAT',
        ).length,
        statusMismatchCount: mismatches.filter(
          (mismatch) => mismatch.mismatchType === 'STATUS_MISMATCH',
        ).length,
        multipleStatCount: mismatches.filter(
          (mismatch) => mismatch.mismatchType === 'MULTIPLE_STATS',
        ).length,
        generatedAt,
        mismatches,
      };

      this.logConsistencyReport(report, safeLimit);

      return report;
    } catch (error) {
      throw withErrorContext(error, 'StatService.checkDiStatConsistency');
    }
  }

  private logConsistencyReport(
    report: DiStatConsistencyReport,
    limit: number,
  ): void {
    try {
      if (report.mismatchCount === 0) {
        return;
      }

      this.logger.warn(
        JSON.stringify({
          event: 'di.stat.consistency.warning',
          category: 'di_stat_consistency_mismatch',
          checkedDiCount: report.checkedDiCount,
          mismatchCount: report.mismatchCount,
          missingStatCount: report.missingStatCount,
          statusMismatchCount: report.statusMismatchCount,
          multipleStatCount: report.multipleStatCount,
          limit,
          generatedAt: report.generatedAt,
        }),
      );
    } catch (error) {
      throw withErrorContext(error, 'StatService.logConsistencyReport');
    }
  }

  async deleteStat(_id: string) {
    try {
      return await this.StatModel.deleteMany({ _idDi: _id });
    } catch (error) {
      throw withErrorContext(error, 'StatService.deleteStat');
    }
  }

  async affectForRep(_idDi: string, _idTech: string) {
    try {
      const di = await this.diModel.findOne({ _id: _idDi });
      if (!di) {
        throw new Error('Issue in finding di in send di to reparation');
      }

      // Cycle TOUJOURS dans le filtre, 0 compris. La branche `else` d'avant
      // écrivait sur `{ _idDi }` SEUL : sur une DI portant plusieurs lignes
      // (`di.ignoreCount = 0` avec des lignes aux cycles 0, 1 et 2 — ça existe
      // en base), le réparateur atterrissait sur une ligne arbitraire.
      const filter = this.cycleFilter(_idDi, di.ignoreCount);
      const result = await this.StatModel.updateOne(filter, {
        $set: { id_tech_rep: _idTech },
      });

      const stat = await this.StatModel.findOne(filter);
      const profile = await this.profileService.findProlileById(_idTech);

      this.notificationGateway.updateTicket({
        action: 'updateState',
        content: {
          di,
          states: {
            ...(stat?.toObject?.() || {}),
            _idDi,
            id_tech_rep: _idTech,
            status: di.status,
          },
        },
        target: profile,
      });

      return result;
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method: 'AFFECT_FOR_REP',
        severity: 'HIGH',
        error: 'Failed to assign tech for repair',
        message: (error as Error)?.message ?? String(error),
        payload: { diId: _idDi, techId: _idTech },
      });
      throw error;
    }
  }

  // Fiter tech data

  async getDiStatusCounts(_idtech: string, startDate?: Date, endDate?: Date) {
    try {
      // Build the date filter if both startDate and endDate are provided
      const dateFilter =
        startDate && endDate
          ? {
              createdAt: {
                $gte: startDate,
                $lte: endDate,
              },
            }
          : {};

      const result = await this.StatModel.aggregate([
        {
          // Filter documents by technician's ID and date range if provided
          $match: {
            $and: [
              {
                $or: [{ id_tech_diag: _idtech }, { id_tech_rep: _idtech }],
              },
              dateFilter, // Apply date filter if provided
              // Le Tech ne voit JAMAIS la clôture documentaire (WAITING_BL /
              // WAITING_FACTURE + legacy) : ni en liste, ni dans ses compteurs.
              { status: { $nin: CLOSING_STATUS_VALUES } },
            ],
          },
        },

        {
          // Group by the 'status' field and count occurrences
          $group: {
            _id: '$status', // Group by 'status' field
            count: { $sum: 1 }, // Count occurrences
          },
        },

        {
          // Reshape the result to have the desired { status: string, count: number } format
          $project: {
            _id: 0, // Exclude the _id field
            status: '$_id', // Use _id as the status field
            count: 1, // Include the count field as-is
          },
        },
      ]);

      return result;
    } catch (error) {
      throw withErrorContext(error, 'StatService.getDiStatusCounts');
    }
  }

  async searchTechDi(
    paginationConfig: PaginationConfigDi,
    search: { field: string; value: string },
    _idtech: string,
    role: string,
    startDate?: Date,
    endDate?: Date,
  ) {
    try {
      const { first, rows } = paginationConfig;
      const { field, value } = search;

      // Base filters
      const dateFilter =
        startDate && endDate
          ? {
              createdAt: {
                $gte: startDate,
                $lte: endDate,
              },
            }
          : {};

      // ADMIN_TECH is a hands-on technician: like TECH it must see ONLY its own
      // assigned DIs (id_tech_diag / id_tech_rep), so the tech list + its per-row
      // diag/rep buttons work for it. Only ADMIN_MANAGER gets the full "see all".
      const isAdmin = role === 'ADMIN_MANAGER';

      const techFilter = isAdmin
        ? {}
        : {
            $or: [{ id_tech_diag: _idtech }, { id_tech_rep: _idtech }],
          };

      const statusFilter = {
        status: { $in: TECH_STATUS_DI_VALUES },
      };

      // Initialize combined filter
      let combinedFilter: any = {
        $and: [techFilter, dateFilter, statusFilter].filter(
          (filter) => Object.keys(filter).length > 0,
        ),
      };

      // Only apply search if value has 2+ characters
      if (field && value && value.trim().length >= 2) {
        const trimmedValue = value.trim();
        const regex = { $regex: `${trimmedValue}`, $options: 'i' };

        switch (field) {
          case '_id':
          case 'status':
            combinedFilter.$and.push({ [field]: regex });
            break;

          case '_idnum':
          case 'title': {
            // Search in the referenced Di document
            const diIds = await this.diModel
              .find({ [field]: regex })
              .distinct('_id');
            if (diIds.length > 0) {
              combinedFilter.$and.push({ _idDi: { $in: diIds } });
            } else {
              // No matching DIs, return empty result
              return { stat: [], totalTechDataCount: 0 };
            }
            break;
          }

          case 'client': {
            const clientIds = await this.clientModel
              .find({ $or: [{ first_name: regex }, { last_name: regex }] })
              .distinct('_id');

            if (clientIds.length > 0) {
              const diIds = await this.diModel
                .find({ client_id: { $in: clientIds } })
                .distinct('_id');

              if (diIds.length > 0) {
                combinedFilter.$and.push({ _idDi: { $in: diIds } });
              } else {
                return { stat: [], totalTechDataCount: 0 };
              }
            } else {
              return { stat: [], totalTechDataCount: 0 };
            }
            break;
          }

          case 'company': {
            const companyIds = await this.companyModel
              .find({ name: regex })
              .distinct('_id');

            if (companyIds.length > 0) {
              const diIds = await this.diModel
                .find({ company_id: { $in: companyIds } })
                .distinct('_id');

              if (diIds.length > 0) {
                combinedFilter.$and.push({ _idDi: { $in: diIds } });
              } else {
                return { stat: [], totalTechDataCount: 0 };
              }
            } else {
              return { stat: [], totalTechDataCount: 0 };
            }
            break;
          }

          case 'location': {
            const locationIds = await this.locationModel
              .find({ location_name: regex })
              .distinct('_id');

            if (locationIds.length > 0) {
              const diIds = await this.diModel
                .find({ location_id: { $in: locationIds } })
                .distinct('_id');

              if (diIds.length > 0) {
                combinedFilter.$and.push({ _idDi: { $in: diIds } });
              } else {
                return { stat: [], totalTechDataCount: 0 };
              }
            } else {
              return { stat: [], totalTechDataCount: 0 };
            }
            break;
          }

          case 'techDiag': {
            const profileIds = await this.profileModel
              .find({ $or: [{ firstName: regex }, { lastName: regex }] })
              .distinct('_id');

            if (profileIds.length > 0) {
              combinedFilter.$and.push({ id_tech_diag: { $in: profileIds } });
            } else {
              return { stat: [], totalTechDataCount: 0 };
            }
            break;
          }

          case 'techRep': {
            const profileIds = await this.profileModel
              .find({ $or: [{ firstName: regex }, { lastName: regex }] })
              .distinct('_id');

            if (profileIds.length > 0) {
              combinedFilter.$and.push({ id_tech_rep: { $in: profileIds } });
            } else {
              return { stat: [], totalTechDataCount: 0 };
            }
            break;
          }

          case 'createdBy': {
            const profileIds = await this.profileModel
              .find({ $or: [{ firstName: regex }, { lastName: regex }] })
              .distinct('_id');

            if (profileIds.length > 0) {
              const diIds = await this.diModel
                .find({ createdBy: { $in: profileIds } })
                .distinct('_id');

              if (diIds.length > 0) {
                combinedFilter.$and.push({ _idDi: { $in: diIds } });
              } else {
                return { stat: [], totalTechDataCount: 0 };
              }
            } else {
              return { stat: [], totalTechDataCount: 0 };
            }
            break;
          }
        }
      }

      // Clean up empty $and array
      const queryFilter = combinedFilter.$and.length > 0 ? combinedFilter : {};

      // COUNT
      const totalTechDataCount = await this.StatModel.countDocuments(queryFilter);

      // FETCH
      const stat = await this.StatModel.find(queryFilter)
        .populate({
          path: 'diRef',
          select: '_idnum client_id company_id',
          populate: [
            { path: 'client_id', select: '_id first_name last_name phone' },
            { path: 'company_id', select: '_id name fax' },
          ],
        })
        .sort({ createdAt: -1 })
        .limit(rows)
        .skip(first)
        .lean();

      const desiredData = stat.map((el: any) => ({
        ...el,
        _idnum: el.diRef?._idnum,
        client:
          this.isEmpty(el.diRef?.client_id) === false
            ? el.diRef?.client_id
            : null,
        company:
          this.isEmpty(el.diRef?.company_id) === false
            ? el.diRef?.company_id
            : null,
      }));

      return {
        stat: desiredData,
        totalTechDataCount,
      };
    } catch (error) {
      throw withErrorContext(error, 'StatService.searchTechDi');
    }
  }

  async getDiForTech(
    paginationConfig: PaginationConfigDi,
    _idtech: string,
    role: string,
    startDate?: Date,
    endDate?: Date,
  ) {
    try {
      this.migrateFieldsToReferenceTheDiEntity();
      const { first, rows } = paginationConfig;

      // Building the date filter if both startDate and endDate are provided
      const dateFilter =
        startDate && endDate
          ? {
              createdAt: {
                $gte: startDate,
                $lte: endDate,
              },
            }
          : {};

      // Check if user has admin roles
      // ADMIN_TECH is a hands-on technician: like TECH it must see ONLY its own
      // assigned DIs (id_tech_diag / id_tech_rep), so the tech list + its per-row
      // diag/rep buttons work for it. Only ADMIN_MANAGER gets the full "see all".
      const isAdmin = role === 'ADMIN_MANAGER';

      // Build the technician filter based on role
      const techFilter = isAdmin
        ? {} // Empty filter to get all records for admin roles
        : {
            $or: [{ id_tech_diag: _idtech }, { id_tech_rep: _idtech }],
          };
      const statusFilter = {
        status: { $in: TECH_STATUS_DI_VALUES },
      };
      // Combine filters
      const finalFilter = {
        $and: [
          techFilter,
          dateFilter, // Applying the date filter if provided
          statusFilter,
        ].filter((filter) => Object.keys(filter).length > 0), // Remove empty filters
      };

      // If there are no filters, remove the $and operator
      const queryFilter = finalFilter.$and.length > 0 ? finalFilter : {};

      const totalTechDataCount = await this.StatModel.countDocuments(queryFilter);

      const stat = await this.StatModel.find(queryFilter)
        .populate({
          path: 'diRef',
          select: '_idnum client_id company_id',
          populate: [
            { path: 'client_id', select: '_id first_name last_name phone' },
            { path: 'company_id', select: '_id name fax' },
          ],
        })
        .sort({ createdAt: -1 })
        .limit(rows)
        .skip(first)
        .lean();
      const desiredData = await Promise.all(
        stat.map(async (el: any) => ({
          ...el,
          _idnum: el.diRef?._idnum,
          client:
            this.isEmpty(el.diRef?.client_id) === false
              ? el.diRef?.client_id
              : null,
          company:
            this.isEmpty(el.diRef?.company_id) === false
              ? el.diRef?.company_id
              : null,
          // Resolve tech ids → display names for the diagnostic/repair résumé.
          techDiag: el.id_tech_diag
            ? await this.profileService.getTech(el.id_tech_diag)
            : null,
          techRep: el.id_tech_rep
            ? await this.profileService.getTech(el.id_tech_rep)
            : null,
        })),
      );
      return {
        stat: desiredData,
        totalTechDataCount,
      };
    } catch (error) {
      throw withErrorContext(error, 'StatService.getDiForTech');
    }
  }

  isEmpty(value) {
    try {
      return (
        value === null ||
        value === undefined ||
        value === '' ||
        value === 'null' ||
        value === 'undefined'
      );
    } catch (error) {
      throw withErrorContext(error, 'StatService.isEmpty');
    }
  }
  // to get techrep and tech daig and their times
  async getRetourDataStats(_id: string) {
    try {
      // Fetch stats from the database
      const statsRetour = await this.StatModel.find({ _idDi: _id });

      if (statsRetour.length === 0) {
        throw new Error('No retour data found for stats');
      }

      // Map over the stats and replace tech IDs with the results of getTech()
      const modifiedStatsRetour = await Promise.all(
        statsRetour.map(async (el) => {
          const techDiag = el.id_tech_diag
            ? await this.profileService.getTech(el.id_tech_diag)
            : null;
          const techRep = el.id_tech_rep
            ? await this.profileService.getTech(el.id_tech_rep)
            : null;

          return {
            ...el.toObject(), // Convert the Mongoose document to a plain object
            id_tech_diag: techDiag, // Replace id_tech_diag with getTech() result
            id_tech_rep: techRep, // Replace id_tech_rep with getTech() result
            // Le type GraphQL `Stat` n'expose QUE `techDiag`/`techRep` : sans ces
            // deux clés, le récapitulatif par cycle affichait « — » partout.
            techDiag,
            techRep,
          };
        }),
      );

      return modifiedStatsRetour;
    } catch (error) {
      throw withErrorContext(error, 'StatService.getRetourDataStats');
    }
  }
  /** "HH:MM:SS" → millisecondes (0 si invalide). */
  private static hhmmssToMs(time: string | null | undefined): number {
    try {
      const s = (time ?? '').trim();
      if (!/^\d{2,}:\d{2}:\d{2}$/.test(s)) {
        return 0;
      }
      const [h, m, sec] = s.split(':').map(Number);
      return (h * 3600 + m * 60 + sec) * 1000;
    } catch (error) {
      throw withErrorContext(error, 'StatService.hhmmssToMs');
    }
  }

  /**
   * Durée maximale plausible pour UN segment de travail continu (12 h).
   *
   * Au-delà, ce n'est pas du temps travaillé mais une session abandonnée : onglet
   * fermé sans pause, ou transition qui n'a pas fermé le segment. On a retrouvé
   * 25 ancres ouvertes en base, jusqu'à 1400 h. Un tel segment n'est PAS cumulé
   * — on ne facture jamais un temps qu'on sait faux — mais l'ancre est vidée.
   */
  private static readonly MAX_PLAUSIBLE_LEG_MS = 12 * 60 * 60 * 1000;

  /** millisecondes → "HH:MM:SS" (HH peut dépasser 99). */
  private static msToHhmmss(ms: number): string {
    try {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const pad = (v: number) => String(v).padStart(2, '0');
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    } catch (error) {
      throw withErrorContext(error, 'StatService.msToHhmmss');
    }
  }

  /**
   * Ouvre le segment de travail diagnostic courant : stampe
   * `diagRunStartedAt = now` UNIQUEMENT si aucun segment n'est ouvert
   * (`diagRunStartedAt: null` matche null ET champ absent). Idempotent :
   * un double « Démarrer » ne déplace pas l'ancre (sinon le temps du
   * segment en cours serait perdu).
   */
  async openDiagLeg(_idDi: string, ignoreCount = 0): Promise<boolean> {
    try {
      // Le cycle est TOUJOURS dans le filtre, 0 compris. Le ternaire
      // precedent retombait sur `{_idDi}` seul pour le flux original :
      // sur une DI ayant aussi des lignes de retour, Mongo rendait
      // l'ordre NATUREL — donc potentiellement la ligne d'un AUTRE
      // cycle. Ces methodes alimentent le temps FACTURABLE.
      const filter: Record<string, unknown> = {
        _idDi,
        ignoreCount,
        diagRunStartedAt: null,
      };
      const res = await this.StatModel.updateOne(filter, {
        $set: { diagRunStartedAt: new Date() },
      });
      return (res as any)?.modifiedCount > 0;
    } catch (error) {
      throw withErrorContext(error, 'StatService.openDiagLeg');
    }
  }

  /**
   * Jumeau RÉPARATION de `closeDiagLeg` : `rep_time += now − repRunStartedAt`,
   * segment journalisé dans `repSegments`, ancre vidée.
   *
   * Il n'existait AUCUN équivalent côté réparation : `repRunStartedAt` était
   * posé au démarrage mais jamais effacé, ni à la pause ni à la fin. Une DI
   * rouverte plus tard en INREPARATION recalculait donc
   * `rep_time + (now − ancre périmée)` → des centaines d'heures affichées.
   * Idempotent (sans segment ouvert : no-op) et sûr en concurrence grâce au
   * re-filtre sur l'ancre lue, exactement comme le diagnostic.
   */
  async closeRepLeg(_idDi: string, ignoreCount = 0): Promise<string | null> {
    try {
      // Le cycle est TOUJOURS dans le filtre, 0 compris. Le ternaire
      // precedent retombait sur `{_idDi}` seul pour le flux original :
      // sur une DI ayant aussi des lignes de retour, Mongo rendait
      // l'ordre NATUREL — donc potentiellement la ligne d'un AUTRE
      // cycle. Ces methodes alimentent le temps FACTURABLE.
      const filter: Record<string, unknown> = { _idDi, ignoreCount };
      const stat = await this.StatModel.findOne(filter);
      if (!stat || !stat.repRunStartedAt) {
        return null; // aucun segment ouvert — rien à cumuler
      }
      const startedAt = new Date(stat.repRunStartedAt);
      const stoppedAt = new Date();
      const rawLegMs = Math.max(0, stoppedAt.getTime() - startedAt.getTime());
      const abandoned = rawLegMs > StatService.MAX_PLAUSIBLE_LEG_MS;
      if (abandoned) {
        this.logger.warn(
          `closeRepLeg: segment ABANDONNÉ non facturé — stat ${stat._id} (${Math.round(
          rawLegMs / 3600000,
        )} h, ouvert le ${startedAt.toISOString()}). Ancre vidée, rep_time inchangé.`,
        );
      }
      const legMs = abandoned ? 0 : rawLegMs;
      const newRepTime = StatService.msToHhmmss(
        StatService.hhmmssToMs(stat.rep_time) + legMs,
      );
      const res = await this.StatModel.updateOne(
        { _id: stat._id, repRunStartedAt: startedAt },
        {
          $set: { rep_time: newRepTime, repRunStartedAt: null },
          $push: { repSegments: { startedAt, stoppedAt } },
        },
      );
      return (res as any)?.modifiedCount > 0 ? newRepTime : null;
    } catch (error) {
      throw withErrorContext(error, 'StatService.closeRepLeg');
    }
  }

  /**
   * Ferme le segment de travail diagnostic courant CÔTÉ SERVEUR :
   * `diag_time += now − diagRunStartedAt`, le segment {startedAt, stoppedAt}
   * est journalisé dans `diagSegments`, l'ancre est vidée. Le temps servant à
   * la FACTURATION est donc calculé ici — jamais depuis une durée envoyée par
   * le client. Idempotent : sans segment ouvert (pause double, transition
   * hors-diagnostic), no-op. Le filtre d'update re-vérifie l'ancre lue pour
   * qu'un appel concurrent ne cumule pas deux fois le même segment.
   */
  async closeDiagLeg(_idDi: string, ignoreCount = 0): Promise<string | null> {
    try {
      // Le cycle est TOUJOURS dans le filtre, 0 compris. Le ternaire
      // precedent retombait sur `{_idDi}` seul pour le flux original :
      // sur une DI ayant aussi des lignes de retour, Mongo rendait
      // l'ordre NATUREL — donc potentiellement la ligne d'un AUTRE
      // cycle. Ces methodes alimentent le temps FACTURABLE.
      const filter: Record<string, unknown> = { _idDi, ignoreCount };
      const stat = await this.StatModel.findOne(filter);
      if (!stat || !stat.diagRunStartedAt) {
        return null; // aucun segment ouvert — rien à cumuler
      }
      const startedAt = new Date(stat.diagRunStartedAt);
      const stoppedAt = new Date();
      const rawLegMs = Math.max(0, stoppedAt.getTime() - startedAt.getTime());
      const abandoned = rawLegMs > StatService.MAX_PLAUSIBLE_LEG_MS;
      if (abandoned) {
        this.logger.warn(
          `closeDiagLeg: segment ABANDONNÉ non facturé — stat ${stat._id} (${Math.round(
          rawLegMs / 3600000,
        )} h, ouvert le ${startedAt.toISOString()}). Ancre vidée, diag_time inchangé.`,
        );
      }
      const legMs = abandoned ? 0 : rawLegMs;
      const newDiagTime = StatService.msToHhmmss(
        StatService.hhmmssToMs(stat.diag_time) + legMs,
      );
      const res = await this.StatModel.updateOne(
        // Re-filtre sur la MÊME ancre : si un appel concurrent a déjà fermé
        // (anchor null) ou rouvert (autre date) le segment, on ne matche pas.
        { _id: stat._id, diagRunStartedAt: startedAt },
        {
          $set: { diag_time: newDiagTime, diagRunStartedAt: null },
          $push: { diagSegments: { startedAt, stoppedAt } },
        },
      );
      return (res as any)?.modifiedCount > 0 ? newDiagTime : null;
    } catch (error) {
      throw withErrorContext(error, 'StatService.closeDiagLeg');
    }
  }

  /**
   * Enregistre l'ABANDON du diagnostic courant sur le cycle `ignoreCount` :
   *   1. `closeDiagLeg` fige le leg en cours → `diag_time` cumulé (JAMAIS remis
   *      à zéro : facturation A+B, choix produit) ;
   *   2. clôt la dernière entrée `diagAssignments` OUVERTE (abandonedAt, motif,
   *      abandonedBy) et y stocke la contribution du tech (`diagTime`, affichage
   *      seul = diag_time cumulé − snapshot d'entrée). Fallback : si aucune entrée
   *      ouverte (DI affectée avant la feature), une entrée clôturée est créée
   *      depuis `id_tech_diag`. Renvoie true si un Stat a été trouvé.
   */
  async recordDiagAbandon(
    _idDi: string,
    ignoreCount: number,
    motif: string,
    abandonedBy: string,
  ): Promise<boolean> {
    try {
      await this.closeDiagLeg(_idDi, ignoreCount); // fige diag_time (cumulatif)
      const filter = this.cycleFilter(_idDi, ignoreCount);
      const stat: any = await this.StatModel.findOne(filter).lean();
      if (!stat) return false;

      const now = new Date();
      const cumulMs = StatService.hhmmssToMs(stat.diag_time);
      const list = [...(stat.diagAssignments ?? [])];
      // Index de la DERNIÈRE entrée ouverte (abandonedAt == null).
      let openIdx = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (!list[i].abandonedAt) {
          openIdx = i;
          break;
        }
      }
      // Écriture CIBLÉE au lieu d'un `save()` du document entier : pas de garde
      // de version (donc pas de `VersionError`), et un abandon concurrent ne peut
      // plus écraser l'historique. Le `abandonedAt: null` dans le FILTRE rend
      // l'opération idempotente : si l'entrée a déjà été clôturée entre-temps,
      // rien n'est réécrit.
      if (openIdx >= 0) {
        const entry = list[openIdx];
        const contribMs = Math.max(
          0,
          cumulMs - StatService.hhmmssToMs(entry.diagTimeStart),
        );
        const at = `diagAssignments.${openIdx}`;
        await this.StatModel.updateOne(
          { ...filter, [`${at}.abandonedAt`]: null },
          {
            $set: {
              [`${at}.abandonedAt`]: now,
              [`${at}.motif`]: motif,
              [`${at}.abandonedBy`]: abandonedBy,
              [`${at}.diagTime`]: StatService.msToHhmmss(contribMs),
            },
          },
        );
      } else {
        // Fallback (données héritées) : entrée clôturée depuis le tech courant.
        await this.StatModel.updateOne(filter, {
          $push: {
            diagAssignments: {
              tech: stat.id_tech_diag,
              assignedAt: (stat as any).createdAt ?? now,
              abandonedAt: now,
              motif,
              abandonedBy,
              diagTimeStart: '00:00:00',
              diagTime: stat.diag_time ?? null,
            },
          },
        });
      }
      return true;
    } catch (error) {
      throw withErrorContext(error, 'StatService.recordDiagAbandon');
    }
  }

  /**
   * Techniciens ayant été affectés (donc potentiellement ayant abandonné) sur le
   * cycle courant d'une DI. Sert au blocage « même tech » côté sélecteur
   * coordinatrice (le serveur re-vérifie dans `createStat`).
   */
  async abandonedTechsForDi(_idDi: string, ignoreCount = 0): Promise<string[]> {
    try {
      const filter = { _idDi, ignoreCount };
      const stat = await this.StatModel.findOne(filter).lean();
      if (!stat) return [];
      return await ((stat as any).diagAssignments ?? [])
        .filter((a: any) => !!a.abandonedAt)
        .map((a: any) => a.tech);
    } catch (error) {
      throw withErrorContext(error, 'StatService.abandonedTechsForDi');
    }
  }

  /**
   * DEPRECATED côté écriture : `diag_time` est désormais cumulé CÔTÉ SERVEUR
   * (`closeDiagLeg`) à la pause et aux transitions de sortie du diagnostic.
   * La valeur envoyée par le client (chaîne construite depuis l'AFFICHAGE,
   * gelée par le throttling des onglets en arrière-plan, et manipulable
   * alors qu'elle alimente la facturation) N'EST PLUS PERSISTÉE. L'endpoint
   * reste pour la compat des clients déployés : il journalise seulement un
   * écart significatif (>5 s) entre la valeur cliente et la valeur serveur.
   */
  async lapTime(_id: string, diag_time: string) {
    try {
      diag_time = (diag_time ?? '').trim();
      const stat = await this.StatModel.findOne({ _id });
      if (!stat) {
        throw new Error('Issue in lapTime');
      }
      const clientMs = StatService.hhmmssToMs(diag_time);
      const serverMs = StatService.hhmmssToMs(stat.diag_time);
      if (Math.abs(clientMs - serverMs) > 5000) {
        this.logger.warn(
          `lapTime ignoré (serveur autoritaire) — stat ${_id}: client=${diag_time} serveur=${stat.diag_time}`,
        );
      }
      return stat; // truthy — le resolver renvoie Boolean(!!)
    } catch (error) {
      throw withErrorContext(error, 'StatService.lapTime');
    }
  }

  async lapTimeForReaparation(_id: string, rep_time: string) {
    try {
      rep_time = (rep_time ?? '').trim();
      // Garde de format conservée : une valeur malformée signale un client cassé.
      if (!/^\d{2,}:\d{2}:\d{2}$/.test(rep_time)) {
        this.logger.warn(
          `lapTimeForReaparation refusé — stat ${_id}: rep_time malformé « ${rep_time} »`,
        );
        throw new Error('rep_time invalide : format attendu HH:MM:SS');
      }
      const stat = await this.StatModel.findOne({ _id });
      if (!stat) {
        throw new Error('Issue in lapTimeForReaparation');
      }
      // SERVEUR AUTORITAIRE (comme `lapTime` pour le diagnostic) : `rep_time` est
      // cumulé par `closeRepLeg` seul. Écrire ici la valeur affichée — qui
      // contient DÉJÀ le segment en cours — pendant que `closeRepLeg` l'ajoutait
      // de son côté comptait le segment DEUX FOIS (7 Stats en base à 2× leurs
      // segments). La valeur cliente n'est plus que journalisée.
      const clientMs = StatService.hhmmssToMs(rep_time);
      const serverMs = StatService.hhmmssToMs(stat.rep_time);
      if (Math.abs(clientMs - serverMs) > 5000) {
        this.logger.warn(
          `lapTimeForReaparation ignoré (serveur autoritaire) — stat ${_id}: client=${rep_time} serveur=${stat.rep_time}`,
        );
      }
      return stat; // truthy — le resolver renvoie Boolean(!!)
    } catch (error) {
      throw withErrorContext(error, 'StatService.lapTimeForReaparation');
    }
  }


  /**
   * Instantané du chrono d'un Stat (cf. `WorkTimer`).
   *
   * Un segment n'est « en cours » que si TOUT concorde : ancre posée, ce Stat
   * est le cycle COURANT de la DI, la DI est dans le statut actif de la phase,
   * et le segment est plausible (≤ 12 h, même règle que closeDiagLeg/closeRepLeg).
   * Sinon l'ancre est un reliquat : on n'affiche que le cumul.
   */
  async getWorkTimer(statId: string) {
    try {
      const stat = await this.StatModel.findOne({ _id: statId }).lean();
      if (!stat) {
        throw new Error(`Stat introuvable : ${statId}`);
      }
      const di = await this.diModel
        .findOne({ _id: (stat as any)._idDi })
        .select('status ignoreCount')
        .lean();
      const status: string = (di as any)?.status ?? (stat as any).status ?? '';
      const isCurrentCycle =
        Number((di as any)?.ignoreCount ?? 0) ===
        Number((stat as any).ignoreCount ?? 0);
      const now = new Date();
      const phase = (
        time: string | undefined,
        anchor: Date | null | undefined,
        runningStatus: string,
      ) => {
        let runningSince: Date | null = null;
        if (anchor && isCurrentCycle && status === runningStatus) {
          const leg = now.getTime() - new Date(anchor).getTime();
          if (leg >= 0 && leg <= StatService.MAX_PLAUSIBLE_LEG_MS) {
            runningSince = new Date(anchor);
          }
        }
        return { accumulatedMs: StatService.hhmmssToMs(time), runningSince };
      };
      return {
        statId: String((stat as any)._id),
        status,
        diag: phase(
          (stat as any).diag_time,
          (stat as any).diagRunStartedAt,
          STATUS_DI.InDiagnostic.status,
        ),
        rep: phase(
          (stat as any).rep_time,
          (stat as any).repRunStartedAt,
          STATUS_DI.InReparation.status,
        ),
        serverNow: now,
      };
    } catch (error) {
      throw withErrorContext(error, 'StatService.getWorkTimer');
    }
  }

  async getLastPauseTime(_id: string) {
    try {
      return await this.StatModel.findOne({ _id }).exec();
    } catch (error) {
      throw withErrorContext(error, 'StatService.getLastPauseTime');
    }
  }
  async getLastPauseTimeForReparation(_id: string) {
    try {
      return await this.StatModel.findOne({ _id }).exec();
    } catch (error) {
      throw withErrorContext(error, 'StatService.getLastPauseTimeForReparation');
    }
  }

  async getDIByStat(_idStat: string) {
    try {
      const di = await this.StatModel.findById(_idStat);

      if (!di) throw new Error(`Demande d'intervention with ID  not found.`);

      return di;
    } catch (error) {
      throw error;
    }
  }

  async getStatInfoForTechReparation(_idDi: string) {
    try {
      const diData = await this.diModel.findOne({ _id: _idDi });
      const StatData = await this.StatModel.findOne({ _idDi });

      const techDiag = await this.profileService.getTech(StatData.id_tech_diag);
      const techrep = await this.profileService.getTech(StatData.id_tech_rep);
      StatData.id_tech_diag = techDiag;
      StatData.id_tech_rep = techrep;

      return { diData, StatData };
    } catch (error) {
      throw withErrorContext(error, 'StatService.getStatInfoForTechReparation');
    }
  }

  //get by ID_DI
  async getInfoStatByIdDi(_idDi: string, _idLog: number) {
    try {
      // Sans `ignoreCount: 0`, le « flux original » pouvait tomber sur le Stat
      // d'un cycle de retour (findOne sans tri = ordre naturel).
      const stat = await this.StatModel.findOne(
        _idLog ? { _idDi, ignoreCount: _idLog } : { _idDi, ignoreCount: 0 },
      );
      if (!stat) return null;

      // `diagAssignments[].tech` est un id de profil : brut, le front l'affiche
      // comme un ObjectId. On le résout en nom (cache local anti-doublon).
      const plain: any = stat.toObject();
      const list: any[] = Array.isArray(plain.diagAssignments)
        ? plain.diagAssignments
        : [];
      if (list.length) {
        const cache = new Map<string, string>();
        plain.diagAssignments = await Promise.all(
          list.map(async (a: any) => {
            const id = a?.tech;
            if (!id) return a;
            if (!cache.has(id)) {
              const name = await this.profileService
                .getTech(id)
                .catch(() => null);
              cache.set(id, typeof name === 'string' ? name : null);
            }
            return { ...a, tech: cache.get(id) ?? null };
          }),
        );
      }

      // Noms résolus aussi pour les cumuls du cycle (mêmes clés que ci-dessus).
      plain.techDiag = plain.id_tech_diag
        ? await this.profileService.getTech(plain.id_tech_diag).catch(() => null)
        : null;
      plain.techRep = plain.id_tech_rep
        ? await this.profileService.getTech(plain.id_tech_rep).catch(() => null)
        : null;

      return await plain;
    } catch (error) {
      throw withErrorContext(error, 'StatService.getInfoStatByIdDi');
    }
  }

  // update status
  /** Statuts pendant lesquels un segment de travail a le droit de courir. */
  private static readonly DIAG_RUNNING_STATUSES = ['DIAGNOSTIC', 'INDIAGNOSTIC'];
  private static readonly REP_RUNNING_STATUSES = ['REPARATION', 'INREPARATION'];

  async updateStatus(_idDi: string, status: string, ignoreCount?: number) {
    try {
      // POINT DE PASSAGE UNIQUE de tout changement de statut : on y ferme le
      // segment de travail dès que la DI QUITTE sa phase. Les correctifs ciblés
      // (pause, fin de diagnostic, fin de réparation) ne suffisaient pas — 25
      // ancres étaient restées ouvertes en base, jusqu'à 1400 h, sur des DI en
      // FINISHED/PRICING/PENDING2. Fermer ici couvre TOUTES les transitions,
      // y compris celles qu'on n'a pas listées. `closeDiagLeg`/`closeRepLeg`
      // sont idempotents (no-op sans ancre) et ne facturent pas un segment
      // abandonné (cf. MAX_PLAUSIBLE_LEG_MS).
      if (!StatService.DIAG_RUNNING_STATUSES.includes(status)) {
        await this.closeDiagLeg(_idDi, ignoreCount ?? 0);
      }
      if (!StatService.REP_RUNNING_STATUSES.includes(status)) {
        await this.closeRepLeg(_idDi, ignoreCount ?? 0);
      }

      // Dynamically construct the query object
      const query: Record<string, any> = { _idDi };

      if (ignoreCount !== undefined) {
        query.ignoreCount = ignoreCount;
      }

      // Add condition to ensure the current status is not equal to the provided status

      const result = await this.StatModel.findOneAndUpdate(
        query,
        {
          $set: { status },
        },
        { new: true }, // Return the updated document
      );

      if (!result) {
        throw new Error('Issue in changing stats stattus');
      }

      return result;
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method: 'UPDATE_STATUS',
        severity: 'HIGH',
        error: 'Failed to update Stat status',
        message: (error as Error)?.message ?? String(error),
        payload: { diId: _idDi, targetStatus: status, ignoreCount },
      });
      throw error;
    }
  }

  async changeStatToDiagnosticInPause(_idDi: string) {
    try {
      const stat = await this.StatModel.findOneAndUpdate(
        { _idDi },
        { $set: { status: STATUS_DI.DiagnosticInPause.status } },
        { new: true },
      );

      if (!stat) {
        throw new Error('Error in update state in pause ');
      }

      return stat;
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method: 'CHANGE_STAT_TO_DIAGNOSTIC_IN_PAUSE',
        severity: 'MEDIUM',
        error: 'Failed to flip Stat to DiagnosticInPause',
        message: (error as Error)?.message ?? String(error),
        payload: { diId: _idDi },
      });
      throw error;
    }
  }

  getStatById(_id: string) {
    try {
      return this.StatModel.findOne({ _id });
    } catch (error) {
      throw withErrorContext(error, 'StatService.getStatById');
    }
  }

  async getStatByIdlogs(_id: string) {
    try {
      const stat = await this.StatModel.findOne({ _idDi: _id });
      // Pas de Stat = DI pas encore affectée à un technicien (CREATED,
      // PENDING1) : état NORMAL. Lever ici déclenchait deux alertes Discord
      // (« Stat not found » MEDIUM + INTERNAL_SERVER_ERROR HIGH) à chaque
      // ouverture du détail d'une telle DI. Le front gère déjà `null` (`|| []`).
      if (!stat) return null;
      // Une DI jamais mise en pause a `pauseLogs` vide : c'est un état NORMAL
      // (ex. DI qui n'est pas un retour), PAS une erreur. On ne lève plus rien
      // ici — sinon l'affichage des listes ticket/coordinateur déclenchait une
      // alerte opérationnelle « No logs found » (INTERNAL_SERVER_ERROR) pour
      // chaque DI sans logs. Le front gère déjà l'absence de logs (`|| []`).
      if (stat.id_tech_diag) {
        const techdiag = await this.profileService.getTech(stat.id_tech_diag);
        stat.id_tech_diag = techdiag;
      }

      if (stat.id_tech_rep) {
        const techrep = await this.profileService.getTech(stat.id_tech_rep);
        stat.id_tech_rep = techrep;
      }

      return stat;
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method: 'GET_STAT_BY_ID_LOGS',
        severity: 'MEDIUM',
        error: 'Failed to load Stat pause logs',
        message: (error as Error)?.message ?? String(error),
        payload: { diId: _id },
      });
      throw error;
    }
  }

  async addPauseLog(statId: string, pauseLog: PauseLogInput): Promise<any> {
    try {
      const stat = await this.getStatById(statId);
      if (!stat) {
        throw new Error('Stat not found');
      }

      if (!stat.pauseLogs) {
        stat.pauseLogs = [];
      }

      stat.pauseLogs.push(pauseLog);
      return stat.save();
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method: 'ADD_PAUSE_LOG',
        severity: 'MEDIUM',
        error: 'Failed to append pause log',
        message: (error as Error)?.message ?? String(error),
        payload: { statId, pauseLog },
      });
      throw error;
    }
  }

  async updatePauseTime(
    statId: string,
    pauseLogId: string,
    updatedPauseTime: Partial<PauseLogInput>,
  ): Promise<any> {
    try {
      const stat = await this.getStatById(statId);

      if (!stat) {
        throw new Error('Stat not found');
      }

      if (!stat.pauseLogs || stat.pauseLogs.length === 0) {
        throw new Error('No pause logs found for the specified Stat');
      }

      // Find the pause log by ID
      const pauseLog = stat.pauseLogs.find((log) => {
        return log._id.toString() === pauseLogId;
      });

      if (!pauseLog) {
        throw new Error('Pause log not found');
      }

      // Update the pause log with the new data
      Object.assign(pauseLog, updatedPauseTime);

      // Save the updated Stat
      return stat.save();
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method: 'UPDATE_PAUSE_TIME',
        severity: 'MEDIUM',
        error: 'Failed to update pause log',
        message: (error as Error)?.message ?? String(error),
        payload: { statId, pauseLogId },
      });
      throw error;
    }
  }

  //
  async migrateFieldsToReferenceTheDiEntity() {
    try {
      return await this.StatModel.updateMany(
        { diRef: { $exists: false }, _idDi: { $type: 'string' } },
        [{ $set: { diRef: '$_idDi' } }],
      );
    } catch (error) {
      throw withErrorContext(error, 'StatService.migrateFieldsToReferenceTheDiEntity');
    }
  }
}
