import { InputType, Field } from '@nestjs/graphql';
import { IsBoolean, IsEmail, IsPhoneNumber, IsString } from 'class-validator';

@InputType()
export class ServiceContactInput {
  @Field({ nullable: true })
  name: string;
  @Field({ nullable: true })
  @IsEmail()
  email: string;
  @Field({ nullable: true })
  @IsPhoneNumber()
  phone: string;
}

@InputType()
export class CreateCompanyInput {
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
  @Field(() => ServiceContactInput, { nullable: true })
  serviceAchat: ServiceContactInput;
  @Field(() => ServiceContactInput, { nullable: true })
  serviceFinancier: ServiceContactInput;
  @Field(() => ServiceContactInput, { nullable: true })
  serviceTechnique: ServiceContactInput;
  @Field()
  @IsBoolean()
  isDeleted: boolean;
}
