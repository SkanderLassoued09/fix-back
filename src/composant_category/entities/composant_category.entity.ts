import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ComposantCategoryDocumet extends Document {
  @Prop()
  @Field()
  _id: string;
  @Prop()
  @Field()
  @IsString()
  category_Di: string;
}
export const Composant_CategorySchema = SchemaFactory.createForClass(
  ComposantCategoryDocumet,
);

@ObjectType()
export class Composant_Category {
  @Field()
  _id: string;
  @Field()
  category_composant: string;
}
