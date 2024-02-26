import { Injectable } from '@nestjs/common';
import { CreateDiInput } from './dto/create-di.input';
import { UpdateDiInput } from './dto/update-di.input';

@Injectable()
export class DiService {
  create(createDiInput: CreateDiInput) {
    return 'This action adds a new di';
  }

  findAll() {
    return `This action returns all di`;
  }

  findOne(id: number) {
    return `This action returns a #${id} di`;
  }

  update(id: number, updateDiInput: UpdateDiInput) {
    return `This action updates a #${id} di`;
  }

  remove(id: number) {
    return `This action removes a #${id} di`;
  }
}
