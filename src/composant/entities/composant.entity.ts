import { ObjectType, Field, Int } from '@nestjs/graphql';
import { IsDate } from 'class-validator';
import mongoose from 'mongoose';

export type ComposantDocument = Composant & Document;
export const ComposantSchema = new mongoose.Schema(
  {
    _id: String,
    name: String,
    package: String,
    categorie_id: String,
    prix_achat: Number,
    prix_vente: Number,
    coming_date: Date,
    link: String,
    quantity_stocked: Number,
    pdf: String,
    status: String,
  },
  { _id: false, timestamps: true },
);

@ObjectType()
export class Composant {
  @Field()
  _id: string;
  @Field()
  name: string;
  @Field()
  package: string;
  //the entity categorie composant
  @Field()
  categorie_id: string;
  @Field()
  prix_achat: number;
  @Field()
  prix_vente: number;
  @Field({ nullable: true })
  @IsDate()
  coming_date: Date;
  @Field({ nullable: true })
  link: string;
  @Field({ nullable: true })
  quantity_stocked: number;
  @Field()
  pdf: string;
  @Field()
  status: string;
}
