import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { normalizeTierName } from './tier-name.util';
import { TierAliasType } from './entities/tier-alias.entity';
import { withErrorContext } from '../../common/error-context';

/**
 * Mémoire des décisions de rapprochement (`tier_aliases`).
 *
 * SÉCURITÉ :
 *  - `record` VALIDE le `tierId` côté back (le tiers doit EXISTER et être du type
 *    annoncé) — on ne fait JAMAIS confiance à un `tierId` venu du front.
 *  - `decidedBy` est l'utilisateur authentifié (passé par le service appelant,
 *    jamais un id arbitraire).
 *
 * COHÉRENCE : `isValid` re-vérifie l'alias contre l'état courant à chaque import.
 */
@Injectable()
export class TierAliasService {
  constructor(
    @InjectModel('TierAlias') private readonly aliasModel: Model<any>,
    @InjectModel('Client') private readonly clientModel: Model<any>,
    @InjectModel('Company') private readonly companyModel: Model<any>,
  ) {}

  /** Le tiers existe-t-il (non supprimé) ET correspond-il au type ? */
  private async tierExists(tierId: string, type: TierAliasType): Promise<boolean> {
    try {
      if (!tierId) return false;
      const model = type === 'CLIENT' ? this.clientModel : this.companyModel;
      const found = await model.exists({ _id: tierId, isDeleted: { $ne: true } });
      return !!found;
    } catch (error) {
      throw withErrorContext(error, 'TierAliasService.tierExists');
    }
  }

  /**
   * Enregistre/actualise une décision (upsert par nom normalisé). REVALIDE le
   * `tierId` : s'il n'existe pas / mauvais type → REJET (jamais d'alias vers un
   * tiers invalide). `decidedBy` = utilisateur authentifié.
   */
  async record(input: {
    importedName: string;
    tierId: string;
    type: TierAliasType;
    decidedBy?: string;
  }): Promise<any> {
    try {
      const key = normalizeTierName(input.importedName);
      if (!key) {
        throw new BadRequestException('Nom de tiers vide — décision non enregistrable.');
      }
      if (input.type !== 'CLIENT' && input.type !== 'SOCIETE') {
        throw new BadRequestException('Type de tiers invalide.');
      }
      const ok = await this.tierExists(input.tierId, input.type);
      if (!ok) {
        throw new BadRequestException(
          `Tiers ${input.type} « ${input.tierId} » introuvable — décision rejetée.`,
        );
      }
      return await this.aliasModel.findOneAndUpdate(
        { importedNameNormalized: key },
        {
          $set: {
            tierId: input.tierId,
            type: input.type,
            decidedBy: input.decidedBy,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
    } catch (error) {
      throw withErrorContext(error, 'TierAliasService.record');
    }
  }

  /** Alias pour un nom (normalisé à l'intérieur), ou null. */
  async findByName(importedName: string): Promise<any | null> {
    try {
      return await this.aliasModel
        .findOne({ importedNameNormalized: normalizeTierName(importedName) })
        .lean();
    } catch (error) {
      throw withErrorContext(error, 'TierAliasService.findByName');
    }
  }

  /** Tous les alias sous forme de Map (clé = nom normalisé), pour un import. */
  async getAliasMap(): Promise<Map<string, any>> {
    try {
      const all = await this.aliasModel.find({}).lean();
      const map = new Map<string, any>();
      for (const a of all as any[]) {
        if (a?.importedNameNormalized) map.set(a.importedNameNormalized, a);
      }
      return map;
    } catch (error) {
      throw withErrorContext(error, 'TierAliasService.getAliasMap');
    }
  }

  /**
   * Alias COHÉRENT avec l'état courant ? Le tiers cible doit encore EXISTER dans
   * l'ensemble d'ids du bon type (Client vs Société). Un tiers supprimé ou dont
   * le type ne correspond plus (id absent de l'ensemble attendu) → INVALIDE.
   */
  isValid(
    alias: { tierId?: string; type?: TierAliasType } | null | undefined,
    clientIds: Set<string>,
    companyIds: Set<string>,
  ): boolean {
    try {
      if (!alias || !alias.tierId) return false;
      if (alias.type === 'CLIENT') return clientIds.has(alias.tierId);
      if (alias.type === 'SOCIETE') return companyIds.has(alias.tierId);
      return false;
    } catch (error) {
      throw withErrorContext(error, 'TierAliasService.isValid');
    }
  }
}
