import { Field, ObjectType, registerEnumType, Int } from '@nestjs/graphql';
import mongoose, { Document } from 'mongoose';

/**
 * Procès-Verbal de Réunion — documents a meeting tied to a DI (in retour mode)
 * or standalone (future "Réunions" menu, reuses the same entity).
 *
 * Refs only (no data duplication): `di` → Di, `createdBy` → Profile,
 * participants[].profile → Profile, actions[].responsable → Profile.
 * Inverse link lives on the Di document (`pvReunions: [ObjectId ref ReunionPV]`)
 * and is maintained by ReunionPvService on create.
 */

export enum Modalite {
  PRESENTIEL = 'PRESENTIEL',
  VISIO = 'VISIO',
  HYBRIDE = 'HYBRIDE',
}
registerEnumType(Modalite, { name: 'Modalite' });

export enum ParticipantStatut {
  PRESENT = 'PRESENT',
  ABSENT = 'ABSENT',
  EXCUSE = 'EXCUSE',
}
registerEnumType(ParticipantStatut, { name: 'ParticipantStatut' });

export enum Priorite {
  BASSE = 'BASSE',
  MOYENNE = 'MOYENNE',
  HAUTE = 'HAUTE',
}
registerEnumType(Priorite, { name: 'Priorite' });

export enum ActionStatut {
  A_FAIRE = 'A_FAIRE',
  EN_COURS = 'EN_COURS',
  TERMINE = 'TERMINE',
}
registerEnumType(ActionStatut, { name: 'ActionStatut' });

export enum PvStatut {
  BROUILLON = 'BROUILLON',
  FINALISE = 'FINALISE',
}
registerEnumType(PvStatut, { name: 'PvStatut' });

// ── Sub-document schemas ────────────────────────────────────────────────

const ParticipantSchema = new mongoose.Schema(
  {
    profile: { type: String, ref: 'Profile', required: true },
    statut: {
      type: String,
      enum: Object.values(ParticipantStatut),
      default: ParticipantStatut.PRESENT,
    },
  },
  { _id: false },
);

const PointDiscuteSchema = new mongoose.Schema(
  {
    titre: { type: String, required: true },
    contenu: { type: String, default: '' },
  },
  { _id: false },
);

// Jira sub-doc — written by the Jira writer (ReunionPVService.syncActionsToJira).
// `synced/issueKey/url` track the mirrored issue; `assignFailed` is set true when
// the action HAD a responsable email but Jira couldn't map it to an account
// (issue still created, unassigned — never lost). Defaults keep it inert.
const JiraInfoSchema = new mongoose.Schema(
  {
    synced: { type: Boolean, default: false },
    issueKey: { type: String, default: null },
    url: { type: String, default: null },
    // true ⇒ issue exists but couldn't be assigned (email not a Jira user).
    assignFailed: { type: Boolean, default: false },
  },
  { _id: false },
);

// NOTE: `_id` is ENABLED on action sub-docs (Mongo auto-generates one). It is
// the stable idempotency key for the Jira writer: on a detail-modal re-save the
// frontend echoes each existing action's `_id`, so the service carries over its
// `jira.issueKey` and UPDATES the same Jira issue instead of creating a new one.
const ActionItemSchema = new mongoose.Schema({
  titre: { type: String, required: true },
  description: { type: String, default: '' },
  responsable: { type: String, ref: 'Profile', default: null },
  echeance: { type: Date, default: null },
  priorite: {
    type: String,
    enum: Object.values(Priorite),
    default: Priorite.MOYENNE,
  },
  statut: {
    type: String,
    enum: Object.values(ActionStatut),
    default: ActionStatut.A_FAIRE,
  },
  jira: { type: JiraInfoSchema, default: () => ({}) },
});

const ContexteRetourSchema = new mongoose.Schema(
  {
    niveau: { type: Number, enum: [1, 2, 3], required: true },
    motif: { type: String, default: '' },
  },
  { _id: false },
);

// 5M / Ishikawa root-cause analysis. A PV documents the *retained* causes
// (those the meeting checked) classified into the five families
// (Main-d'œuvre, Matériel, Milieu, Matière, Méthode). Only kept causes are
// persisted — the static seeded checklist is a UI affordance, not data.
const IshikawaCauseSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    detail: { type: String, default: '' },
    // true when the user typed a cause not in the seeded checklist.
    custom: { type: Boolean, default: false },
  },
  { _id: false },
);

const IshikawaFamilleSchema = new mongoose.Schema(
  {
    // 'mo' | 'mt' | 'mi' | 'ma' | 'me'
    key: { type: String, required: true },
    // Human label kept on the doc so PDF/exports are self-contained.
    label: { type: String, default: '' },
    causes: { type: [IshikawaCauseSchema], default: [] },
  },
  { _id: false },
);

const IshikawaSchema = new mongoose.Schema(
  {
    probleme: { type: String, default: '' },
    familles: { type: [IshikawaFamilleSchema], default: [] },
  },
  { _id: false },
);

// ── ReunionPV root schema ───────────────────────────────────────────────

export const ReunionPVSchema = new mongoose.Schema(
  {
    // Auto-generated PV-{YYYY}-{seq}; service computes it. Unique index so a
    // concurrent insert with the same reference rejects rather than silently
    // duplicating (service catches the dup-key error and retries with seq+1).
    reference: { type: String, required: true, unique: true, index: true },
    titre: { type: String, required: true },
    objet: { type: String, default: '' },

    dateReunion: { type: Date, required: true },
    lieu: { type: String, default: '' },
    modalite: {
      type: String,
      enum: Object.values(Modalite),
      default: Modalite.PRESENTIEL,
    },

    // Di ref — required when the PV was opened from the Retour flow,
    // null for standalone (future "Réunions" menu).
    di: { type: String, ref: 'Di', default: null, index: true },
    contexteRetour: { type: ContexteRetourSchema, default: null },

    // Author (technician/coordinator who created the PV). Required so we
    // can always trace who logged the meeting.
    createdBy: { type: String, ref: 'Profile', required: true, index: true },

    participants: { type: [ParticipantSchema], default: [] },
    ordreDuJour: { type: [String], default: [] },
    decisions: { type: [String], default: [] },
    pointsDiscutes: { type: [PointDiscuteSchema], default: [] },
    actions: { type: [ActionItemSchema], default: [] },

    // 5M / Ishikawa analysis (null when the section was left untouched).
    ishikawa: { type: IshikawaSchema, default: null },

    prochaineReunion: { type: Date, default: null },
    statut: {
      type: String,
      enum: Object.values(PvStatut),
      default: PvStatut.BROUILLON,
    },

    // Idempotence flag for the REUNION_REMINDER cron: set true the first time a
    // ~5-min-before Discord reminder is sent, so re-runs (cron every 1-2 min)
    // never double-notify. Claimed atomically (false→true) before the send.
    reminderSent: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

export type ReunionPVDocument = ReunionPV & Document;

// ── GraphQL ObjectTypes ─────────────────────────────────────────────────

@ObjectType()
export class JiraInfo {
  @Field({ defaultValue: false })
  synced: boolean;
  @Field({ nullable: true })
  issueKey: string;
  @Field({ nullable: true })
  url: string;
  @Field({ defaultValue: false })
  assignFailed: boolean;
}

@ObjectType()
export class Participant {
  @Field()
  profile: string;
  @Field(() => ParticipantStatut)
  statut: ParticipantStatut;
}

@ObjectType()
export class PointDiscute {
  @Field()
  titre: string;
  @Field({ nullable: true })
  contenu: string;
}

@ObjectType()
export class ActionItem {
  // Stable id (Mongo sub-doc _id) — echoed by the frontend on re-save so the
  // Jira writer updates the same issue. Nullable: not yet set for a brand-new
  // action being added in the detail modal before its first save.
  @Field({ nullable: true })
  _id: string;
  @Field()
  titre: string;
  @Field({ nullable: true })
  description: string;
  @Field({ nullable: true })
  responsable: string;
  @Field({ nullable: true })
  echeance: Date;
  @Field(() => Priorite)
  priorite: Priorite;
  @Field(() => ActionStatut)
  statut: ActionStatut;
  @Field(() => JiraInfo, { nullable: true })
  jira: JiraInfo;
}

@ObjectType()
export class ContexteRetour {
  @Field(() => Int)
  niveau: number;
  @Field({ nullable: true })
  motif: string;
}

@ObjectType()
export class IshikawaCause {
  @Field()
  label: string;
  @Field({ nullable: true })
  detail: string;
  @Field({ defaultValue: false })
  custom: boolean;
}

@ObjectType()
export class IshikawaFamille {
  @Field()
  key: string;
  @Field({ nullable: true })
  label: string;
  @Field(() => [IshikawaCause])
  causes: IshikawaCause[];
}

@ObjectType()
export class Ishikawa {
  @Field({ nullable: true })
  probleme: string;
  @Field(() => [IshikawaFamille])
  familles: IshikawaFamille[];
}

@ObjectType()
export class ReunionPV {
  @Field()
  _id: string;
  @Field()
  reference: string;
  @Field()
  titre: string;
  @Field({ nullable: true })
  objet: string;

  @Field()
  dateReunion: Date;
  @Field({ nullable: true })
  lieu: string;
  @Field(() => Modalite)
  modalite: Modalite;

  @Field({ nullable: true })
  di: string;
  @Field(() => ContexteRetour, { nullable: true })
  contexteRetour: ContexteRetour;

  @Field()
  createdBy: string;

  @Field(() => [Participant])
  participants: Participant[];
  @Field(() => [String])
  ordreDuJour: string[];
  @Field(() => [String])
  decisions: string[];
  @Field(() => [PointDiscute])
  pointsDiscutes: PointDiscute[];
  @Field(() => [ActionItem])
  actions: ActionItem[];

  @Field(() => Ishikawa, { nullable: true })
  ishikawa: Ishikawa;

  @Field({ nullable: true })
  prochaineReunion: Date;
  @Field(() => PvStatut)
  statut: PvStatut;

  @Field({ defaultValue: false })
  reminderSent: boolean;

  @Field({ nullable: true })
  createdAt: Date;
  @Field({ nullable: true })
  updatedAt: Date;
}
