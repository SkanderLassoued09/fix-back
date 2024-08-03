import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import * as mongoose from 'mongoose';
import { Client } from 'src/clients/entities/client.entity';
import { Company } from 'src/company/entities/company.entity';
import { DiCategory } from 'src/di_category/entities/di_category.entity';
import { Location } from 'src/location/entities/location.entity';
import { Profile } from 'src/profile/entities/profile.entity';
import { Remarque } from 'src/remarque/entities/remarque.entity';
@Schema({ timestamps: true })
export class DiDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  // title of DI
  title: string;
  @Prop()
  // description of DI
  description: string;
  @Prop()
  nSerie: string;
  @Prop()
  // repair or not
  can_be_repaired: boolean;
  @Prop()
  // pdr or not
  contain_pdr: boolean;
  @Prop({ type: String, ref: 'Profile' })
  // created by who
  createdBy: Profile;
  @Prop({ type: String, ref: 'Client' })
  // belongs to which client
  client_id: Client;
  @Prop({ type: String, ref: 'Company' })
  // belongs to which company
  company_id: Company;

  @Prop({ type: String, ref: 'DiCategory' })
  // belongs to which category
  di_category_id: DiCategory;
  @Prop({ type: String, ref: 'Location' })
  // belongs to which location
  location_id: Location;
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
  array_composants: Array<ComposantStructure>;
  @Prop(() => [String])
  current_workers_ids: [string];
  @Prop(() => [String])
  current_roles: [string];
  @Prop({ default: false })
  isDeleted: boolean;
  @Prop({ default: 0 })
  ignoreCount: number;
  @Prop({ defaultValue: false })
  isOpenedOnce: boolean;
  @Prop({ defaultValue: false })
  gotComposantFromMagasin: string;

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
}
export const DiSchema = SchemaFactory.createForClass(DiDocument);

@ObjectType()
export class Di {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  comment: string;
  @Field({ nullable: true })
  title: string;
  @Field({ nullable: true })
  nSerie: string;
  @Field({ nullable: true })
  description: string;

  //* Booleans
  @Field({ nullable: true })
  can_be_repaired: boolean;
  @Field({ nullable: true })
  contain_pdr: boolean;
  @Field({ defaultValue: false })
  isDeleted: boolean;

  //? ID's
  @Field()
  createdBy: string;
  @Field()
  client_id: string;
  @Field()
  company_id: string;
  @Field(() => [String])
  current_workers_ids: [string];
  @Field(() => [String])
  current_roles: [string];
  //* Array of composants
  @Field(() => [ComposantStructure], { nullable: true })
  array_composants: ComposantStructure[];

  //! Remarque entity containing all the Remarques

  //! entity created by admins
  @Field({ nullable: true })
  di_category_id: string;
  //! Location entity ID
  @Field({ nullable: true })
  location_id: string;
  //! entity STATS ID of technicians
  @Field({ nullable: true })
  stats_id: string;
  //!Files
  @Field({ nullable: true })
  image: string;
  @Field({ nullable: true })
  devis: string;
  @Field({ nullable: true })
  facture: string;
  @Field({ nullable: true })
  bon_de_commande: string;
  @Field({ nullable: true })
  bon_de_livraison: string;

  @Field({ nullable: true })
  price: number;
  @Field({ nullable: true })
  final_price: number;
  @Field({ nullable: true })
  discount: number;
  @Field({ nullable: true })
  discount_value: number;

  @Field({ nullable: true })
  type_client: string;

  @Field({ nullable: true })
  service_quality: string;

  @Field({ nullable: true })
  ignoreCount: number;
  @Field({ nullable: true })
  isOpenedOnce: boolean;
  // Magasin sending composants to coordinatrice
  @Field({ defaultValue: false })
  gotComposantFromMagasin: string;
  @Field({ nullable: true })
  status: string;
  @Field({ nullable: true })
  remarque_manager: string;
  @Field({ nullable: true })
  remarque_admin_manager: string;
  @Field({ nullable: true })
  remarque_admin_tech: string;
  @Field({ nullable: true })
  remarque_tech_diagnostic: string;
  @Field({ nullable: true })
  remarque_tech_repair: string;
  @Field({ nullable: true })
  remarque_magasin: string;
  @Field({ nullable: true })
  remarque_coordinator: string;
}

@ObjectType()
export class ComposantStructure {
  @Field()
  nameComposant: string;

  @Field()
  quantity: number;
}
@ObjectType()
export class RemarqueDi {
  @Field()
  _id: string;
  @Field()
  remarque_manager: string;
  @Field({ nullable: true })
  remarque_admin_manager: string;
  @Field({ nullable: true })
  remarque_admin_tech: string;
  @Field({ nullable: true })
  remarque_tech_diagnostic: string;
  @Field({ nullable: true })
  remarque_tech_repair: string;
  @Field({ nullable: true })
  remarque_magasin: string;
  @Field({ nullable: true })
  remarque_coordinator: string;
}
@ObjectType()
export class ClientDi {
  @Field()
  _id: string;
  @Field()
  first_name: string;
  @Field()
  last_name: string;
}
@ObjectType()
export class CreatedByDi {
  @Field()
  _id: string;
  @Field()
  firstName: string;
  @Field()
  lastName: string;
}

@ObjectType()
export class LocationDi {
  @Field()
  _id: string;
  @Field()
  location_name: string;
}
@ObjectType()
export class CategoryDi {
  @Field()
  _id: string;
  @Field()
  category_Di: string;
}
@ObjectType()
export class DiTable {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  comment: string;
  @Field()
  title: string;
  @Field({ nullable: true })
  description: string;
  @Field({ nullable: true })
  can_be_repaired: boolean;
  @Field({ nullable: true })
  bon_de_commande: string;
  @Field({ nullable: true })
  bon_de_livraison: string;
  @Field({ nullable: true })
  contain_pdr: boolean;
  @Field({ nullable: true })
  status: string;
  @Field({ nullable: true })
  createdAt: string;
  @Field({ nullable: true })
  updatedAt: string;
  @Field({ nullable: true })
  current_roles: string;
  @Field({ nullable: true })
  image: string;
  @Field({ nullable: true })
  client_id: string;
  @Field({ nullable: true })
  createdBy: string;
  @Field({ nullable: true })
  ignoreCount: number;
  @Field({ nullable: true })
  location_id: string;
  @Field({ nullable: true })
  di_category_id: string;
  @Field(() => [ComposantStructure], { nullable: true })
  array_composants: ComposantStructure[];
  /** remarque section  */
  @Field({ nullable: true })
  remarque_manager: string;
  @Field({ nullable: true })
  remarque_admin_manager: string;
  @Field({ nullable: true })
  remarque_admin_tech: string;
  @Field({ nullable: true })
  remarque_tech_diagnostic: string;
  @Field({ nullable: true })
  remarque_tech_repair: string;
  @Field({ nullable: true })
  remarque_magasin: string;
  @Field({ nullable: true })
  remarque_coordinator: string;
} //
@ObjectType()
export class DiTableData {
  @Field(() => [DiTable])
  di: DiTable[];
  @Field()
  totalDiCount: number;
}

@ObjectType()
export class UpdateNego {
  @Field()
  price: number;
  @Field()
  final_price: number;
}
