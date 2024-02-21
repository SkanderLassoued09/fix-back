import { ObjectType, Field, Int } from '@nestjs/graphql';
import mongoose from 'mongoose';

export type EmplacementDocument = Emplacement & Document;
export const EmplacementSchema = new mongoose.Schema(
  {
    _id: String,
    emplacement_name: String,
    emplacement_number: Number,
    max_capacity: Number,
    current_itemsStored: Number,
    avaible: Boolean,
  },
  { _id: false, timestamps: true },
);

@ObjectType()
export class Emplacement {
  @Field()
  _id: string;
  @Field()
  emplacement_name: string;
  @Field(() => Int, { nullable: true })
  emplacement_number: number;
  @Field(() => Int, { nullable: true })
  max_capacity: number;
  @Field(() => Int, { nullable: true })
  current_itemsStored: number;
  @Field({ defaultValue: true })
  avaible: boolean;
}
