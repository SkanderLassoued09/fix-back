import { ObjectType, Field, Int } from '@nestjs/graphql';
import mongoose from 'mongoose';

export type DiCategorieDocumet = DiCategorie & Document;
export const DiCategorieSchema = new mongoose.Schema(
  {
    _id: String,
    categorie_Di: String,
  },
  { _id: false, timestamps: true },
);

@ObjectType()
export class DiCategorie {
  @Field()
  _id: string;
  @Field()
  categorie_DI: string;
}
