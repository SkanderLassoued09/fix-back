import { ObjectType, Field, Int } from '@nestjs/graphql';
import { IsBoolean, IsEmail, IsPhoneNumber, IsString } from 'class-validator';
import mongoose from 'mongoose';

export type ClientDocument = Client & Document;
export const ClientSchema = new mongoose.Schema(
  {
    _id: String,
    first_name: String,
    last_name: String,
    region: String,
    address: String,
    email: String,
    phone: String,
    isDeleted: Boolean,
  },
  { _id: false, timestamps: true },
);

@ObjectType()
export class Client {
  @Field()
  _id: string;
  @Field()
  @IsString()
  first_name: string;
  @Field()
  @IsString()
  last_name: string;
  @Field()
  @IsString()
  region: string;
  @Field()
  address: string;
  @Field({ nullable: true })
  @IsEmail()
  email: string;
  @Field({ nullable: true })
  @IsPhoneNumber()
  phone: string;
  @Field({ defaultValue: false })
  @IsBoolean()
  isDeleted: boolean;
}
