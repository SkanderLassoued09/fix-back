import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ComposantStructure } from 'src/di/entities/di.entity';
import { Document } from 'mongoose';
@Schema({ timestamps: true })
export class DiLogsDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  _idDi: string;
  @Prop()
  idIgnore: number;
  @Prop()
  // repair or not
  can_be_repaired: boolean;
  @Prop()
  // pdr or not
  contain_pdr: boolean;

  @Prop()
  // stats of tech
  stats_id: string;
  @Prop()
  // pdf file
  image: string;
  @Prop()
  // pdf file
  devis: string;
  @Prop()
  // pdf file
  facture: string;
  @Prop()
  // pdf file
  bon_de_commande: string;
  @Prop()
  // pdf file
  bon_de_livraison: string;
  @Prop()
  // affected by magasin
  price: number;
  @Prop()
  // affected by admins
  final_price: number;
  @Prop()
  discount: number;
  @Prop()
  discount_value: number;
  @Prop()
  type_client: string;
  @Prop()
  service_quality: string;
  @Prop()
  // status of DI
  status: string;
  @Prop()
  array_composants: Array<ComposantStructureLogs>;
  @Prop(() => [String])
  current_workers_ids: [string];
  @Prop(() => [String])
  current_roles: [string];
  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ defaultValue: false })
  isOpenedOnce: boolean;
  @Prop({ defaultValue: false })
  gotComposantFromMagasin: string;
  // confirmation component for magasin and coordinator section
  @Prop({ default: false })
  isConfirmedComponentFromCoordinator: boolean;
  @Prop({ default: false })
  isSentToCoordinator: boolean;

  @Prop()
  comment: string;
  /** remarque section  */
  @Prop({ nullable: true })
  remarque_manager: string;
  @Prop({ nullable: true })
  remarque_admin_manager: string;
  @Prop({ nullable: true })
  remarque_admin_tech: string;
  @Prop({ nullable: true })
  remarque_tech_diagnostic: string;
  @Prop({ nullable: true })
  remarque_tech_repair: string;
  @Prop({ nullable: true })
  remarque_magasin: string;
  @Prop({ nullable: true })
  remarque_coordinator: string;
  @Prop({ nullable: true })
  confirmationComposant: string;

  @Prop({ nullable: true })
  isErrorFromFixtronix: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export const DiLogsSchema = SchemaFactory.createForClass(DiLogsDocument);

@ObjectType()
export class LogsDi {
  @Field(() => String, { nullable: true })
  _id: string;
  @Field(() => String, { nullable: true })
  _idDi?: string;
  @Field(() => Number, { nullable: true })
  idIgnore?: number;
  @Field(() => Boolean, { nullable: true })
  can_be_repaired?: boolean;

  @Field(() => Boolean, { nullable: true })
  contain_pdr?: boolean;

  @Field(() => String, { nullable: true })
  stats_id?: string;

  @Field(() => String, { nullable: true })
  image?: string;

  @Field(() => String, { nullable: true })
  devis?: string;

  @Field(() => String, { nullable: true })
  facture?: string;

  @Field(() => String, { nullable: true })
  bon_de_commande?: string;

  @Field(() => String, { nullable: true })
  bon_de_livraison?: string;

  @Field(() => Number, { nullable: true })
  price?: number;

  @Field(() => Number, { nullable: true })
  final_price?: number;

  @Field(() => Number, { nullable: true })
  discount?: number;

  @Field(() => Number, { nullable: true })
  discount_value?: number;

  @Field(() => String, { nullable: true })
  type_client?: string;

  @Field(() => String, { nullable: true })
  service_quality?: string;

  @Field(() => String, { nullable: true })
  status?: string;

  @Field(() => [ComposantStructureLogs], { nullable: true })
  array_composants?: Array<ComposantStructureLogs>;

  @Field(() => [String], { nullable: true })
  current_workers_ids?: string[];

  @Field(() => [String], { nullable: true })
  current_roles?: string[];

  @Field(() => Boolean, { nullable: true })
  isDeleted?: boolean;

  @Field(() => Boolean, { nullable: true })
  isErrorFromFixtronix: boolean;
  @Field(() => Boolean, { nullable: true })
  isOpenedOnce?: boolean;

  @Field(() => Boolean, { nullable: true })
  gotComposantFromMagasin?: boolean;

  @Field(() => Boolean, { nullable: true })
  isConfirmedComponentFromCoordinator?: boolean;

  @Field(() => Boolean, { nullable: true })
  isSentToCoordinator?: boolean;

  @Field(() => String, { nullable: true })
  comment?: string;

  @Field(() => String, { nullable: true })
  remarque_manager?: string;

  @Field(() => String, { nullable: true })
  remarque_admin_manager?: string;

  @Field(() => String, { nullable: true })
  remarque_admin_tech?: string;

  @Field(() => String, { nullable: true })
  remarque_tech_diagnostic?: string;

  @Field(() => String, { nullable: true })
  remarque_tech_repair?: string;

  @Field(() => String, { nullable: true })
  remarque_magasin?: string;

  @Field(() => String, { nullable: true })
  remarque_coordinator?: string;

  @Field(() => String, { nullable: true })
  confirmationComposant?: string;

  @Field(() => Date, { nullable: true })
  createdAt?: Date;

  @Field(() => Date, { nullable: true })
  updatedAt?: Date;
}

@ObjectType()
export class ComposantStructureLogs {
  @Field({ nullable: true })
  nameComposant: string;
  @Field({ nullable: true })
  quantity: number;
  @Field({ nullable: true, defaultValue: false })
  isUpdated: boolean;
}
