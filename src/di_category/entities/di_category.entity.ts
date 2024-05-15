import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class DiCategoryDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  @IsString()
  category_Di: string;
}
export const DiCategorySchema =
  SchemaFactory.createForClass(DiCategoryDocument);

@ObjectType()
export class DiCategory {
  @Field()
  _id: string;
  @Field()
  category_DI: string;
}
