import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@ObjectType()
export class composant_id_quantity {
  @Field()
  composant_id: string;
  @Field(() => Int)
  quantity: number;
}

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
  @Prop()
  // created by who
  created_by_id: string;
  @Prop()
  // belongs to which client
  client_id: string;
  @Prop()
  // belongs to remarque
  remarque_id: string;
  @Prop()
  // belongs to which category
  di_category_id: string;
  @Prop()
  // belongs to which location
  location_id: string;
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
  //list of composant
  @Prop(() => [composant_id_quantity])
  array_composants: composant_id_quantity[];
  @Prop(() => [String])
  current_workers_ids: [string];
  @Prop(() => [String])
  current_roles: [string];
  @Prop()
  status: string;
  @Prop({ defaultValue: false })
  isDeleted: boolean;
  @Prop()
  tocoordiantor: boolean;
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
  @Field()
  tocoordiantor: boolean;

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
  @Field(() => [composant_id_quantity], { nullable: true })
  array_composants: composant_id_quantity[];

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

  @Field()
  status: string;
}
