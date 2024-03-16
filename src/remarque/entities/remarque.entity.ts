import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class RemarqueDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  @IsString()
  remarque_manager: string;
  @Prop()
  @IsString()
  remarque_admin_manager: string;
  @Prop()
  @IsString()
  remarque_admin_tech: string;
  @Prop()
  @IsString()
  remarque_tech_diagnostic: string;
  @Prop()
  @IsString()
  remarque_tech_repair: string;
  @Prop()
  @IsString()
  remarque_magasin: string;
  @Prop()
  @IsString()
  remarque_coordinator: string;
}
export const RemarqueSchema = SchemaFactory.createForClass(RemarqueDocument);

@ObjectType()
export class Remarque {
  @Field()
  _id: string;
  @Field({ nullable: true })
  remarque_manager: string;
  @Field({ nullable: true })
  remarque_admin_manager: string;
  @Field({ nullable: true })
  remarque_admin_tech: string;
  @Field({ nullable: true })
  remarque_tech_diagnostic: string;
  @Field({ nullable: true })
  remarque_tech_repair: string;
  @Field({ nullable: true })
  remarque_magasin: string;
  @Field({ nullable: true })
  remarque_coordinator: string;
}
