import { Field, InputType } from '@nestjs/graphql';
import { StatutCompletude } from '../entities/di-archive.entity';

@InputType()
export class CreateDiArchiveInput {
  @Field({ nullable: true })
  title?: string;
  @Field({ nullable: true })
  description?: string;
  @Field({ nullable: true })
  numSerie?: string;
  @Field({ nullable: true })
  arrangement?: string;
  @Field({ nullable: true })
  clientNom?: string;
  @Field({ nullable: true })
  societeNom?: string;
  // Optionnel — le schéma applique le défaut INCOMPLET si non fourni.
  @Field(() => StatutCompletude, { nullable: true })
  statutCompletude?: StatutCompletude;
}
