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
  category: string;
}
export const DiCategorySchema =
  SchemaFactory.createForClass(DiCategoryDocument);

@ObjectType()
export class DiCategory {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  category: string;
}
