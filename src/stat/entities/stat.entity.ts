import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class StatDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  _idDi: string;

  @Prop()
  id_tech_diag: string;

  @Prop()
  diag_time: string;

  @Prop()
  id_tech_rep: string;

  @Prop()
  rep_time: string;

  @Prop()
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
  _idDi: string;
  @Field()
  id_tech_diag: string;
  @Field()
  diag_time: string;
  @Field()
  id_tech_rep: string;
  @Field()
  rep_time: string;
  @Field(() => [String])
  id_tech_retour: string[];
  @Field()
  retour_time: string;
  @Field(() => Int, { defaultValue: 0 })
  retour_count: number;
}
