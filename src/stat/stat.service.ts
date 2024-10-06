import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CreateStatInput } from './dto/create-stat.input';
import { InjectModel } from '@nestjs/mongoose';
import { Stat } from './entities/stat.entity';
import { Model } from 'mongoose';
import { NotificationsGateway } from 'src/notification.gateway';
import { ProfileService } from 'src/profile/profile.service';
import { STATUS_DI } from 'src/di/di.status';
import { PaginationConfigDi } from 'src/di/dto/create-di.input';
@Injectable()
export class StatService {
  constructor(
    @InjectModel('Stat') private StatModel: Model<Stat>,
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

    const profile = await this.profileService.findProlileById(
      result.id_tech_diag,
    );

    const payload = { profile, stat: result };
    this.notificationGateway.sendNotificationDiag(payload);

    return result;
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
    console.log('🍶[endDate]:', endDate);
    console.log('🌰[startDate]:', startDate);
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

    console.log('🦀[result]:', result);
    return result;
  }

  async getDiForTech(
    paginationConfig: PaginationConfigDi,
    _idtech: string,
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

    const totalTechDataCount = await this.StatModel.countDocuments({
      $and: [
        { $or: [{ id_tech_diag: _idtech }, { id_tech_rep: _idtech }] },
        dateFilter, // Applying the date filter if provided
      ],
    });

    // Querying with the date filter and technician IDs
    const stat = await this.StatModel.find({
      $and: [
        { $or: [{ id_tech_diag: _idtech }, { id_tech_rep: _idtech }] },
        dateFilter, // Applying the date filter if provided
      ],
    })
      .limit(rows)
      .skip(first);

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
    console.log('🦑[_idDi]:', _idDi);

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
}
