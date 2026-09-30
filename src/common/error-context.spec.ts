import { BadRequestException, Logger } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { errorOrigin, withErrorContext } from './error-context';

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
