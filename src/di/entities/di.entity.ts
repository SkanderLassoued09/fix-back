import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import * as mongoose from 'mongoose';
import { Client } from 'src/clients/entities/client.entity';
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
  // repair or not
  can_be_repaired: boolean;
  @Prop()
  // pdr or not
  contain_pdr: boolean;
  @Prop({ type: String, ref: 'Profile' })
  // created by who
  created_by_id: Profile;
  @Prop({ type: String, ref: 'Client' })
  // belongs to which client
  client_id: Client;
  @Prop({ type: String, ref: 'Remarque' })
  // belongs to remarque
  remarque_id: Remarque;
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
  price: string;
  @Prop()
  // affected by admins
  final_price: string;
  @Prop()
  discount: boolean;
  @Prop()
  discount_value: number;
  @Prop()
  type_client: string;
  @Prop()
  service_quality: string;
  @Prop()
  // status of DI
  status: string;
  @Prop(() => [String, Number])
  array_composants: [string, number];
  @Prop(() => [String])
  current_workers_ids: [string];
  @Prop(() => [String])
  current_roles: [string];
  @Prop({ defaultValue: false })
  isDeleted: boolean;
}
export const DiSchema = SchemaFactory.createForClass(DiDocument);

@ObjectType()
export class Di {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  title: string;
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
  created_by_id: string;
  @Field()
  client_id: string;
  @Field(() => [String])
  current_workers_ids: [string];
  @Field(() => [String])
  current_roles: [string];
  //* Array of composants
  @Field(() => [String, Number], { nullable: true })
  array_composants: [string, number];

  //! Remarque entity containing all the Remarques
  @Field({ nullable: true })
  remarque_id: string;
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
  price: string;
  @Field({ nullable: true })
  final_price: string;
  @Field({ nullable: true })
  discount: boolean;
  @Field({ nullable: true })
  discount_value: number;

  @Field({ nullable: true })
  type_client: string;

  @Field({ nullable: true })
  service_quality: string;

  @Field({ nullable: true })
  status: string;
}

@ObjectType()
export class RemarqueDi {
  @Field()
  _id: string;
  @Field()
  remarque_manager: string;
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
  client_id: string;
  @Field({ nullable: true })
  remarque_id: string;
  @Field({ nullable: true })
  created_by_id: string;
  @Field({ nullable: true })
  location_id: string;
  @Field({ nullable: true })
  di_category_id: string;
} //
@ObjectType()
export class DiTableData {
  @Field(() => [DiTable])
  di: DiTable[];
  @Field()
  totalDiCount: number;
}
