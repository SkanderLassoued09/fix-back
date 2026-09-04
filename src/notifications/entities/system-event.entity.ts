import { Field, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Historique ERP — journal append-only de TOUT ce qui se passe (transitions,
 * affectations, uploads…). Volumineux, filtrable, NON actionnable.
 *
 * SOURCE UNIQUE de vérité de l'historique : une ligne = un événement métier.
 * `actorId` peut être `null` (« acteur inconnu ») — honnêtement, tant que les
 * ~85 % de mutations non authentifiées n'ont pas reçu la passe auth v1.1, on
 * n'invente PAS d'acteur. Aucune purge en v1 (valeur ISO 9001) — archivage =
 * option future.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'system_events',
})
export class SystemEventDocument extends Document {
  /** Code stable de l'événement, ex. `DI_ASSIGNED_DIAG`, `DI_STATUS_CHANGED`. */
  @Prop({ required: true, index: true })
  type: string;

  /** DI concernée (null pour un futur événement hors-DI). */
  @Prop({ default: null, index: true })
  diId: string | null;

  /** Acteur authentifié (null = inconnu, jamais deviné). */
  @Prop({ default: null, index: true })
  actorId: string | null;

  /** Rôle de l'acteur si connu (ciblage/affichage), sinon null. */
  @Prop({ default: null })
  actorRole: string | null;

  /** Texte lisible prêt à afficher. */
  @Prop({ required: true })
  message: string;

  /** Charge libre (status from/to, refs de documents, motif…). */
  @Prop({ type: Object, default: {} })
  payload: Record<string, any>;

  createdAt: Date;
}

export const SystemEventSchema =
  SchemaFactory.createForClass(SystemEventDocument);
// Historique paginé + filtré (jamais un chargement illimité) :
SystemEventSchema.index({ createdAt: -1 });
SystemEventSchema.index({ diId: 1, createdAt: -1 });
SystemEventSchema.index({ type: 1, createdAt: -1 });
SystemEventSchema.index({ actorId: 1, createdAt: -1 });

@ObjectType()
export class SystemEvent {
  @Field()
  _id: string;
  @Field()
  type: string;
  @Field({ nullable: true })
  diId?: string;
  @Field({ nullable: true })
  actorId?: string;
  @Field({ nullable: true })
  actorRole?: string;
  /** Nom LISIBLE de l'acteur, résolu depuis `actorId`. Sans lui le journal
   *  n'avait qu'un ObjectId — que le front filtre — et affichait « par — ». */
  @Field({ nullable: true })
  actorName?: string;
  @Field()
  message: string;
  @Field({ nullable: true })
  payloadJson?: string;
  @Field()
  createdAt: Date;
}
