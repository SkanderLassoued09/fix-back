import { Field, InputType, Int } from '@nestjs/graphql';
import {
  ActionStatut,
  Modalite,
  ParticipantStatut,
  Priorite,
  PvStatut,
} from '../entities/reunion-pv.entity';

@InputType()
export class ParticipantInput {
  @Field()
  profile: string;
  @Field(() => ParticipantStatut, { nullable: true })
  statut?: ParticipantStatut;
}

@InputType()
export class PointDiscuteInput {
  @Field()
  titre: string;
  @Field({ nullable: true })
  contenu?: string;
}

@InputType()
export class ActionItemInput {
  @Field()
  titre: string;
  @Field({ nullable: true })
  description?: string;
  @Field({ nullable: true })
  responsable?: string;
  @Field({ nullable: true })
  echeance?: Date;
  @Field(() => Priorite, { nullable: true })
  priorite?: Priorite;
  @Field(() => ActionStatut, { nullable: true })
  statut?: ActionStatut;
}

@InputType()
export class ContexteRetourInput {
  @Field(() => Int)
  niveau: number;
  @Field({ nullable: true })
  motif?: string;
}

@InputType()
export class CreateReunionPVInput {
  @Field()
  titre: string;
  @Field({ nullable: true })
  objet?: string;

  @Field()
  dateReunion: Date;
  @Field({ nullable: true })
  lieu?: string;
  @Field(() => Modalite, { nullable: true })
  modalite?: Modalite;

  // null for standalone mode (future menu). Required for the retour flow —
  // the service validates the ref exists when present.
  @Field({ nullable: true })
  diId?: string;
  @Field(() => ContexteRetourInput, { nullable: true })
  contexteRetour?: ContexteRetourInput;

  // Author of the PV. Sent by the frontend (from localStorage._id) instead
  // of being extracted from the JWT — the @CurrentUser decorator path is
  // unreliable in this codebase, so we keep authorship explicit.
  @Field()
  createdById: string;

  @Field(() => [ParticipantInput], { nullable: true })
  participants?: ParticipantInput[];
  @Field(() => [String], { nullable: true })
  ordreDuJour?: string[];
  @Field(() => [String], { nullable: true })
  decisions?: string[];
  @Field(() => [PointDiscuteInput], { nullable: true })
  pointsDiscutes?: PointDiscuteInput[];
  @Field(() => [ActionItemInput], { nullable: true })
  actions?: ActionItemInput[];

  @Field({ nullable: true })
  prochaineReunion?: Date;
  @Field(() => PvStatut, { nullable: true })
  statut?: PvStatut;
}
