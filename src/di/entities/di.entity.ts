import { ObjectType, Field } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class DiDocument extends Document {
  @Prop()
  _id: string;
  @Prop()
  title: string;
  @Prop()
  description: string;
  @Prop()
  can_be_repaired: boolean;
  @Prop()
  contain_pdr: boolean;
  @Prop()
  created_by_id: string;
  @Prop()
  client_id: string;
  @Prop()
  remarque_id: string;
  @Prop()
  di_category_id: string;
  @Prop()
  location_id: string;
  @Prop()
  stats_id: string;
  @Prop()
  image: string;
  @Prop()
  devis: string;
  @Prop()
  facture: string;
  @Prop()
  bon_de_commande: string;
  @Prop()
  bon_de_livraison: string;
  @Prop()
  price: string;
  @Prop()
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
