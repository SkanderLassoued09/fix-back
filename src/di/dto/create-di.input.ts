import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class CreateDiInput {
  @Field({ nullable: true })
  _id: string;
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
  price: string;
  @Field({ nullable: true })
  finalPrice: string;
  @Field({ nullable: true })
  discount_percentage: boolean;
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
  etat: string;
  @Field()
  quantity: number;
  @Field()
  date: string;
  @Field()
  link: string;
  @Field()
  package: string;
}
