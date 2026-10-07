import { Injectable } from '@nestjs/common';
import { CreateLocationInput } from './dto/create-location.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Location } from './entities/location.entity';
import { Di } from 'src/di/entities/di.entity';
import { v4 as uuidv4 } from 'uuid';
import { withErrorContext, reportCatchError } from '../common/error-context';
@Injectable()
export class LocationService {
  constructor(
    @InjectModel('Location') private LocationModel: Model<Location>,
    @InjectModel('Di') private diModel: Model<Di>,
  ) {}

  async generateLocationId(): Promise<number> {
    try {
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
    } catch (error) {
      throw withErrorContext(error, 'LocationService.generateLocationId');
    }
  }

  async createlocation(
    createLocationInput: CreateLocationInput,
  ): Promise<Location> {
    try {
      const index = await this.generateLocationId();
      createLocationInput._id = uuidv4(); // E => Emplacement
      return await new this.LocationModel(createLocationInput)
        .save()
        .then((res) => {
          return res;
        })
        .catch((err) => {
          return err;
        });
    } catch (error) {
      throw withErrorContext(error, 'LocationService.createlocation');
    }
  }

  async syncEmplacementStats(emplacementId: string): Promise<Location | null> {
    try {
      if (!emplacementId) {
        return null;
      }

      const storedDiCount = await this.diModel.countDocuments({
        location_id: emplacementId,
        isDeleted: false,
      });

      return await this.LocationModel.findOneAndUpdate(
        { _id: emplacementId },
        {
          $set: {
            storedDiCount: Math.max(0, storedDiCount),
            hasStoredDi: storedDiCount > 0,
            current_item_stored: Math.max(0, storedDiCount),
          },
        },
        { new: true },
      );
    } catch (error) {
      throw withErrorContext(error, 'LocationService.syncEmplacementStats');
    }
  }

  async syncEmplacementStatsForChange(
    oldEmplacementId?: string,
    newEmplacementId?: string,
  ): Promise<void> {
    try {
      const ids = Array.from(
        new Set([oldEmplacementId, newEmplacementId].filter(Boolean)),
      );

      await Promise.all(ids.map((id) => this.syncEmplacementStats(id)));
    } catch (error) {
      throw withErrorContext(
        error,
        'LocationService.syncEmplacementStatsForChange',
      );
    }
  }

  async removeLocation(_id: string): Promise<Location> {
    try {
      return await this.LocationModel.findOneAndUpdate(
        { _id },
        { $set: { isDeleted: true } },
      );
    } catch (error) {
      throw withErrorContext(error, 'LocationService.removeLocation');
    }
  }

  async findAllLocations(): Promise<Location[]> {
    try {
      return await this.LocationModel.find({ isDeleted: false })
        // Ordre par défaut de l'app : dernier créé en premier (remplace le tri
        // alphabétique historique — les dropdowns sont désormais recherchables,
        // ce qui compense la perte de l'ordre A→Z).
        .sort({ createdAt: -1 })
        .then((res) => {
          return res;
        })
        .catch((err) => {
          return err;
        });
    } catch (error) {
      throw withErrorContext(error, 'LocationService.findAllLocations');
    }
  }

  async findOneLocation(_id: string): Promise<Location> {
    try {
      const location = await this.LocationModel.findById(_id).lean();

      if (!location) {
        throw new Error(`Location with ID '${_id}' not found.`);
      }
      return location;
    } catch (error) {
      reportCatchError(error, 'LocationService.findOneLocation');
      throw error;
    }
  }
}
