import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Job d'import DI en bloc (collection `di_import_jobs`). L'EXÉCUTION de l'import
 * (phase non interactive) tourne côté serveur, indépendamment de l'onglet
 * navigateur : ce document porte l'état persistant du job (progression + rapport
 * final), pour que la fermeture d'onglet n'arrête rien et que le résultat reste
 * consultable après réouverture.
 *
 * Additif : aucune migration de données existantes. Environment-independent
 * (aucune URL/ID/valeur DEV en dur — `jobId` généré par nanoid).
 */
export type DiImportJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';

export const DI_IMPORT_JOB_STATUSES: DiImportJobStatus[] = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
];

@Schema({ collection: 'di_import_jobs', timestamps: true })
export class DiImportJobDocument extends Document {
  /** Identifiant public du job (filtre les événements WS broadcast). Unique. */
  @Prop({ required: true, unique: true })
  jobId: string;

  /** Propriétaire (profile _id) — sécurité : seul lui (ou un rôle autorisé)
   *  peut consulter le job. */
  @Prop()
  createdBy: string;

  @Prop({ default: 'PENDING', enum: DI_IMPORT_JOB_STATUSES })
  status: DiImportJobStatus;

  @Prop({ default: 0 })
  done: number;

  @Prop({ default: 0 })
  total: number;

  /** Dernière référence traitée (affichage « ligne en cours »). */
  @Prop()
  currentRef: string;

  /** Rapport final (structure `ImportReport` de l'import) — stocké tel quel. */
  @Prop({ type: Object })
  report: any;

  /** Message d'erreur si `status === 'FAILED'`. */
  @Prop()
  error: string;
  // createdAt / updatedAt via `timestamps: true`.
}

export const DiImportJobSchema =
  SchemaFactory.createForClass(DiImportJobDocument);

@ObjectType()
export class DiImportJob {
  @Field()
  jobId: string;

  @Field({ nullable: true })
  createdBy: string;

  @Field()
  status: string;

  @Field(() => Int)
  done: number;

  @Field(() => Int)
  total: number;

  @Field({ nullable: true })
  currentRef: string;

  @Field({ nullable: true })
  error: string;

  @Field({ nullable: true })
  createdAt: Date;

  @Field({ nullable: true })
  updatedAt: Date;
}
