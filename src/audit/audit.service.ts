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
import { withErrorContext } from '../common/error-context';

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

  async getAllNotification() {
    try {
      return await this.auditModel.find({ isSeen: false }).sort({ createdAt: -1 });
    } catch (error) {
      throw withErrorContext(error, 'AuditService.getAllNotification');
    }
  }

  /**
   * Toutes les traces d'audit d'UNE DI (`_idDoc`), vues ET non vues, du plus
   * récent au plus ancien. `getAllNotification` ne renvoie que les non-vues et
   * sans filtre de DI : les traces d'une DI (dont `DI_REACTIVATED`, seul
   * enregistrement de qui a réactivé le dossier) étaient donc inatteignables.
   */
  async getAuditByDi(diId: string, limit = 200) {
    try {
      return await this.auditModel
        .find({ _idDoc: diId })
        .sort({ createdAt: -1 })
        .limit(Math.min(Math.max(limit, 1), 500));
    } catch (error) {
      throw withErrorContext(error, 'AuditService.getAuditByDi');
    }
  }

  async updateConfirm(_id: string, confirmationComposant: string) {
    try {
      return await this.auditModel.findOneAndUpdate(
        { _id },
        {
          $set: {
            message: confirmationComposant,
          },
        },
        { new: true },
      );
    } catch (error) {
      throw withErrorContext(error, 'AuditService.updateConfirm');
    }
  }

  async markAsSeen(_id: string) {
    try {
      return await this.auditModel.findOneAndUpdate(
        { _id },
        { $set: { isSeen: true } },
        { new: true },
      );
    } catch (error) {
      throw withErrorContext(error, 'AuditService.markAsSeen');
    }
  }

  async markReminderAsSeenForaudit(
    auditId: string,
    reminderId: string,
  ): Promise<Audit> {
    try {
      return await this.auditModel
        .findOneAndUpdate(
          { _id: auditId, 'reminder.data._id': reminderId }, // Find by audit _id and reminder _id
          {
            $set: { 'reminder.data.$.isSeen': true }, // Set isSeen to true for the matching reminder
          },
          { new: true }, // Return the updated document
        )
        .exec();
    } catch (error) {
      throw withErrorContext(error, 'AuditService.markReminderAsSeenForaudit');
    }
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
    try {
      const result = await this.auditModel.deleteMany({
        reminder: { $exists: true },
      }); // Filter to match documents with `reminder` field
      return { deletedCount: result.deletedCount };
    } catch (error) {
      throw withErrorContext(error, 'AuditService.deleteDocumentsWithReminderField');
    }
  }

  // Method to find existing reminders by _id
  async findExistingReminders(ids: string[]): Promise<Audit[]> {
    try {
      return await this.auditModel.find({ 'reminder.data._id': { $in: ids } }).exec();
    } catch (error) {
      throw withErrorContext(error, 'AuditService.findExistingReminders');
    }
  }

  async emptyAudit() {
    try {
      return await this.auditModel.deleteMany({});
    } catch (error) {
      throw withErrorContext(error, 'AuditService.emptyAudit');
    }
  }
  findOne(id: number) {
    try {
      return `This action returns a #${id} audit`;
    } catch (error) {
      throw withErrorContext(error, 'AuditService.findOne');
    }
  }

  update(id: number, updateAuditInput: UpdateAuditInput) {
    try {
      return `This action updates a #${id} audit`;
    } catch (error) {
      throw withErrorContext(error, 'AuditService.update');
    }
  }

  remove(id: number) {
    try {
      return `This action removes a #${id} audit`;
    } catch (error) {
      throw withErrorContext(error, 'AuditService.remove');
    }
  }
}
