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
  @Field()
  _id: string;
  @Field()
  username: string;
  @Field()
  firstName: string;
  @Field()
  lastName: string;
  @Field()
  password: string;
  @Field()
  phone: string;
  @Field()
  role: string;
  @Field()
  email: string;
  @Field()
  isTechBusy: boolean;
  @Field()
  createdAt: Date;
  @Field()
  updatedAt: Date;
  @Field()
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
