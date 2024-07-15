import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsBoolean, IsEmail, IsPhoneNumber, IsString } from 'class-validator';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ClientDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  first_name: string;
  @Prop()
  last_name: string;
  @Prop()
  region: string;
  @Prop()
  address: string;
  @Prop()
  email: string;
  @Prop()
  phone: string;
  @Prop()
  isDeleted: boolean;
}
export const ClientSchema = SchemaFactory.createForClass(ClientDocument);

@ObjectType()
export class Client {
  @Field()
  _id: string;
  @Field()
  first_name: string;
  @Field()
  last_name: string;
  @Field()
  region: string;
  @Field()
  address: string;
  @Field({ nullable: true })
  email: string;
  @Field({ nullable: true })
  phone: string;
  @Field({ defaultValue: false })
  isDeleted: boolean;
}

@ObjectType()
export class ClientTableData {
  @Field(() => [Client])
  clientRecords: Client[];
  @Field()
  totalClientRecord: number;
}
