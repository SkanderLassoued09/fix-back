import { InputType, Int, Field, ObjectType } from '@nestjs/graphql';

@InputType()
export class CreateProfileInput {
  @Field({ nullable: true })
  username: string;
  @Field({ nullable: true })
  firstName: string;
  @Field({ nullable: true })
  lastName: string;
  @Field({ nullable: true })
  password: string;
  @Field({ nullable: true })
  phone: string;
  @Field({ nullable: true })
  role: string;
  @Field({ nullable: true })
  email: string;

  // @Field()
  // createdAt: Date;
  // @Field()
  // updatedAt: Date;
}

@ObjectType()
export class TokenData {
  @Field()
  username: string;
  @Field()
  role: string;
  @Field()
  email: string;
}
