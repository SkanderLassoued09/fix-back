import { ObjectType, Field, Int } from '@nestjs/graphql';

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * schemas
 */

@Schema({ timestamps: true })
export class ReminderDocument {
  @Prop({ type: [{ type: Object }] })
  data: Record<string, any>[];

  @Prop({ type: Boolean, required: false, default: false })
  isSeen: boolean;
}

const ReminderSchema = SchemaFactory.createForClass(ReminderDocument);

@Schema()
export class AuditDocument extends Document {
  @Prop({ type: ReminderSchema, required: true })
  reminder: ReminderDocument;
}
export const AuditSchema = SchemaFactory.createForClass(AuditDocument);

/**
 * Types
 */
@ObjectType()
export class ReminderData {
  @Field(() => String)
  _id: string;

  @Field(() => String)
  title: string;
}

@ObjectType()
export class Reminder {
  @Field(() => [ReminderData])
  data: ReminderData[];

  @Field(() => Boolean)
  isSeen: boolean;
}

@ObjectType()
export class Audit {
  @Field()
  _id: string;
  @Field(() => Reminder)
  reminder: Reminder;
}
