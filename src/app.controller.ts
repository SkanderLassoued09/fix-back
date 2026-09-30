import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { withErrorContext } from './common/error-context';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    try {
      return this.appService.getHello();
    } catch (error) {
      throw withErrorContext(error, 'AppController.getHello');
    }
  }
}
