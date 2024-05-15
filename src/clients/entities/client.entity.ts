import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsBoolean, IsEmail, IsPhoneNumber, IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ClientDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  @IsString()
  first_name: string;
  @Prop()
  @IsString()
  last_name: string;
  @Prop()
  @IsString()
  region: string;
  @Prop()
  @IsString()
  address: string;
  @Prop()
  @IsString()
  @IsEmail()
  email: string;
  @Prop()
  @IsPhoneNumber()
  phone: string;
  @Prop()
  @IsBoolean()
  isDeleted: boolean;
}
export const ClientSchema = SchemaFactory.createForClass(ClientDocument);

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

@ObjectType()
export class ClientTableData {
  @Field(() => [Client])
  clientRecords: Client[];
  @Field()
  totalClientRecord: number;
}
