import { ObjectType, Field, Int } from '@nestjs/graphql';

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * schemas
 */

@Schema({ timestamps: true })
export class AuditDocument extends Document {
  @Prop()
  _idDoc: string;
  @Prop()
  message: string;
  @Prop()
  type: string;
  @Prop({ default: false })
  isSeen: boolean;
}
export const AuditSchema = SchemaFactory.createForClass(AuditDocument);

/**
 * Types
 */

@ObjectType()
export class Audit {
  @Field()
  _id: string;
  @Field()
  _idDoc: string;
  @Field()
  type: string;
  @Field()
  message: string;
  @Field()
  isSeen: boolean;
  @Field()
  createAt: string;
  /** Horodatage RÉEL du document (`timestamps: true`). `createAt` ci-dessus est
   *  une coquille historique jamais persistée : elle reste déclarée pour ne
   *  casser aucun appelant, mais toute nouvelle requête doit lire `createdAt`. */
  @Field({ nullable: true })
  createdAt?: Date;
}
