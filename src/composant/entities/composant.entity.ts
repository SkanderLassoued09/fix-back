import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsDate, IsNumber, IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ComposantDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  @IsString()
  name: string;
  @Prop()
  package: string;
  @Prop()
  @IsString()
  category_composant_id: string;
  @Prop()
  @IsNumber()
  prix_achat: number;
  @Prop()
  @IsNumber()
  prix_vente: number;
  @Prop()
  @IsDate()
  coming_date: Date;
  @Prop()
  @IsString()
  link: string;
  @Prop()
  @IsNumber()
  quantity_Instock: string;
  @Prop()
  @IsString()
  pdf: string;
  @Prop()
  @IsString()
  status_composant: string;
}
export const ComposantSchema = SchemaFactory.createForClass(ComposantDocument);
@ObjectType()
export class Composant {
  @Field()
  _id: string;
  @Field()
  name: string;
  @Field()
  package: string;
  //the entity category composant
  @Field()
  category_composant_id: string;
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
