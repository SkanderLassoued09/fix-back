import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateLogsDiInput {
  @Field(() => Int, { description: 'Example field (placeholder)' })
  exampleField: number;
}

@InputType()
export class ComposantStructureLogsInput {
  @Field({ nullable: true })
  nameComposant: string;
  @Field({ nullable: true })
  quantity: number;
  @Field({ nullable: true, defaultValue: false })
  isUpdated: boolean;
}

@InputType()
export class DiagUpdateLogs {
  @Field()
  remarque_tech_diagnostic: string;
  @Field()
  contain_pdr: boolean;
  @Field()
  di_category_id: string;
  @Field()
  isErrorFromFixtronix: boolean;
  @Field()
  can_be_repaired: boolean;
  @Field(() => [ComposantStructureLogsInput], { nullable: true })
  array_composants: ComposantStructureLogsInput[];
}
