import { InputType, Field } from '@nestjs/graphql';
import { IsString } from 'class-validator';

@InputType()
export class CreateRemarqueInput {
  @Field()
  _id: string;
  @Field()
  @IsString()
  _idDi: string;
  @Field()
  @IsString()
  remarque_manager: string;
  @Field()
  @IsString()
  remarque_admin_manager: string;
  @Field()
  @IsString()
  remarque_admin_tech: string;
  @Field()
  @IsString()
  remarque_tech_diagnostic: string;
  @Field()
  @IsString()
  remarque_tech_repair: string;
  @Field()
  @IsString()
  remarque_magasin: string;
  @Field()
  @IsString()
  remarque_coordinator: string;
}
