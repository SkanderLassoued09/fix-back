import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StagnationDispatchDocument = StagnationDispatch & Document;

/**
 * Enregistrement IDEMPOTENT d'un rappel de stagnation quotidien. Une entrée par
 * (jour, DI, statut) : la clé unique `{date, idNum, status}` garantit qu'un
 * ré-exécution du cron le même jour (restart / retry / déploiement) ne
 * re-écrit PAS de ligne dans la feuille et ne renvoie PAS de notification.
 *
 * La clé INCLUT la date → une DI toujours stagnante dans le même statut le
 * lendemain produit une NOUVELLE entrée → elle réapparaît dans la feuille du
 * jour et redéclenche le rappel quotidien (récurrence journalière voulue).
 */
@Schema({ collection: 'stagnation_dispatches', timestamps: true })
export class StagnationDispatch {
  /** Date de génération, format `YYYY-MM-DD` (fuseau Africa/Tunis). */
  @Prop({ required: true }) date: string;

  /** `_idnum` de la DI (ex. « DI114 »). */
  @Prop({ required: true }) idNum: string;

  /** Statut dans lequel la DI stagne. */
  @Prop({ required: true }) status: string;

  /** Ancienneté (heures) au moment de la détection — info/audit. */
  @Prop({ default: 0 }) ageHours: number;

  @Prop({ default: () => new Date() }) sentAt: Date;
}

export const StagnationDispatchSchema =
  SchemaFactory.createForClass(StagnationDispatch);

// Clé d'idempotence : une DI n'est traitée qu'UNE fois par jour et par statut.
StagnationDispatchSchema.index(
  { date: 1, idNum: 1, status: 1 },
  { unique: true },
);
