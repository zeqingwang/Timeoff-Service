import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErrorCode, ErrorCodes } from './error-codes';

export interface ApiErrorBody {
  errorCode: ErrorCode;
  message: string;
  currentBalance?: number;
  requestedDays?: number;
}

export function badRequest(
  errorCode: ErrorCode,
  message: string,
  extra?: Partial<ApiErrorBody>,
): BadRequestException {
  return new BadRequestException({
    errorCode,
    message,
    ...extra,
  });
}

export function invalidRequestDays(message: string): BadRequestException {
  return badRequest(ErrorCodes.INVALID_REQUEST_DAYS, message);
}

export function invalidDimension(
  message: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    errorCode: ErrorCodes.INVALID_DIMENSION,
    message,
  });
}

export function insufficientBalance(
  message: string,
  currentBalance?: number,
  requestedDays?: number,
): ConflictException {
  return new ConflictException({
    errorCode: ErrorCodes.INSUFFICIENT_BALANCE,
    message,
    ...(currentBalance !== undefined ? { currentBalance } : {}),
    ...(requestedDays !== undefined ? { requestedDays } : {}),
  });
}

export function requestNotFound(): NotFoundException {
  return new NotFoundException({
    errorCode: ErrorCodes.REQUEST_NOT_FOUND,
    message: 'Time-off request not found',
  });
}

export function requestNotApprovable(message: string): ConflictException {
  return new ConflictException({
    errorCode: ErrorCodes.REQUEST_NOT_APPROVABLE,
    message,
  });
}

export function requestNotCancellable(message: string): ConflictException {
  return new ConflictException({
    errorCode: ErrorCodes.REQUEST_NOT_CANCELLABLE,
    message,
  });
}

export function employeeMismatch(
  message = 'Request does not belong to this employee',
): ForbiddenException {
  return new ForbiddenException({
    errorCode: ErrorCodes.EMPLOYEE_MISMATCH,
    message,
  });
}

export function hcmUnavailable(
  message = 'HCM is unavailable',
): ServiceUnavailableException {
  return new ServiceUnavailableException({
    errorCode: ErrorCodes.HCM_UNAVAILABLE,
    message,
  });
}

export function hcmInvalidResponse(
  message = 'HCM returned an invalid response',
): HttpException {
  return new HttpException(
    {
      errorCode: ErrorCodes.HCM_INVALID_RESPONSE,
      message,
    },
    HttpStatus.BAD_GATEWAY,
  );
}
