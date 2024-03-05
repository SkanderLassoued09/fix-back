import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IsBoolean, IsEmail, IsPhoneNumber, IsString } from 'class-validator';
import { Document } from 'mongoose';

export class ServiceContactSchema {
  @Prop({ type: String })
  name: string;

  @Prop({ type: String })
  email: string;

  @Prop({ type: String })
  phone: string;
}

@Schema({ timestamps: true })
export class CompanyDocument extends Document {
  @Prop()
  @IsString()
  _id?: string;
  @Prop()
  @IsString()
  name: string;
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
  @IsString()
  activitePrincipale: string;
  @Prop()
  @IsString()
  activiteSecondaire: string;
  @Prop()
  @IsString()
  raisonSociale: string;
  @Prop()
  @IsString()
  Exoneration: string;
  @Prop()
  @IsString()
  fax: string;
  @Prop()
  @IsString()
  webSiteLink: string;
  @Prop({ type: ServiceContactSchema })
  serviceFinancier: ServiceContactSchema;
  @Prop({ type: ServiceContactSchema })
  serviceAchat: ServiceContactSchema;
  @Prop({ type: ServiceContactSchema })
  serviceTechnique: ServiceContactSchema;
  @Prop()
  @IsString()
  isDeleted: boolean;
}
export const CompanySchema = SchemaFactory.createForClass(CompanyDocument);

@ObjectType()
export class ServiceContact {
  @Field({ nullable: true })
  name: string;
  @Field({ nullable: true })
  @IsEmail()
  email: string;
  @Field({ nullable: true })
  @IsPhoneNumber()
  phone: string;
}

@ObjectType()
export class Company extends Document {
  @Field()
  _id: string;
  @Field()
  @IsString()
  name: string;
  @Field()
  @IsString()
  region: string;
  @Field()
  address: string;
  @Field({ nullable: true })
  @IsEmail()
  email: string;
  @Field()
  @IsString()
  activitePrincipale: string;
  @Field({ nullable: true })
  activiteSecondaire: string;
  @Field()
  raisonSociale: string;
  @Field({ nullable: true })
  Exoneration: string;
  @Field({ nullable: true })
  @IsPhoneNumber()
  fax: string;
  @Field({ nullable: true })
  webSiteLink: string;
  @Field(() => ServiceContact, { nullable: true })
  serviceAchat: ServiceContact;
  @Field(() => ServiceContact, { nullable: true })
  serviceFinancier: ServiceContact;
  @Field(() => ServiceContact, { nullable: true })
  serviceTechnique: ServiceContact;
  @Field({ defaultValue: false })
  @IsBoolean()
  isDeleted: boolean;
}

@ObjectType()
export class CompanyTableData {
  @Field(() => [Company])
  companyRecords: Company[];
  @Field()
  totalCompanyRecord: number;
}
