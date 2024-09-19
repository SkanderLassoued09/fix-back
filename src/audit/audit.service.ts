import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AuditInput } from './dto/create-audit.input';
import { UpdateAuditInput } from './dto/update-audit.input';
import { InjectModel } from '@nestjs/mongoose';
import { Audit } from './entities/audit.entity';
import { Model } from 'mongoose';
import { NotFoundError } from 'rxjs';

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(Audit.name) private readonly auditModel: Model<Audit>,
  ) {}
  async create(auditInput: AuditInput) {
    try {
      const createNotification = await new this.auditModel(auditInput).save();
      if (!createNotification) {
        throw new InternalServerErrorException(
          'err while creating notification',
        );
      }
      return createNotification;
    } catch (error) {
      throw error;
    }
  }

  async markReminderAsSeenForaudit(
    auditId: string,
    reminderId: string,
  ): Promise<Audit> {
    return this.auditModel
      .findOneAndUpdate(
        { _id: auditId, 'reminder.data._id': reminderId }, // Find by audit _id and reminder _id
        {
          $set: { 'reminder.data.$.isSeen': true }, // Set isSeen to true for the matching reminder
        },
        { new: true }, // Return the updated document
      )
      .exec();
  }

  async getRemindernotOpenedTickets() {
    try {
      const result = await this.auditModel
        .find({ 'reminder.isSeen': false }, 'reminder')
        .exec();
      if (result.length === 0) {
        throw new NotFoundException('Unable to find reminders');
      }
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(error);
    }
  }
  // Method to update all reminders with isSeen = false to isSeen = true
  async markReminderAsSeen(_id: string): Promise<Audit> {
    try {
      const result = await this.auditModel.findOneAndUpdate(
        { 'reminder.isSeen': false }, // Filter criteria
        { $set: { 'reminder.isSeen': true } },
        { new: true }, // Update operation
      );

      if (!result) {
        throw new InternalServerErrorException('Unable to change the flag');
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  // Method to delete all documents containing the `reminder` field
  async deleteDocumentsWithReminderField(): Promise<{ deletedCount: number }> {
    const result = await this.auditModel.deleteMany({
      reminder: { $exists: true },
    }); // Filter to match documents with `reminder` field
    return { deletedCount: result.deletedCount };
  }

  // Method to find existing reminders by _id
  async findExistingReminders(ids: string[]): Promise<Audit[]> {
    return this.auditModel.find({ 'reminder.data._id': { $in: ids } }).exec();
  }

  async emptyAudit() {
    return await this.auditModel.deleteMany({});
  }
  findOne(id: number) {
    return `This action returns a #${id} audit`;
  }

  update(id: number, updateAuditInput: UpdateAuditInput) {
    return `This action updates a #${id} audit`;
  }

  remove(id: number) {
    return `This action removes a #${id} audit`;
  }
}
