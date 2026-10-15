import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '@livechat/shared';
import { ZodError } from 'zod';

/**
 * Global exception filter (blueprint §8.2): clients get a generic, consistent
 * error shape; detailed stack traces only go to the logs, never the response.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { error: { code: string; message: string; details?: unknown } };

    if (exception instanceof AppError) {
      status = exception.status;
      body = exception.toJSON() as typeof body;
    } else if (exception instanceof ZodError) {
      // Schema failures from direct .parse() calls (mass-assignment etc.).
      status = HttpStatus.BAD_REQUEST;
      body = {
        error: {
          code: 'validation_failed',
          message: 'Validation failed',
          details: exception.issues,
        },
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = {
        error: {
          code: 'http_error',
          message:
            typeof exception.getResponse() === 'string'
              ? exception.message
              : ((exception.getResponse() as any)?.message ?? exception.message),
        },
      };
    } else {
      // Unknown error: log full detail, return generic message.
      this.logger.error(
        `Unhandled error: ${exception instanceof Error ? exception.stack : String(exception)}`,
      );
      body = { error: { code: 'internal_error', message: 'Internal server error' } };
    }

    res.status(status).json(body);
  }
}
