import { ObjectType, Field } from '@nestjs/graphql';
import { IsBoolean, IsEmail, IsPhoneNumber, IsString } from 'class-validator';
import mongoose, { Document } from 'mongoose';

export type companiesDocument = Companie & Document;
export const CompanieSchema = new mongoose.Schema(
  {
    _id: String,
    name: String,
    region: String,
    address: String,
    email: String,
    activitePrincipale: String,
    activiteSecondaire: String,
    raisonSociale: String,
    Exoneration: String,
    fax: String,
    webSiteLink: String,
    serviceAchat: {
      fullName: String,
      email: String,
      phone: String,
    },
    serviceFinancier: {
      fullName: String,
      email: String,
      phone: String,
    },
    serviceTechnique: {
      fullName: String,
      email: String,
      phone: String,
    },
    isDeleted: Boolean,
  },
  { _id: false, timestamps: true },
);

@ObjectType()
export class service_Achat_Tech_Financier {
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
export class Companie extends Document {
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
  //!! to correct problem with object
  // @Field(() => service_Achat_Tech_Financier, { nullable: true })
  // serviceAchat: service_Achat_Tech_Financier;
  // @Field(() => service_Achat_Tech_Financier, { nullable: true })
  // serviceFinancier: service_Achat_Tech_Financier;
  // @Field(() => service_Achat_Tech_Financier, { nullable: true })
  // serviceTechnique: service_Achat_Tech_Financier;
  @Field({ defaultValue: false })
  @IsBoolean()
  isDeleted: boolean;
}
