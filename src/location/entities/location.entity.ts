import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsBoolean, IsInt, IsString, Max } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class LocationDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  location_name: string;
  @Prop()
  location_number: number;
  @Prop()
  max_capacity: number;
  @Prop()
  current_item_stored: number;
  @Prop({ default: 0, min: 0 })
  storedDiCount: number;
  @Prop({ default: false })
  hasStoredDi: boolean;
  @Prop()
  avaible: boolean;
  @Prop({ default: false })
  isDeleted: boolean;
}
export const LocationSchema = SchemaFactory.createForClass(LocationDocument);
LocationSchema.index({ location_name: 1 });
LocationSchema.index({ hasStoredDi: 1, storedDiCount: 1 });
@ObjectType()
export class Location {
  @Field()
  _id: string;
  @Field()
  location_name: string;
  @Field(() => Int, { nullable: true })
  location_number: number;
  @Field(() => Int, { nullable: true })

  //To check with walid the max number
  max_capacity: number;
  @Field(() => Int, { nullable: true })
  current_item_stored: number;
  @Field(() => Int, { nullable: true })
  storedDiCount: number;
  @Field({ nullable: true })
  hasStoredDi: boolean;
  @Field({ defaultValue: true })
  avaible: boolean;
  @Field()
  isDeleted: boolean;
}
