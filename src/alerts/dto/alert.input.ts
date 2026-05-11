import { Field, InputType } from '@nestjs/graphql';
import { AlertSeverity, AlertType } from '../alert.enums';

@InputType()
export class CreateAlertInput {
  @Field()
  diId: string;

  @Field(() => AlertType)
  type: AlertType;

  @Field(() => AlertSeverity, { nullable: true })
  severity?: AlertSeverity;

  @Field()
  message: string;

  @Field(() => [String], { nullable: true })
  assignedRoles?: string[];

  /** JSON-encoded metadata. Kept as a string at the GraphQL boundary so
   *  arbitrary payloads survive without a typed schema per alert kind. */
  @Field({ nullable: true })
  metadataJson?: string;

  @Field({ nullable: true })
  escalationLevel?: number;
}

@InputType()
export class ListAlertsInput {
  @Field({ nullable: true })
  diId?: string;

  @Field(() => AlertType, { nullable: true })
  type?: AlertType;

  @Field({ nullable: true })
  role?: string;

  /** When true, return only open (unresolved) alerts. Defaults to true. */
  @Field({ nullable: true })
  openOnly?: boolean;

  @Field({ nullable: true })
  limit?: number;
}
