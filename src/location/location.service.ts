import { Injectable } from '@nestjs/common';
import { CreateLocationInput } from './dto/create-location.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Location } from './entities/location.entity';

@Injectable()
export class LocationService {
  constructor(
    @InjectModel('Location') private LocationModel: Model<Location>,
  ) {}

  async generateLocationId(): Promise<number> {
    let indexLocation = 0;
    const lastLocation = await this.LocationModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastLocation) {
      indexLocation = +lastLocation._id.substring(1);
      return indexLocation + 1;
    }
    return indexLocation;
  }

  async createlocation(
    createLocationInput: CreateLocationInput,
  ): Promise<Location> {
    const index = await this.generateLocationId();
    createLocationInput._id = `E${index}`; // E => Emplacement
    return await new this.LocationModel(createLocationInput)
      .save()
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async removeLocation(_id: string): Promise<Boolean> {
    return this.LocationModel.deleteOne({ _id })
      .then(() => {
        return true;
      })
      .catch(() => {
        return false;
      });
  }

  async findAllLocations(): Promise<[Location]> {
    return await this.LocationModel.find({})
      .then((res) => {
        return res;
      })
      .catch((err) => {
        return err;
      });
  }

  async findOneLocation(_id: string): Promise<Location> {
    try {
      const location = await this.LocationModel.findById(_id).lean();

      if (!location) {
        throw new Error(`Location with ID '${_id}' not found.`);
      }
      return location;
    } catch (error) {
      throw error;
    }
  }
}
