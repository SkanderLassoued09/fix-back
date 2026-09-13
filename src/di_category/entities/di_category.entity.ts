import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class DiCategoryDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  category: string;
  @Prop({ default: false })
  isDeleted: boolean;
}
export const DiCategorySchema =
  SchemaFactory.createForClass(DiCategoryDocument);
DiCategorySchema.index({ category: 1, isDeleted: 1 });

@ObjectType()
export class DiCategory {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  category: string;
  @Field({ nullable: true })
  isDeleted: boolean;

  /**
   * Champ de RÉPONSE (jamais persisté — il n'existe pas sur
   * `DiCategoryDocument`) : `true` quand `createDiCategory` a réellement
   * inséré la catégorie, `false` quand le nom était déjà pris et que le
   * document EXISTANT est renvoyé.
   *
   * Sans lui l'appelant ne peut pas distinguer les deux cas : le service
   * renvoie le doublon en silence (pas de `ConflictException`, contrairement
   * à `Composant_Category`). Un « Catégorie créée » et une notification
   * partiraient alors à chaque quasi-doublon.
   */
  @Field({ nullable: true })
  created?: boolean;
}
