import {
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
import { STATUS_DI, TECH_STATUS_DI_VALUES } from 'src/di/di.status';
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
@Injectable()
export class StatService {
  private readonly logger = new Logger(StatService.name);

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
    await this.operationalErrorService.capture({
      module: 'stat',
      submodule: 'statService',
      method,
      severity: 'LOW',
      error: 'Discord notification failed',
      message: (err as Error)?.message ?? String(err),
      payload,
    });
  }

  async generateStatId(): Promise<number> {
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
  }

  async createStat(createStatInput: CreateStatInput): Promise<Stat> {
    try {
      const index = await this.generateStatId();

      createStatInput._id = uuidv4();

      const di = await this.diModel.findOne({ _id: createStatInput._idDi });

      if (di.ignoreCount > 0) {
        createStatInput.ignoreCount = di.ignoreCount;
        await this.logsDiService.create(createStatInput._idDi, di.ignoreCount);
      }

      const result = await new this.StatModel(createStatInput).save();

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

      // 🔔 Discord notification — best-effort, routed through capture pipeline.
      try {
        await this.discordHookService.sendDiAssignedToTech({
          di,
          stat: statWithStatus,
          technician: profile,
        });
      } catch (err) {
        await this.captureDiscordFailure('createStat', err, {
          diId: createStatInput._idDi,
          techId: result.id_tech_diag,
        });
      }

      // existing socket notification
      this.notificationGateway.updateTicket({
        action: 'updateState',
        content: { di, states: statWithStatus },
        target: profile,
      });

      return statWithStatus;
    } catch (error) {
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
  }

  async findUserLinkedToConcernedDi(_idDi: string) {
    return await this.StatModel.findOne({ _idDi });
  }

  async checkDiStatConsistency(limit = 100): Promise<DiStatConsistencyReport> {
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
  }

  private logConsistencyReport(
    report: DiStatConsistencyReport,
    limit: number,
  ): void {
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
  }

  async deleteStat(_id: string) {
    return await this.StatModel.deleteMany({ _idDi: _id });
  }

  async affectForRep(_idDi: string, _idTech: string) {
    try {
      const di = await this.diModel.findOne({ _id: _idDi });
      if (!di) {
        throw new Error('Issue in finding di in send di to reparation');
      }

      let result;
      if (di && di.ignoreCount && di.ignoreCount > 0) {
        result = await this.StatModel.updateOne(
          { _idDi, ignoreCount: di.ignoreCount },
          {
            $set: {
              id_tech_rep: _idTech,
            },
          },
        );
      } else {
        result = await this.StatModel.updateOne(
          { _idDi },
          {
            $set: {
              id_tech_rep: _idTech,
            },
          },
        );
      }

      const stat = await this.StatModel.findOne(
        di.ignoreCount > 0 ? { _idDi, ignoreCount: di.ignoreCount } : { _idDi },
      );
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
  }

  async searchTechDi(
    paginationConfig: PaginationConfigDi,
    search: { field: string; value: string },
    _idtech: string,
    role: string,
    startDate?: Date,
    endDate?: Date,
  ) {
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

    const isAdmin = ['ADMIN_MANAGER', 'ADMIN_TECH'].includes(role);

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
  }

  async getDiForTech(
    paginationConfig: PaginationConfigDi,
    _idtech: string,
    role: string,
    startDate?: Date,
    endDate?: Date,
  ) {
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
    const isAdmin = ['ADMIN_MANAGER', 'ADMIN_TECH'].includes(role);

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
  }

  isEmpty(value) {
    return (
      value === null ||
      value === undefined ||
      value === '' ||
      value === 'null' ||
      value === 'undefined'
    );
  }
  // to get techrep and tech daig and their times
  async getRetourDataStats(_id: string) {
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
        };
      }),
    );

    return modifiedStatsRetour;
  }
  async lapTime(_id: string, diag_time: string) {
    try {
      const stat = await this.StatModel.findOne({ _id });

      if (!stat) {
        throw new Error('Issue in lapTime');
      }
      if (stat.ignoreCount > 0) {
        return await this.StatModel.updateOne(
          { _id, ignoreCount: stat.ignoreCount },
          {
            $set: {
              diag_time,
            },
          },
        );
      }

      return await this.StatModel.updateOne(
        { _id },
        {
          $set: {
            diag_time,
          },
        },
      );
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method: 'LAP_TIME_DIAG',
        severity: 'MEDIUM',
        error: 'Failed to persist diag_time',
        message: (error as Error)?.message ?? String(error),
        payload: { statId: _id, diag_time },
      });
      throw error;
    }
  }

  async lapTimeForReaparation(_id: string, rep_time: string) {
    try {
    const stat = await this.StatModel.findOne({ _id });
    if (!stat) {
      throw new Error('Issue in lapTimeForReaparation');
    }

    if (stat.ignoreCount > 0) {
      return await this.StatModel.updateOne(
        { _id, ignoreCount: stat.ignoreCount },
        {
          $set: {
            rep_time,
          },
        },
      );
    }
    return await this.StatModel.updateOne(
      { _id },
      {
        $set: {
          rep_time,
        },
      },
    );
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'stat',
        submodule: 'statService',
        method: 'LAP_TIME_REP',
        severity: 'MEDIUM',
        error: 'Failed to persist rep_time',
        message: (error as Error)?.message ?? String(error),
        payload: { statId: _id, rep_time },
      });
      throw error;
    }
  }

  async getLastPauseTime(_id: string) {
    return await this.StatModel.findOne({ _id }).exec();
  }
  async getLastPauseTimeForReparation(_id: string) {
    return await this.StatModel.findOne({ _id }).exec();
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
    const diData = await this.diModel.findOne({ _id: _idDi });
    const StatData = await this.StatModel.findOne({ _idDi });

    const techDiag = await this.profileService.getTech(StatData.id_tech_diag);
    const techrep = await this.profileService.getTech(StatData.id_tech_rep);
    StatData.id_tech_diag = techDiag;
    StatData.id_tech_rep = techrep;

    return { diData, StatData };
  }

  //get by ID_DI
  async getInfoStatByIdDi(_idDi: string, _idLog: number) {
    let stat;
    if (_idLog) {
      stat = await this.StatModel.findOne({
        _idDi,
        ignoreCount: _idLog,
      });
    } else {
      stat = await this.StatModel.findOne({ _idDi });
    }

    return stat;
  }

  // update status
  async updateStatus(_idDi: string, status: string, ignoreCount?: number) {
    try {
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
    return this.StatModel.findOne({ _id });
  }

  async getStatByIdlogs(_id: string) {
    try {
      const stat = await this.StatModel.findOne({ _idDi: _id });
      if (!stat) {
        throw new Error('Stat not found');
      }
      if (stat.pauseLogs.length === 0) {
        throw new Error('No logs found');
      }
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
    return await this.StatModel.updateMany(
      { diRef: { $exists: false }, _idDi: { $type: 'string' } },
      [{ $set: { diRef: '$_idDi' } }],
    );
  }
}
