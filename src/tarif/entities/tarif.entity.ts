import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class TarifDocument extends Document {
  @Prop()
  tarif: number;
}
export const TarifSchema = SchemaFactory.createForClass(TarifDocument);

@ObjectType()
export class Tarif {
  @Field()
  tarif: number;
}
