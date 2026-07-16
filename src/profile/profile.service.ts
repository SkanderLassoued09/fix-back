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
import { OperationalErrorService } from 'src/operational-error/operational-error.service';
// import { STATUS_TICKET } from 'src/ticket/ticket';

@Injectable()
export class ProfileService {
  constructor(
    @InjectModel('Profile') private profileModel: Model<ProfileDocument>,
    private readonly operationalErrorService: OperationalErrorService,
  ) {}

  async create(
    createProfileInput: CreateProfileInput,
  ): Promise<Profile | undefined> {
    try {
      const doc = await this.profileModel.create(createProfileInput);
      return await doc.save();
    } catch (error) {
      // Previously a silent `.catch((err) => return err)` — the resolver
      // returned an Error object as if it were a Profile. Now we capture
      // and rethrow the original error so the auth/admin flows see the
      // real Mongo cause (duplicate key, validation, etc.).
      await this.operationalErrorService.capture({
        module: 'profile',
        submodule: 'profileService',
        method: 'CREATE_PROFILE',
        severity: 'HIGH',
        error: 'Failed to create profile',
        message: (error as Error)?.message ?? String(error),
        payload: {
          username: createProfileInput?.username,
          email: createProfileInput?.email,
          role: createProfileInput?.role,
        },
      });
      throw error;
    }
  }

  deleteUser(_id: string) {
    return this.profileModel.findOneAndUpdate(
      { _id },
      {
        $set: {
          isDeleted: true,
        },
      },
      { new: true },
    );
  }
  async searchProfile(
    paginationConfig: PaginationConfigProfile,
    search: { field: string; value: string },
  ) {
    const { first, rows } = paginationConfig;
    const { field, value } = search;

    // Base filter
    const filter: any = { isDeleted: false };

    // Only apply search if value has 2+ characters
    if (field && value && value.trim().length >= 2) {
      const trimmedValue = value.trim();
      const regex = { $regex: `${trimmedValue}`, $options: 'i' };

      switch (field) {
        case 'username':
        case 'firstName':
        case 'lastName':
        case 'phone':
        case 'email':
        case 'role':
          filter[field] = regex;
          break;

        case 'createdAt':
        case 'updatedAt':
          // For date fields, try to parse and search
          // This will match dates that contain the search string
          // You might want to implement more sophisticated date search
          const dateSearch = new Date(trimmedValue);
          if (!isNaN(dateSearch.getTime())) {
            filter[field] = {
              $gte: new Date(dateSearch.setHours(0, 0, 0, 0)),
              $lte: new Date(dateSearch.setHours(23, 59, 59, 999)),
            };
          }
          break;
      }
    }

    // COUNT
    const totalProfileCount = await this.profileModel.countDocuments(filter);

    // FETCH
    const profileRecord = await this.profileModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    return { profileRecord, totalProfileCount };
  }
  // for listing profiles pagination
  async getAllProfile(paginationConfig: PaginationConfigProfile) {
    const { first, rows } = paginationConfig;
    const totalProfileCount = await this.profileModel
      .countDocuments({ isDeleted: false })
      .exec();
    const profileRecord = await this.profileModel
      .find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .limit(rows)
      .skip(first)
      .exec();

    return { profileRecord, totalProfileCount };
  }

  async findOneForAuth(username: string): Promise<Profile | undefined> {
    try {
      return await this.profileModel.findOne({ username });
    } catch (error) {
      // CRITICAL: previously a silent `.catch((err) => return err)` — login
      // received an Error object instead of a Profile, with unknown
      // downstream behavior. Now we capture and return null so the auth
      // guard treats it as "user not found" rather than mistaking the
      // Error object for a valid profile.
      await this.operationalErrorService.capture({
        module: 'profile',
        submodule: 'profileService',
        method: 'FIND_ONE_FOR_AUTH',
        severity: 'CRITICAL',
        error: 'Auth lookup failed',
        message: (error as Error)?.message ?? String(error),
        payload: { username },
      });
      return null;
    }
  }

  async getTech(_id: string) {
    try {
      const tech = await this.profileModel.findOne({ _id }).exec();
      if (!tech) {
        // Was crashing with "Cannot read property 'firstName' of null"
        // when a stat referenced a deleted profile. Now we capture +
        // return a sentinel string so callers (StatService.getTech,
        // getRetourDataStats, etc.) keep working with degraded data.
        await this.operationalErrorService.capture({
          module: 'profile',
          submodule: 'profileService',
          method: 'GET_TECH',
          severity: 'MEDIUM',
          error: 'Tech profile not found',
          message: `No profile with _id=${_id}`,
          payload: { _id },
        });
        return 'Unknown';
      }
      return `${tech.firstName} ${tech.lastName}`;
    } catch (error) {
      await this.operationalErrorService.capture({
        module: 'profile',
        submodule: 'profileService',
        method: 'GET_TECH',
        severity: 'MEDIUM',
        error: 'Failed to load tech profile',
        message: (error as Error)?.message ?? String(error),
        payload: { _id },
      });
      return 'Unknown';
    }
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
      .find({
        role: { $in: [ROLE.ADMIN_TECH, ROLE.TECH] },
        isDeleted: false,
      })
      .sort({ createdAt: -1 });
  }

  async getAllAdmins() {
    try {
      return await this.profileModel
        .find({
          role: { $in: [ROLE.ADMIN_MANAGER, ROLE.ADMIN_TECH] },
        })
        .sort({ createdAt: -1 });
    } catch (error) {
      await this.captureSilentFailure('GET_ALL_ADMINS', error);
      return [];
    }
  }

  //! Dashbord services

  // client by region
  async getClientByRegion() {
    try {
      return await this.profileModel.aggregate([
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
      ]);
    } catch (error) {
      await this.captureSilentFailure('GET_CLIENT_BY_REGION', error);
      return [];
    }
  }

  async getTicketByProfileDiag() {
    try {
      return await this.profileModel.aggregate([
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
      ]);
    } catch (error) {
      await this.captureSilentFailure('GET_TICKET_BY_PROFILE_DIAG', error);
      return [];
    }
  }

  async getTicketByProfileRep() {
    try {
      return await this.profileModel.aggregate([
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
      ]);
    } catch (error) {
      await this.captureSilentFailure('GET_TICKET_BY_PROFILE_REP', error);
      return [];
    }
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

  async updateProfile(_id: string, updateProfileInput: UpdateProfileInput) {
    try {
      return await this.profileModel.findOneAndUpdate(
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
      );
    } catch (error) {
      // Previously a silent `.catch((err) => return err)` — profile edit
      // returned an Error object as if the update succeeded. Now capture
      // and rethrow so the caller sees a real failure.
      await this.operationalErrorService.capture({
        module: 'profile',
        submodule: 'profileService',
        method: 'UPDATE_PROFILE',
        severity: 'HIGH',
        error: 'Failed to update profile',
        message: (error as Error)?.message ?? String(error),
        payload: { _id, fields: Object.keys(updateProfileInput ?? {}) },
      });
      throw error;
    }
  }

  /**
   * Shared helper for the historically silent `.catch(err => err)` query
   * sites. Captures with HIGH severity (these were data-returning bugs)
   * and the caller returns a safe `[]` default.
   */
  private async captureSilentFailure(method: string, err: unknown) {
    await this.operationalErrorService.capture({
      module: 'profile',
      submodule: 'profileService',
      method,
      severity: 'HIGH',
      error: 'Query failed (was previously swallowed)',
      message: (err as Error)?.message ?? String(err),
    });
  }
}
