import { ObjectType, Field, Int } from '@nestjs/graphql';
import mongoose from 'mongoose';

export type ComposantCategorieDocumet = Composant_Categorie & Document;
export const Composant_CategorieSchema = new mongoose.Schema(
  {
    _id: String,
    categorie_composant: String,
  },
  { _id: false, timestamps: true },
);

@ObjectType()
export class Composant_Categorie {
  @Field()
  _id: string;
  @Field()
  categorie_composant: string;
}
