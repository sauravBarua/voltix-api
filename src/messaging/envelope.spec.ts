import { PoisonMessageError, parseEnvelope } from './envelope';

const valid = {
  id: 'evt-1',
  type: 'order.paid',
  aggregateType: 'order',
  aggregateId: 'o-1',
  occurredAt: '2026-10-17T12:00:00.000Z',
  payload: { orderId: 'o-1' },
};

describe('parseEnvelope', () => {
  it('parses a valid envelope', () => {
    expect(parseEnvelope(Buffer.from(JSON.stringify(valid)))).toEqual(valid);
  });

  it('flags invalid JSON and wrong shapes as poison', () => {
    expect(() => parseEnvelope(Buffer.from('not json'))).toThrow(PoisonMessageError);
    expect(() => parseEnvelope(Buffer.from(JSON.stringify({ ...valid, id: undefined })))).toThrow(
      PoisonMessageError,
    );
    expect(() => parseEnvelope(Buffer.from(JSON.stringify({ ...valid, payload: 'x' })))).toThrow(
      PoisonMessageError,
    );
  });
});
