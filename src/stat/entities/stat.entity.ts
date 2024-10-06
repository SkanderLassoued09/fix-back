import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { LocationDocument } from 'src/location/entities/location.entity';

@Schema({ timestamps: true, autoIndex: false })
export class StatDocument extends Document {
  @Prop({ unique: true })
  _id: string;
  @Prop({ unique: true })
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
  status: string;
  @Prop({ type: String, ref: 'Location' })
  // belongs to which location
  location_id: LocationDocument;
  @Prop()
  id_tech_retour: string[];
  @Prop({ type: Date })
  retour_time: Date;
  @Prop({ type: Number, default: 0 })
  retour_count: number;
  @Prop({ defaultValue: false })
  diagnostiquefinishedFLAG: boolean;
  @Prop({ defaultValue: false })
  reperationfinishedFLAG: boolean;
}
export const StatSchema = SchemaFactory.createForClass(StatDocument);

@ObjectType()
export class StatsCount {
  @Field()
  status: string;
  @Field()
  count: number;
}
@ObjectType()
export class Stat {
  @Field()
  _id: string;
  @Field({ nullable: true })
  _idDi: string;
  @Field({ nullable: true })
  id_tech_diag: string;
  @Field({ nullable: true })
  diag_time: string;
  @Field({ nullable: true })
  id_tech_rep: string;
  @Field({ nullable: true })
  rep_time: string;
  @Field({ nullable: true })
  id_tech_retour: string;
  @Field({ nullable: true })
  retour_time: string;
  @Field({ nullable: true })
  location_id: string;
  @Field({ nullable: true })
  status: string;
  @Field({ nullable: true })
  retour_count: number;
  @Field({ defaultValue: false })
  diagnostiquefinishedFLAG: boolean;
  @Field({ defaultValue: false })
  reperationfinishedFLAG: boolean;
}

@ObjectType()
export class StatsTableData {
  @Field(() => [Stat])
  stat: Stat[];
  @Field()
  totalTechDataCount: number;
}

@ObjectType()
export class CreateStatNotificationReturn {
  @Field({ nullable: true })
  _idDi: string;
  @Field({ defaultValue: 'You got new task', nullable: true })
  messageNotification: string;
  @Field({ nullable: true })
  id_tech_diag: string;
}
