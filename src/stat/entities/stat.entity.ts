import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class StatDocument extends Document {
  @Prop()
  _id: string;

  @Prop()
  id_tech_diag: string;

  @Prop({ type: Date })
  diag_time: Date;

  @Prop()
  id_tech_rep: string;

  @Prop({ type: Date })
  rep_time: Date;

  @Prop({ type: [String] })
  id_tech_retour: string[];

  @Prop({ type: Date })
  retour_time: Date;

  @Prop({ type: Number, default: 0 })
  retour_count: number;
}
export const StatSchema = SchemaFactory.createForClass(StatDocument);

@ObjectType()
export class Stat {
  @Field()
  _id: string;
  @Field()
  id_tech_diag: string;
  @Field()
  diag_time: Date;
  @Field()
  id_tech_rep: string;
  @Field()
  rep_time: Date;
  @Field(() => [String])
  id_tech_retour: [string];
  @Field()
  retour_time: Date;
  @Field(() => Int, { defaultValue: 0 })
  retour_count: number;
}
