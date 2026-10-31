import { Controller, Get } from '@nestjs/common';
import { Public } from './guards.js';

@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz() {
    return { ok: true };
  }
}
