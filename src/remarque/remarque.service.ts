import { Injectable } from '@nestjs/common';
import { CreateRemarqueInput } from './dto/create-remarque.input';

@Injectable()
export class RemarqueService {
  create(createRemarqueInput: CreateRemarqueInput) {
    return 'This action adds a new remarque';
  }

  findAll() {
    return `This action returns all remarque`;
  }

  findOne(id: number) {
    return `This action returns a #${id} remarque`;
  }

  remove(id: number) {
    return `This action removes a #${id} remarque`;
  }
}
