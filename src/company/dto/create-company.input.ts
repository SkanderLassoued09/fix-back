import { InputType, Field } from '@nestjs/graphql';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

/** Trim string inputs so whitespace-only values fail @IsNotEmpty. */
function Trim() {
  return Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

/**
 * Exoneration is a Oui/Non flag. Kept as a String in the schema (the front
 * sends "Oui"/"Non"); @IsEnum enforces the allowed values once the global
 * ValidationPipe is active.
 */
export enum ExonerationEnum {
  Oui = 'Oui',
  Non = 'Non',
}

@InputType()
export class ServiceContactInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  email: string;
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone: string;
}

@InputType()
export class CreateCompanyInput {
  // Server-assigned (overwritten with a uuid in the service); accepted but
  // ignored. Required-ness mirrors the UI: only « Raison sociale » is mandatory.
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  _id: string;

  @Field()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @Field()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  raisonSociale: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  region: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  email: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  activitePrincipale: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  activiteSecondaire: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsEnum(ExonerationEnum)
  Exoneration: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  fax: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUrl()
  webSiteLink: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  mf: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  rne: string;

  @Field(() => ServiceContactInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceContactInput)
  serviceAchat: ServiceContactInput;

  @Field(() => ServiceContactInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceContactInput)
  serviceFinancier: ServiceContactInput;

  @Field(() => ServiceContactInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceContactInput)
  serviceTechnique: ServiceContactInput;
}

@InputType()
export class PaginationConfig {
  @Field()
  rows: number; // number of element displayed in table
  @Field()
  first: number; // index of current pages
}

@InputType()
export class UpdateCompanyInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  _id: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  raisonSociale: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  region: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  email: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsEnum(ExonerationEnum)
  Exoneration: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  fax: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUrl()
  webSiteLink: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  mf: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  rne: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  activitePrincipale: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  activiteSecondaire: string;

  @Field(() => ServiceContactInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceContactInput)
  serviceAchat: ServiceContactInput;

  @Field(() => ServiceContactInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceContactInput)
  serviceTechnique: ServiceContactInput;

  @Field(() => ServiceContactInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceContactInput)
  serviceFinancier: ServiceContactInput;
}
