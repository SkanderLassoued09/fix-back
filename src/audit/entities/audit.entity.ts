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
}
