import {
  insufficientBalance,
  hcmUnavailable,
  hcmInvalidResponse,
} from '../../src/common/errors';
import { ErrorCodes } from '../../src/common/error-codes';

describe('errors helpers', () => {
  it('insufficientBalance omits optional fields when undefined', () => {
    const ex = insufficientBalance('msg');
    expect(ex.getResponse()).toEqual({
      errorCode: ErrorCodes.INSUFFICIENT_BALANCE,
      message: 'msg',
    });
  });

  it('insufficientBalance includes optional numeric fields when provided', () => {
    const ex = insufficientBalance('msg', 1, 2);
    expect(ex.getResponse()).toEqual({
      errorCode: ErrorCodes.INSUFFICIENT_BALANCE,
      message: 'msg',
      currentBalance: 1,
      requestedDays: 2,
    });
  });

  it('hcmUnavailable uses default message', () => {
    const ex = hcmUnavailable();
    expect(ex.getResponse()).toMatchObject({
      errorCode: ErrorCodes.HCM_UNAVAILABLE,
      message: 'HCM is unavailable',
    });
  });

  it('hcmInvalidResponse uses default message', () => {
    const ex = hcmInvalidResponse();
    expect(ex.getResponse()).toMatchObject({
      errorCode: ErrorCodes.HCM_INVALID_RESPONSE,
      message: 'HCM returned an invalid response',
    });
  });
});
