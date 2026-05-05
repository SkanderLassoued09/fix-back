import { ObjectType, Field, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class AtelierKpi {
  @Field(() => Float)
  tauxClotures: number;

  @Field(() => Float)
  tauxEnCours: number;
}

@ObjectType()
export class SatisfactionKpi {
  @Field(() => Float)
  score: number;
}

@ObjectType()
export class DashboardKpi {
  @Field(() => AtelierKpi)
  atelier: AtelierKpi;

  @Field(() => SatisfactionKpi)
  satisfaction: SatisfactionKpi;
}
