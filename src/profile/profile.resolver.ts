import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ProfileService } from './profile.service';
import {
  ClientByRegionChart,
  GetTicketByProfile,
  Profile,
  TechTickets,
} from './entities/profile.entity';
import { CreateProfileInput, TokenData } from './dto/create-profile.input';
import { UpdateProfileInput } from './dto/update-profile.input';
import { JwtAuthGuard } from 'src/auth/jwt-auth-guard';
import { BadRequestException, UseGuards } from '@nestjs/common';
import { User as CurrentUser } from 'src/auth/profile.decorator';

import { RolesGuard } from 'src/auth/role-guard';
import { Roles, Role } from './role-decorator';

@Resolver()
export class ProfileResolver {
  constructor(private readonly profileService: ProfileService) {}

  @Mutation(() => Profile)
  async createProfile(
    @Args('createProfileInput') createProfileInput: CreateProfileInput,
  ) {
    let data = await this.profileService.create(createProfileInput);

    return data;
  }

  @Query(() => TokenData)
  @UseGuards(JwtAuthGuard)
  getTokenData(@CurrentUser() profile: TokenData) {
    // console.log(profile);
    if (profile !== null) {
      return profile;
    }
  }

  // @Roles(Role.ADMIN_MANAGER, Role.ADMIN_TECH)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Query(() => [TechTickets])
  async getAllTech() {
    return await this.profileService.getAllTech();
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => [TechTickets])
  async getAllAdmins() {
    return await this.profileService.getAllAdmins();
  }

  @Roles(Role.ADMIN_MANAGER, Role.ADMIN_TECH)
  @Query(() => [Profile])
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getAllProfiles() {
    return await this.profileService.getAllProfile();
  }

  @Query(() => Profile)
  async findOne(@Args('username') username: string) {
    return await this.profileService.findOneForAuth(username);
  }

  sumTimes(times: string[]): string {
    if (!Array.isArray(times)) {
      // console.log('');
      return '00:00:00';
    }
    if (times.length === 0) {
      return '00:00:00';
    }
    if (Array.isArray(times) && times.length > 0) {
      const totalMilliseconds = times.reduce((acc, time) => {
        const [hours, minutes, seconds] = time.split(':').map(Number);
        return acc + hours * 3600000 + minutes * 60000 + seconds * 1000;
      }, 0);

      const sumDate = new Date(totalMilliseconds);
      const sumTimeString = `${String(sumDate.getUTCHours()).padStart(
        2,
        '0',
      )}:${String(sumDate.getUTCMinutes()).padStart(2, '0')}:${String(
        sumDate.getUTCSeconds(),
      ).padStart(2, '0')}`;

      return sumTimeString;
    }
  }

  avgTime(times: string[]): string {
    if (!Array.isArray(times)) {
      // console.log('Input is not array');
      return '00:00:00';
    }
    if (times.length === 0) {
      return '00:00:00';
    }

    if (Array.isArray(times) && times.length > 0) {
      const totalMilliseconds = times.reduce((acc, time) => {
        const [hours, minutes, seconds] = time.split(':').map(Number);
        return acc + hours * 3600000 + minutes * 60000 + seconds * 1000;
      }, 0);

      const avgDate = new Date(totalMilliseconds / times.length);
      const sumTimeString = `${String(avgDate.getUTCHours()).padStart(
        2,
        '0',
      )}:${String(avgDate.getUTCMinutes()).padStart(2, '0')}:${String(
        avgDate.getUTCSeconds(),
      ).padStart(2, '0')}`;

      return sumTimeString;
    }
  }

  calculateTechCoast(time: string, givenPrice: number) {
    const [hh, mm, ss] = time.split(':').map(Number);
    const totalMilliseconds = hh * 3600000 + mm * 60000 + ss * 1000;
    const totalHours = totalMilliseconds / 3600000;
    const totalCost = totalHours * givenPrice; // price per hour nezih
    return totalCost.toFixed(3);
  }

  @Query(() => [GetTicketByProfile])
  async getTicketByProfile(@Args('givenPrice') givenPrice: number) {
    let dataDiag = await this.profileService.getTicketByProfileDiag();
    let dataRep = await this.profileService.getTicketByProfileRep();

    const combinedData = dataDiag.map((diag) => {
      const rep = dataRep.find((rep) => rep.techName === diag.techName);

      if (diag.totalDiag !== undefined && rep !== undefined) {
        let diagCost = this.sumTimes(diag.totalDiag || null);
        let repCost = this.sumTimes(rep.totalRep || null);

        if (diagCost !== null && repCost !== null) {
          return {
            techName: diag.techName,
            totalDiag: this.sumTimes(diag.totalDiag) || '0',
            totalRep: this.sumTimes(rep.totalRep) || '0',
            techCostDiag: this.calculateTechCoast(diagCost, givenPrice),
            techCostRep: this.calculateTechCoast(repCost, givenPrice),
            moyRep: this.avgTime(rep.totalRep),
            moyDiag: this.avgTime(diag.totalDiag),
          };
        } else {
          throw new BadRequestException();
        }
      } else {
        throw new BadRequestException();
      }
    });

    console.log('combinedData', combinedData);
    return combinedData;
  }

  @Mutation(() => Boolean)
  updateProfile(
    @Args('_id') _id: string,
    @Args('updateProfileInput') updateProfileInput: UpdateProfileInput,
  ) {
    const update = this.profileService.updateProfile(_id, updateProfileInput);
    if (update) {
      return true;
    } else {
      return false;
    }
  }
  @Mutation(() => Boolean)
  deleteProfile(@Args('_id') _id: string) {
    const update = this.profileService.deleteUser(_id);
    if (update) {
      return true;
    } else {
      return false;
    }
  }

  @Mutation(() => Profile)
  removeProfile(@Args('id', { type: () => Int }) id: number) {
    return this.profileService.remove(id);
  }
}
