import { Injectable, NotFoundException } from '@nestjs/common';
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

  deleteUser(_id: string) {
    return this.profileModel
      .findOneAndUpdate(
        { _id },
        {
          $set: {
            isDeleted: true,
          },
        },
        { new: true },
      )
      .then((res) => {
        return res;
      })
      .catch((err) => {
        //
      });
  }
  // for listing profiles pagination
  async getAllProfile(paginationConfig: PaginationConfigProfile) {
    const { first, rows } = paginationConfig;
    const totalProfileCount = await this.profileModel.countDocuments().exec();
    const profileRecord = await this.profileModel
      .find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    return { profileRecord, totalProfileCount };
  }

  async findOneForAuth(username: string): Promise<Profile | undefined> {
    return await this.profileModel
      .findOne({ username })
      .then((res) => {
        //
        return res;
      })
      .catch((err) => {
        //
        return err;
      });
  }

  async findProlileById(_id: string): Promise<Profile> {
    const result = await this.profileModel.findById(_id);
    if (!result) {
      throw new NotFoundException(`Unable to find profile woth id:${_id}`);
    }
    return result;
  }
  // async getAllTech() {
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
  //     //
  //     return res;
  //   })
  //   .catch((err) => {
  //     //
  //     return err;
  //   });
  // }

  async getAllTech() {
    return await this.profileModel
      .find({ role: { $in: [ROLE.ADMIN_TECH, ROLE.TECH] } })
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
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
        //
        return res;
      })
      .catch((err) => {
        //
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
  /**-------------- */

  /**
   * Update fields
   */

  updateProfile(_id: string, updateProfileInput: UpdateProfileInput) {
    return this.profileModel
      .findOneAndUpdate(
        { _id },
        {
          $set: {
            firstName: updateProfileInput.firstName,
            lastName: updateProfileInput.lastName,
            phone: updateProfileInput.phone,
            email: updateProfileInput.email,
          },
        },
        { new: true }, // Return the updated document
      )
      .then((res) => {
        //
        return res;
      })
      .catch((err) => {
        //
        return err;
      });
  }
}
