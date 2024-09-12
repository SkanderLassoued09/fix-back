import { AuditInput } from './create-audit.input';
import { InputType, Field, Int, PartialType } from '@nestjs/graphql';

@InputType()
export class UpdateAuditInput extends PartialType(AuditInput) {
  @Field(() => Int)
  id: number;
}
