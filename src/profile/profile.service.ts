import { Injectable } from '@nestjs/common';
import {
  CreateProfileInput,
  PaginationConfigProfile,
} from './dto/create-profile.input';
import { UpdateProfileInput } from './dto/update-profile.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Profile, ProfileDocument } from './entities/profile.entity';
import { ROLE } from 'src/auth/roles';
// import { STATUS_TICKET } from 'src/ticket/ticket';

@Injectable()
export class ProfileService {
  constructor(
    @InjectModel('Profile') private profileModel: Model<ProfileDocument>,
  ) {}
  async create(
    createProfileInput: CreateProfileInput,
  ): Promise<Profile | undefined> {
    return (await this.profileModel.create(createProfileInput))
      .save()
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  updateProfile(_id: string, updateProfileInput: UpdateProfileInput) {
    // console.log(updateProfileInput, 'updateProfileInput');
    return this.profileModel
      .updateOne(
        { _id },
        {
          $set: {
            firstName: updateProfileInput.firstName,
            lastName: updateProfileInput.lastName,
            phone: updateProfileInput.phone,
          },
        },
      )
      .then((res) => {
        // console.log('profile update', res);
        return res;
      })
      .catch((err) => {
        // console.log('err', err);
        return err;
      });
  }

  deleteUser(_id: string) {
    return this.profileModel
      .updateOne(
        { _id },
        {
          $set: {
            isDeleted: true,
          },
        },
      )
      .then((res) => {
        return res;
      })
      .catch((err) => {
        // console.log('err');
      });
  }
  // for listing profiles pagination
  async getAllProfile(paginationConfig: PaginationConfigProfile) {
    const { first, rows } = paginationConfig;
    const totalProfileCount = await this.profileModel.countDocuments().exec();
    const profileRecord = await this.profileModel
      .find({})
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();
    console.log('🥒', profileRecord);
    return { profileRecord, totalProfileCount };
  }

  async findOneForAuth(username: string): Promise<Profile | undefined> {
    return await this.profileModel
      .findOne({ username })
      .then((res) => {
        // console.log('find one auth ', res);
        return res;
      })
      .catch((err) => {
        // console.log('Err find one auth', err);
        return err;
      });
  }

  async getAllTech() {
    // return await this.profileModel
    //   .aggregate([
    //     { $match: { role: { $in: [ROLE.TECH, ROLE.ADMIN_TECH] } } },
    //     {
    //       $lookup: {
    //         from: 'tickets',
    //         localField: 'username',
    //         foreignField: 'assignedTo',
    //         as: 'ticketByTech',
    //         pipeline: [
    //           {
    //             $match: {
    //               status: {
    //                 $nin: [STATUS_TICKET.FINISHED, STATUS_TICKET.IGNORED],
    //               },
    //               isOpenByTech: false,
    //             },
    //           },
    //           // Add more stages to the pipeline as needed
    //         ],
    //       },
    //     },
    //     {
    //       $project: {
    //         _id: '$_id',
    //         username: '$username',
    //         ticketCount: { $size: '$ticketByTech' },
    //       },
    //     },
    //   ])
    //   .then((res) => {
    //     // console.log('join ticket tech', res);
    //     return res;
    //   })
    //   .catch((err) => {
    //     // console.log(err, 'err');
    //     return err;
    //   });
  }

  async getAllAdmins() {
    return await this.profileModel
      .find({ role: { $in: [ROLE.ADMIN_MANAGER, ROLE.ADMIN_TECH] } })
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  //! Dashbord services

  // client by region
  getClientByRegion() {
    return this.profileModel
      .aggregate([
        {
          $group: {
            _id: '$role',
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            name: '$_id',
            value: '$count',
            _id: 0,
          },
        },
      ])
      .then((res) => {
        // console.log(res, 'res');
        return res;
      })
      .catch((err) => {
        // console.log(err, 'err');
        return err;
      });
  }

  getTicketByProfileDiag() {
    return this.profileModel
      .aggregate([
        {
          $lookup: {
            from: 'tickets',
            localField: 'username',
            foreignField: 'assignedTo',
            as: 'ticketByProfile',
          },
        },
        { $unwind: '$ticketByProfile' },
        {
          $group: {
            _id: '$username',
            diagnostiqueTime: {
              $push: '$ticketByProfile.diagnosticTimeByTech',
            },
            // reparationTime: {
            //   $push: '$ticketByProfile.reparationTimeByTech',
            // },
          },
        },

        {
          $project: {
            _id: 0,
            techName: '$_id',
            totalDiag: '$diagnostiqueTime',
          },
        },
      ])
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  getTicketByProfileRep() {
    return this.profileModel
      .aggregate([
        {
          $lookup: {
            from: 'tickets',
            localField: 'username',
            foreignField: 'assignedToRep',
            as: 'ticketByProfile',
          },
        },
        { $unwind: '$ticketByProfile' },
        {
          $group: {
            _id: '$username',

            reparationTime: {
              $push: '$ticketByProfile.reparationTimeByTech',
            },
          },
        },

        {
          $project: {
            _id: 0,
            techName: '$_id',
            totalRep: '$reparationTime',
          },
        },
      ])
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  update(id: number, updateProfileInput: UpdateProfileInput) {
    return `This action updates a #${id} profile`;
  }

  remove(id: number) {
    return `This action removes a #${id} profile`;
  }
}
