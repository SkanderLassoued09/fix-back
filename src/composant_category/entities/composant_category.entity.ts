import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ComposantCategoryDocumet extends Document {
  @Prop()
  _id: string;
  @Prop()
  category_composant: string;
  @Prop({ default: false })
  isDeleted: boolean;
}
export const Composant_CategorySchema = SchemaFactory.createForClass(
  ComposantCategoryDocumet,
);
Composant_CategorySchema.index({ category_composant: 1, isDeleted: 1 });

@ObjectType()
export class Composant_Category {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  category_composant: string;
  @Field({ nullable: true })
  isDeleted: boolean;
}
