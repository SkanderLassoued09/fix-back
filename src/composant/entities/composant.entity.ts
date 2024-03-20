import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsDate, IsNumber, IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ComposantDocument extends Document {
  @Prop({ unique: true })
  _id: string;
  @Prop({ unique: true })
  name: string;
  @Prop()
  package: string;
  @Prop()
  category_composant_id: string;
  @Prop()
  prix_achat: number;
  @Prop()
  prix_vente: number;
  @Prop()
  coming_date: Date;
  @Prop()
  link: string;
  @Prop()
  quantity_Instock: string;
  @Prop()
  pdf: string;
  @Prop()
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
