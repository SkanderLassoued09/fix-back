import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class CreateDiInput {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  comment: string;
  @Field({ nullable: true })
  title: string;
  @Field({ nullable: true })
  location: string;
  @Field({ nullable: true })
  designiation: string;
  @Field({ nullable: true })
  remarqueTech: string;
  @Field({ nullable: true })
  can_be_repaired: boolean;
  @Field({ nullable: true })
  location_id: string;
  @Field({ nullable: true })
  di_category_id: string;
  @Field({ nullable: true })
  contain_pdr: boolean;
  @Field({ nullable: true })
  client_id: string;
  @Field({ nullable: true })
  company_id: string;
  @Field({ nullable: true })
  nSerie: string;
  @Field({ nullable: true })
  price: number;
  @Field({ nullable: true })
  finalPrice: number;
  @Field({ nullable: true })
  discount_percentage: number;
  @Field({ nullable: true })
  discount_value: number;

  @Field({ nullable: true })
  typeClient: string;
  @Field({ nullable: true })
  createdBy: string;
  @Field({ nullable: true })
  assigned_diagnostic: string;
  @Field({ nullable: true })
  assigned_reperation: string;
  @Field({ nullable: true })
  assigned_retour: string;
  @Field(() => [ComposantStructureInput], { nullable: true })
  array_composants: ComposantStructureInput[];

  //files
  @Field({ nullable: true })
  image: string;
  @Field({ nullable: true })
  Devis: string;
  @Field({ nullable: true })
  facture: string;
  @Field({ nullable: true })
  bon_de_commande: string;
  @Field({ nullable: true })
  bon_de_livraison: string;

  @Field({ nullable: true })
  status: string;

  @Field({ nullable: true })
  isOpenedOnce: boolean;

  @Field({ defaultValue: false })
  gotComposantFromMagasin: boolean;

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
}
@InputType()
export class PaginationConfigDi {
  @Field()
  rows: number; // number of element displayed in table
  @Field()
  first: number; // index of current pages
}
@InputType()
export class ComposantStructureInput {
  @Field()
  nameComposant: string;

  @Field()
  quantity: number;
}

@InputType()
export class DiagUpdate {
  @Field()
  remarque_tech_diagnostic: string;
  @Field()
  contain_pdr: boolean;
  @Field()
  can_be_repaired: boolean;
  @Field(() => [ComposantStructureInput], { nullable: true })
  array_composants: ComposantStructureInput[];
}
