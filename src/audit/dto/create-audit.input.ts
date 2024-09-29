import { InputType, Int, Field } from '@nestjs/graphql';

/**
 * Types
 */

@InputType()
export class AuditInput {
  @Field()
  _idDoc: string;
  @Field()
  message: string;
  @Field()
  type: string;
  @Field()
  isSeen: boolean;
}
