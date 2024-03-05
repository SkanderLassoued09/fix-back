import { InputType, Int, Field } from '@nestjs/graphql';
import { IsBoolean, IsEmail, IsString } from 'class-validator';

@InputType()
export class CreateClientInput {
  @Field({ nullable: true })
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
  phone: string;
  @Field({ defaultValue: false })
  @IsBoolean()
  isDeleted: boolean;
}
