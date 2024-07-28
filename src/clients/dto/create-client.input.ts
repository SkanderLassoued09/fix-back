import { InputType, Int, Field } from '@nestjs/graphql';
import { IsBoolean, IsEmail, IsString } from 'class-validator';

@InputType()
export class CreateClientInput {
  @Field({ nullable: true })
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

@InputType()
export class UpdateClientInput {
  @Field({ nullable: true })
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
}

@InputType()
export class PaginationConfig {
  @Field()
  rows: number; // number of element displayed in table
  @Field()
  first: number; // index of current pages
}
