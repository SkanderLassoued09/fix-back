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
  @Prop()
  avaible: boolean;
}
export const LocationSchema = SchemaFactory.createForClass(LocationDocument);
@ObjectType()
export class Location {
  @Field()
  _id: string;
  @Field()
  @IsString()
  location_name: string;
  @Field(() => Int, { nullable: true })
  @IsInt()
  location_number: number;
  @Field(() => Int, { nullable: true })
  @IsInt()
  @Max(10)
  //To check with walid the max number
  max_capacity: number;
  @Field(() => Int, { nullable: true })
  @IsInt()
  current_item_stored: number;
  @Field({ defaultValue: true })
  @IsBoolean()
  avaible: boolean;
}
