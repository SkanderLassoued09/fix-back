import { Field, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  ALERT_SEVERITY_VALUES,
  ALERT_TYPE_VALUES,
  AlertSeverity,
  AlertType,
} from '../alert.enums';

/**
 * Persistent operational alert tied to a DI. Surviving page refresh /
 * server restart was an explicit Phase 1 requirement, hence a real
 * collection rather than an in-memory pubsub-only signal.
 */
@Schema({ timestamps: true, collection: 'di_alerts' })
export class DiAlertDocument extends Document {
  @Prop({ required: true, index: true })
  diId: string;

  @Prop({ required: true, type: String, enum: ALERT_TYPE_VALUES, index: true })
  type: AlertType;

  @Prop({
    required: true,
    type: String,
    enum: ALERT_SEVERITY_VALUES,
    default: AlertSeverity.INFO,
  })
  severity: AlertSeverity;

  @Prop({ required: true })
  message: string;

  /**
   * Roles that should see this alert in their dashboard. We deliberately
   * use the existing role string values from src/auth/roles.ts so the
   * frontend can filter without a translation table.
   */
  @Prop({ type: [String], default: [] })
  assignedRoles: string[];

  /** Free-form payload (composant id, blockedReason, etc.). */
  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;

  @Prop({ default: 0 })
  escalationLevel: number;

  /** Null while the alert is open; set when an actor resolves it. */
  @Prop({ default: null, index: true })
  resolvedAt: Date | null;

  @Prop({ type: String, ref: 'Profile', default: null })
  resolvedBy: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export const DiAlertSchema = SchemaFactory.createForClass(DiAlertDocument);
DiAlertSchema.index({ diId: 1, resolvedAt: 1 });
DiAlertSchema.index({ type: 1, resolvedAt: 1 });
DiAlertSchema.index({ assignedRoles: 1, resolvedAt: 1 });
DiAlertSchema.index({ createdAt: -1 });

@ObjectType()
export class DiAlert {
  @Field()
  _id: string;

  @Field()
  diId: string;

  @Field(() => AlertType)
  type: AlertType;

  @Field(() => AlertSeverity)
  severity: AlertSeverity;

  @Field()
  message: string;

  @Field(() => [String])
  assignedRoles: string[];

  @Field({ nullable: true })
  metadataJson?: string;

  @Field()
  escalationLevel: number;

  @Field({ nullable: true })
  resolvedAt?: Date;

  @Field({ nullable: true })
  resolvedBy?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
