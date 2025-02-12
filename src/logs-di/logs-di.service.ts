import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { UpdateLogsDiInput } from './dto/update-logs-di.input';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiLogsDocument, LogsDi } from './entities/logs-di.entity';
import { DiagUpdateLogs } from './dto/create-logs-di.input';

import {
  Composant,
  ComposantDocument,
} from 'src/composant/entities/composant.entity';
@Injectable()
export class LogsDiService {
  constructor(
    @InjectModel(LogsDi.name)
    private readonly logsDiModel: Model<DiLogsDocument>,
    @InjectModel(Composant.name)
    private composantModel: Model<ComposantDocument>,
  ) {}

  async generateDiId(): Promise<number> {
    let indexDIL = 0;
    const lastDIL = await this.logsDiModel.findOne(
      {},
      {},
      { sort: { createdAt: -1 } },
    );

    if (lastDIL) {
      indexDIL = +lastDIL._id.substring(3);
      return indexDIL + 1;
    }
    return indexDIL;
  }

  async create(_idDi: string, idIgnore: number) {
    const index = await this.generateDiId();
    let _id = `DIL${index}`;
    return await new this.logsDiModel({ _id, _idDi, idIgnore }).save();
  }

  async getLogsById(idIgnore: number, _idDi: string) {
    try {
      const logsDi = await this.logsDiModel.findOne({ _idDi, idIgnore });

      // if (!logsDi) {
      //   throw new Error(
      //     `logsDi not found for id ${_idDi} and ignore count ${idIgnore}`,
      //   );
      // }
      return logsDi;
    } catch (error) {
      throw error;
    }
  }

  // async updatePricing(_id:number,price){
  //   const pricing  = await this.logsDiModel.findOneAndUpdate({_id},{$set:{price}})
  // }

  //Tech finsih diagnostic
  async tech_startDiagnostic(
    _idDi: string,
    idIgnore: number,
    diag: DiagUpdateLogs,
  ) {
    console.log('data retour', diag);
    try {
      const result = await this.logsDiModel.findOneAndUpdate(
        { _idDi, idIgnore },
        {
          $set: {
            can_be_repaired: diag.can_be_repaired,
            contain_pdr: diag.contain_pdr,
            remarque_tech_diagnostic: diag.remarque_tech_diagnostic,
            isErrorFromFixtronix: diag.isErrorFromFixtronix ?? null,
            array_composants: diag.array_composants,
            di_category_id: diag.di_category_id,
          },
        },
      );
      if (!result) {
        throw new Error('Issue when saving data when tech save logs');
      }

      return result;
    } catch (error) {
      throw error;
    }
  }
  async savePricing(
    _idDi: string,
    idIgnore: number,
    price: number,
    final_price?: number,
  ) {
    console.log('🥐', { _idDi, idIgnore, price, final_price });
    if (final_price) {
      return await this.logsDiModel
        .findOneAndUpdate({ _idDi, idIgnore }, { $set: { price, final_price } })
        .then((res) => {
          return res;
        })
        .catch((err) => {
          return err;
        });
    } else {
      return await this.logsDiModel
        .findOneAndUpdate({ _idDi, idIgnore }, { $set: { price } })
        .then((res) => {
          return res;
        })
        .catch((err) => {
          return err;
        });
    }
  }

  async calculateComposantTicketPrice(_idDi: string, idIgnore: number) {
    const diLog = await this.logsDiModel.findOne({ _idDi, idIgnore });
    const totalPrice = await Promise.all(
      diLog.array_composants.map(async (item) => {
        const composant = await this.composantModel.findOne({
          name: item.nameComposant,
        });

        return composant ? composant.prix_vente * item.quantity : 0;
      }),
    );
    // TODO substruct the quantity needed from compsant in stock.
    return totalPrice.reduce((acc, curr) => acc + curr, 0);
  }

  async addDevisPDFLogs(_idDi: string, idIgnore: number, pdf: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { devis: pdf } },
      { new: true },
    );
  }
  async addBCPDFLogs(_idDi: string, idIgnore: number, pdf: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { bon_de_commande: pdf } },
      { new: true },
    );
  }
  //Bon de livraison
  async addBLPDFLogs(_idDi: string, idIgnore: number, pdf: string) {
    console.log('🍰[idIgnore]:', idIgnore);
    console.log('🍶[_idDi]:', _idDi);
    const bl = await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { bon_de_livraison: pdf } },
      { new: true },
    );

    console.log('🍧bl', bl);
    return bl;
  }
  async addFacturePDFLogs(_idDi: string, idIgnore: number, pdf: string) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { facture: pdf } },
      { new: true },
    );
  }

  async calculateticketComposantPriceLogs(_id: string, idIgnore: number) {
    const ticket = await this.logsDiModel.findOne({ _id, idIgnore });

    const totalPrice = await Promise.all(
      ticket.array_composants.map(async (item) => {
        const composant = await this.composantModel.findOne({
          name: item.nameComposant,
        });
        return composant ? composant.prix_vente * item.quantity : 0;
      }),
    );
    // TODO substruct the quantity needed from compsant in stock

    return totalPrice.reduce((acc, curr) => acc + curr, 0);
  }

  async isSentToCoordinator(_idDi: string, idIgnore: number) {
    return await this.logsDiModel.findOneAndUpdate(
      { _idDi, idIgnore },
      { $set: { isSentToCoordinator: true } },
      { new: true },
    );
  }
  async componentConfirmedFromCoordinator(_id: string, idIgnore: number) {
    return await this.logsDiModel.findOneAndUpdate(
      { _id, idIgnore },
      {
        $set: {
          isConfirmedComponentFromCoordinator: true,
        },
      },
    );
  }

  async setSelectedComponentAsDoneLogs(
    _idDi: string,
    diIgnore: number,
    nameComponent: string,
  ) {
    try {
      // Find the document with the specific component
      const updatedDocument = await this.logsDiModel.findOneAndUpdate(
        {
          _idDi: _idDi,
          idIgnore: diIgnore,
          'array_composants.nameComposant': nameComponent,
        },
        { $set: { 'array_composants.$.isUpdated': true } }, // Update only the matched component
        { new: true }, // Return the updated document
      );

      if (!updatedDocument) {
        throw new NotFoundException(`Document or component not found.`);
      }

      return updatedDocument;
    } catch (error) {
      console.log('🍋[error]:', error);
      throw new InternalServerErrorException(error);
    }
  }

  async getAllLogsByDi(_idDi: string) {
    try {
      const logs = await this.logsDiModel.find({ _idDi });

      if (logs.length === 0) {
        console.log('No logs for this DI');
        return [];
      }
      return logs;
    } catch (error) {
      console.log('🍎[error]:', error);
    }
  }

  findAll() {
    return `This action returns all logsDi`;
  }

  findOne(id: number) {
    return `This action returns a #${id} logsDi`;
  }

  update(id: number, updateLogsDiInput: UpdateLogsDiInput) {
    return `This action updates a #${id} logsDi`;
  }

  remove(id: number) {
    return `This action removes a #${id} logsDi`;
  }
}
