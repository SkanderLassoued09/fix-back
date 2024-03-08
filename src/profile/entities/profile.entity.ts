import { ObjectType, Field, Int } from '@nestjs/graphql';

import mongoose, { Document } from 'mongoose';

import * as bcrypt from 'bcrypt';
export type ProfileDocument = Profile & Document;

export const ProfileSchema = new mongoose.Schema(
  {
    username: String,
    firstName: String,
    lastName: String,
    password: String,
    phone: String,
    role: String,
    email: String,

    isTechBusy: { type: Boolean, required: false, default: false },
    isDeleted: { type: Boolean, required: false, default: false },
  },
  { timestamps: true },
);

ProfileSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    next();
  } else {
    this['password'] = await bcrypt.hash(this['password'], 10);
    return next();
  }
});
@ObjectType()
export class Profile extends Document {
  @Field({ nullable: true })
  _id: string;
  @Field({ nullable: true })
  username: string;
  @Field({ nullable: true })
  firstName: string;
  @Field({ nullable: true })
  lastName: string;
  @Field({ nullable: true })
  password: string;
  @Field({ nullable: true })
  phone: string;
  @Field({ nullable: true })
  role: string;
  @Field({ nullable: true })
  email: string;
  @Field({ nullable: true })
  isTechBusy: boolean;
  @Field({ nullable: true })
  createdAt: Date;
  @Field({ nullable: true })
  updatedAt: Date;
  @Field({ nullable: true })
  isDeleted: boolean;
}

@ObjectType()
export class TechTickets {
  @Field()
  _id: string;
  @Field()
  isTechBusy: boolean;
  @Field()
  username: string;

  @Field(() => Int)
  ticketCount: number;
}
@ObjectType()
export class ClientByRegionChart {
  @Field()
  name: string;
  @Field()
  value: number;
}

@ObjectType()
export class ChartIssueByTech {
  @Field()
  name: string;
  @Field()
  value: number;
}

@ObjectType()
export class GetTicketByProfile {
  @Field({ nullable: true })
  techName: string;
  @Field({ nullable: true })
  totalDiag: string;
  @Field({ nullable: true })
  totalRep: string;
  @Field({ nullable: true })
  moyDiag: string;
  @Field({ nullable: true })
  moyRep: string;
  @Field({ nullable: true })
  techCostRep: number;
  @Field({ nullable: true })
  techCostDiag: number;
  // @Field(() => [ChartIssueByTech])
  // chartIssueByTech: ChartIssueByTech;
}

@ObjectType()
export class ProfileTableData {
  @Field(() => [Profile])
  profileRecord: Profile[];
  @Field()
  totalProfileCount: number;
}
