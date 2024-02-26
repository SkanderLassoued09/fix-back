import { InputType, Field } from '@nestjs/graphql';
import { service_Achat_Tech_Financier } from '../entities/company.entity';
import { IsBoolean, IsEmail, IsPhoneNumber, IsString } from 'class-validator';

@InputType()
export class CreateCompanieInput {
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
  // @Field(() => service_Achat_Tech_Financier, { nullable: true })
  // serviceAchat: service_Achat_Tech_Financier;
  // @Field(() => service_Achat_Tech_Financier, { nullable: true })
  // serviceFinancier: service_Achat_Tech_Financier;
  // @Field(() => service_Achat_Tech_Financier, { nullable: true })
  // serviceTechnique: service_Achat_Tech_Financier;
  @Field()
  @IsBoolean()
  isDeleted: boolean;
}
