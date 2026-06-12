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

@Schema({ timestamps: true, autoIndex: false })
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
  phone: string;
  @Prop()
  @IsString()
  webSiteLink: string;
  @Prop()
  @IsString()
  mf:string;
  @Prop()
  @IsString()
  rne:string;
  @Prop({ type: ServiceContactSchema })
  serviceFinancier: ServiceContactSchema;
  @Prop({ type: ServiceContactSchema })
  serviceAchat: ServiceContactSchema;
  @Prop({ type: ServiceContactSchema })
  serviceTechnique: ServiceContactSchema;
  // Google Drive client folder auto-created on company creation.
  @Prop()
  @IsString()
  driveFolderId: string;
  @Prop()
  @IsString()
  driveFolderUrl: string;
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
  // Optional on input (only name/raisonSociale required) ⇒ nullable on output,
  // else reading a company that lacks one of these throws a non-null error.
  @Field({ nullable: true })
  @IsString()
  region: string;
  @Field({ nullable: true })
  address: string;
  @Field({ nullable: true })
  @IsEmail()
  email: string;
  @Field({ nullable: true })
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
  phone: string;
  @Field({ nullable: true })
  webSiteLink: string;
  @Field(() => ServiceContact, { nullable: true })
  serviceAchat: ServiceContact;
  @Field(() => ServiceContact, { nullable: true })
  serviceFinancier: ServiceContact;
  @Field(() => ServiceContact, { nullable: true })
  serviceTechnique: ServiceContact;
  @Field({ nullable: true })
  mf: string;
  @Field({ nullable: true })
  rne: string;
  @Field({ nullable: true })
  driveFolderId: string;
  @Field({ nullable: true })
  driveFolderUrl: string;
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
