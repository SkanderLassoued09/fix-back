import { Field, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Notification (cloche) — ligne FINE par destinataire pointant vers un
 * `SystemEvent`. Actionnable, lu/non-lu PAR utilisateur.
 *
 * Choix produit (postes lents) : une ligne par (event, user). Le compteur de
 * non-lus = `count({ userId, readAt:null })` sur l'index `{userId, readAt}` —
 * jamais un chargement de liste. Quelques champs d'AFFICHAGE (`type/diId/
 * message`) sont dénormalisés pour que l'ouverture de la cloche soit UNE requête
 * indexée SANS jointure vers `system_events`.
 *
 * Rétention : TTL sur `readAt` (90 j). Mongo n'expire QUE les lignes dont
 * `readAt` est une Date → les LUES disparaissent 90 j après lecture, les
 * NON-LUES (readAt=null) restent indéfiniment. Le contenu complet survit dans
 * `system_events` (jamais purgé).
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'notifications',
})
export class NotificationDocument extends Document {
  /** Lien vers l'événement source (contenu complet + historique). */
  @Prop({ required: true })
  eventId: string;

  /** Destinataire. */
  @Prop({ required: true })
  userId: string;

  /** Null tant que non lue ; Date à la lecture (déclenche le TTL). */
  @Prop({ default: null })
  readAt: Date | null;

  // ---- Champs d'affichage dénormalisés (évitent la jointure à l'ouverture) --
  @Prop({ required: true })
  type: string;
  @Prop({ default: null })
  diId: string | null;
  @Prop({ required: true })
  message: string;

  createdAt: Date;
}

export const NotificationSchema =
  SchemaFactory.createForClass(NotificationDocument);
// Compteur de non-lus + liste par utilisateur (le cœur de la perf) :
NotificationSchema.index({ userId: 1, readAt: 1 });
NotificationSchema.index({ userId: 1, createdAt: -1 });
// TTL : purge des LUES 90 j après lecture (les non-lues, readAt=null, restent).
NotificationSchema.index(
  { readAt: 1 },
  { expireAfterSeconds: 90 * 24 * 3600 },
);

@ObjectType()
export class Notification {
  @Field()
  _id: string;
  @Field()
  eventId: string;
  @Field()
  userId: string;
  @Field({ nullable: true })
  readAt?: Date;
  @Field()
  type: string;
  @Field({ nullable: true })
  diId?: string;
  @Field()
  message: string;
  @Field()
  createdAt: Date;
}
