import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsDate, IsNumber, IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true, autoIndex: false })
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
  coming_date: string;
  @Prop()
  link: string;
  @Prop()
  quantity_stocked: number;
  @Prop()
  pdf: string;
  @Prop()
  status_composant: string;
}
export const ComposantSchema = SchemaFactory.createForClass(ComposantDocument);
@ObjectType()
export class Composant {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  name: string;
  @Field({ nullable: true })
  package: string;
  //the entity category composant
  @Field({ nullable: true })
  category_composant_id: string;
  @Field({ nullable: true })
  prix_achat: number;
  @Field({ nullable: true })
  prix_vente: number;
  @Field({ nullable: true })
  coming_date: string;
  @Field({ nullable: true })
  link: string;
  @Field({ nullable: true })
  quantity_stocked: number;
  @Field({ nullable: true })
  pdf: string;
  @Field({ nullable: true })
  status_composant: string;
}
