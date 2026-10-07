import { BadRequestException, Logger } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import {
  errorOrigin,
  reportCatchError,
  setErrorReporter,
  wasReported,
  withErrorContext,
} from './error-context';

describe('withErrorContext', () => {
  let errorSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns the SAME error so the rethrow is unchanged', () => {
    const err = new Error('boom');
    expect(withErrorContext(err, 'A.b')).toBe(err);
    expect(err.message).toBe('boom');
    expect(Object.keys(err)).toEqual([]); // tag is non-enumerable
  });

  it('tags the innermost origin and logs once across rethrow frames', () => {
    const err = new Error('boom');
    withErrorContext(err, 'DiService.inner');
    withErrorContext(err, 'DiResolver.outer');
    expect(errorOrigin(err)).toBe('DiService.inner');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('logs expected (4xx / user input) errors at debug, not error', () => {
    withErrorContext(new BadRequestException('bad'), 'A.b');
    withErrorContext(
      new GraphQLError('nope', { extensions: { code: 'BAD_USER_INPUT' } }),
      'A.c',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(2);
  });

  it('passes non-object throwables through untouched', () => {
    expect(withErrorContext('raw', 'A.b')).toBe('raw');
    expect(withErrorContext(undefined, 'A.b')).toBeUndefined();
    expect(errorOrigin('raw')).toBeUndefined();
  });

  it('async wrapper catches a rejection only when the return is awaited', async () => {
    const reject = () => Promise.reject(new Error('late'));
    async function wrapped() {
      try {
        return await reject();
      } catch (error) {
        throw withErrorContext(error, 'X.wrapped');
      }
    }
    await expect(wrapped()).rejects.toThrow('late');
    expect(errorSpy).toHaveBeenCalledWith(
      'X.wrapped · late',
      expect.any(String),
    );
  });
});

describe('withErrorContext → Discord reporter (FIX-232)', () => {
  const PILOT = 'CompanysService.removeCompany';
  let reporter: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    reporter = jest.fn();
    setErrorReporter(reporter);
  });
  afterEach(() => {
    setErrorReporter(null);
    jest.restoreAllMocks();
  });

  it('reports { title, key, error } with the stack, once across rethrow frames', () => {
    const err = new GraphQLError('Company not found', { extensions: { code: 'NOT_FOUND' } });
    withErrorContext(err, PILOT);
    withErrorContext(err, 'CompanysResolver.removeCompany');
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith({
      title: 'removeCompany',
      key: 'removeCompany_CompanysService_error',
      error: {
        name: 'GraphQLError',
        message: 'Company not found',
        code: 'NOT_FOUND',
        stack: expect.stringContaining('Company not found'),
      },
    });
    expect(wasReported(err)).toBe(true);
  });

  it('reports every catch block, not only the former pilot method', () => {
    const err = new Error('boom');
    withErrorContext(err, 'DiService.createDi');
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'createDi', key: 'createDi_DiService_error' }),
    );
    expect(wasReported(err)).toBe(true);
  });

  it('a top-level function (no class) gets a key without a class part', () => {
    withErrorContext(new Error('boom'), 'runWithRequest');
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'runWithRequest', key: 'runWithRequest_error' }),
    );
  });

  it('reportCatchError then withErrorContext on the same error → one alert only', () => {
    const err = new Error('Client not found');
    reportCatchError(err, 'ClientsService.findOneClient');
    withErrorContext(err, 'ClientsResolver.findOneClient');
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'findOneClient_ClientsService_error' }),
    );
  });

  it('no reporter registered → nothing sent, still rethrows the same error', () => {
    setErrorReporter(null);
    const err = new Error('boom');
    expect(withErrorContext(err, PILOT)).toBe(err);
  });

  it('a reporter that throws never changes the rethrow', () => {
    setErrorReporter(() => {
      throw new Error('discord down');
    });
    const err = new Error('boom');
    expect(withErrorContext(err, PILOT)).toBe(err);
  });
});
