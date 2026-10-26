import { describe, expect, it } from 'vitest'
import { errorText, hasResponseCode } from '../src/util'

function httpFailure(status = 403, code: string | number = 40034105, message = 'push denied') {
  return Object.assign(new Error('Request failed'), { response: { status, data: { code, message } } })
}

describe('safe error diagnostics', () => {
  it.each([new Error('database unavailable'), 'database unavailable'])('keeps ordinary diagnostic messages', error => {
    expect(errorText(error)).toBe('database unavailable')
  })

  it.each([new Error(), new AggregateError([]), {}, null, undefined, { message: '  \n ' }])(
    'never returns an empty diagnostic for %s', error => {
      expect(errorText(error)).toBe('未知错误（未提供错误详情）')
    },
  )

  it('extracts the response of Satori-style empty aggregate errors', () => {
    const error = Object.assign(new Error(), { errors: [httpFailure()] })
    expect(errorText(error)).toBe('HTTP 403；code=40034105；push denied；Request failed')
  })

  it('preserves multiple failures and nested causes without duplicating identical errors', () => {
    const first = httpFailure()
    const error = new AggregateError([first, first, new Error('delivery failed', {
      cause: httpFailure(429, 'RATE_LIMIT', 'try later'),
    })])
    const result = errorText(error)
    expect(result.match(/HTTP 403/g)).toHaveLength(1)
    expect(result).toContain('HTTP 429；code=RATE_LIMIT；try later')
    expect(result).toContain('delivery failed')
  })

  it('handles JSON response bodies and plain error objects', () => {
    expect(errorText({ response: { status: '403', data: JSON.stringify({ code: 40054013, message: 'user refused' }) } }))
      .toBe('HTTP 403；code=40054013；user refused')
    expect(errorText({ response: { status: 400, data: { error_code: 400, description: 'Bad Request' } } }))
      .toBe('HTTP 400；code=400；Bad Request')
    expect(errorText(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })))
      .toBe('code=ECONNREFUSED；connection refused')
  })

  it('matches exact nested response codes, never codes merely mentioned in an error message', () => {
    expect(hasResponseCode(new AggregateError([httpFailure(400, '40054010')]), 40054010)).toBe(true)
    expect(hasResponseCode(new Error('40054010'), 40054010)).toBe(false)
    expect(hasResponseCode({ code: 40054010 }, 40054010)).toBe(false)
    expect(hasResponseCode(httpFailure(), 40054010)).toBe(false)
  })

  it('does not dump HTML, request headers, credentials, stacks or extra response fields', () => {
    const error = Object.assign(httpFailure(), {
      config: { headers: { Authorization: 'secret-header' }, data: 'secret-request' },
      stack: 'secret-stack',
    })
    Object.assign(error.response.data, { access_token: 'secret-response', private_data: 'secret-extra' })
    expect(errorText(error)).not.toContain('secret-')
    expect(errorText({ response: { status: 502, data: '<html>secret-html</html>' } })).toBe('HTTP 502')
  })

  it('redacts common credentials and full URLs in selected messages, keeping a single line', () => {
    const error = new Error('denied\r\nAuthorization: Bearer fixture-auth; QQBot fixture-qq; '
      + 'access_token="fixture-access" password=fixture-password; '
      + 'GET https://user:fixture-password@example.invalid/users/private-id?token=fixture-query')
    const result = errorText(error)
    expect(result).toContain('denied')
    expect(result).toContain('[REDACTED]')
    expect(result).toContain('[URL]')
    expect(result).not.toMatch(/fixture-|private-id|[\r\n]/)
  })

  it('bounds cyclic, oversized and deeply nested errors without invoking arbitrary object stringifiers', () => {
    const error: { cause?: unknown; errors: unknown[] } = { errors: [] }
    error.cause = error
    error.errors = [error, ...Array.from({ length: 100 }, (_, i) => new Error(`${i}:${'x'.repeat(5000)}`))]
    expect(errorText(error).length).toBeLessThanOrEqual(2000)
    let nested: unknown = new Error('unreachable')
    for (let i = 0; i < 100; i++) nested = { cause: nested }
    expect(errorText(nested)).toBeTruthy()
    const malformed = { get response() { throw new Error('getter failed') }, toString() { throw new Error('stringifier failed') } }
    expect(errorText(malformed)).toBeTruthy()
    expect(errorText({ response: { status: malformed }, code: malformed })).toBeTruthy()
  })
})
