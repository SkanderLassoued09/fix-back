import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { Di } from 'src/di/entities/di.entity';
import { LocationDocument } from 'src/location/entities/location.entity';

@Schema({ timestamps: true, autoIndex: false })
export class StatDocument extends Document {
  @Prop({ unique: true })
  _id: string;
  @Prop({ unique: true })
  _idDi: string;
  @Prop()
  id_tech_diag: string;
  @Prop()
  diag_time: string;
  @Prop()
  id_tech_rep: string;
  @Prop()
  rep_time: string;
  // Wall-clock at which the CURRENT repair run leg started. Set on a real
  // start/resume into INREPARATION (never on pause or a no-op modal re-open),
  // so the UI derives elapsed = rep_time + (now - repRunStartedAt) and the
  // repair timer survives refresh/tabs/devices without localStorage.
  @Prop({ type: Date, default: null })
  repRunStartedAt: Date;
  @Prop()
  status: string;
  @Prop({ type: String, ref: 'Location' })
  // belongs to which location
  location_id: LocationDocument;
  @Prop({ type: String, ref: 'Di' })
  // belongs to which location
  diRef: string;
  @Prop()
  id_tech_retour: string[];
  @Prop({ type: Date })
  retour_time: Date;
  @Prop({ type: Number, default: 0 })
  retour_count: number;
  @Prop({ defaultValue: false })
  diagnostiquefinishedFLAG: boolean;
  @Prop({ defaultValue: false })
  reperationfinishedFLAG: boolean;
  @Prop({ default: 0 })
  ignoreCount: number;

  // Embedded array of pause logs for diagnostics
  @Prop({
    type: [
      {
        pauseType: { type: String, enum: ['diag', 'rep'], required: true },
        pauseStart: { type: String, required: false },
        pauseEnd: { type: String, required: false, default: null },
      },
    ],
  })
  pauseLogs: Array<{
    pauseType: 'diag' | 'rep';
    pauseStart: Date;
    pauseEnd: Date;
  }>;
}
export const StatSchema = SchemaFactory.createForClass(StatDocument);

@ObjectType()
export class StatsCount {
  @Field()
  status: string;
  @Field()
  count: number;
}

@ObjectType()
export class PauseLog {
  @Field()
  _id?: string;
  @Field()
  pauseType: 'diag' | 'rep';

  @Field({ nullable: true })
  pauseStart?: string;

  @Field({ nullable: true, defaultValue: null })
  pauseEnd?: string;
}

@ObjectType()
export class ClientType {
  @Field()
  _id: string;

  @Field({ nullable: true })
  first_name?: string;

  @Field({ nullable: true })
  last_name?: string;

  @Field({ nullable: true })
  phone?: string;
}

@ObjectType()
export class CompanyType {
  @Field()
  _id: string;

  @Field()
  name: string;

  @Field({ nullable: true })
  fax?: string;
}

@ObjectType()
export class Stat {
  @Field()
  _id: string;
  @Field({ nullable: true })
  _idDi: string;
  @Field({ nullable: true })
  _idnum: string;
  @Field({ nullable: true })
  id_tech_diag: string;
  @Field({ nullable: true })
  diag_time: string;
  @Field({ nullable: true })
  id_tech_rep: string;
  @Field({ nullable: true })
  rep_time: string;
  @Field({ nullable: true })
  repRunStartedAt?: Date;
  @Field({ nullable: true })
  id_tech_retour: string;
  @Field({ nullable: true })
  retour_time: string;
  @Field({ nullable: true })
  location_id: string;
  @Field({ nullable: true })
  status: string;
  @Field({ nullable: true })
  retour_count: number;
  @Field({ defaultValue: false })
  diagnostiquefinishedFLAG: boolean;
  @Field({ defaultValue: false })
  reperationfinishedFLAG: boolean;
  @Field({ defaultValue: 0 })
  ignoreCount: number;
  // Embedded array for pause logs
  @Field(() => [PauseLog], { nullable: true })
  pauseLogs?: PauseLog[];
  @Field({ nullable: true })
  client: ClientType;
  @Field({ nullable: true })
  company: CompanyType;
}

@ObjectType()
export class StatsTableData {
  @Field(() => [Stat])
  stat: Stat[];
  @Field()
  totalTechDataCount: number;
}

@ObjectType()
export class CreateStatNotificationReturn {
  @Field({ nullable: true })
  _idDi: string;
  @Field({ defaultValue: 'You got new task', nullable: true })
  messageNotification: string;
  @Field({ nullable: true })
  id_tech_diag: string;
}

@ObjectType()
export class DiReparationInfo {
  @Field()
  StatData: Stat;
  @Field()
  diData: Di;
}

@ObjectType()
export class DiStatConsistencyMismatch {
  @Field()
  _idDi: string;

  @Field({ nullable: true })
  _idnum?: string;

  @Field({ nullable: true })
  diStatus?: string;

  @Field({ nullable: true })
  statStatus?: string;

  @Field({ nullable: true })
  diIgnoreCount?: number;

  @Field({ nullable: true })
  statIgnoreCount?: number;

  @Field()
  mismatchType: string;

  @Field()
  severity: string;

  @Field()
  message: string;
}

@ObjectType()
export class DiStatConsistencyReport {
  @Field()
  checkedDiCount: number;

  @Field()
  mismatchCount: number;

  @Field()
  missingStatCount: number;

  @Field()
  statusMismatchCount: number;

  @Field()
  multipleStatCount: number;

  @Field()
  generatedAt: string;

  @Field(() => [DiStatConsistencyMismatch])
  mismatches: DiStatConsistencyMismatch[];
}

/**
 * @ObjectType()
export class DiReparationInfo {
  @Field()
  StatData: Stat;
  @Field(() => [Di])
  diData: Di[];
}

  async getStatInfoForTechReparation(_idDi: string) {
    const di = await this.diModel.findOne({ _id: _idDi });
    if (di && di.ignoreCount && di.ignoreCount > 0) {
      const logsDi = await this.logsDiService.getAllLogsByDi(_idDi);
      const StatData = await this.StatModel.findOne({
        _idDi,
        ignoreCount: di.ignoreCount,
      });
      const techDiag = await this.profileService.getTech(StatData.id_tech_diag);
      const techrep = await this.profileService.getTech(StatData.id_tech_rep);
      StatData.id_tech_diag = techDiag;
      StatData.id_tech_rep = techrep;

      return { diData: logsDi, StatData };
    } else {
      const StatData = await this.StatModel.findOne({ _idDi });

      const techDiag = await this.profileService.getTech(StatData.id_tech_diag);
      const techrep = await this.profileService.getTech(StatData.id_tech_rep);
      StatData.id_tech_diag = techDiag;
      StatData.id_tech_rep = techrep;

      return { diData: [di], StatData };
    }
  }
 */
