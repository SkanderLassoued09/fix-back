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
  // Echoed by the detail modal for an EXISTING action so the Jira writer
  // updates its issue instead of creating a duplicate. Absent = new action.
  @Field({ nullable: true })
  _id?: string;
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
export class IshikawaCauseInput {
  @Field()
  label: string;
  @Field({ nullable: true })
  detail?: string;
  @Field({ nullable: true })
  custom?: boolean;
}

@InputType()
export class IshikawaFamilleInput {
  @Field()
  key: string;
  @Field({ nullable: true })
  label?: string;
  @Field(() => [IshikawaCauseInput], { nullable: true })
  causes?: IshikawaCauseInput[];
}

@InputType()
export class IshikawaInput {
  @Field({ nullable: true })
  probleme?: string;
  @Field(() => [IshikawaFamilleInput], { nullable: true })
  familles?: IshikawaFamilleInput[];
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

  @Field(() => IshikawaInput, { nullable: true })
  ishikawa?: IshikawaInput;

  @Field({ nullable: true })
  prochaineReunion?: Date;
  @Field(() => PvStatut, { nullable: true })
  statut?: PvStatut;
}

/**
 * Phase-2 input: the "document the meeting" step performed later from the detail
 * modal (after the light creation). Carries ONLY the detailed sections; the
 * light fields (titre/date/participants) are set at creation and untouched here.
 * `actions[]` may include an `_id` for existing actions (idempotent Jira sync).
 */
@InputType()
export class UpdateReunionPVDetailsInput {
  @Field()
  _id: string;

  @Field(() => [String], { nullable: true })
  ordreDuJour?: string[];
  @Field(() => [String], { nullable: true })
  decisions?: string[];
  @Field(() => [PointDiscuteInput], { nullable: true })
  pointsDiscutes?: PointDiscuteInput[];
  @Field(() => [ActionItemInput], { nullable: true })
  actions?: ActionItemInput[];

  @Field(() => IshikawaInput, { nullable: true })
  ishikawa?: IshikawaInput;

  // Optional finalize toggle: BROUILLON → FINALISE. When omitted the PV keeps
  // its current statut (documenting a draft doesn't lock it).
  @Field(() => PvStatut, { nullable: true })
  statut?: PvStatut;
}
