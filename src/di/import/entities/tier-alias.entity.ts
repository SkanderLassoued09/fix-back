import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Alias de tiers (collection `tier_aliases`) — MÉMOIRE d'une décision humaine
 * d'import : « le nom (normalisé) X correspond au tiers Y de tel type ».
 *
 * ⚠️ Un alias est une MÉMOIRE, pas une autorité : à chaque import il est
 * RE-VALIDÉ contre l'état courant (le tiers existe-t-il encore ? le type
 * correspond-il ? la situation est-elle redevenue ambiguë ?). Un alias
 * incohérent est ignoré → la ligne redevient « à trancher ».
 *
 * Une seule décision courante par nom normalisé (`unique`) : une nouvelle
 * décision met l'alias à jour (upsert).
 */
export type TierAliasType = 'CLIENT' | 'SOCIETE';

@Schema({ collection: 'tier_aliases', timestamps: true })
export class TierAliasDocument extends Document {
  @Prop({ required: true, unique: true })
  importedNameNormalized: string;

  /** _id du tiers cible (Client ou Société) — TOUJOURS dérivé/validé côté back. */
  @Prop({ required: true })
  tierId: string;

  @Prop({ required: true, enum: ['CLIENT', 'SOCIETE'] })
  type: TierAliasType;

  /** Utilisateur authentifié ayant tranché (jamais fourni tel quel par le front). */
  @Prop()
  decidedBy: string;
  // createdAt / updatedAt via `timestamps: true`.
}

export const TierAliasSchema = SchemaFactory.createForClass(TierAliasDocument);
