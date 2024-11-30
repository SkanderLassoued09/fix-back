import { InputType, Int, Field } from '@nestjs/graphql';

@InputType()
export class CreateStatInput {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  id_tech_diag: string;
  @Field({ nullable: true })
  diag_time: string;
  @Field({ nullable: true })
  id_tech_rep: string;
  @Field({ nullable: true })
  rep_time: string;
  @Field(() => [String], { nullable: true })
  id_tech_retour: string[];
  @Field({ nullable: true })
  retour_time: string;
  @Field(() => Int, { defaultValue: 0, nullable: true })
  retour_count: number;
  @Field({ nullable: true })
  location_id: string;
  @Field({ nullable: true })
  status: string;
  @Field({ nullable: true })
  _idDi: string;
  @Field({ defaultValue: 'You got new task Hello', nullable: true })
  notificationMessage: string;
  @Field({ defaultValue: false })
  diagnostiquefinishedFLAG: boolean;
  @Field({ defaultValue: false })
  reperationfinishedFLAG: boolean;
  @Field({ defaultValue: 0 })
  ignoreCount: number;
}

@InputType()
export class PauseLogInput {
  // @Field({ nullable: true })
  // _id: string;
  @Field()
  pauseType: 'diag' | 'rep';

  @Field()
  pauseStart: string;
  @Field({ nullable: true })
  pauseEnd?: string;
}

@InputType()
export class UpdatedPauseTime {
  @Field({ nullable: true })
  pauseEnd?: string;
}
