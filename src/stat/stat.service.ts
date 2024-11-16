import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CreateStatInput, PauseLogInput } from './dto/create-stat.input';
import { InjectModel } from '@nestjs/mongoose';
import { Stat } from './entities/stat.entity';
import { Model } from 'mongoose';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import { STATUS_DI } from 'src/di/di.status';
import { PaginationConfigDi } from 'src/di/dto/create-di.input';
import { Di } from 'src/di/entities/di.entity';
@Injectable()
export class StatService {
  constructor(
    @InjectModel('Stat') private StatModel: Model<Stat>,
    @InjectModel('Di') private diModel: Model<Di>,
    private readonly notificationGateway: NotificationsGateway,
    private readonly profileService: ProfileService,
  ) {}

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
    const index = await this.generateStatId();

    createStatInput._id = `STAT${index}`;
    const result = await new this.StatModel(createStatInput).save();

    if (!result) {
      throw new InternalServerErrorException('Unable to create');
    }

    // Fetch the di entity
    const di = await this.diModel.findOne({ _id: result._idDi });

    // Fetch the statTech entity (statistic)
    const statTech = await this.StatModel.findOne({ _id: result._id });

    // Add the status from di to statTech
    const statWithStatus = {
      ...statTech.toObject(), // Convert statTech to a plain object
      status: di?.status || null, // Add the status from di, set null if not found
    };

    // Log the updated statTech with status

    const profile = await this.profileService.findProlileById(
      result.id_tech_diag,
    );

    // Send the notification with the profile and updated statTech (with status)
    const payload = { profile, stat: statWithStatus };

    // this.notificationGateway.sendNotificationDiag(payload);
    this.notificationGateway.updateTicket({
      action: 'updateState',
      content: { di, states: statWithStatus },
      target: profile,
    });

    return statWithStatus;
  }

  async findUserLinkedToConcernedDi(_idDi: string) {
    return await this.StatModel.findOne({ _idDi });
  }

  async deleteStat(_id: string) {
    const result = await this.StatModel.deleteOne({ _idDi: _id });
    if (result.deletedCount === 0) {
      throw new NotFoundException(
        `Unable to remove stats linked to di with id ${_id}`,
      );
    }

    return result;
  }

  async affectForRep(_idDi: string, _idTech: string) {
    return await this.StatModel.updateOne(
      { _idDi },
      {
        $set: {
          id_tech_rep: _idTech,
        },
      },
    );
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

  async getDiForTech(
    paginationConfig: PaginationConfigDi,
    _idtech: string,
    role: string,
    startDate?: Date,
    endDate?: Date,
  ) {
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

    // Combine filters
    const finalFilter = {
      $and: [
        techFilter,
        dateFilter, // Applying the date filter if provided
      ].filter((filter) => Object.keys(filter).length > 0), // Remove empty filters
    };

    // If there are no filters, remove the $and operator
    const queryFilter = finalFilter.$and.length > 0 ? finalFilter : {};

    const totalTechDataCount = await this.StatModel.countDocuments(queryFilter);

    const stat = await this.StatModel.find(queryFilter).limit(rows).skip(first);

    return { stat, totalTechDataCount };
  }
  async lapTime(_id: string, diag_time: string) {
    return await this.StatModel.updateOne(
      { _id },
      {
        $set: {
          diag_time,
        },
      },
    );
  }

  async lapTimeForReaparation(_id: string, rep_time: string) {
    return await this.StatModel.updateOne(
      { _id },
      {
        $set: {
          rep_time,
        },
      },
    );
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
  async getInfoStatByIdDi(_idDi: string) {
    return await this.StatModel.findOne({ _idDi }).exec();
  }

  // update status
  async updateStatus(_id: string, status: string) {
    const result = await this.StatModel.updateOne(
      { _idDi: _id },
      {
        $set: {
          status,
        },
      },
    );

    return this.getInfoStatByIdDi(_id);
  }

  async changeStatToDiagnosticInPause(_idDi: string) {
    const stat = await this.StatModel.findOneAndUpdate(
      { _idDi },
      { $set: { status: STATUS_DI.DiagnosticInPause.status } },
      { new: true },
    );

    if (!stat) {
      throw new InternalServerErrorException('Error in update state in pause ');
    }

    return stat;
  }

  getStatById(_id: string) {
    return this.StatModel.findOne({ _id });
  }

  async getStatByIdlogs(_id: string) {
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
  }

  async addPauseLog(statId: string, pauseLog: PauseLogInput): Promise<any> {
    const stat = await this.getStatById(statId);
    if (!stat) {
      throw new Error('Stat not found');
    }

    if (!stat.pauseLogs) {
      stat.pauseLogs = [];
    }

    stat.pauseLogs.push(pauseLog);
    return stat.save();
  }

  async updatePauseTime(
    statId: string,
    pauseLogId: string,
    updatedPauseTime: Partial<PauseLogInput>,
  ): Promise<any> {
    const stat = await this.getStatById(statId);

    if (!stat) {
      throw new Error('Stat not found');
    }

    if (!stat.pauseLogs || stat.pauseLogs.length === 0) {
      throw new Error('No pause logs found for the specified Stat');
    }

    // Find the pause log by ID
    const pauseLog = stat.pauseLogs.find((log) => {
      console.log('log', log);
      console.log('log', log._id.toString());
      console.log('🍡[pauseLogId]:', pauseLogId);

      return log._id.toString() === pauseLogId;
    });

    console.log('🍹[pauseLog]:', pauseLog);
    if (!pauseLog) {
      throw new Error('Pause log not found');
    }

    // Update the pause log with the new data
    Object.assign(pauseLog, updatedPauseTime);

    // Save the updated Stat
    return stat.save();
  }
}
