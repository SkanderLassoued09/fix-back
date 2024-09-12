import { InputType, Int, Field } from '@nestjs/graphql';

/**
 * Types
 */
@InputType()
export class ReminderDataInput {
  @Field(() => String)
  _id: string;

  @Field(() => String)
  title: string;
}

@InputType()
export class ReminderInput {
  @Field(() => [ReminderDataInput])
  data: ReminderDataInput[];
}

@InputType()
export class AuditInput {
  @Field(() => ReminderInput)
  reminder: ReminderInput;
}
