import { ObjectType, Field, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsString,
  Max,
  isNumber,
} from 'class-validator';
import mongoose from 'mongoose';

export type LocationDocument = Location & Document;
export const LocationSchema = new mongoose.Schema(
  {
    _id: String,
    location_name: String,
    location_number: Number,
    max_capacity: Number,
    current_itemsStored: Number,
    avaible: Boolean,
  },
  { _id: false, timestamps: true },
);

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
  current_itemsStored: number;
  @Field({ defaultValue: true })
  @IsBoolean()
  avaible: boolean;
}
